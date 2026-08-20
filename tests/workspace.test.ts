/**
 * The workspace row: the default a new chat starts on, and which connection
 * draws.
 *
 * The load-bearing property is the resolution order — thread, then project,
 * then workspace, then whatever exists — because getting it wrong is invisible
 * until someone with three connections finds their chats opening on the wrong
 * one. The other is that a default pointing at a deleted connection degrades to
 * the old behaviour rather than to an error.
 */

import { describe, expect, it } from "vitest";

import { createDb } from "../src/server/db/index.js";
import { connections } from "../src/server/db/schema.js";
import { bury, put } from "../src/server/db/write.js";
import {
  chatDefault,
  imageEngine,
  updateWorkspace,
  workspaceRow,
} from "../src/server/workspace.js";

const store = () => createDb(":memory:");

/**
 * A key variable that is really set.
 *
 * `imageEngine` deliberately requires the connection to be usable, so a
 * fixture with no key would resolve to null everywhere and every assertion
 * below would pass for the wrong reason.
 */
const KEY_ENV = "MODELDOCK_TEST_WORKSPACE_KEY";
process.env[KEY_ENV] = "test-key";

const connection = (
  db: ReturnType<typeof store>,
  name: string,
  kind: "anthropic" | "openai" | "google" | "ollama" | "openai_compatible",
  model = "m",
) =>
  put(db, connections, {
    name,
    kind,
    model,
    apiKeyEnv: KEY_ENV,
    baseUrl: "http://localhost/v1",
  });

describe("the workspace row", () => {
  it("is created on first read, through the ordinary write path", async () => {
    const db = store();
    const row = await workspaceRow(db);

    expect(row.id).toBeTruthy();
    expect(row.defaultConnectionId).toBeNull();

    // Same row on a second read, not a second row.
    expect((await workspaceRow(db)).id).toBe(row.id);
  });

  it("gives two fresh stores the same id, so pairing merges them into one", async () => {
    const a = await workspaceRow(store());
    const b = await workspaceRow(store());

    expect(a.id).toBe(b.id);
  });
});

describe("where a new chat starts", () => {
  it("falls back to the first connection when nothing is chosen", async () => {
    const db = store();
    const first = connection(db, "First", "openai");
    connection(db, "Second", "google");

    expect((await chatDefault(db)).connectionId).toBe(first.id);
  });

  it("prefers the chosen default over the first one", async () => {
    const db = store();
    connection(db, "First", "openai");
    const chosen = connection(db, "Chosen", "google");

    await updateWorkspace(db, { defaultConnectionId: chosen.id, defaultModel: "gemini-2.5-pro" });

    const resolved = await chatDefault(db);
    expect(resolved.connectionId).toBe(chosen.id);
    expect(resolved.model).toBe("gemini-2.5-pro");
  });

  /**
   * The stale-pointer case. Deleting the connection a default names must not
   * break starting a chat — the row is out of date, not wrong, and the useful
   * response to an out-of-date pointer is to ignore it.
   */
  it("ignores a default whose connection has been deleted", async () => {
    const db = store();
    const first = connection(db, "First", "openai");
    const doomed = connection(db, "Doomed", "google");

    await updateWorkspace(db, { defaultConnectionId: doomed.id, defaultModel: "gemini-2.5-pro" });
    bury(db, connections, doomed.id);

    const resolved = await chatDefault(db);
    expect(resolved.connectionId).toBe(first.id);
    // The dead connection's model does not travel to the replacement, which
    // would name something that does not exist there.
    expect(resolved.model).toBeNull();
  });

  it("reports no connection at all rather than throwing", async () => {
    expect((await chatDefault(store())).connectionId).toBeNull();
  });
});

describe("which connection draws", () => {
  it("is off until one is chosen", async () => {
    const db = store();
    connection(db, "OpenAI", "openai");

    expect(await imageEngine(db)).toBeNull();
  });

  it("falls back to the kind's own default model", async () => {
    const db = store();
    const openai = connection(db, "OpenAI", "openai");
    await updateWorkspace(db, { imageConnectionId: openai.id });

    const engine = await imageEngine(db);
    expect(engine?.model).toBe("gpt-image-1");
  });

  it("takes an explicit model over the default", async () => {
    const db = store();
    const openai = connection(db, "OpenAI", "openai");
    await updateWorkspace(db, { imageConnectionId: openai.id, imageModel: "dall-e-3" });

    expect((await imageEngine(db))?.model).toBe("dall-e-3");
  });

  /**
   * Anthropic publishes no image model. A row naming one resolves to nothing
   * rather than to a tool that fails on first use — which is what makes
   * "Claude answering, OpenAI drawing" the ordinary arrangement rather than a
   * special case someone has to discover.
   */
  it("is off when the chosen connection's kind cannot draw", async () => {
    const db = store();
    const claude = put(db, connections, {
      name: "Anthropic",
      kind: "anthropic",
      model: "claude-sonnet-4-5",
      apiKeyEnv: null,
    });
    await updateWorkspace(db, { imageConnectionId: claude.id });

    expect(await imageEngine(db)).toBeNull();
  });

  it("is off when a local endpoint names no model at all", async () => {
    const db = store();
    const local = connection(db, "LM Studio", "openai_compatible");
    await updateWorkspace(db, { imageConnectionId: local.id });

    // openai_compatible has no default image model — guessing one for someone's
    // own server would be a confident 404.
    expect(await imageEngine(db)).toBeNull();

    await updateWorkspace(db, { imageModel: "sd-xl" });
    expect((await imageEngine(db))?.model).toBe("sd-xl");
  });
});

describe("per-column merging", () => {
  it("keeps a default set on one device and an image model set on another", async () => {
    const db = store();
    const a = connection(db, "A", "openai");
    const b = connection(db, "B", "google");

    await updateWorkspace(db, { defaultConnectionId: a.id });
    await updateWorkspace(db, { imageConnectionId: b.id, imageModel: "imagen-4.0-generate-001" });

    const row = await workspaceRow(db);
    expect(row.defaultConnectionId).toBe(a.id);
    expect(row.imageConnectionId).toBe(b.id);
  });
});
