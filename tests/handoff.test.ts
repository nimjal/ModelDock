/**
 * Pointing Claude Code and OpenCode at ModelDock.
 *
 * This is the only code in the project that writes outside `~/.modeldock`, into
 * files people have hand-edited and care about, so what is asserted here is
 * mostly restraint:
 *
 *   - a config that cannot be parsed is never rewritten from a partial
 *     understanding of it;
 *   - keys the handoff did not add are still there afterwards;
 *   - the original is copied aside before the first write, and a second apply
 *     does not overwrite that copy with an already-modified file;
 *   - revert removes what was added and leaves everything else, including
 *     things added after the handoff.
 *
 * Both tools' config locations are redirected with the environment variables
 * they themselves document — `CLAUDE_CONFIG_DIR` and `XDG_CONFIG_HOME` — so no
 * test can reach a real install.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../src/server/db/index.js";
import { HANDOFFS } from "../src/server/handoff/catalog.js";
import { applyHandoff, revertHandoff } from "../src/server/handoff/apply.js";
import { diffLines, planHandoff } from "../src/server/handoff/plan.js";

const home = mkdtempSync(join(tmpdir(), "modeldock-handoff-"));
process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
process.env.XDG_CONFIG_HOME = join(home, "config");

const PORT = 8765;

afterAll(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* the OS will get it */
  }
});

const claudePath = () => HANDOFFS.claude_code.path();
const opencodePath = () => HANDOFFS.opencode.path();

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
};

const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

beforeEach(() => {
  rmSync(join(home, "claude"), { recursive: true, force: true });
  rmSync(join(home, "config"), { recursive: true, force: true });
});

describe("planning, before anything is written", () => {
  it("writes nothing", async () => {
    await planHandoff(db(), "claude_code", PORT);
    expect(existsSync(claudePath())).toBe(false);
  });

  it("offers to create a config that is not there yet", async () => {
    const plan = await planHandoff(db(), "claude_code", PORT);

    expect(plan.exists).toBe(false);
    expect(plan.applied).toBe(false);
    expect(plan.proposed).toContain("ANTHROPIC_BASE_URL");
    expect(plan.diff.some((line) => line.kind === "add")).toBe(true);
  });

  /**
   * The one that matters most. A file with a trailing comma in it must not be
   * replaced by this feature's idea of what it probably said.
   */
  it("refuses to rewrite a config it cannot parse", async () => {
    write(claudePath(), '{ "env": { "FOO": "bar", } }');

    const plan = await planHandoff(db(), "claude_code", PORT);
    expect(plan.problem).toMatch(/not valid JSON/);
    expect(plan.diff).toEqual([]);

    await expect(applyHandoff(db(), "claude_code", PORT)).rejects.toThrow(/not valid JSON/);
    // Untouched.
    expect(readFileSync(claudePath(), "utf8")).toBe('{ "env": { "FOO": "bar", } }');
  });

  it("reports a config that already says the right thing as connected", async () => {
    await applyHandoff(db(), "claude_code", PORT);
    const plan = await planHandoff(db(), "claude_code", PORT);

    expect(plan.applied).toBe(true);
  });
});

