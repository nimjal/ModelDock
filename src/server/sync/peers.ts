/**
 * Who this machine is, and who it is paired with.
 *
 * This lives in `~/.modeldock/peers.json` rather than in the database, and
 * that is load-bearing in two ways.
 *
 * The first is the credential rule. `schema.ts` promises that a stolen or
 * synced database contains no secrets, and a pairing token is a secret. Keeping
 * it out of the store is what lets the database be backed up, copied between
 * machines, or synced without ever becoming a credential leak.
 *
 * The second is subtler. Because the device id is *not* in the database, someone
 * who bootstraps a second machine by copying `modeldock.db` gets a new identity
 * rather than a duplicate one. The copied changelog entries carry the original
 * device's origin, so they replay as no-ops instead of fighting with it. The
 * arrangement self-heals; the alternative silently corrupts.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ulid } from "ulid";

import { modeldockHome } from "../config.js";

export interface Peer {
  id: string;
  label: string;
  url: string;
  token: string;
  /** Our changelog seq the peer has acknowledged. */
  pushedThrough: number;
  /** The peer's changelog seq we have applied. */
  pulledThrough: number;
}

interface PeersFile {
  self: string;
  peers: Peer[];
}

export function peersPath(): string {
  return join(modeldockHome(), "peers.json");
}

function read(): PeersFile | null {
  try {
    const parsed = JSON.parse(readFileSync(peersPath(), "utf8")) as Partial<PeersFile>;
    if (typeof parsed.self !== "string" || !parsed.self) return null;
    return { self: parsed.self, peers: Array.isArray(parsed.peers) ? parsed.peers : [] };
  } catch {
    // Missing or unreadable. Either way there is nothing to recover, and the
    // caller mints a fresh identity — which is the right answer for a file
    // whose whole job is to say "this machine is new".
    return null;
  }
}

export function write(file: PeersFile): void {
  const path = peersPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    // `writeFileSync`'s mode only applies when it creates the file, so an
    // existing one keeps whatever it had.
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX mode. The file is in the user's profile either way.
  }
}

let cached: string | null = null;

/**
 * This device's id, minted on first use.
 *
 * A ULID, like every other id in the store, so it sorts and compares the same
 * way — which matters because it is the tie-break when two devices change the
 * same column in the same millisecond.
 */
export function deviceId(): string {
  if (cached) return cached;

  const existing = read();
  if (existing) {
    cached = existing.self;
    return cached;
  }

  const self = ulid();
  write({ self, peers: [] });
  cached = self;
  return self;
}

export function listPeers(): Peer[] {
  return read()?.peers ?? [];
}

/** Add or replace a pairing, keeping this device's identity. */
export function savePeer(peer: Peer): void {
  const self = deviceId();
  const peers = listPeers().filter((existing) => existing.id !== peer.id);
  write({ self, peers: [...peers, peer] });
}

/**
 * Record how far an exchange with one peer got.
 *
 * Written after every round rather than at the end, so an interrupted sync
 * resumes where it stopped instead of starting over. Re-sending is harmless —
 * a change that loses the merge is a no-op — but on a first sync of a year's
 * conversations, "harmless" is still several minutes.
 */
export function saveCursor(
  id: string,
  cursor: { pushedThrough: number; pulledThrough: number },
): void {
  const peer = listPeers().find((existing) => existing.id === id);
  if (!peer) return;
  savePeer({ ...peer, ...cursor });
}

export function removePeer(id: string): boolean {
  const peers = listPeers();
  const left = peers.filter((peer) => peer.id !== id);
  if (left.length === peers.length) return false;

  write({ self: deviceId(), peers: left });
  return true;
}

/** Only tests need this: they change `MODELDOCK_HOME` between files. */
export function forgetDevice(): void {
  cached = null;
}
