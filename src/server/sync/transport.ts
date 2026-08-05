/**
 * Moving changes between two devices, and the loop that does it.
 *
 * The interface is deliberately small and deliberately client-side only: one
 * machine initiates and the other answers. That asymmetry is what makes this
 * work on a laptop — only the machine that is usually on has to be reachable,
 * and the one behind NAT does the asking.
 *
 * `peer-http.ts` is the transport that ships. The tests use an in-process one,
 * which is the real argument for the interface existing: the merge semantics
 * can be tested against two live stores with no ports, no sockets and no
 * flakiness.
 */

import type { Db } from "../db/index.js";
import { BATCH, applyChanges, changesSince, head, type Change } from "./changelog.js";

export interface Transport {
  /** For the CLI's output and for error messages. */
  readonly label: string;
  /** The peer's device id, so its own changes are not echoed back to it. */
  readonly deviceId: string;
  /** Hand over changes. Returns the sender-side seq the peer has now stored. */
  push(changes: Change[]): Promise<{ ack: number }>;
  /** Everything after `since`, plus the peer's wall clock. */
  pull(since: number, limit: number): Promise<{ changes: Change[]; seq: number; clock: number }>;
}

/** Where an exchange with one peer got to. */
export interface Cursor {
  pushedThrough: number;
  pulledThrough: number;
}

export interface Exchange {
  pushed: number;
  pulled: number;
  cursor: Cursor;
  /** How far apart the two clocks are, in ms. */
  skewMs: number;
}

/**
 * More than this and last-writer-wins starts resolving edits in the wrong
 * order. Nothing can be done about it here — the fix is the person's clock —
 * so it is reported rather than worked around.
 */
export const SKEW_WARNING_MS = 5 * 60 * 1000;

/**
 * Push, then pull, until neither side has anything left.
 *
 * Runs until the cursors stop moving rather than once, because a batch is
 * capped: a first sync of a year's conversations is many rounds, and stopping
 * after one would leave the two stores quietly different.
 */
export async function exchange(db: Db, transport: Transport, from: Cursor): Promise<Exchange> {
  const cursor: Cursor = { ...from };
  let pushed = 0;
  let pulled = 0;
  let skewMs = 0;

  // Push everything this device knows that the peer does not.
  for (;;) {
    const batch = changesSince(db, cursor.pushedThrough, BATCH);
    if (batch.length === 0) break;

    // Its own changes are not worth sending back. They would merge to a no-op,
    // but on a slow link that is real time spent saying nothing.
    const worth = batch.filter((change) => change.origin !== transport.deviceId);
    const last = batch[batch.length - 1]!.seq;

    if (worth.length > 0) {
      await transport.push(worth);
      pushed += worth.length;
    }

    cursor.pushedThrough = last;
    if (batch.length < BATCH) break;
  }

  // Then take everything the peer has that this device does not.
  for (;;) {
    const { changes, clock } = await transport.pull(cursor.pulledThrough, BATCH);
    if (clock) skewMs = Math.abs(Date.now() - clock);
    if (changes.length === 0) break;

    pulled += applyChanges(db, changes);
    cursor.pulledThrough = changes[changes.length - 1]!.seq;

    if (changes.length < BATCH) break;
  }

  return { pushed, pulled, cursor, skewMs };
}

/**
 * The other half of the conversation, for whichever listener is answering.
 *
 * Kept here rather than in `peer-http.ts` so a second transport would not have
 * to reimplement it.
 */
export function serveRequest(db: Db) {
  return {
    push(changes: Change[]): { ack: number } {
      applyChanges(db, changes);
      return { ack: changes.length > 0 ? changes[changes.length - 1]!.seq : 0 };
    },

    pull(since: number, limit = BATCH) {
      return {
        changes: changesSince(db, since, Math.min(limit, BATCH)),
        seq: head(db),
        clock: Date.now(),
      };
    },
  };
}
