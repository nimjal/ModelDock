/**
 * The tools ModelDock can point at itself, and where each one keeps its config.
 *
 * Pure metadata, like every other `catalog.ts` here — no filesystem, no JSON
 * merging, so the UI and the planner can both read it. Adding a third tool is
 * adding a row and a merge function, not a new code path.
 *
 * ## What this is, and why it is the inverse of `code/catalog.ts`
 *
 * `code/catalog.ts` describes agents ModelDock *drives*: it spawns them and
 * owns the transcript. This file describes the opposite arrangement — the tool
 * stays in charge, runs in its own terminal with its own session, and simply
 * gets its models from here. Someone who lives in Claude Code all day does not
 * want to move into ModelDock's Code surface; they want their keys, their model
 * choice and their local Llama available where they already work.
 *
 * Both directions are the same claim from opposite ends, which is why both
 * exist rather than one being the "real" integration.
 *
 * ## On writing into someone else's config
 *
 * This is the only place ModelDock writes outside `~/.modeldock`, and it is
 * treated accordingly: nothing is written without a preview being fetched and
 * an explicit apply, the existing file is copied to `<name>.modeldock.bak`
 * first, and the change is confined to one key that can be lifted back out.
 * `plan.ts` and `apply.ts` enforce that; this file only says where.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type HandoffKind = "claude_code" | "opencode";

export interface HandoffSpec {
  kind: HandoffKind;
  label: string;
  /** The file ModelDock would edit. */
  path: () => string;
  /**
   * What the tool calls ModelDock's base URL.
   *
   * Claude Code appends `/v1/messages` itself, so it gets the origin. OpenCode
   * hands the base URL to `@ai-sdk/openai-compatible`, which appends
   * `/chat/completions`, so it gets the `/v1` prefix included. Getting this
   * wrong produces a 404 that looks like the gateway is broken.
   */
  baseUrl: (origin: string) => string;
  /** Which of the gateway's two protocols this tool will speak. */
  protocol: "anthropic" | "openai";
  hint: string;
  /** Shown after applying: what the person still has to do themselves. */
  after: string;
}

/** `~/.config`, honouring XDG where it is set. OpenCode reads it the same way. */
function configHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/**
 * Claude Code's own directory.
 *
 * `CLAUDE_CONFIG_DIR` is Claude Code's documented override — someone running
 * two accounts side by side has it set, and writing to `~/.claude` regardless
 * would edit a file that session never reads. Honouring it is the difference
 * between the button working and the button appearing to work.
 */
function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export const HANDOFFS: Record<HandoffKind, HandoffSpec> = {
  claude_code: {
    kind: "claude_code",
    label: "Claude Code",
    path: () => join(claudeHome(), "settings.json"),
    // The origin only. Claude Code builds `/v1/messages` from this itself.
    baseUrl: (origin) => origin,
    protocol: "anthropic",
    hint: "Adds ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN to the env block in your Claude Code settings, so every session runs on ModelDock's models.",
    after:
      "Restart Claude Code, then pick a model with /model — they are named <connection>/<model>.",
  },
  opencode: {
    kind: "opencode",
    label: "OpenCode",
    path: () => join(configHome(), "opencode", "opencode.json"),
    // OpenCode passes this to @ai-sdk/openai-compatible, which appends
    // `/chat/completions` — so the `/v1` has to be here.
    baseUrl: (origin) => `${origin}/v1`,
    protocol: "openai",
    hint: "Adds a `modeldock` provider to your OpenCode config, listing every model this machine can reach.",
    after: "Restart OpenCode, then choose a modeldock/… model from the model picker.",
  },
};

export const HANDOFF_LIST: HandoffSpec[] = Object.values(HANDOFFS);

/** The provider key OpenCode's config gets, and the backup file's suffix. */
export const PROVIDER_KEY = "modeldock";
export const BACKUP_SUFFIX = ".modeldock.bak";
