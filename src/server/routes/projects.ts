/**
 * Projects: a context, not a folder.
 *
 * A project owns a memory scope, a default connection, and a set of threads.
 * Most projects are not a checkout, so `directory` stays nullable — but when
 * it is set it turns on the file-reading surfaces (Cowork in chat, and Code),
 * which is why `/projects/:id/status` exists: a path that is merely stored is
 * a path nobody can tell is wrong until a conversation quietly does nothing.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/index.js";
import { memories, projects, threads } from "../db/schema.js";
import { patch, patchWhere, put, stamp } from "../db/write.js";
import { HttpError } from "../errors.js";
import { projectRoot } from "../files/boundary.js";

export const projectRoutes = new Hono();

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project"
  );
}

/** Append -2, -3, ... until the slug is free. Slugs are unique in the schema. */
async function uniqueSlug(base: string): Promise<string> {
  const database = db();
  let candidate = base;
  let suffix = 2;

  for (;;) {
    const [clash] = await database
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, candidate))
      .limit(1);
    if (!clash) return candidate;
    candidate = `${base}-${suffix++}`;
  }
}

projectRoutes.get("/projects", async (c) => {
  const database = db();

  const rows = await database
    .select()
    .from(projects)
    .where(isNull(projects.deletedAt))
    .orderBy(desc(projects.updatedAt))
    .all();

  // Counts drive the sidebar's secondary line; two grouped queries beat a
  // per-project round trip.
  const threadCounts = await database
    .select({ projectId: threads.projectId, total: count() })
    .from(threads)
    .where(and(isNull(threads.deletedAt), isNull(threads.archivedAt)))
    .groupBy(threads.projectId)
    .all();

  const memoryCounts = await database
    .select({ projectId: memories.projectId, total: count() })
    .from(memories)
    .where(and(isNull(memories.deletedAt), eq(memories.scope, "project")))
    .groupBy(memories.projectId)
    .all();

  const threadsBy = new Map(threadCounts.map((row) => [row.projectId, row.total]));
  const memoriesBy = new Map(memoryCounts.map((row) => [row.projectId, row.total]));

  return c.json({
    projects: rows.map((row) => ({
      ...row,
      threadCount: threadsBy.get(row.id) ?? 0,
      memoryCount: memoriesBy.get(row.id) ?? 0,
    })),
  });
});

/**
 * Whether this project's directory is actually usable.
 *
 * The same idea as `doctor`: a setting that silently does nothing is worse
 * than one that says why. A typo'd or moved path degrades Cowork to an
 * ordinary chat, and without this the only symptom is an assistant that
 * mysteriously cannot see any files.
 */
projectRoutes.get("/projects/:id/status", async (c) => {
  const id = c.req.param("id");

  const [project] = await db()
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .limit(1);

  if (!project) throw new HttpError(404, `No project ${id}`);

  if (!project.directory) {
    return c.json({ directory: null, exists: false, readable: false, isGitRepo: false });
  }

  try {
    const root = await projectRoot(project.directory);
    const info = await stat(root);

    if (!info.isDirectory()) {
      return c.json({
        directory: project.directory,
        exists: true,
        readable: false,
        isGitRepo: false,
        problem: "That path is a file, not a directory.",
      });
    }

    // Listing is the honest test: a directory can exist and still not be
    // readable by the account this server runs as.
    await readdir(root);
    const isGitRepo = await stat(join(root, ".git")).then(
      () => true,
      () => false,
    );

    return c.json({ directory: project.directory, exists: true, readable: true, isGitRepo });
  } catch (error) {
    const code = (error as { code?: string }).code;
    return c.json({
      directory: project.directory,
      exists: code !== "ENOENT",
      readable: false,
      isGitRepo: false,
      problem:
        code === "ENOENT"
          ? "No directory at that path."
          : code === "EACCES" || code === "EPERM"
            ? "That directory exists but cannot be read."
            : (error as Error).message,
    });
  }
});

projectRoutes.post("/projects", async (c) => {
  const body = await c.req.json<{
    name?: string;
    description?: string | null;
    directory?: string | null;
    defaultConnectionId?: string | null;
  }>();

  const name = body.name?.trim();
  if (!name) throw new HttpError(400, "Give the project a name.");

  const row = put(db(), projects, {
    name,
    slug: await uniqueSlug(slugify(name)),
    description: body.description?.trim() || null,
    directory: body.directory?.trim() || null,
    defaultConnectionId: body.defaultConnectionId ?? null,
  });

  return c.json({ project: row }, 201);
});

projectRoutes.patch("/projects/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    description?: string | null;
    directory?: string | null;
    defaultConnectionId?: string | null;
  }>();

  const changes: Record<string, unknown> = {};
  if (body.name !== undefined) changes.name = body.name.trim();
  if (body.description !== undefined) changes.description = body.description?.trim() || null;
  if (body.directory !== undefined) changes.directory = body.directory?.trim() || null;
  if (body.defaultConnectionId !== undefined) {
    changes.defaultConnectionId = body.defaultConnectionId;
  }

  const row = patch(db(), projects, id, changes);
  if (!row) throw new HttpError(404, `No project ${id}`);

  return c.json({ project: row });
});

/**
 * Soft-delete a project. Its threads survive and become loose rather than
 * disappearing with it — losing a conversation because a container was
 * tidied away would be the wrong default.
 */
projectRoutes.delete("/projects/:id", async (c) => {
  const id = c.req.param("id");
  const database = db();

  const [row] = patchWhere(
    database,
    projects,
    and(eq(projects.id, id), isNull(projects.deletedAt))!,
    { deletedAt: stamp() },
  );

  if (!row) throw new HttpError(404, `No project ${id}`);

  // Each detached thread gets its own stamp. It used to not, which left the
  // sidebar sorting them by a time that no longer described them — and would
  // have let a delta sync replicate the project's deletion while silently
  // missing that its threads had moved.
  patchWhere(database, threads, eq(threads.projectId, id), { projectId: null });
  return c.json({ ok: true });
});
