/**
 * The workspace row, and the questions it answers.
 *
 * Two settings live here — where a new chat starts, and which connection draws
 * — and both are the same shape of question: "when nobody said, what then?".
 * Answering that in one module means the chat route, the threads route and the
 * image tool cannot drift into three slightly different opinions about it.
 *
 * Everything here degrades to what the app did before this table existed. A
 * store that has never been told a default resolves to the first live
 * connection, which is what `connectionForThread` always did; a store with no
 * image model reports that no connection can draw, and the tool is simply not
 * offered. Nothing is required and nothing fails for being unset.
 */

import { and, asc, eq, isNull } from "drizzle-orm";

import type { Db } from "./db/index.js";
import { connections, workspace, type Connection, type Workspace } from "./db/schema.js";
import { patch, put } from "./db/write.js";
import { imageKindFor } from "./images/catalog.js";
import { checkConnection } from "./providers/registry.js";

/**
 * The one row, on every machine.
 *
 * Fixed for the reason `seed.ts` gives: two fresh machines that later pair
 * should merge into one workspace rather than into two rows that disagree.
 * Shaped like a ULID and dated to the epoch so it sorts ahead of real data.
 */
const WORKSPACE_ID = "0000000000WORKSPACE00";

/**
 * Read the row, creating it the first time.
 *
 * Through `put` rather than a migration insert, so the row gets a changelog
 * entry and reaches other devices like anything else. Two machines that each
 * create it independently produce the same id and merge as one row.
 *
 * A soft-deleted row is *not* filtered out here. Nothing offers to delete this
 * row, and a `deletedAt` arriving from a peer that somehow had one would
 * otherwise make this function insert a second row with the same primary key
 * and throw. Reading it whatever its state is the more robust reading.
 */
export async function workspaceRow(db: Db): Promise<Workspace> {
  const [existing] = await db
    .select()
    .from(workspace)
    .where(eq(workspace.id, WORKSPACE_ID))
    .limit(1);
  if (existing) return existing;

  return put(db, workspace, { id: WORKSPACE_ID });
}

/** The settings a caller is allowed to change. The lifecycle columns are not. */
export type WorkspaceChanges = Partial<
  Pick<Workspace, "defaultConnectionId" | "defaultModel" | "imageConnectionId" | "imageModel">
>;

/**
 * Change one or more of the workspace's settings.
 *
 * Ensures the row first, so the very first save on a fresh store is an insert
 * followed by an update rather than a patch that quietly matches nothing. The
 * `!` is safe for exactly that reason.
 */
export async function updateWorkspace(db: Db, changes: WorkspaceChanges): Promise<Workspace> {
  await workspaceRow(db);
  return patch(db, workspace, WORKSPACE_ID, changes)!;
}

/** A live connection by id, or undefined. Shared by both resolvers below. */
async function liveConnection(db: Db, id: string | null): Promise<Connection | undefined> {
  if (!id) return undefined;
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), isNull(connections.deletedAt)))
    .limit(1);
  return row;
}

export interface ChatDefault {
  connectionId: string | null;
  model: string | null;
}

/**
 * What a new conversation should start on.
 *
 * The chosen default first, then the first live connection — which is the
 * behaviour `connectionForThread` has always fallen back to, kept so that a
 * store with nothing configured is unchanged. A default pointing at a
 * connection that has since been deleted is treated as no default rather than
 * as an error: the row is stale, not wrong, and the useful thing to do with a
 * stale pointer is ignore it.
 *
 * Readiness is deliberately *not* required. Someone whose key has expired
 * should still get their own default in the berth, with the connection's own
 * "not set up yet" problem showing on it — silently starting them somewhere
 * else would hide the thing they need to fix.
 */
export async function chatDefault(db: Db): Promise<ChatDefault> {
  const row = await workspaceRow(db);
  const chosen = await liveConnection(db, row.defaultConnectionId);

  if (chosen) return { connectionId: chosen.id, model: row.defaultModel };

  const [first] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(isNull(connections.deletedAt))
    .orderBy(asc(connections.createdAt))
    .limit(1);

  return { connectionId: first?.id ?? null, model: null };
}

export interface ImageEngine {
  connection: Connection;
  /** Always a concrete id: the override, or the kind's own default. */
  model: string;
}

/**
 * Which connection generates images, and with what model.
 *
 * Returns null rather than throwing, because "no image model configured" is
 * the ordinary state of a fresh install and the caller's response to it is to
 * not offer the tool — not to report a failure. The three reasons it can be
 * null are all normal: nothing chosen, the chosen connection is gone, or the
 * chosen connection's kind cannot generate images at all.
 *
 * Unlike `chatDefault` there is no fallback to "the first connection". Picking
 * one at random and spending someone's OpenAI credits on an image they did not
 * ask that provider for is not a reasonable guess, and the failure mode of
 * guessing wrong here costs money rather than a re-pick.
 */
export async function imageEngine(db: Db): Promise<ImageEngine | null> {
  const row = await workspaceRow(db);
  const connection = await liveConnection(db, row.imageConnectionId);
  if (!connection) return null;

  const spec = imageKindFor(connection.kind);
  if (!spec) return null;

  const model = row.imageModel?.trim() || spec.defaultModel;
  if (!model) return null;

  // The same readiness rule every other surface uses, so a missing key reads
  // as "not set up yet" here too rather than as a failed generation later.
  if (!checkConnection(connection).ok) return null;

  return { connection, model };
}
