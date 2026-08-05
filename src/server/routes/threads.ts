/**
 * Threads: the spine of the sidebar.
 *
 * Deletes are soft everywhere. A conversation is the kind of thing people
 * regret discarding, and a `deleted_at` column costs nothing.
 */

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/index.js";
import { messages, threads } from "../db/schema.js";
import { bury, patch, put, stamp } from "../db/write.js";
import { HttpError } from "../errors.js";

export const threadRoutes = new Hono();

threadRoutes.get("/threads", async (c) => {
  const projectId = c.req.query("projectId");

  const where = [isNull(threads.deletedAt), isNull(threads.archivedAt)];
  // `?projectId=none` asks for loose threads specifically; omitting the
  // parameter asks for all of them.
  if (projectId === "none") where.push(isNull(threads.projectId));
  else if (projectId) where.push(eq(threads.projectId, projectId));

  const rows = await db()
    .select()
    .from(threads)
    .where(and(...where))
    .orderBy(desc(threads.updatedAt))
    .all();

  return c.json({ threads: rows });
});

threadRoutes.post("/threads", async (c) => {
  const body = await c.req.json<{
    projectId?: string | null;
    connectionId?: string | null;
    model?: string | null;
    title?: string | null;
    agentId?: string | null;
    permission?: "read" | "edit" | "full" | null;
  }>();

  const row = put(db(), threads, {
    projectId: body.projectId ?? null,
    connectionId: body.connectionId ?? null,
    model: body.model ?? null,
    title: body.title ?? null,
    // Set on a coding session; null on a chat. This is the discriminator.
    agentId: body.agentId ?? null,
    permission: body.permission ?? null,
  });

  return c.json({ thread: row }, 201);
});

threadRoutes.get("/threads/:id", async (c) => {
  const id = c.req.param("id");
  const database = db();

  const [thread] = await database
    .select()
    .from(threads)
    .where(and(eq(threads.id, id), isNull(threads.deletedAt)))
    .limit(1);

  if (!thread) throw new HttpError(404, `No thread ${id}`);

  const rows = await database
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, id), isNull(messages.deletedAt)))
    .orderBy(asc(messages.createdAt))
    .all();

  return c.json({
    thread,
    messages: rows.map((row) => ({
      id: row.id,
      role: row.role,
      parts: row.parts,
      provider: row.provider,
      model: row.model,
      createdAt: row.createdAt,
    })),
  });
});

/**
 * Change a thread's provider, project or title.
 *
 * The load-bearing case is `connectionId`: this is the whole swap. It updates
 * one column and deliberately does not touch `messages`.
 */
threadRoutes.patch("/threads/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    title?: string | null;
    projectId?: string | null;
    connectionId?: string | null;
    model?: string | null;
    archived?: boolean;
    agentId?: string | null;
    permission?: "read" | "edit" | "full" | null;
  }>();

  const changes: Record<string, unknown> = {};
  if ("title" in body) changes.title = body.title;
  if ("projectId" in body) changes.projectId = body.projectId;
  if ("connectionId" in body) changes.connectionId = body.connectionId;
  if ("model" in body) changes.model = body.model;
  if ("archived" in body) changes.archivedAt = body.archived ? stamp() : null;
  if ("agentId" in body) changes.agentId = body.agentId;
  if ("permission" in body) changes.permission = body.permission;

  const row = patch(db(), threads, id, changes);
  if (!row) throw new HttpError(404, `No thread ${id}`);

  return c.json({ thread: row });
});

threadRoutes.delete("/threads/:id", async (c) => {
  const id = c.req.param("id");
  const row = bury(db(), threads, id);

  if (!row) throw new HttpError(404, `No thread ${id}`);
  return c.json({ ok: true });
});
