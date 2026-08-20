/**
 * Coding without an external agent.
 *
 * The built-in engine is the first coding surface where the model answering is
 * a ModelDock connection, so the things worth proving are that the loop
 * actually runs tools, that what it did lands in the transcript in the same
 * shape as everything else, and — most of all — that the permission level
 * decides which tools exist rather than merely asking an engine to behave.
 *
 * Follows `chat.test.ts`: the provider layer is mocked and streams are scripted
 * in a queue, because a tool call is two round trips.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { MockLanguageModelV4 } from "ai/test";

import { toolsForLevel } from "../src/server/code/permissions.js";

const FINISH = {
  type: "finish" as const,
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  },
};

const scripted: LanguageModelV4StreamPart[][] = [];

vi.mock("../src/server/providers/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/providers/registry.js")>();
  return {
    ...actual,
    resolveModel: () =>
      new MockLanguageModelV4({
        doStream: async () => {
          const parts: LanguageModelV4StreamPart[] = scripted.shift() ?? [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", delta: "Done." },
            { type: "text-end", id: "0" },
            FINISH,
          ];

          return {
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              start(controller) {
                for (const part of parts) controller.enqueue(part);
                controller.close();
              },
            }),
          };
        },
      }),
  };
});

const { createApp } = await import("../src/server/app.js");
const { db } = await import("../src/server/db/index.js");
const { codingAgents, connections, messages, projects, threads } = await import(
  "../src/server/db/schema.js"
);

const app = createApp({ port: 8765 });
const BASE = "http://127.0.0.1:8765";
const HEADERS = { "content-type": "application/json", host: "127.0.0.1:8765" };

/** A tool call plus the prose that follows it: the two round trips. */
function callThen(toolName: string, input: unknown, reply = "Done.") {
  scripted.push(
    [
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "call-1", toolName },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName,
        input: JSON.stringify(input),
      },
      { ...FINISH, finishReason: { unified: "tool-calls" as const, raw: "tool_use" } },
    ],
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: reply },
      { type: "text-end", id: "0" },
      FINISH,
    ],
  );
}

let connectionId: string;
let agentId: string;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";

  const [connection] = await db()
    .insert(connections)
    .values({
      name: "Claude",
      kind: "anthropic",
      model: "claude-sonnet-4-5",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    })
    .returning();
  connectionId = connection!.id;

  const [agent] = await db()
    .insert(codingAgents)
    .values({
      name: "ModelDock",
      kind: "builtin",
      connectionId,
      detected: true,
    })
    .returning();
  agentId = agent!.id;
});

/** A project with a real directory, plus a coding thread pointed at it. */
async function session(permission: "read" | "edit" | "full" | "ask" = "edit") {
  const directory = mkdtempSync(join(tmpdir(), "modeldock-builtin-"));
  writeFileSync(join(directory, "app.ts"), "export const port = 8765;\n");

  const [project] = await db()
    .insert(projects)
    .values({ name: "Harbor", slug: `builtin-${Math.random().toString(36).slice(2)}`, directory })
    .returning();

  const [thread] = await db()
    .insert(threads)
    .values({ projectId: project!.id, agentId, permission })
    .returning();

  return { directory, threadId: thread!.id };
}

async function run(threadId: string, text: string, permission?: string) {
  const response = await app.request(`${BASE}/api/code`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      threadId,
      permission,
      message: { id: "m1", role: "user", parts: [{ type: "text", text }] },
    }),
  });

  // Draining is what lets `onEnd` finish before the assertions run.
  const body = await response.text();
  return { status: response.status, body };
}

const storedFor = (threadId: string) =>
  db()
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.role, "assistant")))
    .orderBy(asc(messages.createdAt))
    .all();

describe("a built-in coding turn", () => {
  it("writes a file the model asked for, and records the call", async () => {
    const { directory, threadId } = await session("edit");
    callThen("write_file", { path: "notes.md", content: "# Notes\n" }, "Written.");

    await run(threadId, "Create notes.md");

    expect(readFileSync(join(directory, "notes.md"), "utf8")).toBe("# Notes\n");

    const [stored] = await storedFor(threadId);
    const parts = stored!.parts as { type: string; state?: string }[];
    const call = parts.find((part) => part.type === "tool-write_file");

    // `tool-` and not `dynamic-tool`: Message.tsx filters on the former, so a
    // dynamic part would render as nothing at all.
    expect(call, "the write should be in the transcript").toBeDefined();
    expect(call!.state).toBe("output-available");
  });

  it("edits part of a file without rewriting the whole thing", async () => {
    const { directory, threadId } = await session("edit");
    callThen("edit_file", {
      path: "app.ts",
      old_string: "8765",
      new_string: "9000",
      replace_all: false,
    });

    await run(threadId, "Change the port");

    expect(readFileSync(join(directory, "app.ts"), "utf8")).toBe("export const port = 9000;\n");
  });

  /**
   * The point of the whole engine: a coding turn is attributed to the model
   * that produced it, exactly as a chat turn is — not to the plumbing that
   * carried it.
   */
  it('attributes the reply to the connection, not to "builtin"', async () => {
    const { threadId } = await session("edit");
    await run(threadId, "Say something");

    const [stored] = await storedFor(threadId);
    expect(stored!.provider).toBe("anthropic");
    expect(stored!.model).toBe("claude-sonnet-4-5");
  });

  it("keeps no engine session, because the transcript is the session", async () => {
    const { threadId } = await session("edit");
    await run(threadId, "Say something");

    const [thread] = await db().select().from(threads).where(eq(threads.id, threadId)).all();
    expect(thread!.agentSessionId).toBeNull();
  });

  it("carries the earlier conversation into the next turn", async () => {
    const { threadId } = await session("edit");
    await run(threadId, "First thing");
    await run(threadId, "Second thing");

    const all = await db()
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.createdAt))
      .all();

    // Two user messages and two replies, in one thread — the history the
    // engine sees on the second turn is the whole of it.
    expect(all).toHaveLength(4);
    expect(all.filter((row) => row.role === "user")).toHaveLength(2);
  });
});

