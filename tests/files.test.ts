/**
 * The directory boundary, and the read-only tools built on it.
 *
 * Cowork's entire safety claim is that a model working in a project cannot
 * read outside that project's directory and cannot write anywhere at all.
 * The first half is `inside()`; these tests are what make the claim checkable.
 *
 * Note the shape of the escape assertions: a blocked path must come back as a
 * returned `{ error }`, not a thrown exception. That distinction is the
 * contract with the AI SDK — a throw becomes a `tool-output-error` part that
 * can end the turn, while a returned error lets the model correct itself.
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { inside, OutsideProject, projectRoot } from "../src/server/files/boundary.js";
import { fileTools } from "../src/server/files/tools.js";

let root: string;
/** The same directory before `realpath`, to prove an uncanonical root works. */
let rawRoot: string;
let outside: string;
let tools: ReturnType<typeof fileTools>;

/**
 * Call a tool's `execute` the way the AI SDK would.
 *
 * The SDK types `execute` as optional and lets it return an async iterable as
 * well as a promise, neither of which these tools do — hence the widening
 * through `unknown` rather than a direct cast.
 */
async function run(
  name: keyof ReturnType<typeof fileTools>,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const execute = tools[name].execute as unknown as (
    input: unknown,
    options: unknown,
  ) => Promise<Record<string, unknown>>;
  return execute(input, {});
}

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "modeldock-files-"));
  outside = join(base, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "do not read me");

  const project = join(base, "project");
  mkdirSync(join(project, "sub"), { recursive: true });
  mkdirSync(join(project, "node_modules"), { recursive: true });

  writeFileSync(join(project, "a.txt"), "alpha\nbeta\ngamma\n");
  writeFileSync(join(project, "sub", "b.txt"), "needle in here\nsecond line\n");
  writeFileSync(join(project, "node_modules", "junk.js"), "module.exports = {}");
  writeFileSync(join(project, "big.bin"), "x".repeat(512 * 1024));
  writeFileSync(join(project, "binary.dat"), Buffer.from([0x41, 0x00, 0x42, 0x43]));

  // Symlinks need elevation on Windows, so the escape-through-symlink case is
  // skipped there rather than failing the suite for an unrelated reason.
  try {
    symlinkSync(join(outside, "secret.txt"), join(project, "link.txt"));
  } catch {
    /* not privileged; the it.skipIf below covers it */
  }

  rawRoot = project;
  root = await projectRoot(project);
  tools = fileTools({ root });
});

describe("boundary", () => {
  it("allows a path inside the root", async () => {
    await expect(inside(root, "sub/b.txt")).resolves.toContain("b.txt");
  });

  it("allows the root itself", async () => {
    await expect(inside(root, ".")).resolves.toBe(root);
  });

  it("allows a path that does not exist yet", async () => {
    // The `realpath` walk has to tolerate a missing target, or every write
    // path in the Code surface would be rejected as an escape.
    await expect(inside(root, "sub/not-created-yet.ts")).resolves.toContain("not-created-yet.ts");
  });

  it("rejects a relative climb out", async () => {
    await expect(inside(root, "../outside/secret.txt")).rejects.toBeInstanceOf(OutsideProject);
  });

  it("rejects an absolute path elsewhere", async () => {
    await expect(inside(root, join(outside, "secret.txt"))).rejects.toBeInstanceOf(OutsideProject);
  });

  it("accepts a root that is not itself canonical", async () => {
    // Regression. `realpath` canonicalises the *target*, so a root given in a
    // non-canonical form — a Windows 8.3 short name like NIMITJ~1, or a path
    // through a symlinked parent on any OS — made `relative()` report a climb
    // out for a file sitting directly inside it, rejecting every file under
    // that directory. `rawRoot` here is the pre-`realpath` path, which on this
    // machine is exactly that short form.
    await expect(inside(rawRoot, "a.txt")).resolves.toBe(await inside(root, "a.txt"));
  });

  it("rejects a sibling directory sharing a name prefix", async () => {
    // The case a naive `startsWith` check gets wrong: `<root>-secrets` is not
    // inside `<root>`, but its absolute path does begin with it.
    await expect(inside(root, `${root}-secrets/x.txt`)).rejects.toBeInstanceOf(OutsideProject);
  });
});

