/**
 * Custom engines: a script, run as a model.
 *
 * Three things are protected here, in order of how badly they would hurt:
 *
 *   1. The adapter speaks the SDK's stream protocol exactly — text, reasoning,
 *      tool calls, usage and why it stopped — because chat, the gateway and the
 *      coding engine all consume a script as though it were a vendor, and none
 *      of them would notice a subtle mistake until a conversation went wrong.
 *   2. The templates work against the wire formats of the APIs they are named
 *      after. A template that fails on its first request is the whole feature
 *      failing, for the person most likely to be trying it.
 *   3. A failure says something someone can act on: the line of the script, the
 *      service's own words, what was yielded that should not have been.
 *
 * That a script never syncs is asserted in `sync.test.ts`, beside the other
 * columns that stay on the machine that wrote them.
 *
 * Nothing here touches the network. Every template is driven against a stubbed
 * `fetch` answering in the shape the real API does, delivered a few bytes at a
 * time so the stream parsers meet chunk boundaries in awkward places.
 */

import type { LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  convertToModelMessages,
  generateImage,
  generateText,
  stepCountIs,
  streamText,
  toUIMessageStream,
  tool,
  type UIMessage,
} from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createApp } from "../src/server/app.js";
import type { Connection } from "../src/server/db/schema.js";
import { resolveImageModel } from "../src/server/images/registry.js";
import { listModels } from "../src/server/providers/models.js";
import { checkConnection, resolveModel } from "../src/server/providers/registry.js";
import { ScriptImageModel } from "../src/server/scripts/image.js";
import { ScriptLanguageModel, type ScriptModelSettings } from "../src/server/scripts/language.js";
import { inspectScript } from "../src/server/scripts/runtime.js";
import { SCRIPT_TEMPLATES, templateForKind } from "../src/server/scripts/templates.js";

// biome-ignore lint/suspicious/noExplicitAny: wire bodies are asserted on field by field.
type Wire = any;

/** Scripts share this process's globals, which is how a test sees what one was handed. */
const probe = globalThis as { seen?: Wire; aborted?: boolean; drawn?: number };

const settings = (script: string, extra: Partial<ScriptModelSettings> = {}) => ({
  name: "Test",
  script,
  baseUrl: null,
  apiKey: null,
  modelId: "m",
  ...extra,
});

const chatWith = (script: string, extra?: Partial<ScriptModelSettings>) =>
  new ScriptLanguageModel(settings(script, extra));

const drawWith = (script: string, extra?: Partial<ScriptModelSettings>) =>
  new ScriptImageModel(settings(script, extra));

function template(id: string) {
  const found = SCRIPT_TEMPLATES.find((item) => item.id === id);
  if (!found) throw new Error(`No template ${id}`);
  return found;
}

const HI: LanguageModelV4Prompt = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

async function collect(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream as unknown as AsyncIterable<LanguageModelV4StreamPart>) {
    parts.push(part);
  }
  return parts;
}

/** A PNG's signature, which is all the SDK reads to name an image's type. */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PNG_B64 = PNG.toString("base64");

/** A body delivered seven bytes at a time, so every parser meets a split line. */
function trickle(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
        controller.close();
      },
    }),
  );
}

const sse = (events: unknown[], named = false) =>
  trickle(
    events
      .map((event) => {
        const data = typeof event === "string" ? event : JSON.stringify(event);
        const type = named ? (event as { type?: string }).type : undefined;
        return `${type ? `event: ${type}\n` : ""}data: ${data}\n\n`;
      })
      .join(""),
  );

const ndjson = (lines: unknown[]) =>
  trickle(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Wire;
}

let calls: Call[] = [];

/** Answer requests in order, and record what each one asked. */
function serve(...responses: Response[]) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const next = responses.shift();
      if (!next) throw new Error(`Nothing left to answer ${String(url)} with`);
      return next;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A tool with a result worth looking for, in every API's own spelling. */
