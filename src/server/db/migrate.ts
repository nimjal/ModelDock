/**
 * Schema creation, applied on every open.
 *
 * Drizzle Kit generates SQL into `drizzle/`, but that directory is only
 * present in a source checkout — a published package would have to carry it
 * and resolve it relative to a bundled binary. The schema is small enough
 * that stating it here keeps `npx modeldock` a single self-contained file,
 * and every statement is `IF NOT EXISTS`, so opening an existing database is
 * a no-op.
 *
 * When a column has to change, add a numbered step to `MIGRATIONS` rather
 * than editing an earlier one. `user_version` records how far a database has
 * come.
 */

import type BetterSqlite3 from "better-sqlite3";

const INITIAL = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  base_url TEXT,
  model TEXT NOT NULL,
  api_key_env TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  directory TEXT,
  default_connection_id TEXT REFERENCES connections(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT REFERENCES projects(id),
  title TEXT,
  connection_id TEXT REFERENCES connections(id),
  model TEXT,
  archived_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS threads_project_idx ON threads (project_id);
CREATE INDEX IF NOT EXISTS threads_updated_idx ON threads (updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  parts TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'fact',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_thread_id TEXT REFERENCES threads(id),
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories (scope, project_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
`;

/** Skills: the on-disk folders, cached for lookup. See schema.ts. */
const SKILLS = `
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  scope TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  triggers TEXT,
  path TEXT NOT NULL,
  body_bytes INTEGER,
  problem TEXT,
  scanned_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS skills_slug_idx ON skills (scope, project_id, slug);
CREATE INDEX IF NOT EXISTS skills_scope_idx ON skills (scope, project_id);
`;

/**
 * Coding agents, and the thread columns that point at them.
 *
 * `ADD COLUMN` is not idempotent the way `CREATE TABLE IF NOT EXISTS` is, but
 * it does not need to be: `user_version` gates each step so this runs exactly
 * once on any given database.
 */
const CODING_AGENTS = `
CREATE TABLE IF NOT EXISTS coding_agents (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  command TEXT,
  args TEXT,
  version TEXT,
  base_url TEXT,
  auth_token_env TEXT,
  detected INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  deleted_at INTEGER
);

ALTER TABLE threads ADD COLUMN agent_id TEXT REFERENCES coding_agents(id);
ALTER TABLE threads ADD COLUMN agent_session_id TEXT;
ALTER TABLE threads ADD COLUMN permission TEXT;
ALTER TABLE projects ADD COLUMN default_agent_id TEXT REFERENCES coding_agents(id);
`;

/**
 * The change log, and the tidying that makes a delta sync possible.
 *
 * `settings` is dropped rather than repaired. It was a key/value bag nothing
 * ever read — the theme it was meant for lives in `localStorage` — and it was
 * the one table without a ULID id, a `createdAt` or a `deletedAt`, so it could
 * not take part in a sync at all. The two things that might have gone in it,
 * the peer token and the approval secret, deliberately live outside the
 * database so that "a stolen or synced database contains no credentials" stays
 * true.
 *
 * The indexes are partial because every list query in the app filters on
 * `deleted_at IS NULL`. One partial index on `updated_at` therefore serves both
 * the UI's ordering and sync's "what changed since" scan.
 */
const SYNC = `
CREATE TABLE IF NOT EXISTS changelog (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  row_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  origin TEXT NOT NULL,
  cols TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS changelog_row_idx ON changelog (tbl, row_id);

DROP TABLE IF EXISTS settings;

CREATE INDEX IF NOT EXISTS connections_live_idx ON connections (updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS projects_live_idx    ON projects    (updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS threads_live_idx     ON threads     (updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS messages_live_idx    ON messages    (updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS memories_live_idx    ON memories    (updated_at) WHERE deleted_at IS NULL;
`;

/**
 * The built-in engine: a coding agent that is a ModelDock connection.
 *
 * Nullable because it is meaningless for the external engines — OpenCode and
 * Claude Code choose their own model — and required only for `kind = 'builtin'`,
 * which the row-to-runnable step enforces rather than the schema.
 */
const BUILTIN_AGENT = `
ALTER TABLE coding_agents ADD COLUMN connection_id TEXT REFERENCES connections(id);
`;

/** Ordered. Index + 1 is the `user_version` a database reaches by running it. */
export const MIGRATIONS: string[] = [INITIAL, SKILLS, CODING_AGENTS, SYNC, BUILTIN_AGENT];

export function runMigrations(sqlite: BetterSqlite3.Database): void {
  const current = sqlite.pragma("user_version", { simple: true }) as number;

  for (let version = current; version < MIGRATIONS.length; version++) {
    // The step and its version bump have to land together. A step is several
    // statements, `ALTER TABLE ADD COLUMN` is not idempotent, and a failure
    // between the two used to leave the database at the old `user_version`
    // with half the step applied — which made every subsequent open fail
    // permanently, because the next run would replay the ALTERs.
    const step = sqlite.transaction(() => {
      sqlite.exec(MIGRATIONS[version]!);
      // pragma values cannot be bound, and `version` is a loop counter over a
      // fixed-length local array, so there is nothing here to inject.
      sqlite.pragma(`user_version = ${version + 1}`);
    });

    step();
  }
}
