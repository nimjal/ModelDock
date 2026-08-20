/**
 * Every model on this machine, under one namespace.
 *
 * This is what the gateway exports: the union of what each configured
 * connection can run, addressed as `<connection>/<model>`. Claude Code sees
 * your Ollama models; OpenCode sees your Anthropic ones; both see whatever
 * OpenRouter is serving today — and none of them needs a key, because the keys
 * stay here and are resolved per request exactly as they are for a chat turn.
 *
 * ## The id format, and why the split is on the first slash
 *
 * A model id is `<connection-slug>/<model-id>`, split on the **first** slash
 * only. That is not arbitrary: OpenRouter's own ids contain slashes
 * (`anthropic/claude-sonnet-4-5`), so splitting on the last one — or on all of
 * them — would mangle the most common openai_compatible setup there is. The
 * connection slug is generated to contain no slash, so the first one is always
 * the boundary.
 *
 * Slugs come from the connection *name*, which is unique in the schema, rather
 * than from its ULID. `openrouter/anthropic/claude-sonnet-4-5` is something a
 * person can type into a config file and recognise later;
 * `01JB2X.../claude-sonnet-4-5` is not. Two names that slug identically are
 * disambiguated with a numeric suffix rather than silently colliding.
 *
 * ## Listing is best-effort, by design
 *
 * Asking four providers for their catalogues means four network calls, any of
 * which can be slow or down. A connection that fails to answer contributes its
 * own configured model and an explanatory `problem` rather than failing the
 * whole listing — a gateway that returns nothing because one endpoint is
 * unreachable is far worse than one that returns most of what it has.
 */

import { isNull } from "drizzle-orm";

import type { Db } from "../db/index.js";
import { connections, type Connection } from "../db/schema.js";
import { listModels } from "../providers/models.js";
import { checkConnection, resolveApiKey } from "../providers/registry.js";

/** Lower-case, no slashes, no spaces. Safe on either side of the boundary. */
export function slugFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "connection";
}

/**
 * Slugs for every connection, disambiguated.
 *
 * `connections.name` is UNIQUE but its slug is not — "My Box" and "my-box"
 * both become `my-box`. Ordering by creation and suffixing later collisions
 * means an existing connection's slug does not change when a new one is added,
 * which matters because these end up written into config files.
 */
export function slugMap(rows: Connection[]): Map<string, string> {
  const byId = new Map<string, string>();
  const taken = new Set<string>();

  for (const row of rows) {
    const base = slugFor(row.name);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    byId.set(row.id, slug);
  }

  return byId;
}

export interface GatewayModel {
  /** `<connection-slug>/<model-id>` — what a client asks for. */
  id: string;
  connectionId: string;
  connectionName: string;
  /** The provider's own id, without the namespace. */
  model: string;
  kind: string;
  label: string | null;
}

export interface GatewayCatalog {
  models: GatewayModel[];
  /** One entry per connection that could not be listed, for `doctor` and the UI. */
  problems: { connection: string; problem: string }[];
}

/** Live connections, oldest first — the order slugs are assigned in. */
export async function gatewayConnections(db: Db): Promise<Connection[]> {
  return db.select().from(connections).where(isNull(connections.deletedAt)).all();
}

/**
 * Resolve `<slug>/<model>` back to a connection and a model id.
 *
 * A bare model id with no slash is also accepted and matched against every
 * connection's own configured model, because some clients hard-code a plain
 * name and being strict there buys nothing.
 */
export function resolveGatewayModel(
  rows: Connection[],
  id: string,
): { connection: Connection; model: string } | null {
  const slugs = slugMap(rows);
  const trimmed = id.trim();

  const cut = trimmed.indexOf("/");
  if (cut > 0) {
    const slug = trimmed.slice(0, cut);
    const model = trimmed.slice(cut + 1);
    const connection = rows.find((row) => slugs.get(row.id) === slug);
    if (connection && model) return { connection, model };
  }

  // No namespace: the first connection whose own model this is.
  const direct = rows.find((row) => row.model === trimmed);
  return direct ? { connection: direct, model: trimmed } : null;
}

/**
 * Ask every ready connection what it can run.
 *
 * Connections are queried in parallel — four sequential HTTP round trips would
 * make `GET /v1/models` feel broken — and a connection that cannot be reached
 * still contributes the model it is configured with, so pointing a client at
 * ModelDock while offline still offers the obvious choice.
 */
export async function gatewayCatalog(db: Db): Promise<GatewayCatalog> {
  const rows = await gatewayConnections(db);
  const slugs = slugMap(rows);

  const models: GatewayModel[] = [];
  const problems: { connection: string; problem: string }[] = [];

  const results = await Promise.all(
    rows.map(async (row) => {
      const status = checkConnection(row);
      if (!status.ok) return { row, listed: null, problem: status.problem! };

      try {
        const listed = await listModels({
          kind: row.kind,
          baseUrl: row.baseUrl,
          apiKey: resolveApiKey(row),
          label: row.name,
        });
        return { row, listed, problem: null };
      } catch (error) {
        return { row, listed: null, problem: (error as Error).message };
      }
    }),
  );

  for (const { row, listed, problem } of results) {
    const slug = slugs.get(row.id)!;

    const add = (model: string, label: string | null) => {
      models.push({
        id: `${slug}/${model}`,
        connectionId: row.id,
        connectionName: row.name,
        model,
        kind: row.kind,
        label,
      });
    };

    if (problem) {
      problems.push({ connection: row.name, problem });
      // The configured model anyway. It is the one the person chose, and a
      // client that asks for it will get whatever error the provider gives —
      // which is more useful than this list pretending the model is not there.
      if (row.model) add(row.model, null);
      continue;
    }

    // Only the conversational ones. `providers/models.ts` deliberately hides
    // nothing and flags instead, but this list is consumed by coding agents
    // that will put every entry in a model picker, and an embedding model in
    // that picker is noise rather than a choice.
    const chat = (listed ?? []).filter((model) => model.chat);
    for (const model of chat) add(model.id, model.label);

    // A provider that lists nothing usable still has the model on the row.
    if (chat.length === 0 && row.model) add(row.model, null);
  }

  return { models, problems };
}
