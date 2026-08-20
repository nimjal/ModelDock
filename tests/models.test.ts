/**
 * Asking a provider what it can run.
 *
 * Four unrelated REST shapes normalised into one list, which is the kind of
 * code that looks obviously correct and is quietly wrong for one provider. So
 * each shape is driven against a stubbed endpoint here rather than discovered
 * by someone whose model picker is mysteriously empty.
 *
 * The behaviour that matters most is the last group: a provider that cannot
 * answer must produce a sentence someone can act on, because listing is an
 * accelerator and the picker still has to work without it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listModels } from "../src/server/providers/models.js";
import { ConnectionError } from "../src/server/providers/registry.js";

interface Call {
  url: string;
  headers: Record<string, string>;
}

let calls: Call[] = [];

/** Answer every request with the same body, and record what was asked. */
function stub(body: unknown, init: { status?: number; text?: string } = {}) {
  const fetchStub = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (options?.headers ?? {}) as Record<string, string>,
    });
    return new Response(init.text ?? JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the OpenAI shape, which most kinds share", () => {
  it("keeps every id and flags the ones that cannot hold a conversation", async () => {
    stub({
      data: [
        { id: "gpt-4.1" },
        { id: "text-embedding-3-small" },
        { id: "whisper-1" },
        { id: "dall-e-3" },
        { id: "o4-mini" },
      ],
    });

    const models = await listModels({ kind: "openai", apiKey: "sk-test" });

    // Nothing is dropped: a picker that silently hid a model would be
    // indistinguishable from a provider that never had it.
    expect(models.map((model) => model.id).sort()).toEqual([
      "dall-e-3",
      "gpt-4.1",
      "o4-mini",
      "text-embedding-3-small",
      "whisper-1",
    ]);

    const chat = models.filter((model) => model.chat).map((model) => model.id);
    expect(chat).toEqual(["gpt-4.1", "o4-mini"]);
  });

  it("puts conversational models first, then sorts by id", async () => {
    stub({ data: [{ id: "zeta" }, { id: "text-embedding-3-small" }, { id: "alpha" }] });

    const models = await listModels({ kind: "openai", apiKey: "sk-test" });
    // The order an endpoint returns is arbitrary and often insertion order,
    // which reads as random in a list.
    expect(models.map((model) => model.id)).toEqual(["alpha", "zeta", "text-embedding-3-small"]);
  });

  it("normalises a base URL someone pasted with a trailing slash", async () => {
    stub({ data: [{ id: "llama3.2" }] });

    await listModels({ kind: "ollama", baseUrl: "http://localhost:11434/v1/" });
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/models");
  });

  it("sends no token to a local server that never asked for one", async () => {
    stub({ data: [{ id: "llama3.2" }] });

    await listModels({ kind: "ollama", baseUrl: "http://localhost:11434/v1" });
    // An empty bearer is not the same as no bearer: some local servers reject
    // a token they did not expect.
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });
});

describe("Anthropic", () => {
  it("follows the pages to the end", async () => {
    const pages = [
      {
        data: [{ id: "claude-opus-4-1", display_name: "Claude Opus 4.1" }],
        has_more: true,
        last_id: "claude-opus-4-1",
      },
      { data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" }], has_more: false },
    ];
    let page = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
        calls.push({
          url: String(url),
          headers: (options?.headers ?? {}) as Record<string, string>,
        });
        return new Response(JSON.stringify(pages[page++]), { status: 200 });
      }),
    );

    const models = await listModels({ kind: "anthropic", apiKey: "sk-ant-test" });

    expect(models.map((model) => model.id)).toEqual(["claude-opus-4-1", "claude-sonnet-4-5"]);
    expect(models[0]!.label).toBe("Claude Opus 4.1");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("after_id=claude-opus-4-1");
  });

  it("authenticates the way Anthropic asks", async () => {
    stub({ data: [], has_more: false });
    await listModels({ kind: "anthropic", apiKey: "sk-ant-test" });

    expect(calls[0]!.headers["x-api-key"]).toBe("sk-ant-test");
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("Google", () => {
  it("strips the models/ prefix and believes what the endpoint says about chat", async () => {
    stub({
      models: [
        {
          name: "models/gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          supportedGenerationMethods: ["generateContent", "countTokens"],
        },
        {
          name: "models/text-embedding-004",
          displayName: "Embedding 004",
          supportedGenerationMethods: ["embedContent"],
        },
      ],
    });

    const models = await listModels({ kind: "google", apiKey: "goog-test" });

    expect(models[0]).toMatchObject({ id: "gemini-2.5-pro", chat: true });
    // The one kind where `chat` is reported rather than guessed from the id.
    expect(models.find((model) => model.id === "text-embedding-004")?.chat).toBe(false);
  });

  it("puts the key in a header rather than the query string", async () => {
    stub({ models: [] });
    await listModels({ kind: "google", apiKey: "goog-secret" });

    // A key in a URL ends up in proxy logs and Referer headers.
    expect(calls[0]!.url).not.toContain("goog-secret");
    expect(calls[0]!.headers["x-goog-api-key"]).toBe("goog-secret");
  });
});

describe("when a provider cannot answer", () => {
  it("says the key was rejected", async () => {
    stub({}, { status: 401 });
    await expect(
      listModels({ kind: "openai", apiKey: "sk-wrong", label: "OpenAI" }),
    ).rejects.toThrow(/rejected that key/i);
  });

  it("suggests typing a model when there is no list to fetch", async () => {
    stub({}, { status: 404 });
    // The failure someone hits with a proxy that serves chat but not /models,
    // and the message has to point at the way out rather than just complain.
    await expect(
      listModels({
        kind: "openai_compatible",
        baseUrl: "https://proxy.example/v1",
        label: "My proxy",
      }),
    ).rejects.toThrow(/enter a model name instead/i);
  });

  it("blames the base URL when the answer is not JSON", async () => {
    stub(null, { text: "<!doctype html><title>Sign in</title>" });
    await expect(
      listModels({ kind: "openai_compatible", baseUrl: "https://example.com", label: "Something" }),
    ).rejects.toThrow(/base URL/i);
  });

  it("does not call out at all when there is nothing to authenticate with", async () => {
    const fetchStub = stub({ data: [] });
    await expect(listModels({ kind: "anthropic" })).rejects.toThrow(ConnectionError);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses an OpenAI-compatible endpoint with no base URL", async () => {
    const fetchStub = stub({ data: [] });
    await expect(
      listModels({ kind: "openai_compatible", apiKey: "sk-test", label: "Mystery" }),
    ).rejects.toThrow(/base URL/i);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
