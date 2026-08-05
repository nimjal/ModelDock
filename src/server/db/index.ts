/**
 * The database handle.
 *
 * One connection for the process, opened lazily so importing this module in a
 * test does not create `~/.modeldock`. Migrations run on open: `npx modeldock`
 * should work on a machine that has never seen ModelDock before, with no
 * separate setup step.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Held at 12.x deliberately. The 13.x line's `linux-x64` prebuild segfaults the
// moment a database is opened — `new Database(":memory:")` alone is enough —
// which on CI takes down every test worker that touches the store. Worth
// re-checking when 13 next publishes, but not worth an unprompted bump.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { databasePath } from "../config.js";
import { runMigrations } from "./migrate.js";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

let handle: Db | null = null;

/**
 * Every handle this process has opened, not just the most recent one.
 *
 * `db()` opens one, but the sync tests open two stores side by side to watch
 * changes travel between them. Tracking only the last one meant `closeDb()`
 * left the earlier file locked, and on Windows that makes the temp-directory
 * cleanup in `tests/setup.ts` fail — silently, because the `rmSync` there is
 * wrapped in a try.
 */
const open = new Set<Database.Database>();

export function createDb(file: string = databasePath()): ReturnType<typeof drizzle<typeof schema>> {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });

  const sqlite = new Database(file);
  // WAL keeps the UI responsive while a turn is being written, and the two
  // pragmas below are the usual pair that make SQLite behave under concurrent
  // readers without risking corruption.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  runMigrations(sqlite);
  open.add(sqlite);
  return db;
}

export function db(): Db {
  handle ??= createDb();
  return handle;
}

/**
 * Release every file this process opened.
 *
 * Only tests need this, and they need it on Windows specifically: an open
 * SQLite handle keeps a lock that makes removing the temp directory fail.
 */
export function closeDb(): void {
  for (const sqlite of open) {
    try {
      sqlite.close();
    } catch {
      // Already closed, or never finished opening. Either way there is no
      // lock left to release, which is all this function is for.
    }
  }
  open.clear();
  handle = null;
}

export { schema };
