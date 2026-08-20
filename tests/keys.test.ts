/**
 * Keys typed into the app.
 *
 * This is the one feature in ModelDock that handles a credential, so it is the
 * one that has to prove it did not break the promise the rest of the codebase
 * is built on. Four properties matter here, and each of them is a thing someone
 * would reasonably assume without checking:
 *
 *   - the value reaches `resolveApiKey`, or the feature does nothing;
 *   - the value never reaches the database, or a synced store leaks;
 *   - the value never reaches a subprocess, or `run_command` reads it back;
 *   - a name that is not a credential is refused, or a settings form becomes a
 *     way to set `NODE_OPTIONS` on a process that spawns shells.
 */

import { readFileSync, statSync } from "node:fs";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createApp } from "../src/server/app.js";
import { keysPath } from "../src/server/config.js";
import { db } from "../src/server/db/index.js";
import { connections } from "../src/server/db/schema.js";
import { childEnv } from "../src/server/files/shell.js";
import {
  deleteKey,
  KeyError,
  keyStatus,
  loadKeys,
  saveKey,
  savedNames,
} from "../src/server/keys.js";
import { resolveApiKey } from "../src/server/providers/registry.js";

const NAME = "TEST_PROVIDER_KEY";
const VALUE = "sk-typed-into-the-app-9f3c";

function clean() {
  for (const name of savedNames()) deleteKey(name);
  delete process.env[NAME];
}

beforeEach(clean);
afterEach(clean);

describe("saving a key", () => {
  it("puts the value where the provider layer already looks", () => {
    saveKey(NAME, VALUE);

    // The point of the whole design: nothing downstream had to learn about
    // this file. `resolveApiKey` reads the environment exactly as before.
    expect(resolveApiKey({ kind: "anthropic", apiKeyEnv: NAME, name: "Typed" })).toBe(VALUE);
  });

  it("survives a restart, which is what a file buys over an export", () => {
    saveKey(NAME, VALUE);
    delete process.env[NAME];

    loadKeys();
    expect(process.env[NAME]).toBe(VALUE);
  });

  it("reports where a value came from, and never what it is", () => {
    saveKey(NAME, VALUE);
    const status = keyStatus(NAME);

    expect(status.set).toBe(true);
    expect(status.source).toBe("file");
    expect(status.tail).toBe(VALUE.slice(-4));
    // The status object is what crosses the HTTP boundary, so serialising the
    // whole thing is the check that matters.
    expect(JSON.stringify(status)).not.toContain(VALUE);
  });

  it("refuses a value carrying a line break, rather than writing half of it", () => {
    // A newline would end the record early and silently split one key into a
    // corrupt pair on the next read.
    expect(() => saveKey(NAME, "sk-one\nEVIL=two")).toThrow(KeyError);
    expect(savedNames()).not.toContain(NAME);
  });
});

describe("what a name is allowed to be", () => {
  it("refuses variables that change how a program starts", () => {
    // These are not credentials. Accepting one would turn a settings form into
    // an execution hook for every agent and shell this process spawns.
    for (const name of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "GIT_SSH_COMMAND"]) {
      expect(() => saveKey(name, "anything"), name).toThrow(KeyError);
      expect(process.env[name]).not.toBe("anything");
    }
  });

  it("refuses ModelDock's own configuration", () => {
    expect(() => saveKey("MODELDOCK_HOME", "/tmp/elsewhere")).toThrow(KeyError);
  });

  it("refuses a name that is not a variable name at all", () => {
    for (const name of ["", "has space", "a=b", "PATH;rm -rf /", "1LEADING"]) {
      expect(() => saveKey(name, "x"), JSON.stringify(name)).toThrow(KeyError);
    }
  });
});

