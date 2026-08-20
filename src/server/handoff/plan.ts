/**
 * What would change, computed before anything is written.
 *
 * Every handoff is the same three steps: read whatever is there now, produce
 * what it should become, and describe the difference. The screen shows that
 * description and nothing happens until someone agrees to it, which is the
 * whole reason a plan is a separate thing from an apply.
 *
 * ## The merge is surgical on purpose
 *
 * These are files people have edited by hand and care about. A handoff adds one
 * key and leaves every other byte of the structure alone — it never rewrites a
 * config it did not fully understand, and it never removes something it did not
 * add. `revert` is the same operation backwards: lift out exactly the keys that
 * were put in, and leave anything added since.
 *
 * Comments are the known casualty and it is worth being honest about it:
 * `JSON.parse` drops them, so a re-serialised file loses any it had. That is
 * why the backup exists and why the diff is shown first rather than described.
 */

import { readFile } from "node:fs/promises";

import { gatewayCatalog, type GatewayCatalog } from "../gateway/catalog.js";
import { gatewayToken } from "../gateway/token.js";
import type { Db } from "../db/index.js";
import { HANDOFFS, PROVIDER_KEY, type HandoffKind, type HandoffSpec } from "./catalog.js";

export interface HandoffPlan {
  kind: HandoffKind;
  label: string;
  path: string;
  hint: string;
  after: string;
  /** Whether the file exists at all. A fresh one is created rather than edited. */
  exists: boolean;
  /** True when the file already says what the plan would make it say. */
  applied: boolean;
  /** The file as it is now. Empty string when there is none. */
  current: string;
  /** The file as it would become. */
  proposed: string;
  /** A unified-ish diff of the two, for the preview. */
  diff: DiffLine[];
  /** Set when the file exists but could not be parsed — nothing will be written. */
  problem: string | null;
  /** How many models this tool would gain. */
  modelCount: number;
}

export interface DiffLine {
  kind: "same" | "add" | "remove";
  text: string;
}

/** Stable output, so the diff does not churn on unrelated re-reads. */
function serialise(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * A line diff, good enough for a config file preview.
 *
 * Longest-common-subsequence over lines. Both sides here are pretty-printed
 * JSON of a few dozen lines, so the quadratic table is measured in kilobytes
 * and a dependency for this would be hard to justify in a project that has kept
 * its runtime dependencies to nine.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];

  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ kind: "remove", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "remove", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });

  return out;
}

/** Read a JSON config, distinguishing "not there" from "not parseable". */
async function readConfig(
  path: string,
): Promise<{ text: string; value: Record<string, unknown>; problem: string | null }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { text: "", value: {}, problem: null };
  }

  if (!text.trim()) return { text, value: {}, problem: null };

  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { text, value: {}, problem: "That file does not contain a JSON object." };
    }
    return { text, value: value as Record<string, unknown>, problem: null };
  } catch (error) {
    return {
      text,
      value: {},
      // Named rather than swallowed: a config with a trailing comma is a thing
      // someone can fix in ten seconds once they are told which file.
      problem: `That file is not valid JSON (${(error as Error).message}), so ModelDock will not rewrite it. Fix or move it and try again.`,
    };
  }
}

/** Claude Code: two variables in the `env` block, and nothing else touched. */
function planClaudeCode(
  config: Record<string, unknown>,
  spec: HandoffSpec,
  origin: string,
  token: string,
): Record<string, unknown> {
  const env = (
    config.env && typeof config.env === "object" && !Array.isArray(config.env)
      ? { ...(config.env as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  env.ANTHROPIC_BASE_URL = spec.baseUrl(origin);
  env.ANTHROPIC_AUTH_TOKEN = token;

  return { ...config, env };
}

/** OpenCode: one provider block, replaced wholesale, siblings untouched. */
function planOpenCode(
  config: Record<string, unknown>,
  spec: HandoffSpec,
  origin: string,
  token: string,
  catalog: GatewayCatalog,
  /** False when ModelDock is creating this file rather than editing one. */
  exists: boolean,
): Record<string, unknown> {
  const provider = (
    config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)
      ? { ...(config.provider as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  // OpenCode does not discover models from an endpoint — it lists what the
  // config declares — so the whole catalogue is written out here. That is also
  // why re-running the handoff after adding a connection is worth doing.
  const models: Record<string, unknown> = {};
  for (const model of catalog.models) {
    models[model.id] = { name: `${model.label ?? model.model} (${model.connectionName})` };
  }

  provider[PROVIDER_KEY] = {
    npm: "@ai-sdk/openai-compatible",
    name: "ModelDock",
    options: { baseURL: spec.baseUrl(origin), apiKey: token },
    models,
  };

  return {
    /**
     * Only on a file ModelDock is creating.
     *
     * It is tempting to add this to an existing config too — OpenCode uses it
     * for editor completion, and a config without one feels second class. But
     * `revert` promises to remove exactly what was added and nothing else, and
     * a `$schema` is not something it can take back out without guessing
     * whether the person had since come to rely on it. Adding a key that
     * revert cannot remove would make that promise false for one line, which
     * is worse than the missing convenience.
     */
    ...(exists ? {} : { $schema: "https://opencode.ai/config.json" }),
    ...config,
    provider,
  };
}

/** The origin the gateway is reachable at, as another program must address it. */
export function gatewayOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function planHandoff(
  db: Db,
  kind: HandoffKind,
  port: number,
  catalog?: GatewayCatalog,
): Promise<HandoffPlan> {
  const spec = HANDOFFS[kind];
  const path = spec.path();
  const origin = gatewayOrigin(port);
  const token = gatewayToken();

  const models = catalog ?? (await gatewayCatalog(db));
  const { text, value, problem } = await readConfig(path);

  const next =
    kind === "claude_code"
      ? planClaudeCode(value, spec, origin, token)
      : planOpenCode(value, spec, origin, token, models, Boolean(text));

  const proposed = serialise(next);
  // Compared against the re-serialised current config rather than the raw
  // bytes, so a difference in indentation alone does not read as a change.
  const normalisedCurrent = text.trim() ? serialise(value) : "";

  return {
    kind,
    label: spec.label,
    path,
    hint: spec.hint,
    after: spec.after,
    exists: Boolean(text),
    applied: !problem && normalisedCurrent === proposed,
    current: normalisedCurrent,
    proposed,
    diff: problem ? [] : diffLines(normalisedCurrent, proposed),
    problem,
    modelCount: models.models.length,
  };
}
