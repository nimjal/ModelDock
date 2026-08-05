/**
 * Memory as a first-class surface.
 *
 * These are the same rows the MCP server exposes and the same rows
 * `buildSystemPrompt` injects, so what someone sees on the Memory screen is
 * exactly what the model is being told — no hidden second store, and no way
 * for the two to drift.
 */

import { and, desc, eq, isNull, like, or } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/index.js";
import { memories } from "../db/schema.js";
import { patch, patchWhere, put, stamp } from "../db/write.js";
import { HttpError } from "../errors.js";
import { loadMemories, renderMemoryBlock } from "../memory/inject.js";

export const memoryRoutes = new Hono();

memoryRoutes.get("/memories", async (c) => {
  const scope = c.req.query("scope");
  const projectId = c.req.query("projectId");
  const search = c.req.query("q")?.trim();

  const where = [isNull(memories.deletedAt)];
  if (scope === "global") where.push(eq(memories.scope, "global"));
  if (projectId) where.push(eq(memories.projectId, projectId));
  if (search) {
    const pattern = `%${search}%`;
    where.push(or(like(memories.title, pattern), like(memories.body, pattern))!);
  }

  const rows = await db()
    .select()
    .from(memories)
    .where(and(...where))
    .orderBy(desc(memories.pinned), desc(memories.updatedAt))
    .all();

  return c.json({ memories: rows });
});

/**
 * Exactly what the model will be told for a given scope.
 *
 * Being able to read the assembled block is the difference between memory you
 * trust and memory you hope is working.
 */
memoryRoutes.get("/memories/preview", async (c) => {
  const projectId = c.req.query("projectId") || null;
  const rows = await loadMemories(db(), projectId);
  return c.json({ block: renderMemoryBlock(rows), count: rows.length });
});

memoryRoutes.post("/memories", async (c) => {
  const body = await c.req.json<{
    title?: string;
    body?: string;
    scope?: "global" | "project";
    projectId?: string | null;
    kind?: "fact" | "preference" | "instruction";
    sourceThreadId?: string | null;
    pinned?: boolean;
  }>();

  const title = body.title?.trim();
  if (!title) throw new HttpError(400, "A memory needs a title.");

  const scope = body.scope === "project" && body.projectId ? "project" : "global";

  const row = put(db(), memories, {
    scope,
    projectId: scope === "project" ? body.projectId! : null,
    kind: body.kind ?? "fact",
    title,
    body: body.body?.trim() ?? "",
    sourceThreadId: body.sourceThreadId ?? null,
    pinned: body.pinned ?? false,
  });

  return c.json({ memory: row }, 201);
});

memoryRoutes.patch("/memories/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    title?: string;
    body?: string;
    kind?: "fact" | "preference" | "instruction";
    pinned?: boolean;
  }>();

  const changes: Record<string, unknown> = {};
  if (body.title !== undefined) changes.title = body.title.trim();
  if (body.body !== undefined) changes.body = body.body.trim();
  if (body.kind !== undefined) changes.kind = body.kind;
  if (body.pinned !== undefined) changes.pinned = body.pinned;

  const row = patch(db(), memories, id, changes);
  if (!row) throw new HttpError(404, `No memory ${id}`);

  return c.json({ memory: row });
});

memoryRoutes.delete("/memories/:id", async (c) => {
  const id = c.req.param("id");
  const [row] = patchWhere(db(), memories, and(eq(memories.id, id), isNull(memories.deletedAt))!, {
    deletedAt: stamp(),
  });

  if (!row) throw new HttpError(404, `No memory ${id}`);
  return c.json({ ok: true });
});
