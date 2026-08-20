/**
 * The shell tool, which is the most dangerous thing in this codebase.
 *
 * The directory boundary does not contain a shell and this project says so
 * plainly rather than implying otherwise — `boundaryHolds` is false wherever
 * `run_command` exists. So what is tested here is everything that *is* a
 * guarantee: the working directory, the credentials the child cannot see, the
 * timeout, and that a failure is reported rather than thrown.
 *
 * The env test is the one that matters most. `connections.apiKeyEnv` names the
 * variable holding a real key, and a child inherits `process.env` — so without
 * stripping, `echo $ANTHROPIC_API_KEY` hands a model a live credential from a
 * store that otherwise never holds one.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { childEnv, shellTools } from "../src/server/files/shell.js";

let root: string;
let tools: ReturnType<typeof shellTools>;

/** See the note in files.test.ts: `execute` is typed loosely by the SDK. */
async function run(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const execute = tools.run_command.execute as unknown as (
    input: unknown,
    options: unknown,
  ) => Promise<Record<string, unknown>>;
  return execute(input, {});
}

/** Node is what every machine running these tests definitely has. */
const node = (script: string) => `node -e "${script}"`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "modeldock-shell-"));
  writeFileSync(join(root, "marker.txt"), "here\n");
  tools = shellTools({ root, secrets: ["MODELDOCK_TEST_KEY"] });
});

describe("running a command", () => {
  it("reports stdout and a zero exit", async () => {
    const result = await run({ command: node("process.stdout.write('hello')") });

    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).toContain("hello");
    expect(result.error).toBeUndefined();
  });

  it("reports a non-zero exit rather than throwing", async () => {
    const result = await run({ command: node("process.exit(3)") });

    expect(result.exitCode).toBe(3);
    expect(result.error).toBeUndefined();
  });

  it("captures stderr", async () => {
    const result = await run({ command: node("process.stderr.write('went wrong')") });

    expect(String(result.stderr)).toContain("went wrong");
  });
});

describe("where it runs", () => {
  it("runs in the project root, which is never an input", async () => {
    // Asserted by what the command can see rather than by comparing path
    // strings: macOS hands out /var as a symlink to /private/var, and Windows
    // has 8.3 short names, so the paths would differ while being the same
    // directory. The file listing is unambiguous.
    const listed = await run({
      command: node("process.stdout.write(require('fs').readdirSync('.').join(','))"),
    });

    expect(String(listed.stdout)).toContain("marker.txt");
    expect(readFileSync(join(root, "marker.txt"), "utf8")).toBe("here\n");
  });
});

describe("what the child cannot see", () => {
  it("strips a variable the store names as holding a key", async () => {
    process.env.MODELDOCK_TEST_KEY = "sk-do-not-leak";

    const result = await run({
      command: node("process.stdout.write(String(process.env.MODELDOCK_TEST_KEY))"),
    });

    expect(String(result.stdout)).toBe("undefined");
    expect(String(result.stdout)).not.toContain("sk-do-not-leak");
  });

  it("strips the conventional provider keys even if the store never named them", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-live";
    process.env.GITHUB_TOKEN = "ghp_live";

    const env = childEnv([]);

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    // Still an ordinary environment otherwise.
    expect(env.PATH ?? env.Path).toBeTruthy();
  });

  it("tells a script it is running under ModelDock", () => {
    expect(childEnv([]).MODELDOCK).toBe("1");
  });
});

describe("a command that will not finish", () => {
  it("is killed, and says so instead of hanging the turn", async () => {
    const result = await run({
      command: node("setTimeout(() => {}, 60000)"),
      timeout_ms: 1000,
    });

    expect(String(result.error)).toMatch(/timed out/i);
    expect(result.exitCode).toBeNull();
  }, 15_000);
});
