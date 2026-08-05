/**
 * Letting the model change a project's files.
 *
 * Deliberately a separate factory from `fileTools`, not a flag on it. That
 * factory is handed to ordinary chat, so anything added to it reaches Cowork —
 * and Cowork's whole safety story is that it cannot damage anything. Keeping
 * these here means the Code surface composes what it wants by permission level
 * and the composition is visible at the call site, rather than a boolean buried
 * two files away.
 *
 * Everything else follows `tools.ts` exactly, because a model does not know
 * which file a tool came from:
 *
 *   - every path goes through `inside()`, which resolves symlinks and tolerates
 *     a target that does not exist yet — the latter specifically so writes are
 *     not rejected as escapes;
 *   - failures are *returned* as `{ error }`, never thrown, so a bad guess is
 *     something the model can correct rather than the end of the turn.
 *
 * The one rule that is not in `tools.ts`: `.git/` is refused. `inside()` cannot
 * know that rewriting `.git/config` is different from rewriting a source file —
 * both are inside the project — but the difference matters enough to state.
 * `.modeldock/ignore` is deliberately not consulted for this; that file lists
 * noise, and using it as a permission boundary would make a listing preference
 * into a security control.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { tool } from "ai";
import { z } from "zod";

import { inside } from "./boundary.js";
import { MAX_FILE_BYTES, display, failure, type FileToolContext } from "./tools.js";

/** Refused outright, however the path was spelled. */
const PROTECTED = new Set([".git"]);

/**
 * Whether a path reaches into somewhere no model should be rewriting.
 *
 * Checked on the resolved path, so `a/../.git/config` and a symlink pointing
 * at `.git` are both caught — the string the model typed is not the thing
 * being tested.
 */
function protectedPath(root: string, absolute: string): string | null {
  const segments = relative(root, absolute).split(sep);
  const hit = segments.find((segment) => PROTECTED.has(segment));
  return hit ?? null;
}

export function editTools({ root }: FileToolContext) {
  /** The check both tools run before touching anything. */
  async function target(path: string): Promise<{ absolute: string } | { error: string }> {
    const absolute = await inside(root, path);

    const hit = protectedPath(root, absolute);
    if (hit) return { error: `${hit}/ is off limits. Ask before changing anything in it.` };

    return { absolute };
  }

  return {
    write_file: tool({
      description:
        "Write a file inside the project, creating it and any missing parent directories. " +
        "Replaces the whole file — prefer edit_file when changing part of an existing one.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path relative to the project root."),
        content: z.string().describe("The complete new contents of the file."),
      }),
      execute: async ({ path, content }) => {
        try {
          const bytes = Buffer.byteLength(content, "utf8");
          if (bytes > MAX_FILE_BYTES) {
            return {
              error:
                `That is ${bytes} bytes and the limit is ${MAX_FILE_BYTES}. ` +
                "Write it in pieces, or reconsider whether it belongs in one file.",
            };
          }

          const resolved = await target(path);
          if ("error" in resolved) return resolved;

          const existed = await stat(resolved.absolute).then(
            (info) => info.isFile(),
            () => false,
          );

          await mkdir(dirname(resolved.absolute), { recursive: true });
          await writeFile(resolved.absolute, content, "utf8");

          return {
            path: display(root, resolved.absolute),
            bytes,
            created: !existed,
          };
        } catch (error) {
          return failure(error, path);
        }
      },
    }),

    edit_file: tool({
      description:
        "Replace an exact string in a file. Use this rather than write_file for a change to " +
        "part of an existing file — it does not require reproducing the rest of it.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path relative to the project root."),
        old_string: z
          .string()
          .min(1)
          .describe("The exact text to replace, copied from the file including whitespace."),
        new_string: z.string().describe("What to put in its place."),
        replace_all: z
          .boolean()
          .describe("Replace every occurrence instead of requiring exactly one.")
          .default(false),
      }),
      execute: async ({ path, old_string, new_string, replace_all }) => {
        try {
          const resolved = await target(path);
          if ("error" in resolved) return resolved;

          const before = await readFile(resolved.absolute, "utf8");
          const shown = display(root, resolved.absolute);

          // Both failures below are things the model can fix on its next
          // attempt, so each one says what would make the call work.
          const occurrences = before.split(old_string).length - 1;

          if (occurrences === 0) {
            return {
              error:
                `old_string was not found in ${shown}. ` +
                "Read the file and copy the exact text, including indentation.",
            };
          }

          if (occurrences > 1 && !replace_all) {
            return {
              error:
                `old_string appears ${occurrences} times in ${shown}. ` +
                "Include more surrounding context to make it unique, or set replace_all.",
            };
          }

          const after = replace_all
            ? before.split(old_string).join(new_string)
            : before.replace(old_string, new_string);

          await writeFile(resolved.absolute, after, "utf8");

          return { path: shown, replacements: replace_all ? occurrences : 1 };
        } catch (error) {
          return failure(error, path);
        }
      },
    }),
  };
}
