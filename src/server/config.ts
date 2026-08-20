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

/**
 * Where a key typed into the app is kept.
 *
 * Beside the database, never in it. The store's rule is unchanged and
 * unconditional — `connections.apiKeyEnv` holds the *name* of a variable, and
 * a synced or copied `modeldock.db` still contains no credentials. This file
 * is the other half of that arrangement: somewhere local and unsynced for the
 * values, so that "bring your own key" does not have to mean "leave the app
 * and export a variable".
 *
 * It is loaded into `process.env` at startup, which is why nothing downstream
 * had to change. `providers/registry.ts` still reads the environment at call
 * time and still cannot tell where a value came from.
 */
export function keysPath(): string {
  return join(modeldockHome(), "keys.env");
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

/**
 * The port this process is actually listening on.
 *
 * Not the same question as `resolvePort()`, which reports what the environment
 * *asks for* and knows nothing about `--port`. The difference does not matter
 * anywhere else in the app — every other caller is answering a browser on the
 * connection it arrived by — but it matters completely to the handoff, which
 * writes an absolute URL into another program's config file. Getting it from
 * the environment meant `modeldock --port 8792` pointed Claude Code at 8765 and
 * produced a config that looked right and connected to nothing.
 *
 * Set once by `createApp`, which is given the real port by whoever serves.
 */
let serving = DEFAULT_PORT;

export function setServingPort(port: number): void {
  serving = port;
}

export function servingPort(): number {
  return serving;
}
