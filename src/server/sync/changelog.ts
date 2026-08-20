/**
 * Reading the log, and applying what another device sends back.
 *
 * `db/write.ts` appends to `changelog`; this reads it. The split matters —
 * everything that writes goes through one file whether or not sync is running,
 * so a store has a complete log from the first turn, long before it is ever
 * paired with anything.
 *
 * Values are not in the log. An entry names a row and the columns that changed,
 * and the values are read from the live row when a peer asks for them. That
 * keeps the log small next to `messages.parts`, and it stays correct because
 * entries are applied in `seq` order and the last entry for a column is the
 * authoritative one. The honest consequence: this is a change index, not a
 * replayable history, and it cannot reconstruct a past state.
 */

import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { getTableColumns } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { changelog } from "../db/schema.js";
import { columnsToApply, type Clock } from "./merge.js";
import { APPLY_ORDER, syncedColumns, tableFor } from "./tables.js";

/** One change, with its values, as it travels between devices. */
export interface Change {
  /** The sender's log position. The receiver keeps it as a cursor. */
  seq: number;
  tbl: string;
  rowId: string;
  at: number;
  origin: string;
  /** Column name to value, already filtered to what may leave this machine. */
  cols: Record<string, unknown>;
}

/** Batches are capped; the exchange loops until both cursors stop moving. */
export const BATCH = 500;

/**
 * The `id` column of a synced table.
 *
 * `SQLiteTable` is the general type, so it does not carry the columns — but
 * every table in `SYNCED` has a ULID `id`, which `tests/schema.test.ts` checks.
 * One named cast beats the same assertion written out at four call sites.
 */
const idOf = (table: SQLiteTable) => (table as unknown as { id: SQLiteColumn }).id;

/** How far this store's log goes. */
export function head(db: Db): number {
  const row = db.get(sql`SELECT COALESCE(MAX(seq), 0) AS seq FROM changelog`) as { seq: number };
  return row.seq;
}

/**
 * Everything after `since`, oldest first, with values attached.
 *
 * Entries whose row has since vanished are skipped rather than sent as empty —
 * there are no hard deletes, so this only happens to a table that stopped being
 * synced between versions.
 */
export function changesSince(db: Db, since: number, limit = BATCH): Change[] {
  const entries = db
    .select()
    .from(changelog)
    .where(gt(changelog.seq, since))
    .orderBy(asc(changelog.seq))
    .limit(limit)
    .all();

  const out: Change[] = [];

  for (const entry of entries) {
    const table = tableFor(entry.tbl);
    if (!table) continue;

    const allowed = new Set(syncedColumns(entry.tbl, entry.cols));
    if (allowed.size === 0) continue;

    const row = db
      .select()
      .from(table)
      .where(eq(idOf(table), entry.rowId))
      .limit(1)
      .all()[0] as Record<string, unknown> | undefined;

    if (!row) continue;

    const cols: Record<string, unknown> = {};
    for (const column of allowed) {
      if (column in row) cols[column] = row[column];
    }

    // The id always travels: a peer that has never seen this row has to insert
    // it, and the primary key is not optional.
    cols.id = entry.rowId;

    out.push({
      seq: entry.seq,
      tbl: entry.tbl,
      rowId: entry.rowId,
      at: entry.at,
      origin: entry.origin,
      cols,
    });
  }

  return out;
}

/**
 * What this device knows about each column of the rows in a batch.
 *
 * One query per table rather than one per row: a batch of 500 messages would
 * otherwise be 500 round trips through better-sqlite3 for no reason.
 */
function clocksFor(db: Db, tbl: string, rowIds: string[]): Map<string, Map<string, Clock>> {
  const entries = db
    .select()
    .from(changelog)
    .where(and(eq(changelog.tbl, tbl), inArray(changelog.rowId, rowIds)))
    .orderBy(asc(changelog.seq))
    .all();

  const byRow = new Map<string, Map<string, Clock>>();

  for (const entry of entries) {
    let columns = byRow.get(entry.rowId);
    if (!columns) {
      columns = new Map();
      byRow.set(entry.rowId, columns);
    }

    for (const column of entry.cols) {
      const known = columns.get(column);
      // Later entries win by construction, but `at` is what the merge compares
      // and a remote change keeps its own `at` when applied — so this cannot
      // assume seq order implies time order.
      if (!known || entry.at >= known.at)
        columns.set(column, { at: entry.at, origin: entry.origin });
    }
  }

  return byRow;
}

