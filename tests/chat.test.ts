/**
 * The behaviour this whole rewrite exists for.
 *
 * A conversation is ModelDock's, not the provider's. Start a thread on one
 * engine, switch to another mid-conversation, and the history must be intact
 * with each message still attributed to whoever produced it. If this test
 * ever fails, the product's central claim is false.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { MockLanguageModelV4 } from "ai/test";

/**
 * Swap the real provider layer for a mock, so these tests exercise routing,
 * persistence and attribution without a network call or an API key.
 * `resolveModel` itself is covered directly in providers.test.ts.
 */
const resolved: string[] = [];

/** Boilerplate every scripted stream ends with. */
const FINISH = {
  type: "finish" as const,
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  },
};

/**
 * Streams to hand back on the next `doStream` calls, newest test wins.
 *
 * Most tests want the default "reply with some text" behaviour, but a tool
 * call takes two round trips — one to request it, one to answer once the
 * result comes back — so a test that needs one queues both here.
 */
const scripted: LanguageModelV4StreamPart[][] = [];

vi.mock("../src/server/providers/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/providers/registry.js")>();
  return {
    ...actual,
    resolveModel: (connection: { name: string; kind: string }) => {
      resolved.push(connection.name);
      return new MockLanguageModelV4({
        doStream: async () => {
          const parts: LanguageModelV4StreamPart[] = scripted.shift() ?? [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", delta: `Reply from ${connection.name}.` },
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
      });
    },
  };
});

const { createApp } = await import("../src/server/app.js");
const { db } = await import("../src/server/db/index.js");
const { connections, messages, projects, threads } = await import("../src/server/db/schema.js");

const app = createApp({ port: 8765 });
const BASE = "http://127.0.0.1:8765";

/**
 * `app.request` builds a Request object directly, with no wire to carry a
 * Host header — so tests have to send the one a browser would. The server
 * requires it, and that check is what the api.test.ts host cases cover.
 */
const HEADERS = { "content-type": "application/json", host: "127.0.0.1:8765" };

const send = (path: string, init: RequestInit = {}) =>
  app.request(`${BASE}${path}`, { ...init, headers: { ...HEADERS, ...init.headers } });

/** Drive one turn and wait for the stream to finish, which is when we persist. */
async function turn(threadId: string, text: string): Promise<void> {
  const response = await send("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      threadId,
      message: {
        id: `user-${Math.random().toString(36).slice(2)}`,
        role: "user",
        parts: [{ type: "text", text }],
      },
    }),
  });

  expect(response.status).toBe(200);
  await response.text();
}

let claude: string;
let local: string;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";

  const [a] = await db()
    .insert(connections)
    .values({
      name: "Claude",
      kind: "anthropic",
      model: "claude-sonnet-4-5",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    })
    .returning();
  const [b] = await db()
    .insert(connections)
    .values({
      name: "Local",
      kind: "ollama",
      model: "llama3.2",
      baseUrl: "http://localhost:11434/v1",
    })
    .returning();

  claude = a!.id;
  local = b!.id;
});

describe("a thread outlives the provider that started it", () => {
  it("keeps every message and attributes each to who produced it", async () => {
    const [thread] = await db().insert(threads).values({ connectionId: claude }).returning();
    const id = thread!.id;

    await turn(id, "First question, on Claude.");
    await turn(id, "Second question, still on Claude.");

    // The swap. One column, and deliberately nothing else.
    await send(`/api/threads/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ connectionId: local, model: null }),
    });

    await turn(id, "Third question, now on a local model.");

    const rows = await db()
      .select()
      .from(messages)
      .where(eq(messages.threadId, id))
      .orderBy(asc(messages.createdAt))
      .all();

    // Three exchanges survived the swap intact.
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.role === "user")).toHaveLength(3);
    expect(rows.filter((row) => row.role === "assistant")).toHaveLength(3);

    const assistants = rows.filter((row) => row.role === "assistant");
    expect(assistants[0]!.provider).toBe("anthropic");
    expect(assistants[1]!.provider).toBe("anthropic");
    // The third came from somewhere else entirely, and says so.
    expect(assistants[2]!.provider).toBe("ollama");
    expect(assistants[2]!.model).toBe("llama3.2");

    // And the earlier turns still name the model that actually produced them,
    // which is what makes an old thread readable years later.
    expect(assistants[0]!.model).toBe("claude-sonnet-4-5");

    expect(resolved).toEqual(["Claude", "Claude", "Local"]);
  });

  it("carries the full history to the new provider", async () => {
    const [thread] = await db().insert(threads).values({ connectionId: claude }).returning();
    const id = thread!.id;

    await turn(id, "Remember the number 41.");

    await send(`/api/threads/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ connectionId: local }),
    });

    await turn(id, "What number?");

    const response = await send(`/api/threads/${id}`);
    const body = (await response.json()) as { messages: { parts: { text?: string }[] }[] };

    const transcript = body.messages.flatMap((m) => m.parts.map((p) => p.text ?? "")).join(" ");
    expect(transcript).toContain("Remember the number 41.");
    expect(transcript).toContain("Reply from Claude.");
    expect(transcript).toContain("Reply from Local.");
  });
});

