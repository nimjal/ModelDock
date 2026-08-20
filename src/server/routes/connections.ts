/**
 * Connections: how to reach a model.
 *
 * Nothing here ever accepts or returns an API key. The client sends the
 * *name* of an environment variable; the server reports whether that variable
 * is currently set. A key never crosses this boundary in either direction,
 * which is what lets the database be synced or backed up without becoming a
 * credential leak.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/index.js";
import { connections, type Connection } from "../db/schema.js";
import { patch, patchWhere, put, stamp } from "../db/write.js";
import { HttpError } from "../errors.js";
import { KINDS, KIND_LIST, PRESETS, type ConnectionKind } from "../providers/catalog.js";
import { listModels } from "../providers/models.js";
import { checkConnection, resolveApiKey } from "../providers/registry.js";

export const connectionRoutes = new Hono();

/** The safe projection: config plus readiness, never a secret. */
function present(row: Connection) {
  const spec = KINDS[row.kind];
  const status = checkConnection(row);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    label: spec?.label ?? row.kind,
    accent: spec?.accent ?? KINDS.openai_compatible.accent,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKeyEnv: row.apiKeyEnv,
    apiKeySet: row.apiKeyEnv ? Boolean(process.env[row.apiKeyEnv]) : false,
    ready: status.ok,
    problem: status.problem ?? null,
  };
}

connectionRoutes.get("/connections", async (c) => {
  const rows = await db()
    .select()
    .from(connections)
    .where(isNull(connections.deletedAt))
    .orderBy(asc(connections.createdAt))
    .all();

  return c.json({ connections: rows.map(present), kinds: KIND_LIST, presets: PRESETS });
});

/**
 * What this connection can actually run.
 *
 * Asked of the provider, not of a list in this repository — see
 * `providers/models.ts`. The key never leaves the server: the browser asks
 * about a connection *id*, and the value is resolved here from the environment
 * exactly as it would be for a real turn.
 *
 * A failure is a 502 rather than a 500 because the thing that failed is
 * upstream, and the message says which upstream and what to do about it.
 */
connectionRoutes.get("/connections/:id/models", async (c) => {
  const id = c.req.param("id");
  const [row] = await db()
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), isNull(connections.deletedAt))!)
    .limit(1);

  if (!row) throw new HttpError(404, `No connection ${id}`);

  try {
    const models = await listModels({
      kind: row.kind,
      baseUrl: row.baseUrl,
      apiKey: resolveApiKey(row),
      label: row.name,
    });
    return c.json({ models });
  } catch (error) {
    throw new HttpError(502, (error as Error).message);
  }
});

/**
 * The same question, before a connection exists.
 *
 * This is what makes first-run setup work in one pass: paste a key, see the
 * real list, pick from it. The body names an environment *variable*, never a
 * value — the browser has no key to send and is never asked for one.
 */
connectionRoutes.post("/models", async (c) => {
  const body = await c.req.json<{
    kind?: ConnectionKind;
    baseUrl?: string | null;
    apiKeyEnv?: string | null;
    label?: string;
  }>();

  if (!body.kind || !KINDS[body.kind]) throw new HttpError(400, "Pick a provider kind.");
  const spec = KINDS[body.kind];

  const name = body.label?.trim() || spec.label;
  const apiKeyEnv = body.apiKeyEnv?.trim() || null;

  try {
    const models = await listModels({
      kind: body.kind,
      baseUrl: body.baseUrl?.trim() || spec.defaultBaseUrl,
      // Reuses the connection rule so the "not set in this environment"
      // message is identical whether or not a row exists yet.
      apiKey: resolveApiKey({ kind: body.kind, apiKeyEnv, name }),
      label: name,
    });
    return c.json({ models });
  } catch (error) {
    throw new HttpError(502, (error as Error).message);
  }
});

connectionRoutes.post("/connections", async (c) => {
  const body = await c.req.json<{
    name?: string;
    kind?: ConnectionKind;
    baseUrl?: string | null;
    model?: string;
    apiKeyEnv?: string | null;
  }>();

  const name = body.name?.trim();
  const model = body.model?.trim();
  if (!name) throw new HttpError(400, "Give the connection a name.");
  if (!body.kind || !KINDS[body.kind]) throw new HttpError(400, "Pick a provider kind.");
  if (!model) throw new HttpError(400, "Give the connection a model.");

  const spec = KINDS[body.kind];
  const baseUrl = body.baseUrl?.trim() || spec.defaultBaseUrl;
  if (spec.baseUrlEditable && !baseUrl) {
    throw new HttpError(400, `${spec.label} needs a base URL.`);
  }

  try {
    const row = put(db(), connections, {
      name,
      kind: body.kind,
      baseUrl: baseUrl || null,
      model,
      apiKeyEnv: body.apiKeyEnv?.trim() || spec.defaultApiKeyEnv,
    });

    return c.json({ connection: present(row) }, 201);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      throw new HttpError(409, `A connection named "${name}" already exists.`);
    }
    throw error;
  }
});

connectionRoutes.patch("/connections/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    baseUrl?: string | null;
    model?: string;
    apiKeyEnv?: string | null;
  }>();

  const changes: Record<string, unknown> = {};
  if (body.name !== undefined) changes.name = body.name.trim();
  if (body.baseUrl !== undefined) changes.baseUrl = body.baseUrl?.trim() || null;
  if (body.model !== undefined) changes.model = body.model.trim();
  if (body.apiKeyEnv !== undefined) changes.apiKeyEnv = body.apiKeyEnv?.trim() || null;

  const row = patch(db(), connections, id, changes);
  if (!row) throw new HttpError(404, `No connection ${id}`);

  return c.json({ connection: present(row) });
});

connectionRoutes.delete("/connections/:id", async (c) => {
  const id = c.req.param("id");
  // Matched on `deletedAt IS NULL` as well as the id, so deleting something
  // already deleted is a 404 rather than a silent success.
  const [row] = patchWhere(
    db(),
    connections,
    and(eq(connections.id, id), isNull(connections.deletedAt))!,
    { deletedAt: stamp() },
  );

  if (!row) throw new HttpError(404, `No connection ${id}`);
  return c.json({ ok: true });
});
