/**
 * Driving OpenCode.
 *
 * `@opencode-ai/sdk` (MIT) gives a typed client and an SSE event stream, so
 * this is an API integration rather than stdout scraping — but it is worth
 * being precise about what it is not. `createOpencodeServer` spawns the
 * `opencode` binary and reads its listening URL; there is no in-process mode,
 * because OpenCode ships as a compiled Bun executable. ModelDock owns that
 * process's lifecycle: one server per ModelDock process, shut down on exit.
 *
 * The event translation lives in `normalize.ts` and is unit-tested there. The
 * detail most likely to be got wrong is that OpenCode sends the *whole* text
 * of a part on every update rather than a delta, which is what `Cumulative`
 * exists for — emitting those verbatim repeats the entire message on every
 * tick.
 */

import type { UIMessageStreamWriter } from "ai";

import { AgentError, type CodingAgentAdapter, type RunContext, type RunResult } from "./adapter.js";
import { chunk, Cumulative, OpenParts, toolInput, toolName } from "./normalize.js";
import { permissionForOpenCode, type ExternalLevel } from "./permissions.js";

/**
 * What a running server was configured with.
 *
 * OpenCode takes its permission block and its instructions when the server is
 * created and never re-reads them, so a server started for one level is not
 * interchangeable with one started for another. Caching a single server without
 * looking at this was a real hazard in the dangerous direction: a run at "Edit
 * and run" followed by a run at "Read only" reused the first server, and the
 * second run silently kept the shell.
 *
 * Pure, so the reuse rule can be tested without spawning anything — the same
 * shape as `permissions.ts`, and for the same reason.
 */
export function serverKeyFor(level: ExternalLevel, instructions: string | null): string {
  return JSON.stringify({
    permission: permissionForOpenCode(level),
    instructions: instructions ?? null,
  });
}

interface Running {
  url: string;
  close: () => void;
  key: string;
}

/** One server for this ModelDock process; spawning per turn costs a second. */
let server: Running | null = null;
let starting: { key: string; promise: Promise<Running> } | null = null;

async function ensureServer(command: string, level: ExternalLevel, instructions: string | null) {
  const key = serverKeyFor(level, instructions);

  if (server?.key === key) return server;
  if (starting?.key === key) return starting.promise;

  // Configured for something else. Stop it rather than reuse it.
  stopOpencodeServer();

  const promise = (async () => {
    const { createOpencodeServer } = await import("@opencode-ai/sdk");
    const started = await createOpencodeServer({
      hostname: "127.0.0.1",
      port: 0,
      config: {
        permission: permissionForOpenCode(level),
        ...(instructions ? { instructions: [instructions] } : {}),
      },
    } as Parameters<typeof createOpencodeServer>[0]);

    server = { ...(started as { url: string; close: () => void }), key };
    return server;
  })();

  starting = { key, promise };

  try {
    return await promise;
  } catch (error) {
    throw new AgentError(`Could not start OpenCode (${command}): ${(error as Error).message}`);
  } finally {
    if (starting?.promise === promise) starting = null;
  }
}

/** Called from the CLI's signal handlers so Ctrl-C does not orphan a server. */
export function stopOpencodeServer(): void {
  try {
    server?.close();
  } catch {
    /* shutting down anyway */
  }
  server = null;
}

