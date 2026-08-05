/**
 * Reading a skill on demand.
 *
 * The system prompt carries only each skill's name and description. When one
 * turns out to be relevant, the model calls `load_skill` and gets the body —
 * which is the whole of progressive disclosure, and the reason a person can
 * install thirty skills without paying for thirty skills on every turn.
 *
 * `read_skill_file` reaches the supporting files that sit beside a SKILL.md —
 * a reference table, a template, a script. It resolves through the same
 * `inside()` used by Cowork and Code, rooted at the skill's own folder, so a
 * skill cannot use its own reference links to read the rest of the disk.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";

import type { Db } from "../db/index.js";
import { inside, OutsideProject } from "../files/boundary.js";
import { parseFrontmatter } from "./frontmatter.js";
import { loadSkillIndex } from "./scan.js";

/** A skill body past this is not being read carefully by anyone, model or not. */
const MAX_BODY_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 128 * 1024;

export interface SkillToolContext {
  db: Db;
  projectId: string | null;
}

export function skillTools({ db, projectId }: SkillToolContext) {
  /** Resolve a slug the same way the index did, so the two cannot disagree. */
  const find = async (slug: string) => {
    const rows = await loadSkillIndex(db, projectId);
    return rows.find((row) => row.slug === slug) ?? null;
  };

  return {
    load_skill: tool({
      description: [
        "Read the full instructions for one of the skills listed in the system prompt.",
        "Do this before carrying out a task a skill covers — the description alone is not the instructions.",
      ].join(" "),
      inputSchema: z.object({
        slug: z.string().min(1).describe("The skill's slug, exactly as listed, e.g. 'changelog'."),
      }),
      execute: async ({ slug }) => {
        const row = await find(slug);
        if (!row) return { error: `No skill called '${slug}'.` };
        if (row.problem) return { error: `Skill '${slug}' is not usable: ${row.problem}` };

        try {
          const raw = await readFile(join(row.path, "SKILL.md"), "utf8");
          const { body } = parseFrontmatter(raw);
          const truncated = Buffer.byteLength(body) > MAX_BODY_BYTES;

          // The sibling files, so the model knows what it can ask for next
          // rather than guessing at names.
          const files = (await readdir(row.path, { withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isFile() && entry.name !== "SKILL.md")
            .map((entry) => entry.name);

          return {
            name: row.name,
            slug: row.slug,
            files,
            truncated,
            instructions: truncated ? body.slice(0, MAX_BODY_BYTES) : body,
          };
        } catch (error) {
          return { error: `Could not read skill '${slug}': ${(error as Error).message}` };
        }
      },
    }),

    read_skill_file: tool({
      description:
        "Read one of the supporting files that sits beside a skill's SKILL.md, as listed by load_skill.",
      inputSchema: z.object({
        slug: z.string().min(1).describe("The skill's slug."),
        file: z.string().min(1).describe("A file name from that skill's 'files' list."),
      }),
      execute: async ({ slug, file }) => {
        const row = await find(slug);
        if (!row) return { error: `No skill called '${slug}'.` };

        try {
          // Rooted at the skill folder: a skill's own reference links cannot
          // become a way out into the rest of the disk.
          const absolute = await inside(row.path, file);
          const raw = await readFile(absolute, "utf8");
          const truncated = Buffer.byteLength(raw) > MAX_FILE_BYTES;

          return {
            slug,
            file,
            truncated,
            content: truncated ? raw.slice(0, MAX_FILE_BYTES) : raw,
          };
        } catch (error) {
          if (error instanceof OutsideProject) {
            return { error: `${file} is outside the '${slug}' skill folder.` };
          }
          const code = (error as { code?: string }).code;
          if (code === "ENOENT") return { error: `Skill '${slug}' has no file called '${file}'.` };
          return { error: `Could not read ${file}: ${(error as Error).message}` };
        }
      },
    }),
  };
}
