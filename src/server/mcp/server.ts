/**
 * ModelDock's memory, offered to everything else.
 *
 * This is the part that makes ModelDock a substrate rather than another chat
 * window. The same rows the UI shows and the chat route injects are exposed
 * over MCP on stdio, so Claude Code, OpenCode, Cursor or anything else that
 * speaks the protocol reads and writes the *same* memory. Nobody has to be
 * inside ModelDock for ModelDock to be useful, and the store stays the one
 * place these facts live.
 *
 * Add to Claude Code with:
 *   claude mcp add modeldock -- npx modeldock mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { and, desc, eq, isNull, like, or } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/index.js";
import { memories, projects } from "../db/schema.js";
import { put } from "../db/write.js";

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "modeldock", version: "0.1.0" });
  const database = db();

  server.registerTool(
    "search_memory",
    {
      title: "Search memory",
      description:
        "Search the person's durable memory in ModelDock: stable preferences, decisions and context they have saved. Use it before asking them something they may have already told you.",
      inputSchema: {
        query: z.string().describe("Words to match against memory titles and bodies.").default(""),
        project: z
          .string()
          .describe("Optional project name or slug to include project-scoped memories from.")
          .optional(),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    async ({ query, project, limit }) => {
      const projectId = project ? await findProjectId(project) : null;

      const scope = projectId
        ? or(eq(memories.scope, "global"), eq(memories.projectId, projectId))
        : eq(memories.scope, "global");

      const where = [isNull(memories.deletedAt), scope];
      if (query.trim()) {
        const pattern = `%${query.trim()}%`;
        where.push(or(like(memories.title, pattern), like(memories.body, pattern))!);
      }

      const rows = await database
        .select()
        .from(memories)
        .where(and(...where))
        .orderBy(desc(memories.pinned), desc(memories.updatedAt))
        .limit(limit)
        .all();

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No memories match." }] };
      }

      const text = rows
        .map((row) => {
          const where = row.scope === "global" ? "everywhere" : "this project";
          return `- ${row.title}${row.body ? ` — ${row.body}` : ""} (${row.kind}, ${where})`;
        })
        .join("\n");

      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "add_memory",
    {
      title: "Add memory",
      description:
        "Save a durable fact to ModelDock so it is available in every future conversation, in any tool. Use for stable preferences and decisions, not transient task details.",
      inputSchema: {
        title: z.string().min(1).max(120).describe("A short label."),
        body: z.string().max(2000).describe("Detail, if the title needs it.").default(""),
        kind: z.enum(["fact", "preference", "instruction"]).default("fact"),
        project: z
          .string()
          .describe("Optional project name or slug. Omit to save globally.")
          .optional(),
      },
    },
    async ({ title, body, kind, project }) => {
      const projectId = project ? await findProjectId(project) : null;
      // A named project that does not exist would otherwise silently become a
      // global memory, which is not what the caller asked for.
      if (project && !projectId) {
        return {
          content: [{ type: "text", text: `No project matching "${project}".` }],
          isError: true,
        };
      }

      put(database, memories, {
        scope: projectId ? "project" : "global",
        projectId,
        kind,
        title: title.trim(),
        body: body.trim(),
      });

      return {
        content: [
          {
            type: "text",
            text: `Saved "${title.trim()}" to ${projectId ? `project ${project}` : "global"} memory.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List the person's ModelDock projects, so you can scope a memory correctly.",
      inputSchema: {},
    },
    async () => {
      const rows = await database
        .select()
        .from(projects)
        .where(isNull(projects.deletedAt))
        .orderBy(desc(projects.updatedAt))
        .all();

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No projects yet." }] };
      }

      const text = rows
        .map(
          (row) => `- ${row.name} (${row.slug})${row.description ? ` — ${row.description}` : ""}`,
        )
        .join("\n");

      return { content: [{ type: "text", text }] };
    },
  );

  async function findProjectId(nameOrSlug: string): Promise<string | null> {
    const needle = nameOrSlug.trim();
    const [row] = await database
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(isNull(projects.deletedAt), or(eq(projects.slug, needle), eq(projects.name, needle))!),
      )
      .limit(1);
    return row?.id ?? null;
  }

  // stdout is the protocol channel, so nothing else may be written to it.
  const transport = new StdioServerTransport();

  // `connect` resolves as soon as the transport is wired up, so this has to
  // keep running until the client goes away — otherwise the caller returns,
  // the process exits, and the connection dies the moment it is established.
  const closed = new Promise<void>((resolveClosed) => {
    transport.onclose = () => resolveClosed();
    process.stdin.once("end", () => resolveClosed());
  });

  await server.connect(transport);
  await closed;
}
