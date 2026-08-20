/**
 * Letting the model write to memory.
 *
 * Memory that only fills up when someone remembers to open a settings screen
 * stays empty. The `remember` tool lets the assistant save a durable fact the
 * moment it comes up in conversation, which is where most of them appear.
 *
 * Writes are scoped by the caller, never by the model: the tool closes over
 * the current project, so the assistant cannot write into a project it is not
 * working in. `sourceThreadId` records where a memory came from, so anything
 * saved this way can be traced back and undone.
 */

import { tool } from "ai";
import { z } from "zod";

import type { Db } from "../db/index.js";
import { memories } from "../db/schema.js";
import { put } from "../db/write.js";

export interface MemoryToolContext {
  db: Db;
  projectId: string | null;
  threadId: string;
}

export function memoryTools({ db, projectId, threadId }: MemoryToolContext) {
  return {
    remember: tool({
      description: [
        "Save a durable fact about the person or their work so it is available in future conversations.",
        "Use it for stable preferences, decisions, and context worth keeping — not for transient details of the current task.",
        "Prefer one clear fact per call.",
      ].join(" "),
      inputSchema: z.object({
        title: z.string().min(1).max(120).describe("A short label, e.g. 'Prefers pnpm over npm'."),
        body: z
          .string()
          .max(2000)
          .describe("The detail worth keeping. Leave empty if the title says it all.")
          .default(""),
        kind: z
          .enum(["fact", "preference", "instruction"])
          .describe(
            "'preference' for how they like things done, 'instruction' for a standing rule, 'fact' otherwise.",
          )
          .default("fact"),
        scope: z
          .enum(["global", "project"])
          .describe(
            "'project' if it only applies to the current project, 'global' if it is true everywhere.",
          )
          .default("global"),
      }),
      execute: async ({ title, body, kind, scope }) => {
        // A project-scoped write outside a project has nowhere to go; saving
        // it globally is the useful reading of the intent.
        const effectiveScope = scope === "project" && projectId ? "project" : "global";

        const row = put(db, memories, {
          scope: effectiveScope,
          projectId: effectiveScope === "project" ? projectId : null,
          kind,
          title: title.trim(),
          body: body.trim(),
          sourceThreadId: threadId,
        });

        return {
          saved: true,
          id: row?.id,
          scope: effectiveScope,
          note: `Saved "${title.trim()}" to ${effectiveScope === "project" ? "this project's" : "global"} memory.`,
        };
      },
    }),
  };
}
