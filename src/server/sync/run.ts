/**
 * Syncing with everything this device is paired with.
 *
 * Its own file because it is the one place that knows about both halves — the
 * transport-agnostic exchange loop and the HTTP transport that constructs one
 * per peer. Putting it in `transport.ts` would have made that module import
 * `peer-http.ts`, which imports it back.
 *
 * A peer that cannot be reached is reported, not thrown. Syncing three devices
 * where one laptop is shut is the ordinary case, not an error.
 */

import type { Db } from "../db/index.js";
import { seedLog } from "./changelog.js";
import { httpTransport } from "./peer-http.js";
import { deviceId, listPeers, saveCursor } from "./peers.js";
import { exchange, SKEW_WARNING_MS } from "./transport.js";

export interface PeerResult {
  peer: string;
  pushed: number;
  pulled: number;
  /** Set when the two clocks are far enough apart to resolve edits wrongly. */
  skew?: string;
  error?: string;
}

export interface SyncReport {
  peers: PeerResult[];
  pushed: number;
  pulled: number;
  /** Rows given a log entry because they predate the log. First run only. */
  seeded: number;
}

export async function syncAll(db: Db): Promise<SyncReport> {
  // Rows written before the log existed have no entries, so a first sync would
  // send nothing and the two devices would quietly disagree forever.
  const seeded = seedLog(db, deviceId());

  const peers = listPeers().filter((peer) => peer.url);
  const results: PeerResult[] = [];

  for (const peer of peers) {
    try {
      const result = await exchange(db, httpTransport(peer), {
        pushedThrough: peer.pushedThrough,
        pulledThrough: peer.pulledThrough,
      });

      saveCursor(peer.id, result.cursor);

      results.push({
        peer: peer.label,
        pushed: result.pushed,
        pulled: result.pulled,
        // Nothing here can fix a clock, so it is said out loud rather than
        // worked around: last-writer-wins on skewed clocks resolves edits in
        // the wrong order, and silently.
        ...(result.skewMs > SKEW_WARNING_MS
          ? { skew: `clocks are ${Math.round(result.skewMs / 60000)} minutes apart` }
          : {}),
      });
    } catch (error) {
      results.push({
        peer: peer.label,
        pushed: 0,
        pulled: 0,
        error: (error as Error).message,
      });
    }
  }

  return {
    peers: results,
    pushed: results.reduce((total, result) => total + result.pushed, 0),
    pulled: results.reduce((total, result) => total + result.pulled, 0),
    seeded,
  };
}

/** The one line `modeldock sync` prints. */
export function summarise(report: SyncReport): string {
  if (report.peers.length === 0) return "No paired devices. Run `modeldock pair --host` on one.";
  return `pushed ${report.pushed} ${plural(report.pushed)}, pulled ${report.pulled}`;
}

const plural = (n: number) => (n === 1 ? "change" : "changes");
