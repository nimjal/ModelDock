/**
 * Where ModelDock keeps its things, and how it is reached.
 *
 * Everything ModelDock owns lives in one directory so it can be backed up,
 * inspected, or deleted as a unit. Nothing here is written anywhere else.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 8765;
export const HOST = "127.0.0.1";

/** `~/.modeldock`, overridable so tests never touch a real install. */
export function modeldockHome(): string {
  return process.env.MODELDOCK_HOME ?? join(homedir(), ".modeldock");
}

export function databasePath(): string {
  return join(modeldockHome(), "modeldock.db");
}

/**
 * The key that signs tool-approval decisions.
 *
 * Beside the database rather than in it, for the same reason the pairing token
 * is: `schema.ts` promises a stolen or synced store contains no credentials,
 * and this one has to stay stable across restarts — an approval that survives
 * a page reload is the whole point of the feature.
 */
export function approvalSecretPath(): string {
  return join(modeldockHome(), "secret");
}

export function resolvePort(): number {
  const raw = process.env.MODELDOCK_PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`MODELDOCK_PORT must be a port number, got "${raw}"`);
  }
  return port;
}
