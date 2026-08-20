/**
 * The gateway: every model on this machine, in two other people's protocols.
 *
 * Three things are worth protecting here.
 *
 * The **token**, because the gateway is the one surface that turns every key on
 * this machine into a general-purpose endpoint, and the rest of the app's
 * loopback-only posture does not distinguish one local process from another.
 *
 * The **model id split**, because it is on the *first* slash and the most
 * common openai_compatible setup in the world — OpenRouter — has slashes in its
 * own model ids. Splitting on the last one would break exactly the case the
 * feature exists for.
 *
 * The **message conversions**, because a wrong one produces an agent loop that
 * appears to work for a turn and then silently loses its tool results.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../src/server/app.js";
import { createDb, db } from "../src/server/db/index.js";
import { connections } from "../src/server/db/schema.js";
import { put } from "../src/server/db/write.js";
import { readAnthropicRequest, stopReason } from "../src/server/gateway/anthropic.js";
import { resolveGatewayModel, slugFor, slugMap } from "../src/server/gateway/catalog.js";
import { finishReason, readOpenAiRequest } from "../src/server/gateway/openai.js";
import { checkGatewayToken, gatewayToken } from "../src/server/gateway/token.js";

const app = createApp({ port: 8765 });
const BASE = "http://127.0.0.1:8765";
const HOST = { host: "127.0.0.1:8765" };

describe("the token", () => {
  it("accepts either header spelling, because both clients are right", () => {
    const token = gatewayToken();

    expect(checkGatewayToken(new Headers({ authorization: `Bearer ${token}` }))).toBe(true);
    expect(checkGatewayToken(new Headers({ "x-api-key": token }))).toBe(true);
  });

  it("refuses a wrong token, an absent one, and one of a different length", () => {
    expect(checkGatewayToken(new Headers())).toBe(false);
    expect(checkGatewayToken(new Headers({ "x-api-key": "nope" }))).toBe(false);
    expect(checkGatewayToken(new Headers({ "x-api-key": `${gatewayToken()}x` }))).toBe(false);
  });

  it("is stable across calls, because it is written into another tool's config", () => {
    expect(gatewayToken()).toBe(gatewayToken());
  });

  it("guards every gateway route", async () => {
    const response = await app.request(`${BASE}/v1/models`, { headers: HOST });
    expect(response.status).toBe(401);

    const body = (await response.json()) as { error: { message: string } };
    // The message has to say where to find the token, not merely that one is
    // missing — this is read in a terminal, with no UI around it.
    expect(body.error.message).toMatch(/Settings/);
  });

  it("lets a request through once it carries the token", async () => {
    const response = await app.request(`${BASE}/v1/models`, {
      headers: { ...HOST, authorization: `Bearer ${gatewayToken()}` },
    });
    expect(response.status).toBe(200);
  });
});

describe("naming a model", () => {
  it("slugs a connection name into something typeable", () => {
    expect(slugFor("My Local Box")).toBe("my-local-box");
    expect(slugFor("OpenRouter")).toBe("openrouter");
    expect(slugFor("!!!")).toBe("connection");
  });

  it("disambiguates two names that slug the same way", () => {
    const rows = [
      { id: "a", name: "My Box" },
      { id: "b", name: "my-box" },
    ] as never;
    const slugs = slugMap(rows);

    expect(slugs.get("a")).toBe("my-box");
    expect(slugs.get("b")).toBe("my-box-2");
  });

  /**
   * The case the whole format is designed around. OpenRouter's own ids contain
   * a slash, so the split has to be on the first one only.
   */
  it("splits on the first slash, so a provider's own slashes survive", () => {
    const rows = [{ id: "r", name: "OpenRouter", model: "x" }] as never;
    const found = resolveGatewayModel(rows, "openrouter/anthropic/claude-sonnet-4-5");

    expect(found?.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("accepts a bare model id that matches a connection's own", () => {
    const rows = [{ id: "r", name: "Ollama", model: "llama3.2" }] as never;
    expect(resolveGatewayModel(rows, "llama3.2")?.model).toBe("llama3.2");
  });

  it("returns null for a name no connection claims", () => {
    const rows = [{ id: "r", name: "Ollama", model: "llama3.2" }] as never;
    expect(resolveGatewayModel(rows, "nope/nothing")).toBeNull();
  });
});

describe("listing what this machine can run", () => {
  it("namespaces every model under its connection", async () => {
    put(db(), connections, {
      name: "Local Box",
      kind: "openai_compatible",
      // Unreachable on purpose: listing has to degrade to the configured model
      // rather than failing the whole catalogue.
      baseUrl: "http://127.0.0.1:9/v1",
      model: "my-model",
      apiKeyEnv: null,
    });

    const response = await app.request(`${BASE}/v1/models`, {
      headers: { ...HOST, authorization: `Bearer ${gatewayToken()}` },
    });

    const body = (await response.json()) as {
      object: string;
      data: { id: string; owned_by: string }[];
      modeldock: { problems: { connection: string }[] };
    };

    expect(body.object).toBe("list");
    expect(body.data.some((model) => model.id === "local-box/my-model")).toBe(true);
    expect(body.data.find((model) => model.id === "local-box/my-model")?.owned_by).toBe(
      "Local Box",
    );
    // Named rather than silently dropped — the `doctor` instinct.
    expect(body.modeldock.problems.some((p) => p.connection === "Local Box")).toBe(true);
  });
});

describe("reading an OpenAI request", () => {
  it("lifts the system prompt out of the message array", () => {
    const request = readOpenAiRequest({
      model: "x/y",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hello" },
      ],
    });

    expect(request.system).toBe("Be brief.");
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]!.role).toBe("user");
  });

  it("joins several system messages rather than letting the last one win", () => {
    const request = readOpenAiRequest({
      model: "x/y",
      messages: [
        { role: "system", content: "One." },
        { role: "developer", content: "Two." },
        { role: "user", content: "Hi" },
      ],
    });

    expect(request.system).toBe("One.\n\nTwo.");
  });

  it("carries a tool call and its result through as a round trip", () => {
    const request = readOpenAiRequest({
      model: "x/y",
      messages: [
        { role: "user", content: "read a file" },
        {
          role: "assistant",
          tool_calls: [{ id: "call1", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
        },
        { role: "tool", tool_call_id: "call1", name: "read", content: '{"content":"hi"}' },
      ],
    });

    const assistant = request.messages[1]!;
    expect(Array.isArray(assistant.content)).toBe(true);
    expect((assistant.content as { type: string }[])[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "call1",
      toolName: "read",
      input: { path: "a.ts" },
    });

    const result = request.messages[2]!;
    expect(result.role).toBe("tool");
    expect((result.content as { output: unknown }[])[0]!.output).toEqual({
      type: "json",
      value: { content: "hi" },
    });
  });

  it("declares the caller's tools without ever giving them an executor", () => {
    const request = readOpenAiRequest({
      model: "x/y",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: { name: "bash", description: "run", parameters: { type: "object" } },
        },
      ],
    });

    expect(request.tools).toEqual([
      { name: "bash", description: "run", parameters: { type: "object" } },
    ]);
  });

  it("reports tool_calls as the finish reason whenever there was one", () => {
    expect(finishReason("stop", true)).toBe("tool_calls");
    expect(finishReason("length", false)).toBe("length");
    expect(finishReason("stop", false)).toBe("stop");
  });

  it("refuses an empty message list rather than calling a provider with nothing", () => {
    expect(() => readOpenAiRequest({ model: "x/y", messages: [] })).toThrow(/messages/);
  });
});

