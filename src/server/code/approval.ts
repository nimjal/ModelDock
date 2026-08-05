/**
 * Asking before a tool runs.
 *
 * The mechanism is the AI SDK's own: `toolApproval` on `streamText` names the
 * tools that need a decision, the model's request for one arrives as a
 * `tool-approval-request` chunk, and the answer comes back as part of the
 * message history on the next request. ModelDock adds the policy and the key,
 * and nothing else.
 *
 * Using the SDK's path rather than a ModelDock-owned one buys the property that
 * matters most here: **an approval survives a reload.** The pause is a request
 * boundary, not a held-open stream — the step ends, the HTTP response
 * completes, and the assistant message is persisted with the pending call in
 * it. Close the browser, reopen it, and the prompt is still there, because it
 * is a row rather than an in-memory promise. Holding the stream open and
 * resolving it from a side-channel would need a durable pending-approval store
 * and a reconnect protocol to reach the same place.
 *
 * Only the built-in engine can do this. OpenCode and Claude Code run their loop
 * inside their own process, so the moment between choosing a tool and running
 * it is not ours to pause — see `permissions.ts`.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { approvalSecretPath } from "../config.js";
import type { PermissionLevel } from "./permissions.js";

/**
 * Tools that are never silently run at `ask`.
 *
 * Reading is not on the list on purpose. A prompt for every `read_file` is a
 * prompt people learn to dismiss without reading, which is worse than not
 * asking — the whole value of the pause is that it is rare enough to be read.
 * What changes the world gets a decision; what only looks does not.
 */
const NEEDS_APPROVAL = ["write_file", "edit_file", "run_command"] as const;

/**
 * The `toolApproval` policy for a level.
 *
 * Empty at every level except `ask`, so this is also the switch that makes the
 * feature exist at all.
 */
export function approvalFor(level: PermissionLevel): Record<string, "user-approval"> {
  if (level !== "ask") return {};
  return Object.fromEntries(NEEDS_APPROVAL.map((name) => [name, "user-approval"])) as Record<
    string,
    "user-approval"
  >;
}

let cached: string | null = null;

/**
 * The key that binds an approval to the exact call it was given for.
 *
 * Without it a client can send back `approved: true` for an input it invented,
 * and the server has no way to tell that from the input the model actually
 * proposed — approving `rm -rf /` because the page said so. The SDK signs the
 * request and verifies the response; this just has to be stable and secret.
 *
 * Stable across restarts is the load-bearing half: a key regenerated on boot
 * would invalidate every pending approval, which is exactly the case the
 * feature exists to survive.
 */
export function approvalSecret(): string {
  if (cached) return cached;

  const path = approvalSecretPath();

  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) {
      cached = existing;
      return cached;
    }
  } catch {
    // Not there yet, which is the ordinary first-run case.
  }

  const secret = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX mode; the file is in the user's profile regardless.
  }

  cached = secret;
  return secret;
}

/** Only tests need this: they move `MODELDOCK_HOME` between files. */
export function forgetSecret(): void {
  cached = null;
}