/**
 * Write incoming changes, keeping whichever value the merge rule prefers.
 *
 * Each applied change is appended to this device's own log **with its original
 * origin**, so it can travel onward to a third device and still be recognised
 * as the same change. That is what makes convergence work without any
 * device-to-device bookkeeping beyond one cursor per peer.
 */
export function applyChanges(db: Db, incoming: Change[]): number {
  if (incoming.length === 0) return 0;

  // Foreign keys are on, so a message cannot be written before its thread.
  const ordered = [...incoming].sort((a, b) => {
    const table = APPLY_ORDER.indexOf(a.tbl) - APPLY_ORDER.indexOf(b.tbl);
    return table !== 0 ? table : a.at - b.at;
  });

  const byTable = new Map<string, Change[]>();
  for (const change of ordered) {
    const list = byTable.get(change.tbl) ?? [];
    list.push(change);
    byTable.set(change.tbl, list);
  }

  const clocks = new Map<string, Map<string, Map<string, Clock>>>();
  for (const [tbl, changes] of byTable) {
    clocks.set(
      tbl,
      clocksFor(
        db,
        tbl,
        changes.map((change) => change.rowId),
      ),
    );
  }

  let applied = 0;

  db.transaction((tx) => {
    for (const change of ordered) {
      const table = tableFor(change.tbl);
      if (!table) continue;

      const known = clocks.get(change.tbl)?.get(change.rowId) ?? new Map<string, Clock>();
      const allowed = new Set(syncedColumns(change.tbl, Object.keys(change.cols)));

      const proposed: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(change.cols)) {
        if (allowed.has(column) || column === "id") proposed[column] = value;
      }

      const winning = columnsToApply(change, proposed, known);
      // `id` is never a conflict; it is how the row is identified at all.
      delete winning.id;

      const columns = getTableColumns(table);
      const existing = tx
        .select()
        .from(table)
        .where(eq(idOf(table), change.rowId))
        .limit(1)
        .all()[0] as Record<string, unknown> | undefined;

      if (!existing) {
        // A row this device has never seen. Everything the sender offered is
        // new, whatever the clocks said.
        const values: Record<string, unknown> = { id: change.rowId };
        for (const [column, value] of Object.entries(proposed)) {
          if (column in columns) values[column] = value;
        }
        // Timestamps travel with the row, so its age is the same everywhere.
        values.createdAt ??= change.at;
        values.updatedAt ??= change.at;

        tx.insert(table)
          .values(values as never)
          .run();
        applied++;
      } else {
        const values: Record<string, unknown> = {};
        for (const [column, value] of Object.entries(winning)) {
          if (column in columns) values[column] = value;
        }
        if (Object.keys(values).length === 0) continue;

        tx.update(table)
          .set(values as never)
          .where(eq(idOf(table), change.rowId))
          .run();
        applied++;
      }

      tx.insert(changelog)
        .values({
          tbl: change.tbl,
          rowId: change.rowId,
          at: change.at,
          origin: change.origin,
          cols: Object.keys(change.cols).filter((column) => column !== "id"),
        })
        .run();
    }
  });

  return applied;
}

/**
 * Seed the log for a store that predates it.
 *
 * Rows written before `write.ts` existed have no entries, so a first sync would
 * send nothing and the two devices would silently disagree. Stamping each live
 * row at `max(createdAt, updatedAt)` also repairs the old clock inversion by
 * construction — the two timestamps came from different sources with different
 * resolutions, and the later of them is the honest one.
 */
export function seedLog(db: Db, origin: string): number {
  let seeded = 0;

  for (const tbl of APPLY_ORDER) {
    const table = tableFor(tbl);
    if (!table) continue;

    const known = new Set(
      db
        .select({ rowId: changelog.rowId })
        .from(changelog)
        .where(eq(changelog.tbl, tbl))
        .all()
        .map((row) => row.rowId),
    );

    const columns = Object.keys(getTableColumns(table));
    const rows = db.select().from(table).all() as Record<string, unknown>[];

    db.transaction((tx) => {
      for (const row of rows) {
        const id = String(row.id);
        if (known.has(id)) continue;

        const at = Math.max(Number(row.createdAt ?? 0), Number(row.updatedAt ?? 0));
        tx.insert(changelog).values({ tbl, rowId: id, at, origin, cols: columns }).run();
        seeded++;
      }
    });
  }

  return seeded;
}

/** Unused here, but the obvious next thing: collapse duplicate (row, column). */
export const compactable = { isNull, BATCH };
