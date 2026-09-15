/**
 * Connections: how to reach a model.
 *
 * Nothing here ever accepts or returns an API key. The client sends the
 * *name* of an environment variable; the server reports whether that variable
 * is currently set. A key never crosses this boundary in either direction,
 * which is what lets the database be synced or backed up without becoming a
 * credential leak.
 *
 * A script connection is the one row that carries something executable, and
 * this is the route that stores it. That is safe for the reason every other
 * write here is: `/api` is loopback-only and Origin-checked in `app.ts`, so the
 * only page that can send a script is ModelDock's own. What a stored script can
 * then do is set out in `scripts/runtime.ts`.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/index.js";
import { connections, type Connection } from "../db/schema.js";
import { patch, patchWhere, put, stamp } from "../db/write.js";
import { HttpError } from "../errors.js";
import { canGenerateImages } from "../images/catalog.js";
import { KINDS, KIND_LIST, PRESETS, type ConnectionKind } from "../providers/catalog.js";
import { listModels } from "../providers/models.js";
import { checkConnection, resolveApiKey } from "../providers/registry.js";
import { inspectScript } from "../scripts/runtime.js";
import { SCRIPT_TEMPLATES } from "../scripts/templates.js";

export const connectionRoutes = new Hono();

/**
 * The safe projection: config plus readiness, never a secret.
 *
 * Asynchronous because a script's readiness includes whether it loads, which
 * only the module can answer. Modules are cached by content, so after the first
 * listing that costs a hash.
 */
async function present(row: Connection) {
  const spec = KINDS[row.kind];
  const status = checkConnection(row);
  const inspection = row.kind === "script" && row.script?.trim() ? await inspectScript(row) : null;

  // Only a script that loads can be believed about what it offers. One that does
  // not is shown everywhere a connection is, not ready, so the reason is visible
  // from wherever someone goes looking for it.
  const known = inspection && !inspection.problem ? inspection : null;

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
    /** The source, for the editor. Set only on a script connection. */
    script: row.kind === "script" ? (row.script ?? "") : null,
    /**
     * What this connection can be asked to do. Known from the kind for a vendor,
     * and asked of the module for a script — the berth leaves out whatever
     * cannot chat, and the image picker whatever cannot draw.
     */
    capabilities: {
      chat: known ? known.chat : true,
      image: known ? known.image : canGenerateImages(row.kind),
      models: known ? known.models : true,
    },
    ready: status.ok && !inspection?.problem,
    problem: status.problem ?? inspection?.problem ?? null,
  };
}

/** A UNIQUE violation on the name, as the sentence someone should see. */
function nameTaken(error: unknown, name: string | undefined): never {
  if (error instanceof Error && error.message.includes("UNIQUE")) {
    throw new HttpError(409, `A connection named "${name}" already exists.`);
  }
  throw error;
}

connectionRoutes.get("/connections", async (c) => {
  const rows = await db()
    .select()
    .from(connections)
    .where(isNull(connections.deletedAt))
    .orderBy(asc(connections.createdAt))
    .all();

  return c.json({
    connections: await Promise.all(rows.map(present)),
    kinds: KIND_LIST,
    presets: PRESETS,
    templates: SCRIPT_TEMPLATES,
  });
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
      script: row.script,
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
 * value — the browser has no key to send and is never asked for one. For a
 * script it carries the draft source, which is how the editor lists models
 * before anything is saved.
 */
connectionRoutes.post("/models", async (c) => {
  const body = await c.req.json<{
    kind?: ConnectionKind;
    baseUrl?: string | null;
    apiKeyEnv?: string | null;
    label?: string;
    script?: string | null;
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
      script: body.script,
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
    script?: string | null;
  }>();

  const name = body.name?.trim();
  const model = body.model?.trim();
  if (!name) throw new HttpError(400, "Give the connection a name.");
  if (!body.kind || !KINDS[body.kind]) throw new HttpError(400, "Pick a provider kind.");
  if (!model) throw new HttpError(400, "Give the connection a model.");

  const spec = KINDS[body.kind];
  const baseUrl = body.baseUrl?.trim() || spec.defaultBaseUrl;
  if (spec.baseUrlRequired && !baseUrl) {
    throw new HttpError(400, `${spec.label} needs a base URL.`);
  }

  // Saved even if it does not load yet. Work in progress should survive a
  // syntax error, and the row reports the error until it is fixed.
  let script: string | null = null;
  if (body.kind === "script") {
    script = body.script ?? "";
    if (!script.trim()) {
      throw new HttpError(400, "Write the script, or start from one of the templates.");
    }
  }

  try {
    const row = put(db(), connections, {
      name,
      kind: body.kind,
      baseUrl: baseUrl || null,
      model,
      apiKeyEnv: body.apiKeyEnv?.trim() || spec.defaultApiKeyEnv,
      script,
    });

    return c.json({ connection: await present(row) }, 201);
  } catch (error) {
    nameTaken(error, name);
  }
});

connectionRoutes.patch("/connections/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    baseUrl?: string | null;
    model?: string;
    apiKeyEnv?: string | null;
    script?: string;
  }>();

  const changes: Record<string, unknown> = {};
  if (body.name !== undefined) changes.name = body.name.trim();
  if (body.baseUrl !== undefined) changes.baseUrl = body.baseUrl?.trim() || null;
  if (body.model !== undefined) changes.model = body.model.trim();
  if (body.apiKeyEnv !== undefined) changes.apiKeyEnv = body.apiKeyEnv?.trim() || null;

  if (body.script !== undefined) {
    const [current] = await db()
      .select({ kind: connections.kind })
      .from(connections)
      .where(eq(connections.id, id))
      .limit(1);
    // Turning a vendor row into a script in place would change what a row
    // synced from another device means there, without its script. The editor
    // makes a new connection instead; this refuses the shortcut.
    if (current && current.kind !== "script") {
      throw new HttpError(400, "Only a script connection has a script to change.");
    }
    if (!body.script.trim()) {
      throw new HttpError(
        400,
        "A script connection needs a script. Remove the connection instead.",
      );
    }
    changes.script = body.script;
  }

  let row: Connection | undefined;
  try {
    row = patch(db(), connections, id, changes);
  } catch (error) {
    nameTaken(error, body.name?.trim());
  }
  if (!row) throw new HttpError(404, `No connection ${id}`);

  return c.json({ connection: await present(row) });
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
