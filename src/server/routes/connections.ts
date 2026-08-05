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
import { KINDS, KIND_LIST, type ConnectionKind } from "../providers/catalog.js";
import { checkConnection } from "../providers/registry.js";

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

  return c.json({ connections: rows.map(present), kinds: KIND_LIST });
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
