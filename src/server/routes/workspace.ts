/**
 * The workspace's own two settings: where a chat starts, and what draws.
 *
 * Both are a connection id plus an optional model, and both report enough for
 * the screen to explain itself without a second round trip — which connection
 * was resolved, whether it can actually run, and which connections are even
 * eligible to be picked for images.
 *
 * Nothing here touches a key, the same as everywhere else: the client sends
 * ids, and readiness is computed server-side from the environment.
 */

import { asc, isNull } from "drizzle-orm";
import { Hono } from "hono";

import { db, type Db } from "../db/index.js";
import { connections, type Connection } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { IMAGE_KIND_LIST, canGenerateImages, imageKindFor } from "../images/catalog.js";
import { checkConnection } from "../providers/registry.js";
import { chatDefault, imageEngine, updateWorkspace, workspaceRow } from "../workspace.js";

export const workspaceRoutes = new Hono();

/**
 * Live connections, oldest first.
 *
 * `.all()` is synchronous — better-sqlite3 is a synchronous driver — so this
 * returns an array rather than a promise, and callers simply use it.
 */
const live = (db: Db): Connection[] =>
  db
    .select()
    .from(connections)
    .where(isNull(connections.deletedAt))
    .orderBy(asc(connections.createdAt))
    .all();

/**
 * The safe projection, in one place so GET and PATCH cannot describe the same
 * row differently. The same reasoning as `present()` in `connections.ts`.
 */
async function present(database: Db) {
  const row = await workspaceRow(database);
  const rows = live(database);

  const resolved = await chatDefault(database);
  const resolvedConnection = rows.find((item) => item.id === resolved.connectionId);
  const engine = await imageEngine(database);

  return {
    defaults: {
      connectionId: row.defaultConnectionId,
      model: row.defaultModel,
      /**
       * What a new chat would *actually* start on right now, which is not the
       * same question as what is stored. A default pointing at a deleted
       * connection falls through to the first live one, and the screen should
       * show the answer rather than the setting.
       */
      resolvedConnectionId: resolved.connectionId,
      resolvedName: resolvedConnection?.name ?? null,
      ready: resolvedConnection ? checkConnection(resolvedConnection).ok : false,
    },
    images: {
      connectionId: row.imageConnectionId,
      model: row.imageModel,
      /** Non-null exactly when `generate_image` is offered to the model. */
      active: engine
        ? { connectionId: engine.connection.id, name: engine.connection.name, model: engine.model }
        : null,
      /**
       * Which connections could be picked, with the ineligible ones simply
       * absent. Anthropic has no image model, so an Anthropic connection is not
       * an option here — see `images/catalog.ts`.
       */
      eligible: rows
        .filter((item) => canGenerateImages(item.kind))
        .map((item) => ({
          id: item.id,
          name: item.name,
          kind: item.kind,
          ready: checkConnection(item).ok,
          suggestedModels: imageKindFor(item.kind)?.suggestedModels ?? [],
          defaultModel: imageKindFor(item.kind)?.defaultModel ?? "",
          hint: imageKindFor(item.kind)?.hint ?? "",
        })),
      kinds: IMAGE_KIND_LIST,
    },
  };
}

/**
 * Whether a connection id is real and usable as a setting.
 *
 * Null clears the setting, which is always allowed. A non-null id has to name
 * a live connection — a dangling foreign key would be accepted by SQLite only
 * to fail confusingly at the next turn.
 */
function checkConnectionId(rows: Connection[], id: string | null | undefined): Connection | null {
  if (id === null || id === undefined || id === "") return null;

  const row = rows.find((item) => item.id === id);
  if (!row) throw new HttpError(400, "That connection no longer exists.");
  return row;
}

workspaceRoutes.get("/workspace", async (c) => c.json(await present(db())));

/**
 * Change one or both settings.
 *
 * `"key" in body` rather than a truthiness check, so sending `null` clears a
 * setting and omitting the field leaves it alone — the same convention
 * `PATCH /threads/:id` uses.
 */
workspaceRoutes.patch("/workspace", async (c) => {
  const body = await c.req.json<{
    defaultConnectionId?: string | null;
    defaultModel?: string | null;
    imageConnectionId?: string | null;
    imageModel?: string | null;
  }>();

  const database = db();
  const rows = live(database);
  const changes: Record<string, unknown> = {};

  if ("defaultConnectionId" in body) {
    changes.defaultConnectionId = checkConnectionId(rows, body.defaultConnectionId)?.id ?? null;
  }
  if ("defaultModel" in body) changes.defaultModel = body.defaultModel?.trim() || null;

  if ("imageConnectionId" in body) {
    const row = checkConnectionId(rows, body.imageConnectionId);
    if (row && !canGenerateImages(row.kind)) {
      throw new HttpError(
        400,
        `${row.name} cannot generate images. Point image generation at OpenAI, Google, or a local endpoint instead — the model you chat with does not have to be the one that draws.`,
      );
    }
    changes.imageConnectionId = row?.id ?? null;
  }
  if ("imageModel" in body) changes.imageModel = body.imageModel?.trim() || null;

  await updateWorkspace(database, changes);

  return c.json(await present(database));
});
