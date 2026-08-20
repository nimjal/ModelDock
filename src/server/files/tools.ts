/**
 * Letting the model read a project's files.
 *
 * This is Cowork: an ordinary chat that can look at the checkout a project
 * points at. It is not a separate surface and not a mode someone switches
 * into — attaching a directory to a project is what turns it on, and the only
 * evidence of it in the UI is the tool-call lines in the transcript.
 *
 * There is no write tool and no shell tool here, and that absence *is* the
 * safety story: Cowork cannot damage anything, so it needs no permission
 * prompt and no approval flow. The Code surface, which can, has both.
 *
 * That is why writing and running live in `edit.ts` and `shell.ts` rather than
 * being added here behind a flag. `fileTools` is handed to ordinary chat, so a
 * write tool in this factory would reach Cowork the moment it existed and make
 * the paragraph above false. The Code surface composes the three factories
 * according to its permission level; the composition is the boundary, and it is
 * visible at the call site.
 *
 * Scope is closed over by the caller exactly as it is in `memoryTools` — the
 * model receives paths relative to a root it never gets to choose.
 *
 * Escapes and missing files are *returned* as `{ error }`, not thrown. A
 * thrown `execute` becomes a `tool-output-error` part that can end the turn;
 * a returned error lets the model notice it guessed a bad path and try the
 * right one, which is what usually happens.
 */

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { tool } from "ai";
import { z } from "zod";

import { inside, OutsideProject } from "./boundary.js";

/** Past these, a tool result costs more context than it is worth. */
export const MAX_FILE_BYTES = 256 * 1024;
const MAX_LINES = 2000;
const BINARY_SNIFF_BYTES = 4096;
const MAX_ENTRIES = 400;
const MAX_RESULTS = 100;
const MAX_MATCH_LINE = 400;
const MAX_SCANNED_FILES = 5000;
const MAX_SCANNED_BYTES = 32 * 1024 * 1024;

/**
 * Directories that are never worth walking. Not a substitute for a real
 * ignore file — see `.modeldock/ignore` below — just the set that would
 * otherwise dominate every listing and search in a typical checkout.
 */
const SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "target",
  ".venv",
  "__pycache__",
  ".turbo",
  ".cache",
]);

export interface FileToolContext {
  /** Already resolved through `projectRoot`. */
  root: string;
}

/** A tool failure the model should see and act on, rather than a crash. */
export function failure(error: unknown, candidate: string): { error: string } {
  if (error instanceof OutsideProject) return { error: error.message };

  const code = (error as { code?: string } | null)?.code;
  if (code === "ENOENT") return { error: `No such file: ${candidate}` };
  if (code === "EISDIR") return { error: `${candidate} is a directory, not a file.` };
  if (code === "ENOTDIR") return { error: `${candidate} is not a directory.` };
  if (code === "EACCES" || code === "EPERM") return { error: `Permission denied: ${candidate}` };
  // Only reachable from the writing tools, but the mapping belongs with the
  // rest of them rather than in a second copy of this function.
  if (code === "ENOSPC") return { error: `No space left on device, writing ${candidate}.` };
  if (code === "EROFS") return { error: `${candidate} is on a read-only filesystem.` };
  if (code === "ENOTEMPTY") return { error: `${candidate} is not empty.` };

  return { error: `Could not read ${candidate}: ${(error as Error).message}` };
}

/**
 * A very small glob matcher: `*`, `**`, `?` and `{a,b}`.
 *
 * Enough for `*.ts` and `src/**​/*.tsx`, which is what people actually pass.
 * Deliberately not a full implementation — the alternative is a dependency
 * and a semantics rabbit hole for a filter that only narrows a listing.
 */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") out += "[^/]";
    else if (char === "{") out += "(?:";
    else if (char === "}") out += ")";
    else if (char === ",") out += "|";
    else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Extra ignore globs, if the project opted into them. */
