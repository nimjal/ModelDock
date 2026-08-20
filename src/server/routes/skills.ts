/**
 * Skills as a surface.
 *
 * There is no create, update or delete here, and that is the design: a skill
 * is a folder, so the way you add one is to make a folder and the way you
 * remove one is to delete it. ModelDock indexes what is there rather than
 * owning it, which means a skill cloned from someone else behaves exactly
 * like one written by hand, and ModelDock never writes into a repository.
 *
 * `/skills/preview` is the same disclosure the Memory screen has: what the
 * model is actually told, assembled by the same function that assembles it
 * for a real turn, so the two cannot drift.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/index.js";
import { projects, skills } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { parseFrontmatter } from "../skills/frontmatter.js";
import {
  globalSkillsDir,
  loadSkillIndex,
  projectSkillsDir,
  renderSkillIndex,
  syncSkills,
} from "../skills/scan.js";

export const skillRoutes = new Hono();

/** Re-read disk for the scopes in play, so a list is never stale. */
async function resync(projectId: string | null): Promise<void> {
  const database = db();
  await syncSkills(database, {});

  if (!projectId) return;

  const [project] = await database
    .select({ directory: projects.directory })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);

  await syncSkills(database, { projectId, directory: project?.directory ?? null });
}

skillRoutes.get("/skills", async (c) => {
  const projectId = c.req.query("projectId") || null;
  await resync(projectId);

  const rows = await loadSkillIndex(db(), projectId);

  return c.json({
    skills: rows,
    // Where to put a new one. The empty state is otherwise a dead end.
    roots: {
      global: globalSkillsDir(),
      project: await projectDirFor(projectId),
    },
  });
});

async function projectDirFor(projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  const [project] = await db()
    .select({ directory: projects.directory })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return project?.directory ? projectSkillsDir(project.directory) : null;
}

/** Exactly what the model will be told, for a given scope. */
skillRoutes.get("/skills/preview", async (c) => {
  const projectId = c.req.query("projectId") || null;
  const rows = await loadSkillIndex(db(), projectId);
  return c.json({
    block: renderSkillIndex(rows, { withPaths: false }),
    count: rows.filter((row) => !row.problem).length,
  });
});

/** The body of one skill, for the detail view. */
skillRoutes.get("/skills/:id", async (c) => {
  const id = c.req.param("id");

  const [row] = await db()
    .select()
    .from(skills)
    .where(and(eq(skills.id, id), isNull(skills.deletedAt)))
    .limit(1);

  if (!row) throw new HttpError(404, `No skill ${id}`);

  try {
    const raw = await readFile(join(row.path, "SKILL.md"), "utf8");
    const { body } = parseFrontmatter(raw);
    return c.json({ skill: row, instructions: body });
  } catch (error) {
    return c.json({ skill: row, instructions: null, problem: (error as Error).message });
  }
});

skillRoutes.post("/skills/scan", async (c) => {
  const body = await c.req.json<{ projectId?: string | null }>().catch(() => ({}) as const);
  const projectId = ("projectId" in body ? body.projectId : null) || null;

  await resync(projectId);
  const rows = await loadSkillIndex(db(), projectId);

  return c.json({ ok: true, count: rows.length });
});
