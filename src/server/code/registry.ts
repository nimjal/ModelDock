/**
 * Finding the coding agents someone already has.
 *
 * ModelDock never bundles or installs an agent. It looks for what is on the
 * machine, and if nothing is there the Code surface simply does not appear —
 * with `modeldock doctor` explaining how to install one. That keeps
 * `npx modeldock` small for the majority who only ever chat, and it means the
 * agent someone uses here is the same one they have already configured, with
 * their own commands and their own project files.
 *
 * Detection is lazy and cached. Probing two or three binaries across PATH plus
 * a handful of well-known directories costs a few hundred milliseconds on a
 * cold Windows filesystem, which is far too much to pay on every request — so
 * it happens on the first `GET /api/agents` and then only on demand.
 */

import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { codingAgents, connections, type CodingAgent, type Connection } from "../db/schema.js";
import { patch, put } from "../db/write.js";
import { checkConnection } from "../providers/registry.js";
import {
  AGENT_LIST,
  AGENTS,
  BINARY_AGENTS,
  type AgentKind,
  type BinaryAgentSpec,
  type BuiltinAgentSpec,
} from "./catalog.js";
import { spawnCommand } from "./spawn.js";

/** Long enough that a re-probe is cheap, short enough to notice an install. */
const CACHE_MS = 60_000;

let lastDetect = 0;

/** Windows needs an extension to consider a file executable. */
function windowsExtensions(): string[] {
  return (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
}

async function executable(path: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const info = await stat(path);
      return info.isFile();
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a command name to an absolute path.
 *
 * Hand-rolled rather than taking `which`: it is about twenty lines, and a
 * dependency for this would be hard to justify in a project that has kept its
 * runtime dependency list to nine.
 */
export async function onPath(name: string, extraDirs: string[] = []): Promise<string | null> {
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...extraDirs];

  // On Windows the extension has to be tried *first*. npm installs both
  // `claude` (a POSIX shell script, unusable here) and `claude.cmd` into the
  // same directory, and picking the bare name finds a file Windows cannot
  // execute — detection then reports the agent as present but every run fails.
  const candidates = process.platform === "win32" ? [...windowsExtensions(), ""] : [""];

  for (const dir of dirs) {
    for (const extension of candidates) {
      const candidate = join(dir, `${name}${extension}`);
      if (await executable(candidate)) return candidate;
    }
  }
  return null;
}

/** Ask the binary what it is. Bounded, because a hung probe blocks a request. */
async function probeVersion(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      // Through the same helper the adapter uses, so a version that probes
      // successfully is one that can actually be run.
      const child = spawnCommand(command, args, { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";

      const timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, 3000);

      child.stdout?.on("data", (buffer: Buffer) => {
        out += buffer.toString();
      });
      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on("close", () => {
        clearTimeout(timer);
        finish(out.split(/\r?\n/)[0]?.trim() || null);
      });
    } catch {
      finish(null);
    }
  });
}

async function locate(
  spec: BinaryAgentSpec,
): Promise<{ command: string; version: string | null } | null> {
  for (const name of spec.commands) {
    const command = await onPath(name, spec.extraDirs());
    if (!command) continue;
    return { command, version: await probeVersion(command, spec.versionArgs) };
  }
  return null;
}

/**
 * Probe for every known agent and record what is there.
 *
 * A detected agent that later disappears is marked `detected: false` rather
 * than deleted, so a row someone edited by hand — a wrapper command, a remote
 * base URL — survives an uninstall of the binary it was originally found at.
 */
/**
 * A fixed id per agent kind.
 *
 * Detection already treats "one row per kind" as its invariant — it selects by
 * kind and updates whatever it finds — so naming the id after the kind is
 * simply saying that out loud. It also means two machines that both detect
 * Claude Code produce the *same* row rather than two rows that collide on the
 * UNIQUE `name` when they sync, and it makes `threads.agentId` resolve on
 * either machine.
 */
function agentId(kind: AgentKind): string {
  const slot = AGENT_LIST.findIndex((spec) => spec.kind === kind) + 1;
  return `0000000000AGENT${String(slot).padStart(11, "0")}`;
}