describe("read_file", () => {
  it("reads a file inside the project", async () => {
    const result = await run("read_file", { path: "sub/b.txt", offset: 1, limit: 2000 });
    expect(result.content).toContain("needle in here");
  });

  it("returns an error rather than throwing on a relative escape", async () => {
    const result = await run("read_file", {
      path: "../outside/secret.txt",
      offset: 1,
      limit: 2000,
    });
    expect(String(result.error)).toContain("outside");
    expect(result.content).toBeUndefined();
  });

  it("returns an error on an absolute escape", async () => {
    const result = await run("read_file", {
      path: join(outside, "secret.txt"),
      offset: 1,
      limit: 2000,
    });
    expect(String(result.error)).toContain("outside");
  });

  it.skipIf(process.platform === "win32")("returns an error through a symlink", async () => {
    const result = await run("read_file", { path: "link.txt", offset: 1, limit: 2000 });
    expect(String(result.error)).toContain("outside");
    expect(result.content).toBeUndefined();
  });

  it("refuses a binary file", async () => {
    const result = await run("read_file", { path: "binary.dat", offset: 1, limit: 2000 });
    expect(String(result.error)).toMatch(/binary/i);
  });

  it("truncates a large file and says so", async () => {
    const result = await run("read_file", { path: "big.bin", offset: 1, limit: 2000 });
    expect(result.truncated).toBe(true);
    expect(String(result.note)).toContain("Truncated");
  });

  it("reports a missing file plainly", async () => {
    const result = await run("read_file", { path: "nope.txt", offset: 1, limit: 2000 });
    expect(String(result.error)).toContain("No such file");
  });

  it("pages with offset and limit", async () => {
    const result = await run("read_file", { path: "a.txt", offset: 2, limit: 1 });
    expect(result.content).toBe("beta");
    expect(result.lines).toBe("2-2");
  });
});

describe("list_files", () => {
  it("lists the project root without noise directories", async () => {
    const result = await run("list_files", { path: ".", depth: 2 });
    const entries = result.entries as string[];
    expect(entries).toContain("a.txt");
    expect(entries).toContain("sub/");
    expect(entries.some((entry) => entry.startsWith("node_modules"))).toBe(false);
  });

  it("returns an error rather than throwing on an escape", async () => {
    const result = await run("list_files", { path: "../outside", depth: 2 });
    expect(String(result.error)).toContain("outside");
  });
});

describe("search_files", () => {
  it("finds a match and reports its line", async () => {
    const result = await run("search_files", {
      pattern: "needle",
      path: ".",
      glob: "",
      maxResults: 50,
    });
    const matches = result.matches as { path: string; line: number }[];
    expect(matches).toHaveLength(1);
    expect(matches[0]!.path).toBe("sub/b.txt");
    expect(matches[0]!.line).toBe(1);
  });

  it("honours a glob filter", async () => {
    const result = await run("search_files", {
      pattern: "alpha",
      path: ".",
      glob: "*.md",
      maxResults: 50,
    });
    expect(result.count).toBe(0);
  });

  it("reports an invalid regular expression instead of crashing", async () => {
    const result = await run("search_files", {
      pattern: "(unclosed",
      path: ".",
      glob: "",
      maxResults: 50,
    });
    expect(String(result.error)).toContain("Invalid regular expression");
  });

  it("returns an error rather than throwing on an escape", async () => {
    const result = await run("search_files", {
      pattern: "secret",
      path: "../outside",
      glob: "",
      maxResults: 50,
    });
    expect(String(result.error)).toContain("outside");
  });
});
