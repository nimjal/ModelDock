/**
 * The provider layer, which is where the anti-lock-in claim is either true or
 * it isn't. Two things matter here: every kind resolves through one function,
 * and a key never reaches the database.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../src/server/db/index.js";
import { connections, type Connection } from "../src/server/db/schema.js";
import { KINDS } from "../src/server/providers/catalog.js";
import {
  ConnectionError,
  checkConnection,
  resolveApiKey,
  resolveModel,
} from "../src/server/providers/registry.js";

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "test",
    name: "Test",
    kind: "anthropic",
    baseUrl: null,
    model: "claude-sonnet-4-5",
    apiKeyEnv: "TEST_KEY",
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...overrides,
  } as Connection;
}

describe("resolveModel", () => {
  beforeEach(() => {
    process.env.TEST_KEY = "sk-test-value";
  });

  it("resolves every kind the schema allows", () => {
    const cases: Connection[] = [
      connection({ kind: "anthropic", model: "claude-sonnet-4-5" }),
      connection({ kind: "openai", model: "gpt-4.1" }),
      connection({ kind: "google", model: "gemini-2.5-pro" }),
      connection({
        kind: "openai_compatible",
        model: "my-model",
        baseUrl: "https://api.example.com/v1",
      }),
      connection({
        kind: "ollama",
        model: "llama3.2",
        baseUrl: "http://localhost:11434/v1",
        apiKeyEnv: null,
      }),
    ];

    for (const row of cases) {
      const model = resolveModel(row);
      expect(model, `${row.kind} should resolve`).toBeDefined();
    }
  });

  it("lets the caller override the model without changing the connection", () => {
    const row = connection({ model: "claude-sonnet-4-5" });
    expect(resolveModel(row, "claude-opus-4-1")).toBeDefined();
    // The row is untouched — the override is per-turn.
    expect(row.model).toBe("claude-sonnet-4-5");
  });

  it("refuses an OpenAI-compatible endpoint with no base URL", () => {
    const row = connection({ kind: "openai_compatible", baseUrl: null });
    expect(() => resolveModel(row)).toThrow(ConnectionError);
  });

  it("names the missing variable when a required key is unset", () => {
    delete process.env.TEST_KEY;
    expect(() => resolveModel(connection())).toThrow(/TEST_KEY/);
  });

  it("allows a keyless local endpoint", () => {
    const row = connection({
      kind: "ollama",
      apiKeyEnv: null,
      baseUrl: "http://localhost:11434/v1",
    });
    expect(resolveApiKey(row)).toBeNull();
    expect(checkConnection(row).ok).toBe(true);
  });
});

describe("credentials", () => {
  it("never writes a key to the database", async () => {
    process.env.SECRET_KEY_VAR = "sk-do-not-persist";

    await db().insert(connections).values({
      name: "Keyed",
      kind: "anthropic",
      model: "claude-sonnet-4-5",
      apiKeyEnv: "SECRET_KEY_VAR",
    });

    const [row] = await db().select().from(connections);

    // The row names the variable and nothing more. Serialising the whole row
    // is the check that matters: it is what a backup or a sync would carry.
    expect(row!.apiKeyEnv).toBe("SECRET_KEY_VAR");
    expect(JSON.stringify(row)).not.toContain("sk-do-not-persist");

    // But it still resolves, from the environment, at call time.
    expect(resolveApiKey(row!)).toBe("sk-do-not-persist");
  });
});

describe("catalog", () => {
  it("gives an unbranded endpoint a neutral accent", () => {
    // Only real providers get to paint the berth. A private box does not
    // borrow someone else's identity.
    expect(KINDS.openai_compatible.accent).toBe("#8A8F8C");
    expect(KINDS.anthropic.accent).not.toBe(KINDS.openai.accent);
  });
});