const weather = tool({
  description: "Current weather",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, temperature: 21 }),
});

describe("loading a script", () => {
  it("reports what a script exports without calling any of it", async () => {
    const inspection = await inspectScript({
      name: "Both",
      script: [
        "export async function* chat() { throw new Error('not called'); }",
        "export function image() { throw new Error('not called'); }",
        'export const defaultImageModel = "pix";',
      ].join("\n"),
    });

    expect(inspection).toEqual({
      chat: true,
      image: true,
      models: false,
      defaultImageModel: "pix",
      problem: null,
    });
  });

  it("says which line a syntax error is on, and points at it", async () => {
    const { problem } = await inspectScript({
      name: "Broken",
      script: "export async function* chat() {\n  yield 'a';\n  yield = ;\n}\n",
    });

    expect(problem).toMatch(/does not parse/);
    expect(problem).toMatch(/Line 3/);
    expect(problem).toContain("^");
  });

  it("lets a script use Node's built-ins", async () => {
    const { problem } = await inspectScript({
      name: "Hashing",
      script:
        'import { createHash } from "node:crypto";\nexport const chat = () => createHash("sha1").update("x").digest("hex");',
    });
    expect(problem).toBeNull();
  });

  it("explains that a script cannot import a package, without quoting base64 at anyone", async () => {
    const { problem } = await inspectScript({
      name: "Deps",
      script: 'import leftPad from "left-pad";\nexport const chat = () => leftPad("a", 2);',
    });

    expect(problem).toMatch(/cannot reach/i);
    expect(problem).toMatch(/built-in/);
    expect(problem).not.toMatch(/base64/);
  });

  it("refuses a script that has nothing to call", async () => {
    const { problem } = await inspectScript({ name: "Empty", script: "export const hello = 1;" });
    expect(problem).toMatch(/neither chat\(\) nor image\(\)/);
  });

  it("names the line a script threw from", async () => {
    const model = chatWith(
      "export async function* chat() {\n  const reply = undefined;\n  yield reply.text;\n}\n",
    );
    await expect(generateText({ model, prompt: "hi" })).rejects.toThrow(/line 3 of the script/);
  });
});

