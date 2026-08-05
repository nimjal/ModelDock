/**
 * Asking before a tool runs.
 *
 * The claim being tested is narrow and worth stating exactly: at `ask`, a call
 * that changes something does not happen until a person says so, and the
 * pending decision is a *row* rather than a promise held open in memory — which
 * is what lets it survive a reload.
 *
 * The resume path is the subtle part. The client sends back the assistant
 * message with the decision merged in, so `/api/code` has to recognise an
 * assistant message as a continuation rather than storing the model's words as
 * something the person said.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { MockLanguageModelV4 } from "ai/test";

import { approvalFor } from "../src/server/code/approval.js";

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

  const [agent] = await db()
    .insert(codingAgents)
    .values({ name: "ModelDock", kind: "builtin", connectionId: connection!.id, detected: true })
    .returning();

  agentId = agent!.id;
});

async function session() {
  const directory = mkdtempSync(join(tmpdir(), "modeldock-approval-"));
  writeFileSync(join(directory, "app.ts"), "export const port = 8765;\n");

  const [project] = await db()
    .insert(projects)
    .values({
      name: "Harbor",
      slug: `approval-${Math.random().toString(36).slice(2)}`,
      directory,
    })
    .returning();

  const [thread] = await db()
    .insert(threads)
    .values({ projectId: project!.id, agentId, permission: "ask" })
    .returning();

  return { directory, threadId: thread!.id };
}

const post = async (threadId: string, message: unknown) => {
  const response = await app.request(`${BASE}/api/code`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ threadId, message }),
  });
  const body = await response.text();
  return { status: response.status, body };
};

const say = (threadId: string, text: string) =>
  post(threadId, { id: "m1", role: "user", parts: [{ type: "text", text }] });

const rowsFor = (threadId: string) =>
  db()
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt))
    .all();

/** Queue a tool call that wants approval, then the prose that follows it. */
function wantsToWrite(path: string, content = "made") {
  scripted.push([
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "call-1", toolName: "write_file" },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "write_file",
      input: JSON.stringify({ path, content }),
    },
    { ...FINISH, finishReason: { unified: "tool-calls" as const, raw: "tool_use" } },
  ]);
}

interface ToolPart {
  type: string;
  state?: string;
  input?: unknown;
  approval?: { id: string; approved?: boolean; signature?: string };
}

/** The stored assistant message, as the browser would have it. */
async function pending(threadId: string) {
  const rows = await rowsFor(threadId);
  const assistant = rows.filter((row) => row.role === "assistant").at(-1)!;
  const parts = assistant.parts as ToolPart[];
  const part = parts.find((p) => p.state === "approval-requested");
  return { assistant, parts, part };
}

/**
 * What `addToolApprovalResponse` produces on the client: the same message, with
 * the pending part answered. The signature travels back untouched — it is what
 * binds the decision to the call it was given for.
 */
function answer(parts: ToolPart[], approved: boolean, tamper?: unknown) {
  return parts.map((part) =>
    part.state === "approval-requested"
      ? {
          ...part,
          state: "approval-responded",
          ...(tamper === undefined ? {} : { input: tamper }),
          approval: { ...part.approval, approved },
        }
      : part,
  );
}

describe("the policy", () => {
  it("asks only at `ask`, and only about what changes something", () => {
    expect(approvalFor("read")).toEqual({});
    expect(approvalFor("edit")).toEqual({});
    expect(approvalFor("full")).toEqual({});

    const asked = approvalFor("ask");
    expect(Object.keys(asked).sort()).toEqual(["edit_file", "run_command", "write_file"]);

    // Reading is deliberately absent: a prompt on every read is one people
    // learn to dismiss without reading it.
    expect(asked).not.toHaveProperty("read_file");
  });
});

describe("a call that needs a decision", () => {
  it("stops and asks, without doing the thing", async () => {
    const { directory, threadId } = await session();
    wantsToWrite("notes.md");

    const { status, body } = await say(threadId, "Write notes.md");

    expect(status).toBe(200);
    expect(body).toContain("tool-approval-request");

    // The whole point.
    expect(existsSync(join(directory, "notes.md"))).toBe(false);

    const { part } = await pending(threadId);
    expect(part, "the pending call should be persisted").toBeDefined();
    expect(part!.approval?.id).toBeTruthy();
  });

  it("runs it once approved, and does not duplicate the person's message", async () => {
    const { directory, threadId } = await session();
    wantsToWrite("notes.md", "# Notes\n");
    await say(threadId, "Write notes.md");

    const before = (await rowsFor(threadId)).filter((row) => row.role === "user").length;
    const { parts } = await pending(threadId);

    // The continuation: the tool runs, then the model says something.
    scripted.push([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "Written." },
      { type: "text-end", id: "0" },
      FINISH,
    ]);

    const { status } = await post(threadId, {
      id: "resume",
      role: "assistant",
      parts: answer(parts, true),
    });

    expect(status).toBe(200);
    expect(existsSync(join(directory, "notes.md"))).toBe(true);

    // A resume is not a new turn: the assistant message coming back must not
    // be stored as something the person said.
    const after = (await rowsFor(threadId)).filter((row) => row.role === "user");
    expect(after).toHaveLength(before);
  });

  it("does not run it when denied", async () => {
    const { directory, threadId } = await session();
    wantsToWrite("denied.md");
    await say(threadId, "Write denied.md");

    const { parts } = await pending(threadId);

    scripted.push([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "Left it alone." },
      { type: "text-end", id: "0" },
      FINISH,
    ]);

    await post(threadId, { id: "resume", role: "assistant", parts: answer(parts, false) });

    expect(existsSync(join(directory, "denied.md"))).toBe(false);
  });

  it("refuses a resume when nothing is waiting", async () => {
    const { threadId } = await session();

    const { status } = await post(threadId, {
      id: "resume",
      role: "assistant",
      parts: [{ type: "text", text: "nothing pending" }],
    });

    expect(status).toBe(400);
  });
});

/**
 * The reason the signing key exists.
 *
 * Without it, a page that got past the Origin check could send back approval
 * for an input the model never proposed — approving one command and running a
 * different one. The signature binds the decision to the exact call.
 */
describe("a forged approval", () => {
  it("does not run a call whose input was changed after the fact", async () => {
    const { directory, threadId } = await session();
    wantsToWrite("honest.md", "fine");
    await say(threadId, "Write honest.md");

    const { parts } = await pending(threadId);

    scripted.push([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "Done." },
      { type: "text-end", id: "0" },
      FINISH,
    ]);

    // Approved the write of `honest.md`; tries to get `forged.md` instead.
    const { status } = await post(threadId, {
      id: "resume",
      role: "assistant",
      parts: answer(parts, true, { path: "forged.md", content: "owned" }),
    });

    // Asserted so this cannot pass merely because the request was rejected
    // before the approval was ever considered — the identical flow without
    // tampering does write its file, one test above.
    expect(status).toBe(200);

    expect(existsSync(join(directory, "forged.md"))).toBe(false);
    expect(existsSync(join(directory, "honest.md"))).toBe(false);
  });
});
