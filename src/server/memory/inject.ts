/**
 * Standing context, assembled fresh for every turn.
 *
 * Memory is ModelDock's, not a provider's and not an engine's. It is read
 * from the local store and prepended as a system block on each request, which
 * means it survives switching provider mid-conversation, applies to a brand
 * new thread with no history, and reaches any model capable of a system
 * prompt. Nothing has to be re-uploaded or re-indexed when the model changes.
 *
 * Scope is deliberately simple: global memories reach every turn, project
 * memories reach turns in their project. There is no retrieval step and no
 * embedding — at the volume a person writes by hand, sending everything is
 * both cheaper and more predictable than guessing what is relevant.
 */

import { and, desc, eq, isNull, or } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { memories, type Memory } from "../db/schema.js";
import { loadSkillIndex, renderSkillIndex } from "../skills/scan.js";

/** Beyond this, a memory block is costing more than it is worth. */
const MAX_MEMORIES = 200;

export async function loadMemories(db: Db, projectId: string | null): Promise<Memory[]> {
  const inScope = projectId
    ? or(eq(memories.scope, "global"), eq(memories.projectId, projectId))
    : eq(memories.scope, "global");

  return (
    db
      .select()
      .from(memories)
      .where(and(isNull(memories.deletedAt), inScope))
      // Pinned first, then most recently touched: if the block is ever
      // truncated, the things explicitly marked important survive.
      .orderBy(desc(memories.pinned), desc(memories.updatedAt))
      .limit(MAX_MEMORIES)
      .all()
  );
}

/** Render memories as the system block, or null when there are none. */
export function renderMemoryBlock(rows: Memory[]): string | null {
  if (rows.length === 0) return null;

  const globals = rows.filter((row) => row.scope === "global");
  const scoped = rows.filter((row) => row.scope === "project");

  const sections: string[] = [
    "What you already know about this person and their work.",
    "This is durable context they have saved, not part of the current conversation.",
    "Use it when relevant. Do not recite it back to them or mention that you were given it.",
  ];

  if (globals.length > 0) {
    sections.push("\n## Always\n" + globals.map(asBullet).join("\n"));
  }
  if (scoped.length > 0) {
    sections.push("\n## This project\n" + scoped.map(asBullet).join("\n"));
  }

  return sections.join("\n");
}

function asBullet(row: Memory): string {
  const body = row.body.trim();
  const title = row.title.trim();
  // A title that just restates the body would read as a stutter to the model.
  if (!body || body.toLowerCase() === title.toLowerCase()) return `- ${title}`;
  return `- **${title}** — ${body}`;
}

/** The full system prompt for a turn: who the assistant is, plus what it knows. */
export async function buildSystemPrompt(
  db: Db,
  projectId: string | null,
  projectName?: string | null,
  directory?: string | null,
): Promise<string> {
  const parts = [
    "You are ModelDock, a capable assistant working inside someone's own workspace.",
    "Be direct and concrete. Skip preamble and flattery. When you are unsure, say so plainly.",
  ];

  if (projectName) {
    parts.push(`\nThe current project is "${projectName}".`);
  }

  // Stated here so there is one function that assembles a turn's standing
  // context, rather than the file-tool instructions living beside the tools
  // and drifting from them. (The Memory screen's preview renders the memory
  // block alone; what the person sees about the directory is the line in the
  // empty thread, and the Skills screen has its own preview.)
  if (directory) {
    parts.push(
      `\nYou can read files under \`${directory}\`. You cannot change them.`,
      "Paths you pass to the file tools are relative to that directory.",
    );
  }

  const block = renderMemoryBlock(await loadMemories(db, projectId));
  if (block) parts.push("\n" + block);

  // Name and description only. The body arrives via `load_skill` when one
  // turns out to be relevant — see skills/scan.ts for why.
  const skillBlock = renderSkillIndex(await loadSkillIndex(db, projectId), { withPaths: false });
  if (skillBlock) parts.push("\n" + skillBlock);

  return parts.join("\n");
}