describe("a script as a language model", () => {
  it("streams reasoning and text as separate blocks, with usage reported once", async () => {
    const model = chatWith(`export async function* chat() {
      yield { type: "reasoning", text: "Thinking " };
      yield { type: "reasoning", text: "it over." };
      yield "Hello, ";
      yield { type: "text", text: "world." };
      yield { type: "usage", inputTokens: 12 };
      yield { type: "usage", outputTokens: 4 };
    }`);

    const { stream } = await model.doStream({ prompt: HI });
    const parts = await collect(stream);

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "response-metadata",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(parts.at(-1)).toMatchObject({
      finishReason: { unified: "stop" },
      usage: { inputTokens: { total: 12 }, outputTokens: { total: 4 } },
    });
  });

  it("hands over the conversation in a shape that reads plainly", async () => {
    probe.seen = undefined;
    const model = chatWith(
      "export function chat(request) { globalThis.seen = request; return 'ok'; }",
    );

    await generateText({
      model,
      system: "Be brief.",
      maxOutputTokens: 100,
      temperature: 0.2,
      tools: { weather },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "weather", input: { city: "Oslo" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "weather",
              output: { type: "json", value: { temperature: -2 } },
            },
          ],
        },
      ],
    });

    expect(probe.seen).toMatchObject({
      model: "m",
      system: "Be brief.",
      maxOutputTokens: 100,
      temperature: 0.2,
      tools: [{ name: "weather", description: "Current weather" }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "file", mediaType: "image/png", data: "AQID" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool-call", id: "c1", name: "weather", input: { city: "Oslo" } }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "c1",
              name: "weather",
              output: '{"temperature":-2}',
              isError: false,
            },
          ],
        },
      ],
    });
  });

  it("runs a tool round trip, and reports tool-calls even when the script says stop", async () => {
    const model = chatWith(`export async function* chat(request) {
      const result = request.messages.find((message) => message.role === "tool");
      if (!result) {
        yield { type: "tool-call", name: "weather", input: { city: "Paris" } };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield "It is " + JSON.parse(result.content[0].output).temperature + " degrees.";
    }`);

    const result = streamText({
      model,
      prompt: "Weather in Paris?",
      tools: { weather },
      stopWhen: stepCountIs(3),
    });
    await result.consumeStream();

    const steps = await result.steps;
    expect(steps[0]!.finishReason).toBe("tool-calls");
    expect(steps[0]!.toolCalls[0]).toMatchObject({ toolName: "weather", input: { city: "Paris" } });
    expect(await result.text).toBe("It is 21 degrees.");
  });

  /**
   * The path a real conversation takes: streamed, turned into a stored UI
   * message the way `routes/chat.ts` does it, then replayed from the store on
   * the next turn. A signature that did not survive that trip would make every
   * second Claude-with-thinking turn fail.
   */
  it("returns meta on the same part of the next request, through a stored message", async () => {
    probe.seen = undefined;
    const model = chatWith(`export async function* chat(request) {
      globalThis.seen = request.messages;
      yield { type: "reasoning", text: "Hm." };
      yield { type: "reasoning", text: "", meta: { signature: "sig-1" } };
      yield "Done.";
    }`);

    const result = streamText({ model, prompt: "hi" });
    let stored: UIMessage | undefined;
    const ui = toUIMessageStream({
      stream: result.stream,
      onEnd: ({ responseMessage }) => {
        stored = responseMessage;
      },
    });
    for await (const _ of ui as unknown as AsyncIterable<unknown>) {
      /* drained, as the response to the browser would be */
    }

    expect(stored).toBeDefined();
    const replay = await convertToModelMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      stored!,
      { id: "u2", role: "user", parts: [{ type: "text", text: "again" }] },
    ]);
    await generateText({ model, messages: replay });

    const history = probe.seen as { role: string; content: { type: string; meta?: unknown }[] }[];
    const assistant = history.find((message) => message.role === "assistant");
    expect(assistant?.content.find((part) => part.type === "reasoning")?.meta).toEqual({
      signature: "sig-1",
    });
  });

  it("fails the call outright when its first request is refused, in the service's words", async () => {
    serve(json({ error: { message: "invalid x-api-key" } }, 401));
    const model = chatWith(`export async function* chat(request, ctx) {
      await ctx.request("https://api.example.com/v1/chat", { method: "POST", json: {} });
      yield "never";
    }`);

    await expect(model.doStream({ prompt: HI })).rejects.toThrow(
      /refused \(401\).*invalid x-api-key/,
    );
  });

  it("reports a failure partway through as an error after what already arrived", async () => {
    const model = chatWith(
      "export async function* chat() { yield 'Half'; throw new Error('the socket closed'); }",
    );

    const parts = await collect((await model.doStream({ prompt: HI })).stream);

    expect(parts.find((part) => part.type === "text-delta")).toMatchObject({ delta: "Half" });
    expect(parts.find((part) => part.type === "error")).toBeTruthy();
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "error" } });
  });

  it("names what a script yielded when it is not an event", async () => {
    const model = chatWith("export async function* chat() { yield { kind: 'text', body: 'hi' }; }");
    await expect(generateText({ model, prompt: "hi" })).rejects.toThrow(/yielded \{"kind":"text"/);
  });

  it("accepts a reply returned in one piece", async () => {
    const model = chatWith("export async function chat() { return 'All at once.'; }");
    expect((await generateText({ model, prompt: "hi" })).text).toBe("All at once.");
  });

  it("aborts a script's work when the stream is cancelled", async () => {
    probe.aborted = false;
    const model = chatWith(`export async function* chat(request, ctx) {
      ctx.signal.addEventListener("abort", () => { globalThis.aborted = true; });
      yield "first";
      await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
      yield "never";
    }`);

    const { stream } = await model.doStream({ prompt: HI });
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done || value.type === "text-delta") break;
    }
    await reader.cancel();

    expect(probe.aborted).toBe(true);
  });
});

