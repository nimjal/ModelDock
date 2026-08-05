/**
 * Finding skills on disk and keeping the index in step with them.
 *
 * A skill is a folder with a `SKILL.md` in it — the same shape Claude Code and
 * claude.ai use, so a skill someone already wrote works here unchanged. Two
 * roots are scanned:
 *
 *   ~/.modeldock/skills/<slug>/            follows the person everywhere
 *   <project.directory>/.modeldock/skills/<slug>/   belongs to the checkout
 *
 * The second one is the interesting half: it sits inside the repository, so it
 * can be committed and every person working in that project gets the same
 * skills without installing anything.
 *
 * What reaches the model is only the name and description of each skill —
 * roughly fifteen tokens each — plus a `load_skill` tool to pull the body when
 * one turns out to be relevant. Sending every skill body on every turn would
 * cost more than the skills are worth, and this is the same bargain the Agent
 * Skills convention makes.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNull, or } from "drizzle-orm";

import { modeldockHome } from "../config.js";
import type { Db } from "../db/index.js";
import { skills, type Skill } from "../db/schema.js";
import { bury, patch, put } from "../db/write.js";
import { asList, asString, parseFrontmatter } from "./frontmatter.js";

/** Beyond this the index is costing more than the skills are worth. */
const MAX_INDEXED = 60;

/** Where global skills live. */
export function globalSkillsDir(): string {
  return join(modeldockHome(), "skills");
}

/** Where a project's own skills live, inside the checkout so they commit. */
export function projectSkillsDir(directory: string): string {
  return join(directory, ".modeldock", "skills");
}

interface Found {
  slug: string;
  path: string;
  name: string;
  description: string;
  triggers: string[];
  bodyBytes: number;
  problem: string | null;
}

/** Read one candidate folder into a row, or into a row with a `problem`. */
async function readSkill(dir: string, slug: string): Promise<Found | null> {
  const file = join(dir, "SKILL.md");

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    // No SKILL.md — this folder simply is not a skill, which is not an error.
    return null;
  }

  const { data, body } = parseFrontmatter(text);
  const name = asString(data.name) || slug;
  const description = asString(data.description);

  // Stated rather than skipped. A skill that disappears without saying why is
  // how someone concludes the whole feature is broken.
  const problem = !asString(data.name)
    ? "No `name` in the frontmatter."
    : !description
      ? "No `description` in the frontmatter, so the model cannot tell when to use it."
      : null;

  return {
    slug,
    path: dir,
    name,
    description,
    triggers: asList(data.triggers),
    bodyBytes: Buffer.byteLength(body),
    problem,
  };
}

async function scanRoot(root: string): Promise<Found[]> {
  // The directory not existing yet is the normal state, not a failure.
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];

  const found: Found[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skill = await readSkill(join(root, entry.name), entry.name);
    if (skill) found.push(skill);
  }
  return found;
}

/**
 * Bring the table in line with what is actually on disk, for one scope.
 *
 * A full replace rather than a diff: rows whose folder has gone are
 * soft-deleted, and everything present is upserted. At the volume of skills a
 * person installs by hand this is cheaper than tracking changes.
 */
export async function syncSkills(
  db: Db,
  options: { projectId?: string | null; directory?: string | null } = {},
): Promise<number> {
  const scope = options.projectId ? ("project" as const) : ("global" as const);
  const projectId = options.projectId ?? null;

  const root = projectId
    ? options.directory
      ? projectSkillsDir(options.directory)
      : null
    : globalSkillsDir();

  const found = root ? await scanRoot(root) : [];
  const now = Date.now();

  const existing = await db
    .select()
    .from(skills)
    .where(
      and(
        eq(skills.scope, scope),
        projectId ? eq(skills.projectId, projectId) : isNull(skills.projectId),
      ),
    )
    .all();

  const bySlug = new Map(existing.map((row) => [row.slug, row]));

  for (const skill of found) {
    const previous = bySlug.get(skill.slug);
    const values = {
      name: skill.name,
      description: skill.description,
      triggers: skill.triggers,
      path: skill.path,
      bodyBytes: skill.bodyBytes,
      problem: skill.problem,
      scannedAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    if (previous) {
      patch(db, skills, previous.id, values);
    } else {
      put(db, skills, { slug: skill.slug, scope, projectId, ...values });
    }
  }

  // Anything the table knows about that is no longer on disk.
  const present = new Set(found.map((skill) => skill.slug));
  for (const row of existing) {
    if (present.has(row.slug) || row.deletedAt) continue;
    bury(db, skills, row.id);
  }

  return found.length;
}

/**
 * The skills in scope for a turn: global always, plus the project's own.
 *
 * A project-scoped skill shadows a global one with the same slug, so a
 * checkout can override a personal default without renaming anything.
 */
export async function loadSkillIndex(db: Db, projectId: string | null): Promise<Skill[]> {
  const inScope = projectId
    ? or(eq(skills.scope, "global"), eq(skills.projectId, projectId))
    : eq(skills.scope, "global");

  const rows = await db
    .select()
    .from(skills)
    .where(and(isNull(skills.deletedAt), inScope))
    .all();

  const bySlug = new Map<string, Skill>();
  for (const row of rows) {
    const existing = bySlug.get(row.slug);
    if (!existing || (row.scope === "project" && existing.scope === "global")) {
      bySlug.set(row.slug, row);
    }
  }

  return [...bySlug.values()].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Render the index for a system prompt, or null when there is nothing to say.
 *
 * `withPaths` is what the Code surface uses: an external coding agent has its
 * own file tools and its own skill loader, so the useful thing to hand it is
 * where the skills are, not a tool to fetch them through.
 */
export function renderSkillIndex(rows: Skill[], options: { withPaths: boolean }): string | null {
  const usable = rows.filter((row) => !row.problem);
  if (usable.length === 0) return null;

  const shown = usable.slice(0, MAX_INDEXED);

  const lines = shown.map((row) => {
    const where = row.scope === "project" ? "project" : "global";
    const path = options.withPaths ? ` — ${join(row.path, "SKILL.md")}` : "";
    return `- \`${row.slug}\` — ${row.description} (${where})${path}`;
  });

  const header = options.withPaths
    ? [
        "## Skills available",
        "These are instructions for specific tasks. Read the file before doing the work it covers.",
      ]
    : [
        "## Skills available",
        "Call `load_skill` with the slug to read the full instructions before using one.",
      ];

  if (usable.length > shown.length) {
    lines.push(`- …and ${usable.length - shown.length} more, not listed.`);
  }

  return [...header, ...lines].join("\n");
}
