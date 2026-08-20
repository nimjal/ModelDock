/**
 * What is and is not working, in one call.
 *
 * The Python version's `doctor` was the most quietly useful thing in it: BYOK
 * setups fail for boring environmental reasons — a variable set in one shell
 * but not the one that launched the app — and a person needs to be told
 * which, not shown a failed request. Same idea here, reported to the UI and
 * to `modeldock doctor`.
 */

import { and, count, isNotNull, isNull } from "drizzle-orm";
import { Hono } from "hono";

import { modeldockHome, databasePath } from "../config.js";
import { db } from "../db/index.js";
import { connections, memories, projects, skills, threads } from "../db/schema.js";
import { AGENT_LIST } from "../code/catalog.js";
import { agentsFresh, checkAgent } from "../code/registry.js";
import { keyStatus, keysLocation, savedNames } from "../keys.js";
import { checkConnection } from "../providers/registry.js";
import { syncSkills } from "../skills/scan.js";

export const healthRoutes = new Hono();

export interface Check {
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const database = db();

  checks.push({
    label: "Store",
    status: "ok",
    detail: databasePath(),
  });

  const rows = await database.select().from(connections).where(isNull(connections.deletedAt)).all();

  if (rows.length === 0) {
    checks.push({
      label: "Connections",
      status: "warn",
      detail: "None yet. Add one to start chatting.",
    });
  } else {
    for (const row of rows) {
      const status = checkConnection(row);
      // Where the key came from, named on the row that uses it. Without this,
      // a connection that works because of a key typed into the app looks
      // identical to one working off a variable exported in this shell — and
      // when the two disagree, that is exactly what someone needs to know.
      const source = row.apiKeyEnv ? keyStatus(row.apiKeyEnv).source : null;
      checks.push({
        label: row.name,
        status: status.ok ? "ok" : "warn",
        detail: status.ok
          ? [`${row.kind} · ${row.model}`, source === "file" ? "saved key" : null]
              .filter(Boolean)
              .join(" · ")
          : // A connection that is merely unconfigured is a warning, not a
            // failure: it is normal to keep several and have keys for some.
            status.problem!,
      });
    }
  }

  // Where saved keys live, and whether any is standing in front of a variable
  // this shell also exports. The second case is the one that produces "I
  // changed the key and nothing happened", so it is reported rather than left
  // to be discovered.
  const saved = savedNames();
  const shadowing = saved.filter((name) => keyStatus(name).shadowsEnvironment);
  checks.push({
    label: "Keys",
    status: shadowing.length > 0 ? "warn" : "ok",
    detail:
      saved.length === 0
        ? "none saved here — keys are read from this environment"
        : shadowing.length > 0
          ? `${saved.length} in ${keysLocation().path}; ${shadowing.join(", ")} also set in this environment and the saved one is used`
          : `${saved.length} in ${keysLocation().path}`,
  });

  // Coding agents. Absent is a warning, not a failure — most people will not
  // have both, and Code simply does not appear when there is none.
  const agents = await agentsFresh(database);

  if (agents.length === 0) {
    for (const spec of AGENT_LIST) {
      checks.push({ label: spec.label, status: "warn", detail: `not found. ${spec.installHint}` });
    }
  } else {
    for (const agent of agents) {
      const status = checkAgent(agent);
      checks.push({
        label: agent.name,
        status: status.ok ? "ok" : "warn",
        detail: status.ok
          ? [agent.version, agent.baseUrl ?? agent.command].filter(Boolean).join(" · ")
          : status.problem!,
      });
    }
  }

  // A skill whose SKILL.md cannot be understood is never sent to the model.
  // Saying so here is the difference between "that skill does not work" and
  // "skills do not work", which are very different conclusions to reach.
  await syncSkills(database, {});
  const broken = await database
    .select()
    .from(skills)
    .where(and(isNull(skills.deletedAt), isNotNull(skills.problem)))
    .all();

  for (const skill of broken) {
    checks.push({ label: skill.slug, status: "warn", detail: skill.problem! });
  }

  return checks;
}

healthRoutes.get("/health", async (c) => {
  const database = db();

  const [threadCount] = await database
    .select({ total: count() })
    .from(threads)
    .where(isNull(threads.deletedAt));
  const [projectCount] = await database
    .select({ total: count() })
    .from(projects)
    .where(isNull(projects.deletedAt));
  const [memoryCount] = await database
    .select({ total: count() })
    .from(memories)
    .where(isNull(memories.deletedAt));

  return c.json({
    home: modeldockHome(),
    checks: await runChecks(),
    counts: {
      threads: threadCount?.total ?? 0,
      projects: projectCount?.total ?? 0,
      memories: memoryCount?.total ?? 0,
    },
  });
});
