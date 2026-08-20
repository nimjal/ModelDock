/**
 * Turning two engines' event streams into one shape.
 *
 * OpenCode speaks SSE objects and Claude Code speaks newline-delimited JSON,
 * but both have to end up as AI SDK `UIMessage` parts — because that is what
 * `messages.parts` already stores and what `Message.tsx` already renders. A
 * Code session should read back years later exactly like a chat does, with no
 * second renderer and no second storage format.
 *
 * Three ordering rules are load-bearing, each read out of the SDK's own
 * `processUIMessageStream`, and each of which fails *silently* if broken:
 *
 *   1. Never set `dynamic: true`. It produces a part of type `dynamic-tool`,
 *      and `Message.tsx` filters on `tool-` — those parts would vanish from
 *      the transcript entirely. Omitting it yields `tool-${name}`.
 *   2. `tool-output-available` throws unless the tool part already exists, so
 *      every call id needs a `tool-input-start` or `tool-input-available`
 *      before its result.
 *   3. `tool-input-delta` throws without a preceding `tool-input-start`
 *      carrying the same `toolCallId`.
 */

import type { UIMessageChunk } from "ai";

/**
 * One vocabulary for tool names across engines.
 *
 * Both agents call the same handful of things by different names, and the
 * transcript reads better — and stays greppable — if `read` means read
 * whoever produced it.
 */
const TOOL_NAMES: Record<string, string> = {
  // OpenCode
  read: "read",
  edit: "edit",
  patch: "edit",
  write: "write",
  bash: "bash",
  grep: "grep",
  glob: "glob",
  list: "list",
  webfetch: "fetch",
  websearch: "search",
  task: "task",
  todowrite: "todo",
  todoread: "todo",
  // Claude Code
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "write",
  Bash: "bash",
  Grep: "grep",
  Glob: "glob",
  LS: "list",
  WebFetch: "fetch",
  WebSearch: "search",
  Task: "task",
  TodoWrite: "todo",
};

export function toolName(raw: string): string {
  return TOOL_NAMES[raw] ?? raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

/**
 * Normalise a tool's arguments to the few keys the UI reads, keeping the
 * engine's own payload under `raw` — parts are stored, so throwing away the
 * original would make an old transcript less readable, not more.
 */
export function toolInput(raw: unknown, root: string): Record<string, unknown> {
  const input = (raw ?? {}) as Record<string, unknown>;

  const path = firstString(input, ["path", "file_path", "filePath", "filename", "file"]);
  const pattern = firstString(input, ["pattern", "query", "regex"]);
  const command = firstString(input, ["command", "cmd"]);

  return {
    ...(path ? { path: relativise(path, root) } : {}),
    ...(pattern ? { pattern } : {}),
    ...(command ? { command } : {}),
    raw: input,
  };
}

function firstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** Absolute paths inside the project read as noise; show them relative. */
function relativise(path: string, root: string): string {
  if (!root) return path;
  const normalisedRoot = root.replace(/[\\/]+$/, "");
  if (path.startsWith(normalisedRoot)) {
    return (
      path
        .slice(normalisedRoot.length)
        .replace(/^[\\/]+/, "")
        .replace(/\\/g, "/") || "."
    );
  }
  return path;
}

export const chunk = {
  textStart: (id: string): UIMessageChunk => ({ type: "text-start", id }),
  textDelta: (id: string, delta: string): UIMessageChunk => ({ type: "text-delta", id, delta }),
  textEnd: (id: string): UIMessageChunk => ({ type: "text-end", id }),

  reasoningStart: (id: string): UIMessageChunk => ({ type: "reasoning-start", id }),
  reasoningDelta: (id: string, delta: string): UIMessageChunk => ({
    type: "reasoning-delta",
    id,
    delta,
  }),
  reasoningEnd: (id: string): UIMessageChunk => ({ type: "reasoning-end", id }),

  // No `dynamic` flag anywhere below — see rule 1 in the header.
  toolStart: (toolCallId: string, name: string): UIMessageChunk => ({
    type: "tool-input-start",
    toolCallId,
    toolName: name,
  }),
  toolInput: (toolCallId: string, name: string, input: unknown): UIMessageChunk => ({
    type: "tool-input-available",
    toolCallId,
    toolName: name,
    input,
  }),
  toolOutput: (toolCallId: string, output: unknown): UIMessageChunk => ({
    type: "tool-output-available",
    toolCallId,
    output,
  }),
  toolFailed: (toolCallId: string, errorText: string): UIMessageChunk => ({
    type: "tool-output-error",
    toolCallId,
    errorText,
  }),

  error: (errorText: string): UIMessageChunk => ({ type: "error", errorText }),
};

/**
 * Tracks which ids are open so a stream can be closed cleanly even when the
 * engine stops mid-sentence — an aborted run still has to persist as a
 * well-formed message.
 */
export class OpenParts {
  private readonly text = new Set<string>();
  private readonly reasoning = new Set<string>();
  private readonly tools = new Set<string>();

  openText(id: string): boolean {
    if (this.text.has(id)) return false;
    this.text.add(id);
    return true;
  }

  openReasoning(id: string): boolean {
    if (this.reasoning.has(id)) return false;
    this.reasoning.add(id);
    return true;
  }

  /** True the first time a call id is seen, so rule 2 can be satisfied once. */
  openTool(id: string): boolean {
    if (this.tools.has(id)) return false;
    this.tools.add(id);
    return true;
  }

  hasTool(id: string): boolean {
    return this.tools.has(id);
  }

  /** Close everything still open, in the order the SDK expects. */
  closeAll(): UIMessageChunk[] {
    const out: UIMessageChunk[] = [];
    for (const id of this.text) out.push(chunk.textEnd(id));
    for (const id of this.reasoning) out.push(chunk.reasoningEnd(id));
    this.text.clear();
    this.reasoning.clear();
    return out;
  }
}

/**
 * OpenCode sends the *whole* text of a part on every update, not a delta.
 *
 * Emitting that verbatim would repeat the entire message on every tick, so
 * this keeps the length already sent per part id and yields only the suffix.
 * It is the single easiest thing to get wrong in the OpenCode adapter, which
 * is why it lives here with a test rather than inline.
 */
export class Cumulative {
  private readonly sent = new Map<string, number>();

  suffix(id: string, full: string): string {
    const already = this.sent.get(id) ?? 0;
    if (full.length <= already) return "";
    this.sent.set(id, full.length);
    return full.slice(already);
  }
}
