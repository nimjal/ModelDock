/**
 * What travels between devices, and what stays on the machine that wrote it.
 *
 * Pure metadata, like `providers/catalog.ts` — no I/O, so the merge rules can
 * be tested without a database.
 *
 * "Does this column mean anything on another machine" is a sync question, not
 * a storage question, so the answer lives here rather than in `schema.ts`.
 * There is one file to read and one file to change. `skip` is typed against
 * the table's own row type, so renaming a column breaks the build instead of
 * silently starting to sync something machine-local.
 */

import { getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import { codingAgents, connections, memories, messages, projects, threads } from "../db/schema.js";

interface Synced<T extends SQLiteTable> {
  table: T;
  /** Columns that describe *this* machine and would be wrong on another. */
  skip: readonly (keyof T["$inferSelect"] & string)[];
}

const synced = <T extends SQLiteTable>(
  table: T,
  skip: readonly (keyof T["$inferSelect"] & string)[],
): Synced<T> => ({ table, skip });

export const SYNCED = [
  synced(connections, []),

  /** `directory` is a path on the machine that set it. */
  synced(projects, ["directory"]),

  /**
   * `agentSessionId` is an engine's own session handle. Claude Code's
   * `--resume` only works where `~/.claude` holds the session, so the id is
   * meaningless on another machine — ModelDock's own transcript is complete
   * regardless, which is the point of owning the store.
   */
  synced(threads, ["agentSessionId"]),

  synced(messages, []),
  synced(memories, []),

  /**
   * Identity only. Every other column is the result of probing *this* box:
   * an absolute path, the version found there, whether it was detected at all.
   * The row still has to travel because `threads.agentId` is a foreign key and
   * skipping the table would leave it dangling. On the far side `checkAgent`
   * reports the agent as not installed and the Code entry point hides itself,
   * which is exactly right.
   */
  synced(codingAgents, ["command", "args", "version", "baseUrl", "detected"]),
] as const;

/**
 * Tables that deliberately never sync.
 *
 * `skills` is a cache of on-disk folders keyed by an absolute `path`. Syncing
 * it would put rows on the peer pointing at directories that do not exist
 * there, which `syncSkills` soft-deletes on its next scan — and the delete
 * would travel back, and the original would be re-created, forever. The folder
 * is the source of truth; `~/.modeldock/skills/` is a directory that syncs
 * perfectly well with any file tool.
 *
 * `changelog` is the log itself.
 */
export const NOT_SYNCED = ["skills", "changelog"] as const;

const BY_NAME: Map<string, { skip: readonly string[]; table: SQLiteTable }> = new Map(
  SYNCED.map((entry) => [
    getTableName(entry.table),
    entry as unknown as { skip: readonly string[]; table: SQLiteTable },
  ]),
);

/** Whether a write to this table should be recorded for other devices. */
export function isLogged(table: string): boolean {
  return BY_NAME.has(table);
}

/**
 * The drizzle table for a name off the wire.
 *
 * Returns undefined for anything not in `SYNCED`, which is the check that keeps
 * a peer from naming `changelog` — or a table this version has never heard of —
 * and having it written to.
 */
export function tableFor(name: string): SQLiteTable | undefined {
  return BY_NAME.get(name)?.table;
}

/**
 * Apply order within a batch.
 *
 * Foreign keys are on, so a message cannot land before its thread and a thread
 * cannot land before its project. Ordering the apply is simpler than switching
 * `foreign_keys` off, and it does not turn off a safety net to do it.
 */
export const APPLY_ORDER: readonly string[] = [
  "connections",
  "coding_agents",
  "projects",
  "threads",
  "messages",
  "memories",
];

/** The columns of `table` that may cross to another device. */
export function syncedColumns(table: string, all: readonly string[]): string[] {
  const entry = BY_NAME.get(table);
  if (!entry) return [];

  const skip = new Set<string>(entry.skip);
  return all.filter((column) => !skip.has(column));
}