describe("a script as an image model", () => {
  it("accepts base64, data URLs, bytes and links", async () => {
    serve(new Response(PNG));
    const model = drawWith(`export const maxImagesPerCall = 4;
export async function image() {
  return [
    "${PNG_B64}",
    "data:image/png;base64,${PNG_B64}",
    new Uint8Array([${[...PNG].join(",")}]),
    { url: "https://images.example.com/1.png" },
  ];
}`);

    const { images } = await generateImage({ model, prompt: "a heron", n: 4 });

    expect(images).toHaveLength(4);
    for (const image of images) {
      expect(image.base64).toBe(PNG_B64);
      expect(image.mediaType).toBe("image/png");
    }
    expect(calls.map((call) => call.url)).toEqual(["https://images.example.com/1.png"]);
  });

  it("is asked as many times as it takes when it makes one picture a call", async () => {
    probe.drawn = 0;
    const model = drawWith(
      `export function image() { globalThis.drawn += 1; return "${PNG_B64}"; }`,
    );

    const { images } = await generateImage({ model, prompt: "x", n: 3 });

    expect(images).toHaveLength(3);
    expect(probe.drawn).toBe(3);
  });

  it("says so when a script cannot draw", async () => {
    const model = drawWith("export function chat() { return 'hi'; }");
    await expect(generateImage({ model, prompt: "x" })).rejects.toThrow(/no image\(\) export/);
  });
});

describe("listing a script's models", () => {
  it("takes ids or objects, and guesses only what a script leaves out", async () => {
    const models = await listModels({
      kind: "script",
      label: "Mine",
      script: `export function models() {
        return ["llama3", "flux-dev", { id: "house-special", label: "House", chat: false, image: true }, 42, { label: "no id" }];
      }`,
    });

    expect(models).toEqual([
      { id: "llama3", label: null, chat: true, image: false },
      { id: "flux-dev", label: null, chat: false, image: true },
      { id: "house-special", label: "House", chat: false, image: true },
    ]);
  });

  it("asks for a typed model name when a script has no models()", async () => {
    await expect(
      listModels({
        kind: "script",
        label: "Quiet",
        script: "export function chat() { return ''; }",
      }),
    ).rejects.toThrow(/enter a model name instead/);
  });
});

describe("a script connection", () => {
  const row = (extra: Partial<Connection> = {}): Connection =>
    ({
      id: "s1",
      name: "Mine",
      kind: "script",
      baseUrl: null,
      model: "m",
      apiKeyEnv: null,
      script: "export function chat() { return 'hi'; }",
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      ...extra,
    }) as Connection;

  it("is not ready without a script, and says why that is normal on another device", () => {
    expect(checkConnection(row({ script: null })).problem).toMatch(/never sync/);
  });

  it("treats a key variable it names as a key it needs", () => {
    delete process.env.MODELDOCK_TEST_SCRIPT_KEY;
    expect(checkConnection(row({ apiKeyEnv: "MODELDOCK_TEST_SCRIPT_KEY" })).problem).toMatch(
      /MODELDOCK_TEST_SCRIPT_KEY is not set/,
    );
    expect(checkConnection(row()).ok).toBe(true);
  });

  it("resolves through the same two functions a vendor does", () => {
    expect(resolveModel(row())).toBeInstanceOf(ScriptLanguageModel);

    const image = resolveImageModel(row({ model: "sdxl" }));
    expect(image).toBeInstanceOf(ScriptImageModel);
    // No image model named anywhere, so a script that draws is asked with its own.
    expect((image as ScriptImageModel).modelId).toBe("sdxl");
  });
});

