/**
 * What every coding agent has to look like from the route's side.
 *
 * The adapter owns all of the engine-specific mess — spawning, event shapes,
 * session ids, abort semantics — and writes normalised chunks into a stream
 * the route knows nothing about. That is the same division `resolveModel`
 * makes for chat: one place per engine, and one path for everything after it.
 */

import type { UIMessage, UIMessageStreamWriter } from "ai";

import type { CodingAgent, Connection } from "../db/schema.js";
import type { AgentKind } from "./catalog.js";
import type { PermissionLevel } from "./permissions.js";

export interface RunContext {
  agent: CodingAgent;
  /** Already resolved through `projectRoot`. The agent runs here and nowhere else. */
  root: string;
  /**
   * The newest turn, flattened to text.
   *
   * Enough for an external engine, which keeps its own transcript and only
   * needs to be told what was just said. The built-in engine needs `history`.
   */
  prompt: string;
  /**
   * The whole conversation.
   *
   * The built-in engine has no memory outside this store, so this *is* its
   * session — which is also why its sessions are portable when the external
   * engines' are not.
   */
  history: UIMessage[];
  /**
   * The connection a built-in run uses. Null for the external engines, which
   * choose their own model and report it back in `RunResult`.
   *
   * Resolved by the route so a misconfigured provider fails before the stream
   * opens, the way `checkAgent` already does.
   */
  connection: Connection | null;
  /**
   * The project this session belongs to.
   *
   * The external engines get the skill index on stdin and read their own
   * `CLAUDE.md`/`AGENTS.md` for the rest. The built-in engine has no such
   * channel, so it builds the same system prompt an ordinary turn does — which
   * needs these two.
   */
  projectId: string | null;
  projectName: string | null;
  /** The engine's own session id from a previous turn, if it had one. */
  sessionId: string | null;
  permission: PermissionLevel;
  /** Rendered with absolute paths — coding agents read files themselves. */
  skillIndex: string | null;
  signal: AbortSignal;
}

export interface RunResult {
  /** Persisted to `threads.agentSessionId` so the next turn can resume. */
  sessionId: string | null;
  /** Whatever the engine reported it was using, for per-message attribution. */
  model: string | null;
}

export interface CodingAgentAdapter {
  kind: AgentKind;
  run(context: RunContext, writer: UIMessageStreamWriter): Promise<RunResult>;
}

/** Raised when an engine fails in a way worth showing the person verbatim. */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}
