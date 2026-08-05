/**
 * The parts of a turn that are the same whether a model or an agent answers.
 *
 * Both `/api/chat` and `/api/code` persist the person's message before the
 * engine is touched, and both name an untitled thread from its first line.
 * Those are product decisions rather than implementation details, so they are
 * stated once here rather than twice in two routes that could drift.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import type { UIMessage } from "ai";

import { db } from "../db/index.js";
import { connections, messages, projects, threads } from "../db/schema.js";
import { patch } from "../db/write.js";
import { HttpError } from "../errors.js";

/**
 * Which connection answers this turn.
 *
 * The thread's own connection wins, then the project default, then whatever
 * single connection exists. The fallback matters on first run: someone who
 * has added exactly one connection should be able to type immediately
 * without first choosing it from a menu.
 */
export async function connectionForThread(threadId: string) {
  const database = db();

  const [thread] = await database
    .select()
    .from(threads)
    .where(and(eq(threads.id, threadId), isNull(threads.deletedAt)))
    .limit(1);

  if (!thread) throw new HttpError(404, `No thread ${threadId}`);

  const candidates: (string | null)[] = [thread.connectionId];

  if (thread.projectId) {
    const [project] = await database
      .select()
      .from(projects)
      .where(eq(projects.id, thread.projectId))
      .limit(1);
    candidates.push(project?.defaultConnectionId ?? null);
  }

  for (const id of candidates) {
    if (!id) continue;
    const [row] = await database
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), isNull(connections.deletedAt)))
      .limit(1);
    if (row) return { thread, connection: row };
  }

  const [fallback] = await database
    .select()
    .from(connections)
    .where(isNull(connections.deletedAt))
    .limit(1);

  if (!fallback) {
    throw new HttpError(
      400,
      "No connection set up yet. Add one in Connections and set the API key variable it names.",
    );
  }
  return { thread, connection: fallback };
}

/** Fetch a thread, or 404. Used by the Code route, which picks its own engine. */
export async function requireThread(threadId: string) {
  const [thread] = await db()
    .select()
    .from(threads)
    .where(and(eq(threads.id, threadId), isNull(threads.deletedAt)))
    .limit(1);

  if (!thread) throw new HttpError(404, `No thread ${threadId}`);
  return thread;
}

/**
 * Give an untitled thread a name from its first message.
 *
 * Deliberately not a model call: a second round trip to name a conversation
 * costs real money and latency on every provider, and the first line of what
 * someone typed is a better label than most generated ones.
 */
export async function titleThreadIfNeeded(threadId: string): Promise<void> {
  const database = db();
  const [thread] = await database
    .select({ title: threads.title })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);

  if (thread?.title) return;

  const [first] = await database
    .select({ parts: messages.parts })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.role, "user")))
    .orderBy(asc(messages.createdAt))
    .limit(1);

  const parts = (first?.parts ?? []) as { type?: string; text?: string }[];
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return;

  const title = text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
  patch(database, threads, threadId, { title });
}

/**
 * Rows in, `UIMessage`s out — the shape the client and the SDK both expect.
 *
 * Here rather than in `routes/chat.ts` because the built-in coding engine needs
 * the same conversion: its session is this store's transcript, so it rebuilds
 * the history the same way an ordinary chat turn does.
 */
export function toUiMessages(rows: { id: string; role: string; parts: unknown }[]): UIMessage[] {
  return rows.map(
    (row) =>
      ({
        id: row.id,
        role: row.role,
        parts: Array.isArray(row.parts) ? row.parts : [],
      }) as UIMessage,
  );
}

/** The full transcript of a thread, oldest first. */
export async function historyFor(threadId: string) {
  return db()
    .select({ id: messages.id, role: messages.role, parts: messages.parts })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.createdAt))
    .all();
}
