/**
 * Threads: the spine of the sidebar.
 *
 * Deletes are soft everywhere. A conversation is the kind of thing people
 * regret discarding, and a `deleted_at` column costs nothing.
 */

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/index.js";
import { messages, projects, threads } from "../db/schema.js";
import { bury, patch, put, stamp } from "../db/write.js";
import { HttpError } from "../errors.js";
import { chatDefault } from "../workspace.js";

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

/**
 * Start a conversation.
 *
 * A new chat is stamped with a connection and model rather than left blank:
 * the project's default if it has one, otherwise the workspace default. Doing
 * it here rather than at the first turn is what makes the berth show the right
 * engine the moment the chat opens, instead of "No connection" until someone
 * sends something.
 *
 * It also fixes the meaning of changing the default later. A stamped thread
 * keeps what it started on, so setting a new default tomorrow does not
 * retroactively re-point a conversation someone began today — which is the
 * behaviour people expect from a *default* as opposed to a global override.
 *
 * A caller that names a connection is always obeyed, including on a coding
 * session, where the agent picks its own model and this is left alone.
 */
threadRoutes.post("/threads", async (c) => {
  const body = await c.req.json<{
    projectId?: string | null;
    connectionId?: string | null;
    model?: string | null;
    title?: string | null;
    agentId?: string | null;
    permission?: "read" | "edit" | "full" | null;
  }>();

  const database = db();
  const agentId = body.agentId ?? null;

  let connectionId = body.connectionId ?? null;
  let model = body.model ?? null;

  if (!connectionId && !agentId) {
    if (body.projectId) {
      const [project] = await database
        .select({ defaultConnectionId: projects.defaultConnectionId })
        .from(projects)
        .where(and(eq(projects.id, body.projectId), isNull(projects.deletedAt)))
        .limit(1);
      connectionId = project?.defaultConnectionId ?? null;
    }

    if (!connectionId) {
      const fallback = await chatDefault(database);
      connectionId = fallback.connectionId;
      // Only alongside the workspace's own connection. Carrying a default model
      // id onto a project's different provider would name something that does
      // not exist there — the same reasoning the berth's swap uses.
      model = model ?? fallback.model;
    }
  }

  const row = put(database, threads, {
    projectId: body.projectId ?? null,
    connectionId,
    model,
    title: body.title ?? null,
    // Set on a coding session; null on a chat. This is the discriminator.
    agentId,
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