export const opencodeAdapter: CodingAgentAdapter = {
  kind: "opencode",

  async run(context: RunContext, writer: UIMessageStreamWriter): Promise<RunResult> {
    const { agent, root, prompt, permission, sessionId, skillIndex, signal } = context;

    // The route refuses `ask` for an external engine before it gets here; this
    // is the second lock. See the note in `claude-code.ts`.
    if (permission === "ask") {
      throw new AgentError("OpenCode cannot ask before each call. Pick another level.");
    }

    const { createOpencodeClient } = await import("@opencode-ai/sdk");

    // A row with a base URL attaches to a server someone else is running;
    // otherwise ModelDock starts one.
    let baseUrl = agent.baseUrl?.trim() || null;
    if (!baseUrl) {
      if (!agent.command) throw new AgentError("OpenCode is not installed on this machine.");
      baseUrl = (await ensureServer(agent.command, permission, skillIndex)).url;
    }

    const token = agent.authTokenEnv ? process.env[agent.authTokenEnv] : undefined;

    const client = createOpencodeClient({
      baseUrl,
      directory: root,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    } as Parameters<typeof createOpencodeClient>[0]);

    const session = sessionId ? { id: sessionId } : await create(client, root);

    const open = new OpenParts();
    const cumulative = new Cumulative();
    let model: string | null = null;

    const events = await client.event.subscribe({ signal });

    const prompting = client.session
      .prompt({
        sessionID: session.id,
        directory: root,
        parts: [{ type: "text", text: skillIndex ? `${skillIndex}\n\n${prompt}` : prompt }],
      } as never)
      .catch((error: Error) => {
        writer.write(chunk.error(error.message));
      });

    const abort = () => {
      void client.session
        .abort({ sessionID: session.id, directory: root } as never)
        .catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });

    try {
      for await (const event of events.stream as AsyncIterable<OpencodeEvent>) {
        // The event stream is server-wide, so anything from another session
        // has to be dropped or two concurrent runs would interleave.
        const properties = event.properties ?? {};
        const belongs =
          properties.sessionID === session.id || properties.info?.sessionID === session.id;
        if (!belongs) continue;

        if (event.type === "message.part.updated") {
          const part = properties.part;
          if (!part) continue;
          model = part.model ?? model;
          emitPart(part, writer, open, cumulative, root);
          continue;
        }

        if (event.type === "session.error") {
          writer.write(chunk.error(String(properties.error ?? "OpenCode reported an error.")));
          break;
        }

        if (event.type === "message.updated" && properties.info?.time?.completed) break;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      for (const part of open.closeAll()) writer.write(part);
      await prompting;
    }

    return { sessionId: session.id, model };
  },
};

async function create(client: OpencodeClient, root: string): Promise<{ id: string }> {
  const created = (await client.session.create({ directory: root } as never)) as unknown as {
    id?: string;
    data?: { id?: string };
  };
  const id = created.id ?? created.data?.id;
  if (!id) throw new AgentError("OpenCode did not return a session.");
  return { id };
}

function emitPart(
  part: OpencodePart,
  writer: UIMessageStreamWriter,
  open: OpenParts,
  cumulative: Cumulative,
  root: string,
): void {
  const id = String(part.id ?? "0");

  if (part.type === "text") {
    if (open.openText(id)) writer.write(chunk.textStart(id));
    const delta = cumulative.suffix(id, part.text ?? "");
    if (delta) writer.write(chunk.textDelta(id, delta));
    return;
  }

  if (part.type === "reasoning") {
    if (open.openReasoning(id)) writer.write(chunk.reasoningStart(id));
    const delta = cumulative.suffix(id, part.text ?? "");
    if (delta) writer.write(chunk.reasoningDelta(id, delta));
    return;
  }

  if (part.type !== "tool") return;

  const callId = String(part.callID ?? part.id ?? "0");
  const name = toolName(String(part.tool ?? "tool"));
  const state = part.state ?? {};

  // Rule 2 in normalize.ts: the part must exist before any result arrives.
  if (open.openTool(callId)) writer.write(chunk.toolStart(callId, name));

  switch (state.status) {
    case "running":
      writer.write(chunk.toolInput(callId, name, toolInput(state.input, root)));
      break;
    case "completed":
      writer.write(chunk.toolOutput(callId, state.output ?? state.metadata ?? ""));
      break;
    case "error":
      writer.write(chunk.toolFailed(callId, String(state.error ?? "Tool failed.")));
      break;
    default:
      break;
  }
}

/**
 * Structural types for the events actually read above.
 *
 * Hand-written rather than imported: the SDK's generated event union is very
 * wide, and naming only the handful of fields this adapter touches keeps the
 * translation honest about its own assumptions.
 */
interface OpencodePart {
  id?: string;
  type?: string;
  text?: string;
  model?: string;
  callID?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    metadata?: unknown;
    error?: unknown;
  };
}

interface OpencodeEvent {
  type?: string;
  properties?: {
    sessionID?: string;
    part?: OpencodePart;
    error?: unknown;
    info?: { sessionID?: string; time?: { completed?: number } };
  };
}

type OpencodeClient = {
  session: {
    create: (input: never) => Promise<unknown>;
    prompt: (input: never) => Promise<unknown>;
    abort: (input: never) => Promise<unknown>;
  };
  event: { subscribe: (options?: { signal?: AbortSignal }) => Promise<{ stream: unknown }> };
};