/** The row for an agent kind, if this store has one. */
async function rowFor(db: Db, kind: AgentKind) {
  const [row] = await db
    .select()
    .from(codingAgents)
    .where(and(eq(codingAgents.kind, kind), isNull(codingAgents.deletedAt)))
    .limit(1);
  return row;
}

/**
 * Keep the built-in engine's row in step with what it needs to run.
 *
 * There is no binary to probe, so "detected" means something different here:
 * whether there is a connection for it to run on. Pointing it at the first live
 * one is a starting position, not a decision — the row is editable like any
 * other, and a thread can override it.
 */
async function detectBuiltin(db: Db, spec: BuiltinAgentSpec): Promise<void> {
  const [connection] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(isNull(connections.deletedAt))
    .orderBy(asc(connections.createdAt))
    .limit(1);

  const existing = await rowFor(db, spec.kind);

  if (!existing) {
    put(db, codingAgents, {
      id: agentId(spec.kind),
      name: spec.label,
      kind: spec.kind,
      connectionId: connection?.id ?? null,
      detected: Boolean(connection),
    });
    return;
  }

  // A connection the person chose is left alone; only the readiness flag and an
  // unset pointer are maintained.
  const connectionId = existing.connectionId ?? connection?.id ?? null;
  const detected = Boolean(connectionId);

  if (existing.connectionId !== connectionId || existing.detected !== detected) {
    patch(db, codingAgents, existing.id, { connectionId, detected });
  }
}

export async function detectAgents(db: Db): Promise<CodingAgent[]> {
  const builtin = AGENTS.builtin;
  if (builtin.discovery === "connection") await detectBuiltin(db, builtin);

  for (const spec of BINARY_AGENTS) {
    const found = await locate(spec);

    const existing = await rowFor(db, spec.kind);

    if (!found) {
      if (existing?.detected) {
        patch(db, codingAgents, existing.id, { detected: false });
      }
      continue;
    }

    if (existing) {
      // A hand-configured command wins; detection only refreshes the version.
      patch(
        db,
        codingAgents,
        existing.id,
        existing.detected
          ? { command: found.command, version: found.version, detected: true }
          : { version: found.version },
      );
    } else {
      put(db, codingAgents, {
        id: agentId(spec.kind),
        name: spec.label,
        kind: spec.kind,
        command: found.command,
        version: found.version,
        authTokenEnv: spec.defaultTokenEnv,
        detected: true,
      });
    }
  }

  lastDetect = Date.now();
  return listAgents(db);
}

export async function listAgents(db: Db): Promise<CodingAgent[]> {
  return db.select().from(codingAgents).where(isNull(codingAgents.deletedAt)).all();
}

/** List, detecting first if the cache has gone cold. */
export async function agentsFresh(db: Db, force = false): Promise<CodingAgent[]> {
  if (force || Date.now() - lastDetect > CACHE_MS) return detectAgents(db);
  return listAgents(db);
}

/**
 * Whether this row can actually be run right now, and why not if it cannot.
 *
 * The built-in engine takes a `Connection` because its readiness *is* the
 * connection's readiness — and answering with `checkConnection`'s own words
 * means `doctor` says "ANTHROPIC_API_KEY is not set in this environment"
 * rather than a second, vaguer sentence that means the same thing.
 */
export function checkAgent(
  agent: CodingAgent,
  connection?: Connection | null,
): { ok: boolean; problem?: string } {
  const spec = AGENTS[agent.kind as AgentKind];

  if (spec?.discovery === "connection") {
    if (!agent.connectionId) {
      return { ok: false, problem: "Pick a connection for the built-in engine to run on." };
    }
    if (!connection) {
      return { ok: false, problem: "The connection this agent runs on is gone." };
    }
    return checkConnection(connection);
  }

  if (agent.baseUrl) {
    if (!(spec?.discovery === "binary" && spec.supportsRemote)) {
      return {
        ok: false,
        problem: `${spec?.label ?? agent.kind} cannot attach to a remote server.`,
      };
    }
    if (agent.authTokenEnv && !process.env[agent.authTokenEnv]) {
      return { ok: false, problem: `Set ${agent.authTokenEnv} to reach ${agent.baseUrl}.` };
    }
    return { ok: true };
  }

  if (!agent.command) {
    return { ok: false, problem: spec?.installHint ?? "Not found on this machine." };
  }

  return { ok: true };
}
