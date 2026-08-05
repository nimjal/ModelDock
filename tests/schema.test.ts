/**
 * That `schema.ts` and `migrate.ts` still describe the same database.
 *
 * They are two hand-written statements of one thing. Drizzle Kit's generated
 * SQL is deliberately not used at runtime — see the note at the top of
 * `migrate.ts` — which buys a self-contained `npx modeldock` and costs exactly
 * this: nothing but discipline keeps the two files in step, and a column added
 * to one and forgotten in the other fails at runtime, on someone else's
 * machine, in whichever query happens to mention it first.
 *
 * Also asserted here: every table has an explicit answer to "does this sync?",
 * so adding one forces the decision rather than defaulting to silence.
 */

import { getTableColumns, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { createDb } from "../src/server/db/index.js";
import * as schema from "../src/server/db/schema.js";
import { NOT_SYNCED, SYNCED } from "../src/server/sync/tables.js";

// Each export is its own precisely-typed table, so the union cannot narrow to
// the general `SQLiteTable` through a predicate — this walks them structurally.
const tables = Object.values(schema).filter((value) =>
  is(value, SQLiteTable),
) as unknown as SQLiteTable[];

/** Created implicitly by `AUTOINCREMENT`; not ours to declare. */
const INTERNAL = new Set(["sqlite_sequence"]);

const db = createDb(":memory:");

interface ColumnInfo {
  name: string;
  notnull: number;
  pk: number;
}

const actual = (table: string) => db.all(`PRAGMA table_info(${table})`) as ColumnInfo[];

describe("the schema the app compiles against", () => {
  it("declares at least the tables we expect", () => {
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.map(getTableName).sort()).toEqual([
      "changelog",
      "coding_agents",
      "connections",
      "memories",
      "messages",
      "projects",
      "skills",
      "threads",
    ]);
  });

  it.each(tables.map((table) => [getTableName(table), table] as const))(
    "matches the migrated database for %s",
    (name, table) => {
      const live = actual(name);
      expect(live.length, `${name} is missing from the migrations`).toBeGreaterThan(0);

      const declared = Object.values(getTableColumns(table));

      expect(declared.map((column) => column.name).sort()).toEqual(
        live.map((column) => column.name).sort(),
      );

      // Primary keys are exempt, and the reason is a SQLite quirk rather than a
      // liberty: an `INTEGER PRIMARY KEY` is an alias for the rowid, and
      // `table_info` reports it as nullable even though inserting a null into
      // it just allocates the next id. Comparing it would fail on a column that
      // is not actually nullable in any sense the code cares about.
      const nullability = new Map(
        live.filter((column) => column.pk === 0).map((c) => [c.name, c.notnull === 1]),
      );

      for (const column of declared) {
        if (!nullability.has(column.name)) continue;
        // A column the code believes is NOT NULL but the database does not will
        // hand back a null that no type ever admitted was possible.
        expect(nullability.get(column.name), `${name}.${column.name} nullability disagrees`).toBe(
          column.notNull,
        );
      }
    },
  );

  it("has no table the migrations create but the code does not know about", () => {
    const live = (
      db.all("SELECT name FROM sqlite_master WHERE type = 'table'") as { name: string }[]
    )
      .map((row) => row.name)
      .filter((name) => !INTERNAL.has(name));

    expect(live.sort()).toEqual(tables.map(getTableName).sort());
  });
});

describe("every table has a sync decision", () => {
  it("appears in exactly one of SYNCED or NOT_SYNCED", () => {
    const synced = SYNCED.map((entry) => getTableName(entry.table));
    const decided = [...synced, ...NOT_SYNCED].sort();

    expect(decided).toEqual(tables.map(getTableName).sort());
    expect(new Set(decided).size).toBe(decided.length);
  });

  it("never lists a skipped column that the table does not have", () => {
    for (const entry of SYNCED) {
      const names = Object.keys(getTableColumns(entry.table));
      for (const skipped of entry.skip) {
        expect(names, `${getTableName(entry.table)}.${skipped}`).toContain(skipped);
      }
    }
  });
});
