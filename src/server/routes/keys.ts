/**
 * Keys: the one route in ModelDock that accepts a secret.
 *
 * Everything else in `routes/` is built on never touching one — `connections.ts`
 * says so at the top and means it. This file is the deliberate exception, and
 * the boundary is one-directional: a value can be **written** here, and can
 * never be read back. `GET` returns whether a variable is set, where the value
 * came from and its last four characters; there is no endpoint that returns a
 * key, and adding one would undo the reason the rest of the app is shaped this
 * way.
 *
 * The value goes to `~/.modeldock/keys.env` and into `process.env` — never into
 * the database, which still holds only the name. See `keys.ts` for why the file
 * takes precedence over an inherited variable, and for the names it refuses.
 */

import { asc, isNull } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/index.js";
import { connections } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { deleteKey, KeyError, keyStatus, keysLocation, savedNames, saveKey } from "../keys.js";
import { PRESETS } from "../providers/catalog.js";

export const keyRoutes = new Hono();

/**
 * Every variable worth reporting on.
 *
 * Three sources, because each answers a different question: what has been saved
 * here, what the connections on this machine actually need, and what the
 * providers on the setup screen conventionally use. A name in the second group
 * with no value is the exact case `doctor` exists to catch.
 */
async function relevantNames(): Promise<string[]> {
  const rows = await db()
    .select({ env: connections.apiKeyEnv })
    .from(connections)
    .where(isNull(connections.deletedAt))
    .orderBy(asc(connections.createdAt))
    .all();

  const names = new Set<string>();
  for (const name of savedNames()) names.add(name);
  for (const row of rows) if (row.env) names.add(row.env);
  for (const preset of PRESETS) if (preset.apiKeyEnv) names.add(preset.apiKeyEnv);

  return [...names].sort();
}

keyRoutes.get("/keys", async (c) => {
  const names = await relevantNames();
  return c.json({ keys: names.map(keyStatus), ...keysLocation() });
});

keyRoutes.put("/keys/:name", async (c) => {
  const body = await c.req.json<{ value?: string }>();

  try {
    return c.json({ key: saveKey(c.req.param("name"), body.value ?? "") });
  } catch (error) {
    // A rejected name or a malformed value is the caller's mistake and has a
    // sentence explaining it; anything else is a real failure and rises.
    if (error instanceof KeyError) throw new HttpError(400, error.message);
    throw error;
  }
});

keyRoutes.delete("/keys/:name", async (c) => {
  try {
    return c.json({ key: deleteKey(c.req.param("name")) });
  } catch (error) {
    if (error instanceof KeyError) throw new HttpError(400, error.message);
    throw error;
  }
});
