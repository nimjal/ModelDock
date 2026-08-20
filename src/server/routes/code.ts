/**
 * One turn of an agentic coding session.
 *
 * Structurally the same as `/api/chat`: the person's message is persisted
 * before the engine is touched, the reply is streamed, and `onEnd` writes it
 * back with per-message attribution. What differs is who produces the reply —
 * an external coding agent rather than a model — and that the stream is fed by
 * an adapter writing normalised chunks rather than by `streamText`.
 *
 * The AI SDK's `createUIMessageStream` gives the identical `onEnd`
 * ({ responseMessage, isAborted }) that `toUIMessageStream` gives the chat
 * route, which is why a Code session lands in the same `messages.parts` column
 * and renders through the same `Message.tsx` with no schema change at all.
 *
 * One deliberate divergence: an aborted run is *persisted*, where chat throws
 * an aborted reply away. Chat has nothing to keep — no words were said. A
 * half-finished agent run has already edited files, so the record of what it
 * did has to survive the stop button.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";

import { historyFor, titleThreadIfNeeded, toUiMessages } from "../chat/turn.js";
import { builtinAdapter } from "../code/builtin.js";
import { AGENTS, AGENT_LIST } from "../code/catalog.js";
import { claudeCodeAdapter } from "../code/claude-code.js";
import { opencodeAdapter } from "../code/opencode.js";
import { agentsFresh, checkAgent, detectAgents } from "../code/registry.js";
import { isPermissionLevel, LEVELS, type PermissionLevel } from "../code/permissions.js";
import type { CodingAgentAdapter } from "../code/adapter.js";
import { AgentError } from "../code/adapter.js";
import { db } from "../db/index.js";
import {
  codingAgents,
  connections,
  messages,
  projects,
  threads,
  type CodingAgent,
  type Connection,
} from "../db/schema.js";
import { patch, patchWhere, put, stamp } from "../db/write.js";
import { HttpError } from "../errors.js";
import { projectRoot } from "../files/boundary.js";
import { loadSkillIndex, renderSkillIndex } from "../skills/scan.js";

export const codeRoutes = new Hono();

const ADAPTERS: Record<string, CodingAgentAdapter> = {
  opencode: opencodeAdapter,
  claude_code: claudeCodeAdapter,
  builtin: builtinAdapter,
};

/**
 * In-flight runs, so a shutdown can stop them.
 *
 * Drained by the CLI's signal handlers before the HTTP server closes —
 * otherwise Ctrl-C leaves an agent child running against someone's checkout.
 */
export const activeRuns = new Map<string, () => void>();

export function stopAllRuns(): void {
  for (const stop of activeRuns.values()) stop();
  activeRuns.clear();
}

/**
 * The assistant row this thread is waiting on a decision for.
 *
 * Newest first, and only one can be pending at a time — the loop stops when it
 * needs an answer, so there is nothing after it to have produced another.
 */
async function pendingApproval(threadId: string) {
  const rows = await db()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        eq(messages.role, "assistant"),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(5);

  return rows.find((row) => {
    const parts = (row.parts ?? []) as { state?: string }[];
    return parts.some(
      (part) => part.state === "approval-requested" || part.state === "approval-responded",
    );
  });
}

