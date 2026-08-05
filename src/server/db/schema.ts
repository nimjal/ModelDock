/**
 * ModelDock's own store.
 *
 * This is the point of the whole project: conversations, projects and memory
 * belong to ModelDock, not to whichever engine answered a given turn. Swap
 * providers and the thread is untouched, because the provider is a column.
 *
 * Two conventions run through every table:
 *
 *   - Identifiers are ULIDs, not autoincrementing integers, and every row
 *     carries `updatedAt` and a soft-delete `deletedAt`. That is what lets the
 *     Cloud Chat surface sync this store without a migration that rewrites
 *     every primary key — see `sync/` and the `changelog` table below.
 *   - Timestamps are epoch milliseconds. SQLite has no date type, and an
 *     integer sorts and diffs correctly everywhere.
 *
 * Nothing writes to these tables directly. `db/write.ts` is the only module
 * that inserts or updates, because a write and its changelog entry have to
 * land together or not at all.
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { ulid } from "ulid";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => ulid());

const now = sql`(unixepoch() * 1000)`;

/** The columns every table carries. Spread into each definition. */
const lifecycle = {
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
  deletedAt: integer("deleted_at"),
};

/**
 * How to reach a model.
 *
 * `apiKeyEnv` holds the *name* of an environment variable, never a key. The
 * key is read from the environment at the moment a request is made, so a
 * stolen or synced database contains no credentials. This is the one idea
 * worth carrying over wholesale from the Python version.
 */
export const connections = sqliteTable("connections", {
  id: id(),
  name: text("name").notNull().unique(),
  kind: text("kind", {
    enum: ["anthropic", "openai", "google", "openai_compatible", "ollama"],
  }).notNull(),
  baseUrl: text("base_url"),
  model: text("model").notNull(),
  apiKeyEnv: text("api_key_env"),
  ...lifecycle,
});

/**
 * A container for related work.
 *
 * `directory` is nullable and has no behaviour in v1. A project is a context —
 * memory scope, default connection, a group of threads — and most of them are
 * not a checkout. It becomes meaningful when the Code surface lands.
 */
export const projects = sqliteTable("projects", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  directory: text("directory"),
  defaultConnectionId: text("default_connection_id").references(() => connections.id),
  defaultAgentId: text("default_agent_id").references(() => codingAgents.id),
  ...lifecycle,
});

/**
 * One conversation.
 *
 * `projectId` is nullable: a chat needs neither a project nor a directory,
 * which is the inversion this rewrite exists for. `connectionId` is what
 * changes when someone swaps providers mid-conversation — the messages below
 * are not touched.
 */
export const threads = sqliteTable(
  "threads",
  {
    id: id(),
    projectId: text("project_id").references(() => projects.id),
    title: text("title"),
    connectionId: text("connection_id").references(() => connections.id),
    model: text("model"),
    /**
     * Set when this thread is a Code session. There is no separate `kind`
     * column on purpose: `agentId != null` is the discriminator, so a thread
     * cannot claim to be both a chat and a coding session.
     */
    agentId: text("agent_id").references(() => codingAgents.id),
    /** The engine's own session id, so a follow-up turn can resume it. */
    agentSessionId: text("agent_session_id"),
    /**
     * Sticky default for the composer's level control.
     *
     * No migration was needed to add `ask` here: drizzle's `enum` is a
     * type-level assertion, and the column is a plain `TEXT` with no CHECK.
     */
    permission: text("permission", { enum: ["read", "edit", "full", "ask"] }),
    archivedAt: integer("archived_at"),
    ...lifecycle,
  },
  (table) => [
    index("threads_project_idx").on(table.projectId),
    index("threads_updated_idx").on(table.updatedAt),
  ],
);

/**
 * One message, stored as the AI SDK's own `UIMessage.parts` array.
 *
 * Keeping the parts verbatim rather than flattening to a text column is what
 * lets tool calls, reasoning blocks and file attachments survive a reload —
 * and what lets a thread rendered today still render correctly after the
 * model that produced it is gone.
 *
 * `provider` and `model` are recorded per message, not per thread, so a
 * conversation that spans providers can show exactly who said what.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: id(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    parts: text("parts", { mode: "json" }).notNull().$type<unknown[]>(),
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    ...lifecycle,
  },
  (table) => [index("messages_thread_idx").on(table.threadId, table.createdAt)],
);

/**
 * A durable fact that outlives the conversation it came from.
 *
 * Global memories reach every turn; project memories reach turns in their
 * project. `sourceThreadId` is kept so a memory can be traced back to where
 * it was learned.
 */