describe("the API", () => {
  const app = createApp({ port: 8765 });
  const HEADERS = { "content-type": "application/json", host: "127.0.0.1:8765" };

  const call = async (path: string, method = "GET", body?: unknown): Promise<Wire> => {
    const response = await app.request(`http://127.0.0.1:8765/api${path}`, {
      method,
      headers: HEADERS,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };

  it("stores a script connection and says what it can do", async () => {
    const drawer = await call("/connections", "POST", {
      name: "Drawer",
      kind: "script",
      model: "default",
      script: template("sd_webui").script,
    });
    expect(drawer.status).toBe(201);
    expect(drawer.body.connection).toMatchObject({
      kind: "script",
      ready: true,
      capabilities: { chat: false, image: true, models: true },
    });

    const broken = await call("/connections", "POST", {
      name: "Broken",
      kind: "script",
      model: "m",
      script: "export const = 1;",
    });
    // Saved anyway, so work in progress survives — and reported, so it is not a surprise.
    expect(broken.status).toBe(201);
    expect(broken.body.connection).toMatchObject({
      ready: false,
      problem: expect.stringMatching(/does not parse/),
    });
  });

  it("refuses a script connection with no script", async () => {
    const response = await call("/connections", "POST", {
      name: "Hollow",
      kind: "script",
      model: "m",
    });
    expect(response.status).toBe(400);
  });

  it("will not put a script on a vendor connection", async () => {
    const plain = await call("/connections", "POST", {
      name: "Plain",
      kind: "openai",
      model: "gpt-4.1",
    });
    const response = await call(`/connections/${plain.body.connection.id}`, "PATCH", {
      script: "export function chat() { return 'hi'; }",
    });
    expect(response.status).toBe(400);
  });

  it("offers templates alongside the connections", async () => {
    const { body } = await call("/connections");
    expect(body.templates.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining(["ollama", "openai", "anthropic"]),
    );
  });

  it("checks and tries a draft without saving it", async () => {
    const before = (await call("/connections")).body.connections.length;

    const check = await call("/scripts/check", "POST", { script: template("scratch").script });
    expect(check.body.inspection).toMatchObject({ chat: true, models: true, problem: null });

    const trial = await call("/scripts/try", "POST", {
      script: template("scratch").script,
      model: "echo",
      prompt: "ahoy there",
    });
    expect(trial.body).toMatchObject({
      ok: true,
      text: "You said: ahoy there",
      finishReason: "stop",
    });

    expect((await call("/connections")).body.connections).toHaveLength(before);
  });

  it("reports a failed try as the reason, not as a status code", async () => {
    const trial = await call("/scripts/try", "POST", {
      script: "export async function* chat() { throw new Error('nope'); }",
    });
    expect(trial.status).toBe(200);
    expect(trial.body).toMatchObject({ ok: false, error: expect.stringMatching(/nope/) });
  });

  it("offers only the scripts that draw for image generation", async () => {
    const painter = await call("/connections", "POST", {
      name: "Painter",
      kind: "script",
      model: "default",
      script: template("sd_webui").script,
    });
    const chatter = await call("/connections", "POST", {
      name: "Chatter",
      kind: "script",
      model: "echo",
      script: template("scratch").script,
    });

    const workspace = await call("/workspace");
    const names = workspace.body.images.eligible.map((item: { name: string }) => item.name);
    expect(names).toContain("Painter");
    expect(names).not.toContain("Chatter");

    const refused = await call("/workspace", "PATCH", {
      imageConnectionId: chatter.body.connection.id,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/no image\(\) export/);

    const chosen = await call("/workspace", "PATCH", {
      imageConnectionId: painter.body.connection.id,
    });
    // No image model chosen and none declared, so the connection's own model draws.
    expect(chosen.body.images.active).toMatchObject({ name: "Painter", model: "default" });
  });
});

describe("the templates", () => {
  it.each(SCRIPT_TEMPLATES.map((item) => [item.id, item] as const))(
    "%s loads, and exports what it says it does",
    async (_id, item) => {
      const inspection = await inspectScript({ name: item.label, script: item.script });

      expect(inspection.problem).toBeNull();
      expect({ chat: inspection.chat, image: inspection.image, models: inspection.models }).toEqual(
        {
          chat: item.does.includes("chat"),
          image: item.does.includes("image"),
          models: item.does.includes("models"),
        },
      );
    },
  );

  it("mirrors every built-in kind, so an existing connection starts from its own", () => {
    for (const kind of ["anthropic", "openai", "google", "ollama", "openai_compatible"]) {
      expect(templateForKind(kind).kind).toBe(kind);
    }
  });
});

describe("the ChatGPT template", () => {
  it("assembles a tool call from its pieces, then sends the result back as a tool message", async () => {
    serve(
      sse([
        { choices: [{ delta: { role: "assistant", content: "" } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "weather", arguments: "" },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }],
        },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
        "[DONE]",
      ]),
      sse([
        { choices: [{ delta: { content: "It is 21 degrees." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        "[DONE]",
      ]),
    );

    const model = chatWith(template("openai").script, { apiKey: "sk-test", modelId: "gpt-4.1" });
    const result = streamText({
      model,
      system: "Be brief.",
      prompt: "Weather in Paris?",
      tools: { weather },
      stopWhen: stepCountIs(3),
      maxOutputTokens: 200,
    });
    await result.consumeStream();

    expect(await result.text).toBe("It is 21 degrees.");
    expect((await result.steps)[0]!.usage.inputTokens).toBe(20);

    const [first, second] = calls;
    expect(first!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(first!.headers.authorization).toBe("Bearer sk-test");
    expect(first!.body).toMatchObject({
      model: "gpt-4.1",
      stream: true,
      max_completion_tokens: 200,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "Weather in Paris?" }] },
      ],
      tools: [{ type: "function", function: { name: "weather" } }],
    });
    expect(second!.body.messages.slice(2)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"city":"Paris","temperature":21}' },
    ]);
  });

  it("asks DALL-E for the bytes, and never asks a gpt-image model", async () => {
    serve(json({ data: [{ b64_json: PNG_B64 }] }), json({ data: [{ b64_json: PNG_B64 }] }));
    const draw = (modelId: string) =>
      drawWith(template("openai").script, { apiKey: "sk-test", modelId });

    await generateImage({ model: draw("dall-e-3"), prompt: "a heron", size: "1024x1024" });
    await generateImage({ model: draw("gpt-image-1"), prompt: "a heron" });

    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    expect(calls[0]!.body).toMatchObject({
      model: "dall-e-3",
      response_format: "b64_json",
      size: "1024x1024",
    });
    expect(calls[1]!.body.response_format).toBeUndefined();
  });
});

describe("the Claude template", () => {
  it("keeps thinking's signature for the next turn, and sends tool results as a user turn", async () => {
    serve(
      sse(
        [
          {
            type: "message_start",
            message: { usage: { input_tokens: 30, cache_read_input_tokens: 10 } },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Need the weather." },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "sig-abc" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_1", name: "weather", input: {} },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"city": "Pa' },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: 'ris"}' },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 15 },
          },
          { type: "message_stop" },
        ],
        true,
      ),
      sse(
        [
          { type: "message_start", message: { usage: { input_tokens: 60 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "ping" },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "21 degrees in Paris." },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 6 },
          },
          { type: "message_stop" },
        ],
        true,
      ),
    );

    const model = chatWith(template("anthropic").script, {
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-4-5",
    });
    const result = streamText({
      model,
      system: "Be brief.",
      prompt: "Weather in Paris?",
      tools: { weather },
      stopWhen: stepCountIs(3),
    });
    await result.consumeStream();

    expect(await result.text).toBe("21 degrees in Paris.");
    const steps = await result.steps;
    expect(steps[0]!.reasoningText).toBe("Need the weather.");
    expect(steps[0]!.finishReason).toBe("tool-calls");
    expect(steps[0]!.usage).toMatchObject({ inputTokens: 40, outputTokens: 15 });

    const [first, second] = calls;
    expect(first!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(first!.headers).toMatchObject({
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
    });
    expect(first!.body).toMatchObject({
      model: "claude-sonnet-4-5",
      system: "Be brief.",
      max_tokens: 8192,
      stream: true,
      tools: [{ name: "weather", input_schema: { type: "object" } }],
    });
    expect(second!.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Weather in Paris?" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need the weather.", signature: "sig-abc" },
          { type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Paris" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: '{"city":"Paris","temperature":21}',
            is_error: false,
          },
        ],
      },
    ]);
  });
});

