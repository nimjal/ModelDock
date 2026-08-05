/**
 * Driving the Claude Code CLI.
 *
 * Over its documented headless protocol — `-p` with `--output-format
 * stream-json` — and not through `@anthropic-ai/claude-agent-sdk`, which is
 * distributed under Anthropic's commercial terms and cannot be a dependency of
 * an MIT project. Invoking a program someone already installed is a different
 * thing from linking their library, and it has the happy side effect that the
 * agent runs with the person's own login, their CLAUDE.md, their slash
 * commands and their MCP servers, exactly as it does in their terminal.
 *
 * Two decisions worth knowing about:
 *
 *   - The prompt goes on stdin, never argv. Prompts contain quotes and
 *     newlines, and on Windows a `.cmd` shim has to be invoked through
 *     `cmd.exe`, where argument quoting is a well-known source of injection
 *     (CVE-2024-27980). With the prompt on stdin there is nothing to quote.
 *   - `--add-dir` is never passed and `cwd` is the project root, so the only
 *     directory in scope is the project's own.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { UIMessageStreamWriter } from "ai";

import { AgentError, type CodingAgentAdapter, type RunContext, type RunResult } from "./adapter.js";
import { chunk, OpenParts, toolInput, toolName } from "./normalize.js";
import { permissionArgsForClaude } from "./permissions.js";
import { killTree, spawnCommand } from "./spawn.js";

/** Enough stderr to explain a failure, not enough to be a memory leak. */
const MAX_STDERR = 8 * 1024;

interface Line {
  type?: string;
  subtype?: string;
  session_id?: string;
  event?: Record<string, unknown>;
  message?: { content?: Record<string, unknown>[]; model?: string };
  [key: string]: unknown;
}

export const claudeCodeAdapter: CodingAgentAdapter = {
  kind: "claude_code",

  async run(context: RunContext, writer: UIMessageStreamWriter): Promise<RunResult> {
    const { agent, root, prompt, permission, sessionId, skillIndex, signal } = context;

    if (!agent.command) throw new AgentError("Claude Code is not installed on this machine.");

    // The route refuses `ask` for an external engine before it gets here; this
    // is the second lock. Falling back to a neighbouring level instead would
    // silently run something the person asked to be consulted about.
    if (permission === "ask") {
      throw new AgentError("Claude Code cannot ask before each call. Pick another level.");
    }

    const args = [
      // `args` comes first: it is a prefix, so `command` can be an interpreter
      // or a version-manager shim with the real entry point in `args`.
      ...(agent.args ?? []),
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...permissionArgsForClaude(permission, root),
      ...(sessionId ? ["--resume", sessionId] : []),
    ];

    // The skill index rides on stdin with the prompt rather than going to
    // `--append-system-prompt`. It is multi-line text assembled from files on
    // disk, and argv is the one place multi-line text must never go — see
    // `cmdLineFor`. Everything left on argv above is a fixed flag or an id.
    const stdin = skillIndex ? `${skillIndex}\n\n---\n\n${prompt}` : prompt;

    const child = spawnCommand(agent.command, args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    const open = new OpenParts();
    let resolvedSession: string | null = sessionId;
    let model: string | null = null;
    let stderr = "";
    let failure: string | null = null;

    // The prompt never touches argv — see the header.
    child.stdin.end(stdin);

    child.stderr.on("data", (buffer: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += buffer.toString();
    });

    // Takes the whole tree, because the agent may have started a build.
    const stop = () => killTree(child);

    signal.addEventListener("abort", stop, { once: true });

    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });

    try {
      for await (const raw of reader) {
        if (!raw.trim()) continue;

        let line: Line;
        try {
          line = JSON.parse(raw) as Line;
        } catch {
          // Not every line is protocol; a stray log should not end the run.
          continue;
        }

        if (line.session_id) resolvedSession = line.session_id;

        switch (line.type) {
          case "system":
            if (line.subtype === "init") model = (line.model as string) ?? model;
            break;

          case "stream_event":
            handleStreamEvent(line.event ?? {}, writer, open);
            break;

          case "assistant":
            // The authoritative, fully-parsed tool inputs. Text blocks are
            // deliberately not re-emitted: partial streaming already sent them.
            model = line.message?.model ?? model;
            for (const block of line.message?.content ?? []) {
              if (block.type !== "tool_use") continue;
              const id = String(block.id);
              const name = toolName(String(block.name));
              if (open.openTool(id)) writer.write(chunk.toolStart(id, name));
              writer.write(chunk.toolInput(id, name, toolInput(block.input, root)));
            }
            break;

          case "user":
            for (const block of (line.message?.content ?? []) as Record<string, unknown>[]) {
              if (block.type !== "tool_result") continue;
              const id = String(block.tool_use_id);
              // Rule 2: a result needs its call to exist first.
              if (open.openTool(id)) writer.write(chunk.toolStart(id, "tool"));
              if (block.is_error) writer.write(chunk.toolFailed(id, stringify(block.content)));
              else writer.write(chunk.toolOutput(id, block.content));
            }
            break;

          case "result":
            if (typeof line.subtype === "string" && line.subtype.startsWith("error")) {
              failure = stringify(line.result ?? line.subtype);
            }
            break;

          default:
            break;
        }
      }

      const code = await new Promise<number>((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.on("close", (value) => resolve(value ?? 0));
      });

      for (const part of open.closeAll()) writer.write(part);

      // 143 is the documented exit for an aborted turn, which is not an error.
      if (failure) writer.write(chunk.error(failure));
      else if (code !== 0 && code !== 143 && !signal.aborted) {
        writer.write(chunk.error(stderr.trim() || `Claude Code exited with code ${code}.`));
      }
    } finally {
      reader.close();
      signal.removeEventListener("abort", stop);
    }

    return { sessionId: resolvedSession, model };
  },
};

/**
 * Claude Code sends true deltas, so these pass straight through. (OpenCode
 * sends cumulative text and needs `Cumulative` to difference it — that
 * asymmetry is the main reason the two adapters are separate files.)
 */
function handleStreamEvent(
  event: Record<string, unknown>,
  writer: UIMessageStreamWriter,
  open: OpenParts,
): void {
  const block = event.content_block as Record<string, unknown> | undefined;
  const delta = event.delta as Record<string, unknown> | undefined;
  const index = String(event.index ?? 0);

  switch (event.type) {
    case "content_block_start":
      if (block?.type === "text" && open.openText(index)) writer.write(chunk.textStart(index));
      else if (block?.type === "thinking" && open.openReasoning(index)) {
        writer.write(chunk.reasoningStart(index));
      } else if (block?.type === "tool_use") {
        const id = String(block.id);
        if (open.openTool(id)) writer.write(chunk.toolStart(id, toolName(String(block.name))));
      }
      break;

    case "content_block_delta":
      if (delta?.type === "text_delta") {
        if (open.openText(index)) writer.write(chunk.textStart(index));
        writer.write(chunk.textDelta(index, String(delta.text ?? "")));
      } else if (delta?.type === "thinking_delta") {
        if (open.openReasoning(index)) writer.write(chunk.reasoningStart(index));
        writer.write(chunk.reasoningDelta(index, String(delta.thinking ?? "")));
      }
      // `input_json_delta` is deliberately dropped: the `assistant` message
      // carries the parsed input, and a partial JSON string renders as noise.
      break;

    default:
      break;
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === "string" ? item : String((item as { text?: unknown })?.text ?? ""),
      )
      .join("")
      .trim();
  }
  return JSON.stringify(value ?? "");
}