/** The connection a builtin agent runs on, for readiness and presentation. */
async function connectionFor(agent: CodingAgent): Promise<Connection | null> {
  if (!agent.connectionId) return null;
  const [row] = await db()
    .select()
    .from(connections)
    .where(and(eq(connections.id, agent.connectionId), isNull(connections.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** Never the token itself, only whether it is set. Mirrors connections.ts. */
function present(agent: CodingAgent, connection: Connection | null = null) {
  const status = checkAgent(agent, connection);
  const spec = AGENTS[agent.kind as keyof typeof AGENTS];

  return {
    id: agent.id,
    name: agent.name,
    kind: agent.kind,
    label: spec?.label ?? agent.kind,
    hint: spec?.hint ?? "",
    installHint: spec?.installHint ?? "",
    command: agent.command,
    version: agent.version,
    baseUrl: agent.baseUrl,
    authTokenEnv: agent.authTokenEnv,
    tokenSet: Boolean(agent.authTokenEnv && process.env[agent.authTokenEnv]),
    detected: agent.detected,
    connectionId: agent.connectionId,
    /**
     * The levels *this* agent can honour, so the composer offers "Ask each
     * time" only where it means something. Sent per row rather than per app
     * because it varies by agent.
     */
    levels: spec?.levels ?? ["read", "edit", "full"],
    ready: status.ok,
    problem: status.problem ?? null,
  };
}

/** Present a list, resolving the connections the builtin rows point at. */
async function presentAll(rows: CodingAgent[]) {
  const live = await db().select().from(connections).where(isNull(connections.deletedAt)).all();
  const byId = new Map(live.map((row) => [row.id, row]));

  return rows.map((agent) =>
    present(agent, agent.connectionId ? (byId.get(agent.connectionId) ?? null) : null),
  );
}

codeRoutes.get("/agents", async (c) => {
  const rows = await agentsFresh(db());
  return c.json({
    agents: await presentAll(rows),
    kinds: AGENT_LIST.map((spec) => ({
      kind: spec.kind,
      label: spec.label,
      hint: spec.hint,
      installHint: spec.installHint,
      supportsRemote: spec.discovery === "binary" && spec.supportsRemote,
      levels: spec.levels,
    })),
    levels: LEVELS,
  });
});

codeRoutes.post("/agents/detect", async (c) => {
  const rows = await detectAgents(db());
  return c.json({ agents: await presentAll(rows) });
});

codeRoutes.post("/agents", async (c) => {
  const body = await c.req.json<{
    name?: string;
    kind?: string;
    command?: string | null;
    args?: string[] | null;
    baseUrl?: string | null;
    authTokenEnv?: string | null;
  }>();

  const name = body.name?.trim();
  if (!name) throw new HttpError(400, "Give the agent a name.");
  if (!body.kind || !(body.kind in ADAPTERS)) {
    throw new HttpError(400, `Unknown agent kind ${body.kind ?? "(none)"}.`);
  }

  try {
    const row = put(db(), codingAgents, {
      name,
      kind: body.kind as CodingAgent["kind"],
      command: body.command?.trim() || null,
      args: body.args ?? null,
      baseUrl: body.baseUrl?.trim() || null,
      authTokenEnv: body.authTokenEnv?.trim() || null,
      detected: false,
    });

    return c.json({ agent: present(row) }, 201);
  } catch (error) {
    if ((error as Error).message.includes("UNIQUE")) {
      throw new HttpError(409, `An agent called "${name}" already exists.`);
    }
    throw error;
  }
});

codeRoutes.patch("/agents/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    command?: string | null;
    args?: string[] | null;
    baseUrl?: string | null;
    authTokenEnv?: string | null;
  }>();

  const changes: Record<string, unknown> = {};
  if (body.name !== undefined) changes.name = body.name.trim();
  if (body.command !== undefined) changes.command = body.command?.trim() || null;
  if (body.args !== undefined) changes.args = body.args;
  if (body.baseUrl !== undefined) changes.baseUrl = body.baseUrl?.trim() || null;
  if (body.authTokenEnv !== undefined) changes.authTokenEnv = body.authTokenEnv?.trim() || null;
  // A hand-edited row stops being managed by detection.
  if (body.command !== undefined || body.baseUrl !== undefined) changes.detected = false;

  const row = patch(db(), codingAgents, id, changes);
  if (!row) throw new HttpError(404, `No agent ${id}`);

  return c.json({ agent: present(row) });
});

codeRoutes.delete("/agents/:id", async (c) => {
  const id = c.req.param("id");
  const [row] = patchWhere(
    db(),
    codingAgents,
    and(eq(codingAgents.id, id), isNull(codingAgents.deletedAt))!,
    { deletedAt: stamp() },
  );

  if (!row) throw new HttpError(404, `No agent ${id}`);
  return c.json({ ok: true });
});

codeRoutes.post("/code", async (c) => {
  const body = await c.req.json<{
    threadId?: string;
    message?: UIMessage;
    permission?: string;
  }>();

  const threadId = body.threadId;
  const incoming = body.message;

  if (!threadId) throw new HttpError(400, "threadId is required");
  if (!incoming) throw new HttpError(400, "message is required");

  const database = db();

  const [thread] = await database
    .select()
    .from(threads)
    .where(and(eq(threads.id, threadId), isNull(threads.deletedAt)))
    .limit(1);
  if (!thread) throw new HttpError(404, `No thread ${threadId}`);

  /**
   * A resume, not a new turn.
   *
   * When someone answers an approval the client sends back the *assistant*
   * message with the decision merged into it, because that is where the SDK
   * keeps it. Inserting that as a user turn — which is what this route did
   * before it could be asked anything — would put the model's own words in the
   * transcript attributed to the person.
   *
   * The pending row is found by looking for the approval state rather than by
   * id: the stored row carries this store's ULID, not the id the SDK used
   * within one stream. `chat.ts` explains why that is the right way round.
   */
  const resuming = incoming.role === "assistant";

  if (resuming) {
    const pending = await pendingApproval(threadId);
    if (!pending) throw new HttpError(400, "Nothing here is waiting on an approval.");
    patch(database, messages, pending.id, { parts: incoming.parts as unknown[] });
  } else {
    // Persisted before the agent is touched, exactly as in chat: if the engine
    // is misconfigured, what the person typed is still there. The id is this
    // store's, for the reason given on the assistant row in `chat.ts`.
    put(database, messages, {
      threadId,
      role: "user",
      parts: incoming.parts as unknown[],
    });
  }

  // The thread moved when the message landed, not when the run finished.
  patch(database, threads, threadId, {});

  const agent = await agentFor(thread.agentId, thread.projectId);
  const connection = await connectionFor(agent);
  const status = checkAgent(agent, connection);
  if (!status.ok) throw new HttpError(400, status.problem!);

  const project = thread.projectId
    ? (
        await database
          .select({ name: projects.name, directory: projects.directory })
          .from(projects)
          .where(eq(projects.id, thread.projectId))
          .limit(1)
      )[0]
    : undefined;

  if (!project?.directory) {
    throw new HttpError(400, "A coding session needs a project with a directory set.");
  }

  let root: string;
  try {
    root = await projectRoot(project.directory);
  } catch {
    throw new HttpError(400, `Cannot reach ${project.directory}.`);
  }

  const permission: PermissionLevel = isPermissionLevel(body.permission)
    ? body.permission
    : isPermissionLevel(thread.permission)
      ? thread.permission
      : "read";

  // Which levels an agent honours is stated in the catalog and offered to the
  // composer per agent, so this should be unreachable from the UI. It is here
  // because "unreachable from the UI" is not the same as unreachable, and
  // silently downgrading to a neighbouring level would run something the person
  // asked to be consulted about.
  const spec = AGENTS[agent.kind as keyof typeof AGENTS];
  if (spec && !spec.levels.includes(permission)) {
    throw new HttpError(400, `${spec.label} cannot run at "${permission}".`);
  }

  // A resume carries a decision rather than an instruction, so there is
  // nothing for the person to have said.
  const prompt = textOf(incoming);
  if (!prompt && !resuming) throw new HttpError(400, "Say what you want done.");

  // Absolute paths: a coding agent reads files itself, so pointing at the
  // skills is a smaller integration than reimplementing its skill loader.
  const skillIndex = renderSkillIndex(await loadSkillIndex(database, thread.projectId), {
    withPaths: true,
  });

  const adapter = ADAPTERS[agent.kind];
  if (!adapter) throw new HttpError(400, `No adapter for ${agent.kind}.`);

  const controller = new AbortController();
  // The browser aborting the fetch is the Stop button; a process signal is
  // shutdown. Either one has to reach the agent.
  c.req.raw.signal.addEventListener("abort", () => controller.abort(), { once: true });
  activeRuns.set(threadId, () => controller.abort());

  let result = { sessionId: thread.agentSessionId, model: null as string | null };

  // The transcript as it stands, including whatever was just written above.
  const history = toUiMessages(await historyFor(threadId));

  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      /**
       * On a resume this puts the stream in persistence mode, so the reply
       * *continues* the pending assistant message instead of starting an empty
       * one. Without it the tool output arrives for a call the new stream has
       * never heard of, and the SDK rejects it — the same ordering rule
       * `normalize.ts` documents for the external adapters.
       */
      ...(resuming ? { originalMessages: history } : {}),

      execute: async ({ writer }) => {
        try {
          result = await adapter.run(
            {
              agent,
              root,
              prompt,
              // The user message was inserted above, so this history already
              // ends with it — exactly as chat's does.
              history,
              connection,
              projectId: thread.projectId,
              projectName: project.name ?? null,
              sessionId: thread.agentSessionId,
              permission,
              skillIndex,
              signal: controller.signal,
            },
            writer,
          );
        } catch (error) {
          if (error instanceof AgentError) {
            writer.write({ type: "error", errorText: error.message });
            return;
          }
          throw error;
        }
      },

      // The repo surfaces real messages rather than a generic string; a local
      // tool that hides its own errors is not worth running.
      onError: (error) => (error as Error).message,

      onEnd: async ({ responseMessage, isAborted }) => {
        activeRuns.delete(threadId);

        const parts = [...(responseMessage.parts as unknown[])];

        // `isAborted` only covers the SDK's own cancellation; a browser that
        // simply disconnects trips our controller instead. Checking both is
        // what makes the Stop button honest about what happened.
        const stopped = isAborted || controller.signal.aborted;

        // Unlike chat, an aborted run is kept — files may already have changed,
        // so the record of how far it got has to survive the stop.
        if (stopped) parts.push({ type: "text", text: "Stopped." });
        if (parts.length === 0) return;

        // A built-in run is attributed to whoever actually answered — the
        // connection's kind — not to "builtin", which names the plumbing
        // rather than the model. That is the same rule chat follows, and it
        // is what keeps a mixed transcript honest about who said what.
        const provider = connection ? connection.kind : agent.kind;

        // A resume finished the message it was continuing, so it updates that
        // row rather than adding a second one. One decision does not turn one
        // reply into two.
        const pending = resuming ? await pendingApproval(threadId) : undefined;

        if (pending) {
          patch(database, messages, pending.id, { parts, provider, model: result.model });
        } else {
          put(database, messages, {
            threadId,
            role: "assistant",
            parts,
            provider,
            model: result.model,
          });
        }

        patch(database, threads, threadId, {
          agentId: agent.id,
          agentSessionId: result.sessionId,
          permission,
        });

        await titleThreadIfNeeded(threadId);
      },
    }),
  });
});