describe("the Ollama template", () => {
  it("speaks the native API, even from an OpenAI-shaped base URL", async () => {
    serve(
      ndjson([
        {
          model: "llama3.2",
          message: { role: "assistant", content: "", thinking: "Weather tool." },
          done: false,
        },
        {
          model: "llama3.2",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "weather", arguments: { city: "Oslo" } } }],
          },
          done: false,
        },
        {
          model: "llama3.2",
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 25,
          eval_count: 9,
        },
      ]),
      ndjson([
        { message: { role: "assistant", content: "Cold: " }, done: false },
        { message: { role: "assistant", content: "21 degrees." }, done: false },
        {
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 40,
          eval_count: 5,
        },
      ]),
    );

    const model = chatWith(template("ollama").script, {
      baseUrl: "http://localhost:11434/v1/",
      modelId: "llama3.2",
    });
    const result = await generateText({
      model,
      prompt: "Weather in Oslo?",
      tools: { weather },
      stopWhen: stepCountIs(3),
    });

    expect(result.text).toBe("Cold: 21 degrees.");
    expect(result.steps[0]!.finishReason).toBe("tool-calls");
    expect(result.steps[0]!.reasoningText).toBe("Weather tool.");
    expect(calls[0]!.url).toBe("http://localhost:11434/api/chat");
    // A local server that never asked for a token is not sent one.
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[1]!.body.messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "weather", arguments: { city: "Oslo" } } }],
      },
      { role: "tool", content: '{"city":"Oslo","temperature":21}', tool_name: "weather" },
    ]);
  });

  it("lists what has been pulled", async () => {
    serve(json({ models: [{ name: "llama3.2:latest" }, { name: "nomic-embed-text:latest" }] }));

    const models = await listModels({
      kind: "script",
      label: "Ollama",
      baseUrl: "http://localhost:11434",
      script: template("ollama").script,
    });

    expect(models.map((model) => [model.id, model.chat])).toEqual([
      ["llama3.2:latest", true],
      ["nomic-embed-text:latest", false],
    ]);
    expect(calls[0]!.url).toBe("http://localhost:11434/api/tags");
  });
});