async function loadIgnore(root: string): Promise<RegExp[]> {
  try {
    const text = await readFile(join(root, ".modeldock", "ignore"), "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map(globToRegExp);
  } catch {
    return [];
  }
}

/** Posix-style path relative to the root, which is what the model is shown. */
export function display(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/") || ".";
}

function ignored(rel: string, ignore: RegExp[]): boolean {
  return ignore.some((re) => re.test(rel));
}

/** A NUL byte in the first few KB is the usual cheap binary test. */
async function looksBinary(path: string): Promise<boolean> {
  const handle = await readFile(path, { flag: "r" }).catch(() => null);
  if (!handle) return false;
  return handle.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export function fileTools({ root }: FileToolContext) {
  return {
    read_file: tool({
      description: [
        "Read a text file from the project directory.",
        "Paths are relative to the project root. Use this before answering questions about code you have not seen.",
      ].join(" "),
      inputSchema: z.object({
        path: z.string().min(1).describe("Path relative to the project root, e.g. 'src/index.ts'."),
        offset: z
          .number()
          .int()
          .min(1)
          .describe("First line to return, 1-based. Use with 'limit' to page through a long file.")
          .default(1),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LINES)
          .describe("How many lines to return.")
          .default(MAX_LINES),
      }),
      execute: async ({ path, offset, limit }) => {
        try {
          const absolute = await inside(root, path);
          const info = await stat(absolute);
          if (info.isDirectory()) return { error: `${path} is a directory, not a file.` };

          if (await looksBinary(absolute)) {
            return { error: `${path} looks like a binary file.` };
          }

          const raw = await readFile(absolute, "utf8");
          const truncatedBytes = Buffer.byteLength(raw) > MAX_FILE_BYTES;
          const text = truncatedBytes ? raw.slice(0, MAX_FILE_BYTES) : raw;

          const all = text.split(/\r?\n/);
          const start = offset - 1;
          const slice = all.slice(start, start + limit);

          return {
            path: display(root, absolute),
            lines: `${start + 1}-${start + slice.length}`,
            totalLines: all.length,
            truncated: truncatedBytes || start + slice.length < all.length,
            content: slice.join("\n"),
            ...(truncatedBytes ? { note: `Truncated at ${MAX_FILE_BYTES / 1024} KB.` } : {}),
          };
        } catch (error) {
          return failure(error, path);
        }
      },
    }),

    list_files: tool({
      description: [
        "List files and directories inside the project directory.",
        "Start here when you need to orient yourself in an unfamiliar project.",
      ].join(" "),
      inputSchema: z.object({
        path: z
          .string()
          .describe("Directory relative to the project root. '.' is the root itself.")
          .default("."),
        depth: z.number().int().min(1).max(4).describe("How many levels to descend.").default(2),
      }),
      execute: async ({ path, depth }) => {
        try {
          const base = await inside(root, path);
          const info = await stat(base);
          if (!info.isDirectory()) return { error: `${path} is not a directory.` };

          const ignore = await loadIgnore(root);
          const entries: string[] = [];
          let truncated = false;

          const walk = async (dir: string, level: number): Promise<void> => {
            if (level > depth || truncated) return;

            const found = await readdir(dir, { withFileTypes: true });
            found.sort((a, b) => a.name.localeCompare(b.name));

            for (const entry of found) {
              if (truncated) return;
              if (SKIP.has(entry.name)) continue;

              const absolute = join(dir, entry.name);
              const rel = display(root, absolute);
              if (ignored(rel, ignore)) continue;

              if (entries.length >= MAX_ENTRIES) {
                truncated = true;
                return;
              }

              if (entry.isDirectory()) {
                entries.push(`${rel}/`);
                await walk(absolute, level + 1);
              } else {
                entries.push(rel);
              }
            }
          };

          await walk(base, 1);

          return {
            path: display(root, base),
            count: entries.length,
            truncated,
            entries,
            ...(truncated ? { note: `Stopped at ${MAX_ENTRIES} entries.` } : {}),
          };
        } catch (error) {
          return failure(error, path);
        }
      },
    }),

    search_files: tool({
      description: [
        "Search the project directory for lines matching a regular expression.",
        "Prefer this over reading many files when you are looking for where something is defined or used.",
      ].join(" "),
      inputSchema: z.object({
        pattern: z
          .string()
          .min(1)
          .describe("A JavaScript regular expression, e.g. 'function\\\\s+build'."),
        path: z
          .string()
          .describe("Directory to search, relative to the project root.")
          .default("."),
        glob: z
          .string()
          .describe(
            "Optional filename filter, e.g. '*.ts' or 'src/**/*.tsx'. Empty means every file.",
          )
          .default(""),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS)
          .describe("Stop after this many matching lines.")
          .default(50),
      }),
      execute: async ({ pattern, path, glob, maxResults }) => {
        let test: RegExp;
        try {
          test = new RegExp(pattern);
        } catch (error) {
          return { error: `Invalid regular expression: ${(error as Error).message}` };
        }

        const filter = glob.trim() ? globToRegExp(glob.trim()) : null;

        try {
          const base = await inside(root, path);
          const ignore = await loadIgnore(root);

          const matches: { path: string; line: number; text: string }[] = [];
          let scannedFiles = 0;
          let scannedBytes = 0;
          let truncated = false;

          const walk = async (dir: string): Promise<void> => {
            if (truncated) return;

            const found = await readdir(dir, { withFileTypes: true });
            found.sort((a, b) => a.name.localeCompare(b.name));

            for (const entry of found) {
              if (truncated) return;
              if (SKIP.has(entry.name)) continue;

              const absolute = join(dir, entry.name);
              const rel = display(root, absolute);
              if (ignored(rel, ignore)) continue;

              if (entry.isDirectory()) {
                await walk(absolute);
                continue;
              }

              if (filter && !filter.test(rel) && !filter.test(entry.name)) continue;

              if (++scannedFiles > MAX_SCANNED_FILES) {
                truncated = true;
                return;
              }

              const info = await stat(absolute).catch(() => null);
              if (!info) continue;
              scannedBytes += info.size;
              if (scannedBytes > MAX_SCANNED_BYTES) {
                truncated = true;
                return;
              }
              if (info.size > MAX_FILE_BYTES) continue;

              // Streamed line by line rather than read whole: a search that
              // matches early should not pay for the rest of the file.
              const reader = createInterface({
                input: createReadStream(absolute, { encoding: "utf8" }),
                crlfDelay: Infinity,
              });

              let lineNumber = 0;
              try {
                for await (const line of reader) {
                  lineNumber++;
                  if (!test.test(line)) continue;

                  matches.push({
                    path: rel,
                    line: lineNumber,
                    text: line.length > MAX_MATCH_LINE ? `${line.slice(0, MAX_MATCH_LINE)}…` : line,
                  });

                  if (matches.length >= maxResults) {
                    truncated = true;
                    break;
                  }
                }
              } finally {
                reader.close();
              }
            }
          };

          await walk(base);

          return {
            pattern,
            count: matches.length,
            truncated,
            matches,
            ...(matches.length === 0 ? { note: "No matches." } : {}),
          };
        } catch (error) {
          return failure(error, path);
        }
      },
    }),
  };
}
