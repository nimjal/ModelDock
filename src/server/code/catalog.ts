/**
 * The coding agents ModelDock knows how to drive.
 *
 * Pure metadata, no imports from the adapters — the same split as
 * `providers/catalog.ts`, so the detection layer and the UI can both read this
 * without pulling in a subprocess or an SDK.
 *
 * The point of having more than one is that people already have an agent set
 * up the way they like it, with their own slash commands, their own AGENTS.md
 * or CLAUDE.md, their own MCP servers. Making them adopt a different one to
 * use ModelDock would be the same mistake as making them adopt a different
 * model provider. ModelDock owns the transcript; which agent produced it is a
 * column, exactly as it is for chat.
 *
 * There is deliberately no `accent` here. The provider colour on the Berth
 * means "ModelDock chose this model for you" — a coding agent chooses its own,
 * so the Code surface spends no colour and says so in `--ink-2`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { PermissionLevel } from "./permissions.js";

export type AgentKind = "opencode" | "claude_code" | "builtin";

/** What the fields every agent has, whatever it is underneath. */
interface AgentBase {
  kind: AgentKind;
  label: string;
  /** Whether a follow-up turn can continue an earlier session. */
  supportsResume: boolean;
  installHint: string;
  hint: string;
  /**
   * The permission levels this agent can actually honour.
   *
   * Data rather than a special case: the composer renders the levels for the
   * thread's own agent, so `ask` can be offered where it works and simply not
   * appear where it does not.
   */
  levels: readonly PermissionLevel[];
}

/**
 * An agent that is a program on this machine.
 *
 * Everything here is about finding and running a binary, which is why this is a
 * union rather than one interface with half the fields nullable — a built-in
 * engine has no command to probe, no version to report and nothing to install,
 * and saying that with `commands: []` would be a lie the compiler could not
 * catch.
 */
export interface BinaryAgentSpec extends AgentBase {
  kind: "opencode" | "claude_code";
  discovery: "binary";
  /** The engine keeps its own transcript and resumes by session id. */
  session: "engine";
  /** Binary names to probe, in order of preference. */
  commands: string[];
  versionArgs: string[];
  /** Places to look beyond PATH, because GUI apps often do not inherit it. */
  extraDirs: () => string[];
  defaultTokenEnv: string | null;
  /** Whether this agent can attach to an already-running server. */
  supportsRemote: boolean;
}

/** An agent that is a ModelDock connection running the loop itself. */
export interface BuiltinAgentSpec extends AgentBase {
  kind: "builtin";
  discovery: "connection";
  /**
   * The session *is* this store's transcript.
   *
   * Which is the quiet advantage over the external engines: a Claude Code
   * session only resumes on the machine whose `~/.claude` holds it, so
   * `threads.agentSessionId` does not travel. A built-in session has nothing
   * outside `messages`, so it resumes anywhere the store reaches.
   */
  session: "store";
}

export type AgentSpec = BinaryAgentSpec | BuiltinAgentSpec;

function common(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    return [
      join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs"),
      join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"),
      join(home, ".bun", "bin"),
      join(home, ".local", "bin"),
    ];
  }
  return [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/**
 * What an external engine can be asked for.
 *
 * `ask` is missing on purpose. Approving a call one at a time requires being
 * able to pause the loop between the model choosing a tool and that tool
 * running, and for these two the loop is inside someone else's process. See
 * `permissions.ts`.
 */
const EXTERNAL_LEVELS = ["read", "edit", "full"] as const;

export const AGENTS: Record<AgentKind, AgentSpec> = {
  opencode: {
    kind: "opencode",
    discovery: "binary",
    session: "engine",
    label: "OpenCode",
    commands: ["opencode"],
    versionArgs: ["--version"],
    extraDirs: common,
    // OpenCode's own `serve` has no auth. A bearer token only means anything
    // in front of a reverse proxy, which is why this is null by default.
    defaultTokenEnv: null,
    supportsRemote: true,
    supportsResume: true,
    levels: EXTERNAL_LEVELS,
    installHint: "Install with: curl -fsSL https://opencode.ai/install | bash",
    hint: "Open source, provider-agnostic. ModelDock starts and stops its server for you.",
  },
  claude_code: {
    kind: "claude_code",
    discovery: "binary",
    session: "engine",
    label: "Claude Code",
    commands: ["claude"],
    versionArgs: ["--version"],
    extraDirs: () => [...common(), join(homedir(), ".claude", "local")],
    defaultTokenEnv: "ANTHROPIC_API_KEY",
    supportsRemote: false,
    supportsResume: true,
    levels: EXTERNAL_LEVELS,
    installHint: "Install with: npm install -g @anthropic-ai/claude-code",
    hint: "Uses your existing Claude Code login, CLAUDE.md and slash commands.",
  },
  builtin: {
    kind: "builtin",
    discovery: "connection",
    session: "store",
    label: "ModelDock",
    supportsResume: true,
    // The only agent that can be asked before each call, because it is the only
    // one whose tool loop runs in this process.
    levels: ["read", "edit", "full", "ask"],
    installHint: "",
    hint: "Runs the loop on one of your connections. Nothing else to install.",
  },
};

export const AGENT_LIST: AgentSpec[] = Object.values(AGENTS);

/** The ones that are a program to be found on this machine. */
export const BINARY_AGENTS: BinaryAgentSpec[] = AGENT_LIST.filter(
  (spec): spec is BinaryAgentSpec => spec.discovery === "binary",
);