/**
 * The thread's agent, then the project's default, then whatever is ready.
 *
 * The last step changed meaning when the built-in engine arrived, so it is
 * worth stating rather than discovering: an external agent is "ready" only if
 * its binary is installed, but the built-in one is ready whenever any
 * connection works. It is therefore usually what a thread falls back to — which
 * is the right answer (a coding session that can run beats one that cannot) but
 * it is a decision, not an accident.
 */
async function agentFor(agentId: string | null, projectId: string | null): Promise<CodingAgent> {
  const database = db();
  const candidates: (string | null)[] = [agentId];

  if (projectId) {
    const [project] = await database
      .select({ defaultAgentId: projects.defaultAgentId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    candidates.push(project?.defaultAgentId ?? null);
  }

  for (const id of candidates) {
    if (!id) continue;
    const [row] = await database
      .select()
      .from(codingAgents)
      .where(and(eq(codingAgents.id, id), isNull(codingAgents.deletedAt)))
      .limit(1);
    if (row) return row;
  }

  const rows = await agentsFresh(database);

  // Resolved per row, because a builtin agent's readiness *is* its connection's
  // — checking it without one would report every builtin agent as broken and
  // quietly rule out the only engine that needs nothing installed.
  let ready: CodingAgent | undefined;
  for (const row of rows) {
    if (checkAgent(row, await connectionFor(row)).ok) {
      ready = row;
      break;
    }
  }

  if (!ready) {
    throw new HttpError(
      400,
      "No coding engine is ready. Set up a connection to use the built-in one, " +
        "or install OpenCode or Claude Code. Then run: modeldock doctor",
    );
  }
  return ready;
}

function textOf(message: UIMessage): string {
  return (message.parts as { type?: string; text?: string }[])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("\n")
    .trim();
}