describe("the Gemini template", () => {
  it("round-trips a thought signature on a function call, with the key in a header", async () => {
    serve(
      sse([
        {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: { name: "weather", args: { city: "Rome" } },
                    thoughtSignature: "gem-sig",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 4 },
        },
      ]),
      sse([
        { candidates: [{ content: { role: "model", parts: [{ text: "Warm, " }] } }] },
        {
          candidates: [
            { content: { role: "model", parts: [{ text: "21 degrees." }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 6 },
        },
      ]),
    );

    const model = chatWith(template("google").script, {
      apiKey: "goog-secret",
      modelId: "gemini-2.5-flash",
    });
    const result = await generateText({
      model,
      system: "Be brief.",
      prompt: "Weather in Rome?",
      tools: { weather },
      stopWhen: stepCountIs(3),
    });

    expect(result.text).toBe("Warm, 21 degrees.");
    expect(result.steps[0]!.finishReason).toBe("tool-calls");

    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    );
    expect(calls[0]!.url).not.toContain("goog-secret");
    expect(calls[0]!.headers["x-goog-api-key"]).toBe("goog-secret");
    expect(calls[0]!.body).toMatchObject({
      systemInstruction: { parts: [{ text: "Be brief." }] },
      tools: [{ functionDeclarations: [{ name: "weather" }] }],
    });
    expect(calls[1]!.body.contents).toEqual([
      { role: "user", parts: [{ text: "Weather in Rome?" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "weather", args: { city: "Rome" } },
            thoughtSignature: "gem-sig",
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "weather",
              response: { result: '{"city":"Rome","temperature":21}' },
            },
          },
        ],
      },
    ]);
  });

  it("draws with Imagen at the nearest aspect ratio it offers", async () => {
    serve(json({ predictions: [{ bytesBase64Encoded: PNG_B64, mimeType: "image/png" }] }));

    const model = drawWith(template("google").script, {
      apiKey: "goog",
      modelId: "imagen-4.0-generate-001",
    });
    const { images } = await generateImage({ model, prompt: "a heron", size: "1408x768" });

    expect(images).toHaveLength(1);
    expect(calls[0]!.url).toContain("/models/imagen-4.0-generate-001:predict");
    expect(calls[0]!.body.parameters).toEqual({ sampleCount: 1, aspectRatio: "16:9" });
  });
});