describe("reading an Anthropic request", () => {
  it("takes a system prompt in either spelling", () => {
    expect(
      readAnthropicRequest({
        model: "x/y",
        system: "Be brief.",
        messages: [{ role: "user", content: "Hi" }],
      }).system,
    ).toBe("Be brief.");

    expect(
      readAnthropicRequest({
        model: "x/y",
        system: [{ type: "text", text: "Be brief." }],
        messages: [{ role: "user", content: "Hi" }],
      }).system,
    ).toBe("Be brief.");
  });

  /**
   * The conversion most likely to be got wrong. Anthropic puts a tool result
   * in a *user* message; the AI SDK gives it its own role. A user turn carrying
   * both a result and prose has to become two messages, in that order.
   */
  it("splits a user turn's tool results into their own message, first", () => {
    const request = readAnthropicRequest({
      model: "x/y",
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "file contents" },
            { type: "text", text: "now explain it" },
          ],
        },
      ],
    });

    expect(request.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);

    const result = request.messages[2]!;
    expect((result.content as { toolCallId: string }[])[0]!.toolCallId).toBe("t1");
  });

  it("marks a failed tool result as an error rather than as its text", () => {
    const request = readAnthropicRequest({
      model: "x/y",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }],
        },
      ],
    });

    expect((request.messages[0]!.content as { output: unknown }[])[0]!.output).toEqual({
      type: "error-text",
      value: "boom",
    });
  });

  it("translates tool_choice into the SDK's vocabulary", () => {
    const choice = (type: string, name?: string) =>
      readAnthropicRequest({
        model: "x/y",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: { type, name },
      }).toolChoice;

    expect(choice("auto")).toBe("auto");
    expect(choice("any")).toBe("required");
    expect(choice("tool", "bash")).toEqual({ name: "bash" });
  });

  it("defaults max_tokens, which the real API requires", () => {
    expect(
      readAnthropicRequest({ model: "x/y", messages: [{ role: "user", content: "hi" }] })
        .maxOutputTokens,
    ).toBe(4096);
  });

  it("reports tool_use as the stop reason whenever there was a call", () => {
    expect(stopReason("stop", true)).toBe("tool_use");
    expect(stopReason("length", false)).toBe("max_tokens");
    expect(stopReason("stop", false)).toBe("end_turn");
  });
});

/**
 * Errors, in the shape the clients on the other side actually read.
 *
 * Both vendors nest the message in an object, and every library built against
 * them reads `error.message`. ModelDock's own page reads a bare string. Getting
 * this wrong is not cosmetic: a 404 surfaces inside Claude Code as `undefined`
 * instead of the sentence naming the model and how to list the real ones.
 */
describe("asking for a model that is not here", () => {
  const ask = (path: string, body: unknown) =>
    app.request(`${BASE}${path}`, {
      method: "POST",
      headers: {
        ...HOST,
        "content-type": "application/json",
        authorization: `Bearer ${gatewayToken()}`,
      },
      body: JSON.stringify(body),
    });

  it("says so in the vendor's error envelope, on the OpenAI path", async () => {
    const response = await ask("/v1/chat/completions", {
      model: "nothing/at-all",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("not_found_error");
    expect(body.error.message).toMatch(/<connection>\/<model>/);
  });

  it("does the same on the Anthropic path", async () => {
    const response = await ask("/v1/messages", {
      model: "nothing/at-all",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/nothing\/at-all/);
  });

  it("leaves ModelDock's own API answering in its own shape", async () => {
    const database = createDb(":memory:");
    expect(database).toBeTruthy();

    const response = await app.request(`${BASE}/api/threads/nope`, { headers: HOST });
    expect(response.status).toBe(404);

    // A bare string, which is what `lib/api.ts` reads.
    const body = (await response.json()) as { error: unknown };
    expect(typeof body.error).toBe("string");
  });
});