describe("persistence", () => {
  it("round-trips message parts through SQLite", async () => {
    const [thread] = await db().insert(threads).values({ connectionId: claude }).returning();
    await turn(thread!.id, "Anything.");

    const [stored] = await db()
      .select()
      .from(messages)
      .where(eq(messages.threadId, thread!.id))
      .orderBy(asc(messages.createdAt))
      .all();

    // Stored as a structured array, not flattened to a string — this is what
    // lets tool calls and reasoning survive a reload.
    expect(Array.isArray(stored!.parts)).toBe(true);
    expect(stored!.parts[0]).toMatchObject({ type: "text", text: "Anything." });
  });

  /**
   * The browser mints an id for the message it sends, and this store used to
   * keep it. That made roughly half the ids in `messages` values chosen by a
   * client rather than ULIDs, so they neither sorted with the other half nor
   * came from anywhere this process controlled. The assistant row has always
   * used the store's own id and says why; the same reasoning applies here.
   */
  it("gives a user message this store's own id, not the one the client sent", async () => {
    const [thread] = await db().insert(threads).values({ connectionId: claude }).returning();

    const sent = "user-a-client-chose-this";
    const response = await app.request(`${BASE}/api/chat`, {
      headers: HEADERS,
      method: "POST",
      body: JSON.stringify({
        threadId: thread!.id,
        message: { id: sent, role: "user", parts: [{ type: "text", text: "Hello." }] },
      }),
    });
    await response.text();

    const [stored] = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.threadId, thread!.id), eq(messages.role, "user")))
      .all();

    expect(stored!.id).not.toBe(sent);
    // Crockford base32, 26 characters — the shape everything else in the store
    // has, so the two halves of this table sort together.
    expect(stored!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("names an untitled thread from its first message", async () => {
    const [thread] = await db().insert(threads).values({ connectionId: claude }).returning();
    await turn(thread!.id, "How should we shard the events table?");

    const [row] = await db().select().from(threads).where(eq(threads.id, thread!.id));
    expect(row!.title).toBe("How should we shard the events table?");
  });

  it("keeps what the person typed even when the provider fails", async () => {
    const [thread] = await db().insert(threads).values({ connectionId: claude }).returning();

    // A connection that cannot resolve: the turn fails, but the question
    // must not vanish with it.
    await db().update(threads).set({ connectionId: null }).where(eq(threads.id, thread!.id));
    await turn(thread!.id, "Typed into the void.");

    const rows = await db().select().from(messages).where(eq(messages.threadId, thread!.id)).all();
    expect(rows.some((row) => JSON.stringify(row.parts).includes("Typed into the void."))).toBe(
      true,
    );
  });
});

/**
 * Cowork rides the chat path rather than duplicating it, so the thing worth
 * proving is that a file tool call lands in the same `parts` column as
 * everything else and comes back out in the shape `Message.tsx` renders.
 */
describe("cowork", () => {
  it("stores a file tool call as a structural part, like any other tool", async () => {
    const directory = mkdtempSync(join(tmpdir(), "modeldock-cowork-"));
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src", "app.ts"), "export const port = 8765;\n");

    const [project] = await db()
      .insert(projects)
      .values({ name: "Harbor", slug: "cowork-harbor", directory })
      .returning();

    const [thread] = await db()
      .insert(threads)
      .values({ connectionId: claude, projectId: project!.id })
      .returning();

    // Two round trips: ask for the file, then answer with what came back.
    scripted.push(
      [
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "call-1", toolName: "read_file" },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "read_file",
          input: JSON.stringify({ path: "src/app.ts", offset: 1, limit: 2000 }),
        },
        { ...FINISH, finishReason: { unified: "tool-calls" as const, raw: "tool_use" } },
      ],
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "The port is 8765." },
        { type: "text-end", id: "0" },
        FINISH,
      ],
    );

    await turn(thread!.id, "What port does this project use?");

    const [assistant] = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.threadId, thread!.id), eq(messages.role, "assistant")))
      .all();

    const parts = assistant!.parts as { type: string; state?: string; output?: unknown }[];
    const call = parts.find((part) => part.type === "tool-read_file");

    // `tool-<name>`, not `dynamic-tool` — the prefix Message.tsx filters on.
    expect(call).toBeDefined();
    expect(call!.state).toBe("output-available");
    expect(JSON.stringify(call!.output)).toContain("export const port = 8765;");

    // And the prose that followed the tool call is in the same row.
    expect(JSON.stringify(parts)).toContain("The port is 8765.");
  });

  it("does not offer file tools to a project with no directory", async () => {
    const [project] = await db()
      .insert(projects)
      .values({ name: "Bare", slug: "cowork-bare" })
      .returning();

    const [thread] = await db()
      .insert(threads)
      .values({ connectionId: claude, projectId: project!.id })
      .returning();

    await turn(thread!.id, "Anything at all.");

    // The turn completes normally; nothing file-shaped was ever offered.
    const rows = await db().select().from(messages).where(eq(messages.threadId, thread!.id)).all();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("tool-read_file");
  });
});