describe("the OpenAI-compatible template", () => {
  it("asks for a base URL rather than guessing one", async () => {
    const model = chatWith(template("openai_compatible").script, { modelId: "qwen" });
    await expect(generateText({ model, prompt: "hi" })).rejects.toThrow(/Set a base URL/);
  });

  it("caps replies with max_tokens, streams separate thinking, and sends no key it was not given", async () => {
    serve(
      sse([
        { choices: [{ delta: { reasoning_content: "hmm" } }] },
        { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
        "[DONE]",
      ]),
    );

    const model = chatWith(template("openai_compatible").script, {
      baseUrl: "http://localhost:8000/v1",
      modelId: "qwen",
    });
    const result = await generateText({ model, prompt: "hi", maxOutputTokens: 50 });

    expect(result.text).toBe("hi");
    expect(result.reasoningText).toBe("hmm");
    expect(calls[0]!.url).toBe("http://localhost:8000/v1/chat/completions");
    expect(calls[0]!.body.max_tokens).toBe(50);
    expect(calls[0]!.body.max_completion_tokens).toBeUndefined();
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });
});

describe("the Stable Diffusion WebUI template", () => {
  it("renders a batch in one call and leaves out the contact sheet", async () => {
    serve(json({ images: ["R1JJRA==", PNG_B64, PNG_B64] }));

    const checkpoint = "sd_xl_base_1.0.safetensors [31e35c80fc]";
    const model = drawWith(template("sd_webui").script, {
      baseUrl: "http://127.0.0.1:7860",
      modelId: checkpoint,
    });
    const { images } = await generateImage({ model, prompt: "a heron", n: 2, size: "832x1216" });

    expect(images.map((image) => image.base64)).toEqual([PNG_B64, PNG_B64]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:7860/sdapi/v1/txt2img");
    expect(calls[0]!.body).toMatchObject({
      prompt: "a heron",
      width: 832,
      height: 1216,
      batch_size: 2,
      override_settings: { sd_model_checkpoint: checkpoint },
    });
  });
});

describe("the from-scratch template", () => {
  it("works before it is pointed at anything", async () => {
    const model = chatWith(template("scratch").script);
    const result = streamText({ model, prompt: "is anyone there" });
    expect(await result.text).toBe("You said: is anyone there");
  });
});
