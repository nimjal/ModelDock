/**
 * Writing the change, and taking it back out.
 *
 * The only code in ModelDock that writes outside `~/.modeldock`, which is why
 * every step here is conservative:
 *
 *   - nothing is written unless `plan.ts` produced a plan with no `problem`,
 *     so a config that could not be parsed is never rewritten from a partial
 *     understanding of it;
 *   - the existing file is copied to `<name>.modeldock.bak` first, and the
 *     copy is only taken when there is no backup yet — so re-applying twice
 *     cannot overwrite the pristine original with an already-modified one;
 *   - `revert` removes exactly the keys the handoff added and leaves the rest,
 *     rather than restoring the backup wholesale, because anything else the
 *     person changed since should survive.
 *
 * The backup is a fallback for the case revert cannot express, not the primary
 * undo. That distinction is why both exist.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Db } from "../db/index.js";
import { HttpError } from "../errors.js";
import { BACKUP_SUFFIX, HANDOFFS, PROVIDER_KEY, type HandoffKind } from "./catalog.js";
import { planHandoff, type HandoffPlan } from "./plan.js";

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the file aside, once.
 *
 * Guarded on the backup not already existing. Without that, applying a second
 * time would back up the already-modified file and destroy the only copy of
 * what was there before ModelDock touched it.
 */
async function backup(path: string): Promise<string | null> {
  if (!(await exists(path))) return null;

  const target = `${path}${BACKUP_SUFFIX}`;
  if (await exists(target)) return target;

  await copyFile(path, target);
  return target;
}

export interface HandoffResult {
  plan: HandoffPlan;
  backupPath: string | null;
}

/**
 * Point a tool at ModelDock.
 *
 * The plan is recomputed here rather than taken from the client, so what gets
 * written is what the server decided and not what a request body claimed. The
 * preview the person approved and the bytes that land are produced by the same
 * function; a file that changed in between simply produces a different plan and
 * a fresh diff on the next fetch.
 */
export async function applyHandoff(
  db: Db,
  kind: HandoffKind,
  port: number,
): Promise<HandoffResult> {
  const plan = await planHandoff(db, kind, port);

  if (plan.problem) throw new HttpError(400, plan.problem);

  const backupPath = await backup(plan.path);

  await mkdir(dirname(plan.path), { recursive: true });
  await writeFile(plan.path, plan.proposed, "utf8");

  return { plan: await planHandoff(db, kind, port), backupPath };
}

/** Remove what a handoff added, leaving everything else in place. */
function withoutHandoff(
  kind: HandoffKind,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === "claude_code") {
    const env = config.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) return config;

    const next = { ...(env as Record<string, unknown>) };
    delete next.ANTHROPIC_BASE_URL;
    delete next.ANTHROPIC_AUTH_TOKEN;

    // An `env` block that only ever held these two goes away entirely, so
    // reverting returns the file to the shape it had rather than leaving an
    // empty object behind as a scar.
    const rest = { ...config };
    if (Object.keys(next).length === 0) delete rest.env;
    else rest.env = next;
    return rest;
  }

  const provider = config.provider;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return config;

  const next = { ...(provider as Record<string, unknown>) };
  delete next[PROVIDER_KEY];

  const rest = { ...config };
  if (Object.keys(next).length === 0) delete rest.provider;
  else rest.provider = next;
  return rest;
}

/**
 * Undo the handoff.
 *
 * Reads the file as it stands, lifts out the keys this feature owns, and
 * writes the rest back. A config someone has since added their own provider to
 * keeps it; a config that is now unparseable is refused rather than replaced,
 * with the backup named in the message so there is somewhere to go.
 */
export async function revertHandoff(
  db: Db,
  kind: HandoffKind,
  port: number,
): Promise<HandoffResult> {
  const spec = HANDOFFS[kind];
  const path = spec.path();

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    // Nothing there is the state revert was trying to reach.
    return { plan: await planHandoff(db, kind, port), backupPath: null };
  }

  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    config = parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(
      400,
      `${path} is no longer valid JSON, so ModelDock will not rewrite it. A copy of the original is at ${path}${BACKUP_SUFFIX}.`,
    );
  }

  const next = withoutHandoff(kind, config);
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  return { plan: await planHandoff(db, kind, port), backupPath: null };
}
