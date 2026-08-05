/**
 * Upgrading a database that already has someone's work in it.
 *
 * `migrate.ts` warns that `ADD COLUMN` is not idempotent and leans entirely on
 * `user_version` to run each step exactly once — but nothing ever tested a
 * database arriving from an older version, which is the only situation that
 * warning is about. Every other test in this suite starts from an empty file
 * and so only ever exercises the newest schema.
 *
 * These tests build a database at each historical version, put rows in it, and
 * then open it the way the app does.
 */

import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDb } from "../src/server/db/index.js";
import { MIGRATIONS } from "../src/server/db/migrate.js";

const scratch = () => join(mkdtempSync(join(tmpdir(), "modeldock-migrate-")), "store.db");

/** A database as it stood after `version` migrations, and no further. */
function at(version: number): string {
  const file = scratch();
  const sqlite = new Database(file);

  for (let step = 0; step < version; step++) sqlite.exec(MIGRATIONS[step]!);
  sqlite.pragma(`user_version = ${version}`);
  sqlite.close();

  return file;
}

const columns = (db: ReturnType<typeof createDb>, table: string) =>
  (db.all(`PRAGMA table_info(${table})`) as { name: string }[]).map((row) => row.name);

const version = (db: ReturnType<typeof createDb>) =>
  (db.get("PRAGMA user_version") as { user_version: number }).user_version;

describe("upgrading an existing database", () => {
  it("carries rows forward from the first release", () => {
    const file = at(1);

    const before = new Database(file);
    before.exec(`
      INSERT INTO connections (id, name, kind, model) VALUES ('c1', 'Anthropic', 'anthropic', 'm');
      INSERT INTO threads (id, connection_id, title) VALUES ('t1', 'c1', 'Kept');
      INSERT INTO messages (id, thread_id, role, parts) VALUES ('m1', 't1', 'user', '[]');
    `);
    before.close();

    const db = createDb(file);

    expect(version(db)).toBe(MIGRATIONS.length);
    expect(db.all("SELECT title FROM threads")).toEqual([{ title: "Kept" }]);
    expect(db.all("SELECT id FROM messages")).toEqual([{ id: "m1" }]);

    // The columns each later step added.
    expect(columns(db, "threads")).toEqual(
      expect.arrayContaining(["agent_id", "agent_session_id", "permission"]),
    );
    expect(columns(db, "projects")).toContain("default_agent_id");
    expect(columns(db, "changelog")).toEqual(
      expect.arrayContaining(["seq", "tbl", "row_id", "at", "origin", "cols"]),
    );
  });

  it("upgrades from every intermediate version", () => {
    for (let from = 0; from < MIGRATIONS.length; from++) {
      const db = createDb(at(from));
      expect(version(db)).toBe(MIGRATIONS.length);
      expect(columns(db, "changelog")).toContain("seq");
    }
  });

  it("is a no-op the second time, so `ADD COLUMN` never runs twice", () => {
    const file = at(1);

    expect(version(createDb(file))).toBe(MIGRATIONS.length);
    // The second open is the one that used to fail, permanently, if a step had
    // half-applied.
    expect(() => createDb(file)).not.toThrow();
    expect(version(createDb(file))).toBe(MIGRATIONS.length);
  });

  it("drops the settings table that could never be synced", () => {
    const db = createDb(at(1));

    const tables = (
      db.all("SELECT name FROM sqlite_master WHERE type = 'table'") as { name: string }[]
    ).map((row) => row.name);

    expect(tables).not.toContain("settings");
  });
});

describe("a step that fails", () => {
  it("leaves the version where it was, so the step can be retried", () => {
    const file = at(1);
    const sqlite = new Database(file);

    // Stand in for a step whose second statement throws. The point is that the
    // first statement must not survive it — otherwise the retry replays an
    // `ADD COLUMN` against a column that already exists and fails forever.
    const step = sqlite.transaction(() => {
      sqlite.exec("ALTER TABLE threads ADD COLUMN doomed TEXT;");
      sqlite.exec("THIS IS NOT SQL;");
    });

    expect(() => step()).toThrow();

    const names = (sqlite.pragma("table_info(threads)") as { name: string }[]).map((r) => r.name);
    expect(names).not.toContain("doomed");
    expect(sqlite.pragma("user_version", { simple: true })).toBe(1);
    sqlite.close();
  });
});
