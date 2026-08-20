/**
 * The only module that writes.
 *
 * Every insert and update in the server goes through here, because a row change
 * and its changelog entry have to land together or not at all. Scattering
 * `db.insert(...)` across twenty route handlers and remembering to append a log
 * line next to each one is the kind of discipline that holds for a month; a
 * write that silently fails to sync is not a failure anyone notices until two
 * devices disagree. `tests/write.test.ts` asserts the rule by scanning the
 * source, the same way the agent tests assert that no permission flag escapes
 * the project directory.
 *
 * These functions are synchronous, and deliberately so. better-sqlite3 is a
 * synchronous driver, so drizzle's `transaction()` takes a synchronous callback
 * — hand it an `async` one and a throw inside escapes as an unhandled rejection
 * instead of rolling anything back. Rather than paper over that with a helper
 * that looks asynchronous and isn't, the shape here matches what the driver
 * actually does.
 *
 * The other job this file does is own the clock. Row inserts used to take their
 * timestamp from the SQL default `(unixepoch() * 1000)`, which has one-second
 * resolution, while updates used `Date.now()`, which has one-millisecond
 * resolution. The two are not comparable: a row patched in the same second it
 * was created could carry an `updatedAt` *earlier* than its `createdAt`, and
 * last-writer-wins across devices cannot be built on a clock like that. Now
 * every stamp comes from `stamp()`. The SQL defaults stay as a backstop for
 * rows written by hand in `sqlite3`.
 */

import { type SQL, eq, getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import { deviceId } from "../sync/peers.js";
import { isLogged } from "../sync/tables.js";
import type { Db } from "./index.js";
import { changelog } from "./schema.js";

let last = 0;

/**
 * One clock for the whole process, never going backwards.
 *
 * Two writes in the same millisecond get distinct, ordered stamps, so the
 * changelog can be read in `at` order and mean something.
 */
export function stamp(): number {
  last = Math.max(Date.now(), last + 1);
  return last;
}

/** Tables this module can write: everything with a ULID `id`. */
type Row = SQLiteTable & { id: unknown };

interface LogOptions {
  /**
   * The device that first made this change. Defaults to this one; sync passes
   * the original so a change keeps its provenance as it travels onward, which
   * is what makes three-device convergence work without extra bookkeeping.
   */
  origin?: string;
}

/**
 * A transaction handle. Narrowed to what this file needs so the callback's
 * drizzle type does not have to be spelled out at every call site.
 */
type Writer = Pick<Db, "insert">;

function record(
  tx: Writer,
  table: SQLiteTable,
  rowId: string,
  at: number,
  cols: string[],
  origin: string,
): void {
  const name = getTableName(table);
  if (!isLogged(name)) return;

  tx.insert(changelog).values({ tbl: name, rowId, at, origin, cols }).run();
}

/**
 * Whose change this is.
 *
 * `deviceId()` only touches `peers.json` when it is called, not when it is
 * imported, so a test that opens a store without writing to it never creates
 * the file.
 */
function device(options: LogOptions | undefined): string {
  return options?.origin ?? deviceId();
}

/**
 * Insert a row, and log every one of its columns.
 *
 * The whole row is logged rather than just what the caller supplied, because a
 * peer that has never seen this row has to be able to INSERT it — and that
 * means satisfying every NOT NULL, including the ones that came from a default.
 */
export function put<T extends Row>(
  db: Db,
  table: T,
  values: T["$inferInsert"],
  options?: LogOptions,
): T["$inferSelect"] {
  const [inserted] = putMany(db, table, [values], options);
  return inserted as T["$inferSelect"];
}

export function putMany<T extends Row>(
  db: Db,
  table: T,
  rows: T["$inferInsert"][],
  options?: LogOptions,
): T["$inferSelect"][] {
  if (rows.length === 0) return [];

  const origin = device(options);
  const columns = Object.keys(getTableColumns(table));

  return db.transaction((tx) => {
    const inserted = rows.map((values) => {
      const at = (values as { updatedAt?: number }).updatedAt ?? stamp();
      const [row] = tx
        .insert(table)
        .values({ createdAt: at, updatedAt: at, ...values })
        .returning()
        .all() as unknown as { id: string }[];

      record(tx, table, row!.id, at, columns, origin);
      return row;
    });

    return inserted as T["$inferSelect"][];
  });
}

/**
 * Update one row by id, and log the columns that actually changed.
 *
 * Unlike an insert this logs only what the caller passed, so two devices
 * editing different fields of the same row both keep their edit.
 */
export function patch<T extends Row>(
  db: Db,
  table: T,
  id: string,
  values: Partial<T["$inferInsert"]>,
  options?: LogOptions,
): T["$inferSelect"] | undefined {
  const origin = device(options);
  const at = (values as { updatedAt?: number }).updatedAt ?? stamp();
  const next = { ...values, updatedAt: at };

  return db.transaction((tx) => {
    const [row] = tx
      .update(table)
      .set(next)
      .where(eq(table.id as never, id))
      .returning()
      .all() as unknown as { id: string }[];

    if (!row) return undefined;

    record(tx, table, row.id, at, Object.keys(next), origin);
    return row as T["$inferSelect"];
  });
}

/**
 * Update every row matching `where`, logging each one.
 *
 * Needed because not every update is by id — deleting a project detaches its
 * threads, and agent detection updates a row it found by kind.
 */
export function patchWhere<T extends Row>(
  db: Db,
  table: T,
  where: SQL,
  values: Partial<T["$inferInsert"]>,
  options?: LogOptions,
): T["$inferSelect"][] {
  const origin = device(options);
  const at = (values as { updatedAt?: number }).updatedAt ?? stamp();
  const next = { ...values, updatedAt: at };

  return db.transaction((tx) => {
    const rows = tx.update(table).set(next).where(where).returning().all() as unknown as {
      id: string;
    }[];

    for (const row of rows) {
      record(tx, table, row.id, at, Object.keys(next), origin);
    }

    return rows as T["$inferSelect"][];
  });
}

/**
 * Soft-delete a row.
 *
 * There are no hard deletes anywhere in this codebase, which is why the
 * changelog needs no notion of one: a delete is a write to `deletedAt` like any
 * other column change, and it merges like one.
 */
export function bury<T extends Row>(
  db: Db,
  table: T,
  id: string,
  options?: LogOptions,
): T["$inferSelect"] | undefined {
  // `patch` stamps `updatedAt` itself, and uses that same stamp for the log
  // entry — so the delete and its timestamp cannot disagree.
  return patch(db, table, id, { deletedAt: stamp() } as Partial<T["$inferInsert"]>, options);
}
