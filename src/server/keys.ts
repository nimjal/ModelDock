/**
 * Keys, kept beside the store rather than in it.
 *
 * The rule the database keeps is unchanged: `connections.apiKeyEnv` holds the
 * *name* of an environment variable, resolved from `process.env` at the moment
 * a request is made, so a store that is backed up, copied or synced to another
 * machine still contains no credentials. Nothing in `providers/registry.ts`
 * knows this file exists.
 *
 * What this adds is somewhere for the value to live on *this* machine. Exporting
 * a variable before launching is a fine mechanism and remains the documented
 * one, but it is a bad first five minutes: it fails silently in the wrong shell,
 * it cannot be fixed from inside the app, and it asks someone to learn their
 * platform's export syntax before they have seen a single reply. So a key typed
 * into the app is written here and loaded into `process.env` at startup, and
 * every downstream reader is left exactly as it was.
 *
 * Two decisions worth stating plainly.
 *
 * **This file wins over an inherited variable.** Someone who typed a key into
 * the app did so deliberately and most recently, and a saved key that silently
 * does nothing because an old variable is still exported in some shell profile
 * is precisely the confusion the whole feature exists to remove. The value that
 * was shadowed is remembered for the process lifetime, so removing a key here
 * restores it rather than leaving a hole. `doctor` and the Connections screen
 * both report which source a key came from, so the precedence is visible rather
 * than merely documented.
 *
 * **The name is checked, not just the value.** These names arrive over HTTP and
 * are written into `process.env` of a process that spawns coding agents and
 * shells. A variable that changes how a program starts — `PATH`,
 * `NODE_OPTIONS`, `LD_PRELOAD` — is not a credential, and accepting one would
 * turn a settings form into a way to run code. The allowed shape is narrow and
 * the deny list is explicit.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { keysPath, modeldockHome } from "./config.js";

export class KeyError extends Error {}

/** Shell-exportable and unambiguous. Anything else is refused rather than mangled. */
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names that are never a credential and always a way to change how a program
 * starts. A child process inherits `process.env`, so writing any of these would
 * hand a spawned agent or shell an execution hook.
 */
const REFUSED = new Set([
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SHELL",
  "IFS",
  "ENV",
  "BASH_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "RUBYOPT",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "WINDIR",
  "TMPDIR",
  "TMP",
  "TEMP",
]);

/** Names this process has loaded from the file, and what each one shadowed. */
const loaded = new Map<string, string>();
const shadowed = new Map<string, string | undefined>();

export type KeySource = "file" | "environment";

export interface KeyStatus {
  name: string;
  set: boolean;
  /** Where the live value came from, or null when there is no value. */
  source: KeySource | null;
  /** Last four characters, so a key can be recognised without being revealed. */
  tail: string | null;
  /** Set when this file's value is standing in front of an inherited one. */
  shadowsEnvironment: boolean;
}

export function checkName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new KeyError("Give the variable a name.");
  if (!NAME_SHAPE.test(trimmed)) {
    throw new KeyError(
      `"${trimmed}" is not a usable variable name — letters, digits and underscores only.`,
    );
  }
  if (REFUSED.has(trimmed.toUpperCase()) || trimmed.toUpperCase().startsWith("MODELDOCK_")) {
    throw new KeyError(
      `${trimmed} changes how programs on this machine start, so ModelDock will not set it. Use the variable your provider documents.`,
    );
  }
  return trimmed;
}

/**
 * Read the file.
 *
 * A line that cannot be understood is skipped rather than thrown, because one
 * bad line must not cost someone every other key they have saved.
 */
function readFile(): Map<string, string> {
  const values = new Map<string, string>();
  const path = keysPath();
  if (!existsSync(path)) return values;

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return values;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf("=");
    if (split <= 0) continue;
    const name = trimmed.slice(0, split).trim();
    const value = trimmed.slice(split + 1);
    if (!NAME_SHAPE.test(name) || !value) continue;
    values.set(name, value);
  }
  return values;
}

function writeFile(values: Map<string, string>): void {
  const path = keysPath();
  mkdirSync(dirname(path), { recursive: true });

  const body = [
    "# ModelDock — API keys for this machine.",
    "#",
    "# Loaded into the environment at startup. Never synced, never written to",
    "# modeldock.db, and safe to delete: removing a line only means the",
    "# connection using it reports as not ready again.",
    "",
    ...[...values].map(([name, value]) => `${name}=${value}`),
    "",
  ].join("\n");

  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  try {
    // Re-applied because `mode` only takes effect when the file is created, and
    // this one is usually being rewritten. A no-op on Windows, where the file
    // is protected by the profile directory it sits in instead.
    chmodSync(path, 0o600);
  } catch {
    /* not fatal — the value is still only readable by this account */
  }
}

/**
 * Put saved keys into the environment. Call once, before anything serves.
 *
 * Returns how many were applied so the CLI can say so. Safe to call twice: the
 * shadow map only records what was there the first time.
 */
export function loadKeys(): number {
  const values = readFile();

  for (const [name, value] of values) {
    if (!shadowed.has(name)) shadowed.set(name, process.env[name]);
    process.env[name] = value;
    loaded.set(name, value);
  }
  return values.size;
}

export function keyStatus(name: string): KeyStatus {
  const value = process.env[name];
  const fromFile = loaded.has(name) && loaded.get(name) === value;

  return {
    name,
    set: Boolean(value),
    source: value ? (fromFile ? "file" : "environment") : null,
    tail: value && value.length >= 4 ? value.slice(-4) : null,
    shadowsEnvironment: fromFile && Boolean(shadowed.get(name)),
  };
}

/** Every name this machine has a saved value for. */
export function savedNames(): string[] {
  return [...readFile().keys()].sort();
}

export function saveKey(name: string, value: string): KeyStatus {
  const checked = checkName(name);
  const trimmed = value.trim();

  if (!trimmed) throw new KeyError("Paste the key, or remove it instead.");
  // A newline would end the line early and silently split one key into a
  // corrupt pair, so it is refused rather than stripped.
  if (/[\r\n]/.test(value)) throw new KeyError("A key cannot contain a line break.");

  const values = readFile();
  values.set(checked, trimmed);
  writeFile(values);

  if (!shadowed.has(checked)) shadowed.set(checked, process.env[checked]);
  process.env[checked] = trimmed;
  loaded.set(checked, trimmed);

  return keyStatus(checked);
}

/**
 * Forget a key.
 *
 * Whatever this file was standing in front of comes back, so someone who had
 * `ANTHROPIC_API_KEY` exported before they ever opened ModelDock is returned to
 * exactly where they started rather than to a broken connection.
 */
export function deleteKey(name: string): KeyStatus {
  const checked = checkName(name);

  const values = readFile();
  const existed = values.delete(checked);
  if (existed) writeFile(values);

  const original = shadowed.get(checked);
  if (original === undefined) delete process.env[checked];
  else process.env[checked] = original;

  loaded.delete(checked);
  shadowed.delete(checked);

  return keyStatus(checked);
}

/** Shown on the Connections screen so the file is findable, not magic. */
export function keysLocation(): { path: string; home: string } {
  return { path: keysPath(), home: modeldockHome() };
}