describe("Claude Code", () => {
  it("adds the two variables and leaves everything else alone", async () => {
    write(
      claudePath(),
      JSON.stringify({
        model: "opus",
        env: { MY_OWN: "keep me" },
        permissions: { allow: ["Bash(ls:*)"] },
      }),
    );

    await applyHandoff(db(), "claude_code", PORT);
    const config = read(claudePath());

    const env = config.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8765");
    expect(env.ANTHROPIC_AUTH_TOKEN).toMatch(/^md-/);

    // The point of the whole surgical merge.
    expect(env.MY_OWN).toBe("keep me");
    expect(config.model).toBe("opus");
    expect(config.permissions).toEqual({ allow: ["Bash(ls:*)"] });
  });

  /**
   * Claude Code appends `/v1/messages` itself, so it must be given the origin.
   * A `/v1` here would produce `/v1/v1/messages` and a 404 that reads as the
   * gateway being broken.
   */
  it("gives the origin, not the /v1 path", async () => {
    await applyHandoff(db(), "claude_code", PORT);
    const env = read(claudePath()).env as Record<string, string>;

    expect(env.ANTHROPIC_BASE_URL).not.toMatch(/\/v1$/);
  });

  /**
   * The port has to be the one actually being served.
   *
   * `resolvePort()` reports what the environment asks for and knows nothing
   * about `--port`, so reading it here produced a config that looked correct
   * and pointed at a port nothing was listening on. Everywhere else in the app
   * the distinction is invisible — every other caller is answering a browser on
   * the connection it arrived by — which is exactly why it went unnoticed.
   */
  it("writes the port the server is actually on, not the default", async () => {
    await applyHandoff(db(), "claude_code", 8792);
    const env = read(claudePath()).env as Record<string, string>;

    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8792");
  });

  it("keeps a backup, and does not clobber it on a second apply", async () => {
    write(claudePath(), JSON.stringify({ env: { ORIGINAL: "yes" } }));

    const first = await applyHandoff(db(), "claude_code", PORT);
    expect(first.backupPath).toBeTruthy();

    await applyHandoff(db(), "claude_code", PORT);

    // Still the pristine original, not the already-modified first pass.
    const backup = JSON.parse(readFileSync(first.backupPath!, "utf8")) as {
      env: Record<string, string>;
    };
    expect(backup.env.ORIGINAL).toBe("yes");
    expect(backup.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("takes only its own keys back out on revert", async () => {
    write(claudePath(), JSON.stringify({ env: { MY_OWN: "keep me" }, model: "opus" }));

    await applyHandoff(db(), "claude_code", PORT);
    await revertHandoff(db(), "claude_code", PORT);

    const config = read(claudePath());
    expect((config.env as Record<string, string>).MY_OWN).toBe("keep me");
    expect((config.env as Record<string, string>).ANTHROPIC_BASE_URL).toBeUndefined();
    expect(config.model).toBe("opus");
  });

  it("removes an env block it was the only occupant of", async () => {
    await applyHandoff(db(), "claude_code", PORT);
    await revertHandoff(db(), "claude_code", PORT);

    // Returned to the shape it had rather than left with an empty object.
    expect(read(claudePath()).env).toBeUndefined();
  });

  it("is a no-op when there is nothing to revert", async () => {
    await expect(revertHandoff(db(), "claude_code", PORT)).resolves.toBeTruthy();
  });
});

describe("OpenCode", () => {
  it("adds one provider and leaves any others in place", async () => {
    write(
      opencodePath(),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: { mine: { npm: "@ai-sdk/openai-compatible", name: "Mine" } },
        theme: "dark",
      }),
    );

    await applyHandoff(db(), "opencode", PORT);
    const config = read(opencodePath());
    const provider = config.provider as Record<string, Record<string, unknown>>;

    expect(provider.mine).toBeTruthy();
    expect(provider.modeldock!.npm).toBe("@ai-sdk/openai-compatible");
    expect(config.theme).toBe("dark");
  });

  /**
   * OpenCode hands this to `@ai-sdk/openai-compatible`, which appends
   * `/chat/completions` — so unlike Claude Code it needs the `/v1` included.
   */
  it("gives the /v1 base URL and the token as the apiKey", async () => {
    await applyHandoff(db(), "opencode", PORT);
    const provider = (read(opencodePath()).provider as Record<string, Record<string, unknown>>)
      .modeldock!;
    const options = provider.options as Record<string, string>;

    expect(options.baseURL).toBe("http://127.0.0.1:8765/v1");
    expect(options.apiKey).toMatch(/^md-/);
  });

  it("adds the schema line to a config it creates", async () => {
    await applyHandoff(db(), "opencode", PORT);
    expect(read(opencodePath()).$schema).toBe("https://opencode.ai/config.json");
  });

  /**
   * Revert promises to remove exactly what was added. A `$schema` is not
   * something it can take back out without guessing whether the person has
   * since come to rely on it, so it is never added to a file that already
   * existed — an asymmetry between apply and revert is worse than a missing
   * editor-completion hint.
   */
  it("does not add a schema line to a config someone already wrote", async () => {
    write(opencodePath(), JSON.stringify({ theme: "dark" }));

    await applyHandoff(db(), "opencode", PORT);
    expect(read(opencodePath()).$schema).toBeUndefined();
  });

  it("leaves an existing config byte-identical after apply and revert", async () => {
    const original = `${JSON.stringify({ theme: "dark", provider: { mine: { name: "Mine" } } }, null, 2)}\n`;
    write(opencodePath(), original);

    await applyHandoff(db(), "opencode", PORT);
    await revertHandoff(db(), "opencode", PORT);

    expect(readFileSync(opencodePath(), "utf8")).toBe(original);
  });

  it("drops only its own provider on revert", async () => {
    write(opencodePath(), JSON.stringify({ provider: { mine: { name: "Mine" } } }));

    await applyHandoff(db(), "opencode", PORT);
    await revertHandoff(db(), "opencode", PORT);

    const provider = read(opencodePath()).provider as Record<string, unknown>;
    expect(provider.mine).toBeTruthy();
    expect(provider.modeldock).toBeUndefined();
  });
});

describe("the diff shown before applying", () => {
  it("marks added and removed lines and leaves the rest alone", () => {
    const diff = diffLines("a\nb\nc\n", "a\nB\nc\n");

    expect(diff.filter((line) => line.kind === "add").map((line) => line.text)).toEqual(["B"]);
    expect(diff.filter((line) => line.kind === "remove").map((line) => line.text)).toEqual(["b"]);
    expect(diff.filter((line) => line.kind === "same")).toHaveLength(3);
  });

  it("is all additions when there was no file", () => {
    const diff = diffLines("", "one\ntwo\n");
    expect(diff.every((line) => line.kind === "add")).toBe(true);
  });

  it("reconstructs the proposed file exactly", async () => {
    write(claudePath(), JSON.stringify({ model: "opus" }));
    const plan = await planHandoff(db(), "claude_code", PORT);

    const rebuilt = plan.diff
      .filter((line) => line.kind !== "remove")
      .map((line) => line.text)
      .join("\n");

    expect(rebuilt).toBe(plan.proposed);
  });
});