export const memories = sqliteTable(
  "memories",
  {
    id: id(),
    scope: text("scope", { enum: ["global", "project"] }).notNull(),
    projectId: text("project_id").references(() => projects.id),
    kind: text("kind", { enum: ["fact", "preference", "instruction"] })
      .notNull()
      .default("fact"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    sourceThreadId: text("source_thread_id").references(() => threads.id),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    ...lifecycle,
  },
  (table) => [index("memories_scope_idx").on(table.scope, table.projectId)],
);

/**
 * A coding agent ModelDock can drive.
 *
 * Deliberately its own table rather than another `connections.kind`. A
 * connection resolves to a `LanguageModel` through an exhaustive switch in
 * `providers/registry.ts`; a coding agent resolves to a process or an HTTP
 * session, so folding it in would force that switch to return the wrong type
 * and cost the compile-time exhaustiveness that makes it worth having. A
 * coding agent also has no model until it runs and reports one, while
 * `connections.model` is NOT NULL — the row would have to lie.
 *
 * What does carry over is the credential rule, unchanged: `authTokenEnv`
 * holds the *name* of an environment variable, never a token. A stolen or
 * synced database contains no secrets.
 *
 * `command` and `args` are separate so a row can point at a wrapper script
 * rather than a bare binary — which is how someone runs their agent through
 * `mise`, `asdf` or a project-specific launcher, and how the tests point at a
 * fake agent without needing one installed.
 *
 * `connectionId` is what the built-in engine uses, and it is worth being
 * precise about why it does not contradict the paragraph above. Folding coding
 * agents *into* `connections` is still the wrong move, for both reasons given.
 * Pointing one *at* a connection is a different thing: the builtin row does not
 * become a connection, it references one. `resolveModel` still returns a
 * `LanguageModel` from an exhaustive switch that never learns about agents, and
 * the builtin row still has no model of its own — the connection it points at
 * carries the NOT NULL one, so the row still does not have to lie.
 */
export const codingAgents = sqliteTable("coding_agents", {
  id: id(),
  name: text("name").notNull().unique(),
  kind: text("kind", { enum: ["opencode", "claude_code", "builtin"] }).notNull(),
  /** Set only on `kind = "builtin"`: the connection whose model runs the loop. */
  connectionId: text("connection_id").references(() => connections.id),
  /** Absolute path, as resolved by detection. */
  command: text("command"),
  args: text("args", { mode: "json" }).$type<string[]>(),
  version: text("version"),
  /** Set to attach to an already-running server instead of spawning one. */
  baseUrl: text("base_url"),
  authTokenEnv: text("auth_token_env"),
  detected: integer("detected", { mode: "boolean" }).notNull().default(false),
  ...lifecycle,
});

/**
 * A skill: a folder on disk with a SKILL.md in it.
 *
 * This table is a *cache*, not the source of truth. The folder is. Everything
 * here exists so the index injected into a system prompt — name, description,
 * trigger words — can be assembled with one query instead of a directory walk
 * on every turn, and so the Skills screen can list what is installed without
 * reading a hundred files.
 *
 * The body is deliberately not stored. Editing a SKILL.md in an editor should
 * take effect on the next message, with nothing to resync and no chance of the
 * copy here disagreeing with the file someone is looking at.
 *
 * Skills live in two places for the same reason memories have two scopes:
 * `~/.modeldock/skills/<slug>/` follows the person across every project, while
 * `<project.directory>/.modeldock/skills/<slug>/` belongs to a checkout and
 * can be committed and shared with whoever else works in it. A project-scoped
 * skill wins over a global one with the same slug — nearest scope, as always.
 */
export const skills = sqliteTable(
  "skills",
  {
    id: id(),
    slug: text("slug").notNull(),
    scope: text("scope", { enum: ["global", "project"] }).notNull(),
    projectId: text("project_id").references(() => projects.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    triggers: text("triggers", { mode: "json" }).$type<string[]>(),
    /** Absolute path to the skill folder, not the SKILL.md inside it. */
    path: text("path").notNull(),
    bodyBytes: integer("body_bytes"),
    /** Set when the folder exists but could not be understood. */
    problem: text("problem"),
    scannedAt: integer("scanned_at").notNull().default(now),
    ...lifecycle,
  },
  (table) => [
    uniqueIndex("skills_slug_idx").on(table.scope, table.projectId, table.slug),
    index("skills_scope_idx").on(table.scope, table.projectId),
  ],
);

/**
 * What changed, so another device can be told about it.
 *
 * Appended to inside the same transaction as every write — see `db/write.ts`,
 * which is the only module allowed to touch it.
 *
 * `cols` holds column *names*, not values. Values are read from the live row
 * when a peer asks for them, which keeps the log small next to `messages.parts`
 * and stays correct because entries apply in `seq` order, so the last entry for
 * a column is authoritative. The consequence is worth stating plainly: this is
 * a change index, not a replayable history. You cannot reconstruct a past state
 * from it, and it is not meant for that.
 *
 * There is no `op` column because there are no hard deletes anywhere in this
 * codebase — a delete is a write to `deleted_at`, so it is an ordinary column
 * change. That falls out of soft-deletes-everywhere, and it is strictly more
 * correct under per-column merging: a delete on one device and a title edit on
 * another both survive.
 */
export const changelog = sqliteTable(
  "changelog",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    tbl: text("tbl").notNull(),
    rowId: text("row_id").notNull(),
    /** The `stamp()` that produced the write. One clock, so these compare. */
    at: integer("at").notNull(),
    /** The device that first made this change, kept as it travels onward. */
    origin: text("origin").notNull(),
    cols: text("cols", { mode: "json" }).notNull().$type<string[]>(),
  },
  (table) => [index("changelog_row_idx").on(table.tbl, table.rowId)],
);

export type Connection = typeof connections.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type CodingAgent = typeof codingAgents.$inferSelect;
export type Change = typeof changelog.$inferSelect;

export type NewConnection = typeof connections.$inferInsert;
export type NewProject = typeof projects.$inferInsert;
export type NewThread = typeof threads.$inferInsert;
export type NewMessage = typeof messages.$inferInsert;
export type NewMemory = typeof memories.$inferInsert;
export type NewSkill = typeof skills.$inferInsert;
export type NewCodingAgent = typeof codingAgents.$inferInsert;
export type NewChange = typeof changelog.$inferInsert;