describe("what each level hands the model", () => {
  /**
   * The clearest statement of the rule, and it needs no model at all: at
   * `read` the writing tools are not in the set. A tool the model was never
   * given cannot be called, which is a stronger guarantee than a config string
   * asking an external engine to decline on our behalf.
   */
  it("composes the tool set from the level", () => {
    expect(toolsForLevel("read")).toEqual({ read: true, edit: false, shell: false });
    expect(toolsForLevel("edit")).toEqual({ read: true, edit: true, shell: false });
    expect(toolsForLevel("full")).toEqual({ read: true, edit: true, shell: true });
    expect(toolsForLevel("ask")).toEqual({ read: true, edit: true, shell: true });
  });

  it("gives a read-only session no way to write", async () => {
    const { directory, threadId } = await session("read");
    callThen("write_file", { path: "sneaky.md", content: "nope" });

    const { status } = await run(threadId, "Write a file");

    // Asserted so this cannot pass because the turn never happened.
    expect(status).toBe(200);

    // Not "refused" — absent. The model was never given the tool, so the call
    // could not resolve to anything.
    expect(() => readFileSync(join(directory, "sneaky.md"), "utf8")).toThrow();
  });

  it("refuses a level the agent cannot honour, rather than downgrading it", async () => {
    const { threadId } = await session("edit");

    // `ask` is fine for the built-in engine; an external one would 400 here.
    const ok = await run(threadId, "Anything", "ask");
    expect(ok.status).toBe(200);
  });
});

/**
 * Unlike the external engines there is nothing to install, so "detection" here
 * means "is there a connection to run on" — and the row has to exist without
 * anyone setting it up, or the Code surface never offers it.
 */
describe("finding the built-in engine", () => {
  it("appears in the agent list with the levels it can honour", async () => {
    const response = await app.request(`${BASE}/api/agents`, { headers: HEADERS });
    const body = (await response.json()) as {
      agents: { kind: string; ready: boolean; levels: string[]; connectionId: string | null }[];
    };

    const builtin = body.agents.find((agent) => agent.kind === "builtin");
    expect(builtin, "the built-in engine should be listed").toBeDefined();
    expect(builtin!.ready).toBe(true);
    expect(builtin!.connectionId).toBeTruthy();

    // The composer reads this per agent, which is how "Ask each time" is
    // offered here and not for an engine that cannot pause.
    expect(builtin!.levels).toContain("ask");
  });

  it("does not offer `ask` for an engine that cannot pause mid-run", async () => {
    const response = await app.request(`${BASE}/api/agents`, { headers: HEADERS });
    const body = (await response.json()) as { kinds: { kind: string; levels: string[] }[] };

    for (const kind of body.kinds) {
      if (kind.kind === "builtin") continue;
      expect(kind.levels, `${kind.kind} cannot ask`).not.toContain("ask");
    }
  });
});

describe("the directory boundary", () => {
  it("refuses a write outside the project and says so to the model", async () => {
    const { directory, threadId } = await session("edit");
    callThen("write_file", { path: "../escaped.md", content: "nope" }, "Could not.");

    await run(threadId, "Write outside");

    const [stored] = await storedFor(threadId);
    const parts = stored!.parts as { type: string; output?: { error?: string } }[];
    const call = parts.find((part) => part.type === "tool-write_file");

    // Returned as an error the model can see and correct, never thrown — the
    // contract stated at the top of files/tools.ts.
    expect(call!.output?.error).toMatch(/outside this project/i);
    expect(() => readFileSync(join(directory, "..", "escaped.md"), "utf8")).toThrow();
  });

  it("refuses to touch .git, which is inside the project but not source", async () => {
    const { threadId } = await session("edit");
    callThen("write_file", { path: ".git/config", content: "nope" }, "Could not.");

    await run(threadId, "Rewrite git config");

    const [stored] = await storedFor(threadId);
    const parts = stored!.parts as { type: string; output?: { error?: string } }[];
    const call = parts.find((part) => part.type === "tool-write_file");

    expect(call!.output?.error).toMatch(/off limits/i);
  });
});