describe("precedence over an inherited variable", () => {
  it("wins, because it was set here and set most recently", () => {
    process.env[NAME] = "sk-from-the-shell";
    loadKeys();

    saveKey(NAME, VALUE);
    expect(process.env[NAME]).toBe(VALUE);
    expect(keyStatus(NAME).shadowsEnvironment).toBe(true);
  });

  it("gives the inherited value back when the saved one is removed", () => {
    process.env[NAME] = "sk-from-the-shell";
    saveKey(NAME, VALUE);

    deleteKey(NAME);

    // Not a hole: someone who exported a key before they ever opened ModelDock
    // is returned to exactly where they started.
    expect(process.env[NAME]).toBe("sk-from-the-shell");
    expect(keyStatus(NAME).source).toBe("environment");
  });

  it("leaves nothing behind when there was nothing to fall back to", () => {
    saveKey(NAME, VALUE);
    deleteKey(NAME);

    expect(process.env[NAME]).toBeUndefined();
    expect(keyStatus(NAME).set).toBe(false);
  });
});

describe("the promises the rest of the codebase makes", () => {
  it("never writes the value into the database", async () => {
    saveKey(NAME, VALUE);

    await db().insert(connections).values({
      name: "Typed key",
      kind: "anthropic",
      model: "claude-sonnet-4-5",
      apiKeyEnv: NAME,
    });

    const rows = await db().select().from(connections);
    // Serialising every row is what a backup or a sync would carry.
    expect(JSON.stringify(rows)).not.toContain(VALUE);
  });

  it("hides the value from a shell the model can run", () => {
    saveKey(NAME, VALUE);

    // `run_command` inherits `process.env`, and a key put there at startup is
    // indistinguishable from an exported one — which is exactly why the strip
    // list has to read the saved names rather than trust the caller's.
    expect(childEnv()[NAME]).toBeUndefined();
  });

  it("keeps the file readable only by this account", () => {
    saveKey(NAME, VALUE);

    const contents = readFileSync(keysPath(), "utf8");
    expect(contents).toContain(`${NAME}=${VALUE}`);
    // Not asserted on Windows, where mode bits are not how access is decided.
    if (process.platform !== "win32") {
      expect(statSync(keysPath()).mode & 0o077).toBe(0);
    }
  });
});

/**
 * The HTTP boundary is one-directional on purpose: a value can be written and
 * can never be read back. If that ever stops being true, every other guarantee
 * in this file is decoration — a page on the open internet could not reach
 * loopback, but anything already running as this user could.
 */
describe("the API surface", () => {
  const app = createApp({ port: 8765 });
  const BASE = "http://127.0.0.1:8765";
  const HEADERS = { "content-type": "application/json", host: "127.0.0.1:8765" };

  it("takes a key in and will not give one back", async () => {
    const saved = await app.request(`${BASE}/api/keys/${NAME}`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ value: VALUE }),
    });
    expect(saved.status).toBe(200);

    const listed = await app.request(`${BASE}/api/keys`, { headers: HEADERS });
    const body = await listed.text();

    expect(body).toContain(NAME);
    expect(body).toContain('"source":"file"');
    // The whole response, not one field: there is no route that returns a key,
    // and this is what would catch one being added.
    expect(body).not.toContain(VALUE);
  });

  it("refuses a name that is not a credential, with a reason", async () => {
    const response = await app.request(`${BASE}/api/keys/NODE_OPTIONS`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ value: "--inspect" }),
    });

    expect(response.status).toBe(400);
    expect(process.env.NODE_OPTIONS).not.toBe("--inspect");
  });

  it("describes the providers a first run can choose from", async () => {
    const response = await app.request(`${BASE}/api/connections`, { headers: HEADERS });
    const body = (await response.json()) as { presets: { id: string; apiKeyEnv: string | null }[] };

    // The setup screen is driven entirely by this list, so an empty or
    // malformed one is a blank first run rather than a visible error.
    expect(body.presets.length).toBeGreaterThan(5);
    expect(body.presets.map((preset) => preset.id)).toContain("ollama");
    expect(body.presets.some((preset) => preset.apiKeyEnv === "ANTHROPIC_API_KEY")).toBe(true);
  });
});
