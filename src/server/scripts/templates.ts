// biome-ignore-all lint/complexity/noUselessStringRaw: every template is raw, so adding a backslash to one later cannot silently change what it does.

/**
 * Where a custom engine starts.
 *
 * A blank editor is the worst way to meet a feature like this, so every script
 * begins as one of these — and the first four are providers ModelDock already
 * speaks natively, rewritten as plain JavaScript against each vendor's public
 * HTTP API. They are not a second implementation to keep in step with the first.
 * A built-in connection still resolves through `providers/registry.ts` and the
 * AI SDK's own clients; these exist so that "Claude, but with this header" or
 * "Ollama, but with a bigger context window" is an edit to something that works
 * rather than a blank page.
 *
 * Every template is a complete, self-contained module with no shared helpers.
 * A script is copied into a connection and edited from there, and a helper it
 * could not see would be a helper it could not change.
 *
 * The scripts are written without template literals, which keeps this file free
 * of escaping: each sits inside `String.raw` and reads exactly as it will in the
 * editor. `tests/scripts.test.ts` loads every one and drives it against its API's
 * wire format, because a template that does not parse is a first impression
 * nobody recovers from.
 *
 * Model ids come from `providers/catalog.ts`, so a template and the built-in
 * connection it mirrors suggest the same one.
 */

import { type ConnectionKind, KINDS } from "../providers/catalog.js";

export type ScriptCapability = "chat" | "image" | "models";

export interface ScriptTemplate {
  id: string;
  label: string;
  hint: string;
  /**
   * The built-in kind this template reimplements, if any. It is how
   * "Customise as a script" on an existing connection finds its starting point.
   */
  kind: ConnectionKind | null;
  /** What the script exports, so the editor can say so before it is run. */
  does: ScriptCapability[];
  /** Suggested connection name. Different from the built-in's, which is unique. */
  name: string;
  baseUrl: string | null;
  apiKeyEnv: string | null;
  model: string;
  keyUrl: string | null;
  script: string;
}

/**
 * The OpenAI shape, twice.
 *
 * OpenAI itself and every server that copies its API differ in three places: a
 * default base URL, which field caps the reply, and whether there is a sensible
 * default image model. Generating both from one source keeps a fix to the
 * stream parser from landing in only one of them.
 */
function openAiShaped(options: {
  intro: string;
  base: string;
  maxTokensField: string;
  defaultImageModel: string | null;
}): string {
  const imageDefault = options.defaultImageModel
    ? `export const defaultImageModel = ${JSON.stringify(options.defaultImageModel)};\n\n`
    : "";

  return String.raw`${options.intro}
//
// chat() streams a reply, image() draws, and models() fills the model list.
// Everything request and ctx carry is described under "How a script works".

const BASE = ${JSON.stringify(options.base)};

function base(ctx) {
  const url = ctx.baseUrl || BASE;
  if (!url) {
    throw new Error("Set a base URL on this connection: the address the API is served from, usually ending in /v1.");
  }
  return url;
}

function headers(ctx) {
  return ctx.apiKey ? { authorization: "Bearer " + ctx.apiKey } : {};
}

// ModelDock's conversation, in the shape Chat Completions expects.
function toMessages(request) {
  const messages = [];
  if (request.system) messages.push({ role: "system", content: request.system });

  for (const message of request.messages) {
    if (message.role === "user") {
      const content = [];
      for (const part of message.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "file" && part.mediaType.startsWith("image/")) {
          const url = part.url || "data:" + part.mediaType + ";base64," + part.data;
          content.push({ type: "image_url", image_url: { url } });
        } else if (part.type === "file" && part.text) {
          content.push({ type: "text", text: part.text });
        }
      }
      messages.push({ role: "user", content });
    } else if (message.role === "assistant") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const calls = message.content.filter((part) => part.type === "tool-call");
      const turn = { role: "assistant", content: text || null };
      if (calls.length > 0) {
        turn.tool_calls = calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        }));
      }
      messages.push(turn);
    } else if (message.role === "tool") {
      for (const result of message.content) {
        messages.push({ role: "tool", tool_call_id: result.id, content: result.output });
      }
    }
  }

  return messages;
}

const FINISH = {
  stop: "stop",
  length: "length",
  tool_calls: "tool-calls",
  content_filter: "content-filter",
};

export async function* chat(request, ctx) {
  const body = {
    model: request.model,
    messages: toMessages(request),
    stream: true,
    // Asks for token counts in a final chunk. Delete it for a server that
    // refuses fields it does not recognise.
    stream_options: { include_usage: true },
  };

  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    if (typeof request.toolChoice === "object") {
      body.tool_choice = { type: "function", function: { name: request.toolChoice.name } };
    } else if (request.toolChoice) {
      body.tool_choice = request.toolChoice;
    }
  }

  if (request.maxOutputTokens) body.${options.maxTokensField} = request.maxOutputTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.stopSequences?.length) body.stop = request.stopSequences;
  if (request.seed !== undefined) body.seed = request.seed;

  const response = await ctx.request(base(ctx) + "/chat/completions", {
    method: "POST",
    headers: headers(ctx),
    json: body,
  });

  // A tool call arrives in pieces, keyed by index, and is only whole at the end.
  const calls = new Map();
  let finish;

  for await (const { data } of ctx.sse(response)) {
    if (data === "[DONE]") break;
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));

    if (chunk.usage) {
      yield {
        type: "usage",
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
        cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
        reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};

    // Several OpenAI-shaped servers stream a model's thinking in a field of its own.
    const thinking = delta.reasoning_content ?? delta.reasoning;
    if (typeof thinking === "string" && thinking) yield { type: "reasoning", text: thinking };
    if (typeof delta.content === "string" && delta.content) yield delta.content;

    for (const piece of delta.tool_calls || []) {
      const index = piece.index ?? calls.size;
      const call = calls.get(index) || { id: undefined, name: "", args: "" };
      if (piece.id) call.id = piece.id;
      if (piece.function?.name) call.name = piece.function.name;
      if (piece.function?.arguments) call.args += piece.function.arguments;
      calls.set(index, call);
    }

    if (choice.finish_reason) finish = choice.finish_reason;
  }

  for (const call of calls.values()) {
    yield { type: "tool-call", id: call.id, name: call.name, input: call.args || "{}" };
  }

  if (finish) yield { type: "finish", reason: FINISH[finish] || "other", raw: finish };
}

export async function models(ctx) {
  const response = await ctx.request(base(ctx) + "/models", { headers: headers(ctx) });
  const body = await response.json();
  return (body.data || []).map((model) => model.id);
}

${imageDefault}export async function image(request, ctx) {
  const body = { model: request.model, prompt: request.prompt, n: request.n };
  if (request.size) body.size = request.size;
  // DALL-E answers with a link unless asked for the bytes. The gpt-image
  // models always send bytes, and refuse to be asked.
  if (request.model.startsWith("dall-e")) body.response_format = "b64_json";

  const response = await ctx.request(base(ctx) + "/images/generations", {
    method: "POST",
    headers: headers(ctx),
    json: body,
  });
  const result = await response.json();
  return (result.data || []).map((item) => item.b64_json || item.url);
}
`;
}

const OPENAI = openAiShaped({
  intro: "// ChatGPT, through OpenAI's own API.",
  base: "https://api.openai.com/v1",
  maxTokensField: "max_completion_tokens",
  defaultImageModel: "gpt-image-1",
});

const OPENAI_COMPATIBLE = openAiShaped({
  intro: [
    "// Any server that speaks OpenAI's API: vLLM, LM Studio, llama.cpp, LiteLLM,",
    "// LocalAI, OpenRouter, Groq. Set the base URL on this connection.",
  ].join("\n"),
  base: "",
  maxTokensField: "max_tokens",
  defaultImageModel: null,
});

const ANTHROPIC = String.raw`// Claude, through Anthropic's Messages API.
//
// chat() streams a reply and models() fills the model list. Anthropic has no
// image API, so there is no image(). Everything request and ctx carry is
// described under "How a script works".

const BASE = "https://api.anthropic.com/v1";

function base(ctx) {
  return ctx.baseUrl || BASE;
}

function headers(ctx) {
  return { "x-api-key": ctx.apiKey || "", "anthropic-version": "2023-06-01" };
}

// Claude wants user and assistant turns to alternate, so neighbours with the
// same role are folded into one turn.
function toMessages(request) {
  const turns = [];

  for (const message of request.messages) {
    const blocks = [];

    for (const part of message.content) {
      if (part.type === "text" && part.text) {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "file" && part.data && part.mediaType.startsWith("image/")) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: part.mediaType, data: part.data },
        });
      } else if (part.type === "file" && part.data && part.mediaType === "application/pdf") {
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: part.mediaType, data: part.data },
        });
      } else if (part.type === "file" && part.text) {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "reasoning" && part.meta?.signature) {
        // Thinking can only be sent back with the signature it arrived with,
        // which chat() below keeps in meta for exactly this.
        blocks.push({ type: "thinking", thinking: part.text, signature: part.meta.signature });
      } else if (part.type === "tool-call") {
        const input = part.input && typeof part.input === "object" ? part.input : {};
        blocks.push({ type: "tool_use", id: part.id, name: part.name, input });
      } else if (part.type === "tool-result") {
        blocks.push({
          type: "tool_result",
          tool_use_id: part.id,
          content: part.output || "(no output)",
          is_error: part.isError,
        });
      }
    }

    if (blocks.length === 0) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  }

  return turns;
}

const STOP = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool-calls",
  refusal: "content-filter",
};

export async function* chat(request, ctx) {
  const body = {
    model: request.model,
    // Anthropic requires a ceiling. Raise it for long answers.
    max_tokens: request.maxOutputTokens || 8192,
    messages: toMessages(request),
    stream: true,
  };

  if (request.system) body.system = request.system;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.topK !== undefined) body.top_k = request.topK;
  if (request.stopSequences?.length) body.stop_sequences = request.stopSequences;

  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
    if (request.toolChoice === "required") body.tool_choice = { type: "any" };
    else if (request.toolChoice === "none") body.tool_choice = { type: "none" };
    else if (typeof request.toolChoice === "object") {
      body.tool_choice = { type: "tool", name: request.toolChoice.name };
    }
  }

  // To have Claude think before it answers, uncomment this. Its reasoning then
  // streams in as a block of its own, and is kept for the next turn.
  // body.thinking = { type: "enabled", budget_tokens: 4000 };

  const response = await ctx.request(base(ctx) + "/messages", {
    method: "POST",
    headers: headers(ctx),
    json: body,
  });

  // Tool input arrives as fragments of JSON, one content block at a time.
  const blocks = new Map();
  let stop;

  for await (const { data } of ctx.sse(response)) {
    const event = JSON.parse(data);

    if (event.type === "error") {
      throw new Error(event.error?.message || "Claude reported an error partway through its reply.");
    }

    if (event.type === "message_start") {
      const usage = event.message?.usage || {};
      const cached = usage.cache_read_input_tokens || 0;
      yield {
        type: "usage",
        inputTokens: (usage.input_tokens || 0) + cached + (usage.cache_creation_input_tokens || 0),
        cachedInputTokens: cached,
      };
    } else if (event.type === "content_block_start") {
      const block = event.content_block || {};
      blocks.set(event.index, { type: block.type, id: block.id, name: block.name, json: "" });
    } else if (event.type === "content_block_delta") {
      const delta = event.delta || {};
      if (delta.type === "text_delta") {
        yield delta.text;
      } else if (delta.type === "thinking_delta") {
        yield { type: "reasoning", text: delta.thinking };
      } else if (delta.type === "signature_delta") {
        yield { type: "reasoning", text: "", meta: { signature: delta.signature } };
      } else if (delta.type === "input_json_delta") {
        const block = blocks.get(event.index);
        if (block) block.json += delta.partial_json;
      }
    } else if (event.type === "content_block_stop") {
      const block = blocks.get(event.index);
      if (block?.type === "tool_use") {
        yield { type: "tool-call", id: block.id, name: block.name, input: block.json || "{}" };
      }
    } else if (event.type === "message_delta") {
      if (event.usage?.output_tokens !== undefined) {
        yield { type: "usage", outputTokens: event.usage.output_tokens };
      }
      if (event.delta?.stop_reason) stop = event.delta.stop_reason;
    }
  }

  if (stop) yield { type: "finish", reason: STOP[stop] || "other", raw: stop };
}

export async function models(ctx) {
  const found = [];
  let after = "";

  // Anthropic pages its list. Twenty pages is a ceiling, not an expectation.
  for (let page = 0; page < 20; page++) {
    const query = "?limit=100" + (after ? "&after_id=" + encodeURIComponent(after) : "");
    const response = await ctx.request(base(ctx) + "/models" + query, { headers: headers(ctx) });
    const body = await response.json();
    for (const model of body.data || []) {
      found.push({ id: model.id, label: model.display_name, chat: true });
    }
    if (!body.has_more || !body.last_id) break;
    after = body.last_id;
  }

  return found;
}
`;

const OLLAMA = String.raw`// Ollama, through its own API rather than its OpenAI-compatible one. That is
// where thinking, tool calls and per-request options such as the context
// window are all available.
//
// chat() streams a reply and models() lists what has been pulled. Everything
// request and ctx carry is described under "How a script works".

const BASE = "http://localhost:11434";

// The native API lives at the server's root. A base URL copied from an
// OpenAI-shaped Ollama connection ends in /v1, so that is trimmed off.
function base(ctx) {
  return (ctx.baseUrl || BASE).replace(/\/v1$/, "");
}

// No key by default. Set one on the connection if Ollama sits behind a proxy
// that asks for a bearer token.
function headers(ctx) {
  return ctx.apiKey ? { authorization: "Bearer " + ctx.apiKey } : {};
}

function toMessages(request) {
  const messages = [];
  if (request.system) messages.push({ role: "system", content: request.system });

  for (const message of request.messages) {
    if (message.role === "tool") {
      for (const result of message.content) {
        messages.push({ role: "tool", content: result.output, tool_name: result.name });
      }
      continue;
    }

    const turn = { role: message.role, content: "" };
    const images = [];
    const calls = [];

    for (const part of message.content) {
      if (part.type === "text") {
        turn.content += part.text;
      } else if (part.type === "file" && part.text) {
        turn.content += part.text;
      } else if (part.type === "file" && part.data && part.mediaType.startsWith("image/")) {
        images.push(part.data);
      } else if (part.type === "tool-call") {
        calls.push({ function: { name: part.name, arguments: part.input ?? {} } });
      }
    }

    if (images.length > 0) turn.images = images;
    if (calls.length > 0) turn.tool_calls = calls;
    messages.push(turn);
  }

  return messages;
}

export async function* chat(request, ctx) {
  const options = {};
  if (request.temperature !== undefined) options.temperature = request.temperature;
  if (request.topP !== undefined) options.top_p = request.topP;
  if (request.topK !== undefined) options.top_k = request.topK;
  if (request.maxOutputTokens) options.num_predict = request.maxOutputTokens;
  if (request.stopSequences?.length) options.stop = request.stopSequences;
  if (request.seed !== undefined) options.seed = request.seed;
  // Ollama's default context window is small, and a long conversation quietly
  // loses its beginning. Raise it here if the model has the memory for it.
  // options.num_ctx = 32768;

  const body = { model: request.model, messages: toMessages(request), stream: true, options };

  if (request.tools.length > 0 && request.toolChoice !== "none") {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (request.responseFormat?.type === "json") body.format = request.responseFormat.schema || "json";

  const response = await ctx.request(base(ctx) + "/api/chat", {
    method: "POST",
    headers: headers(ctx),
    json: body,
  });

  // One JSON object per line, the last one marked done.
  for await (const line of ctx.lines(response)) {
    const chunk = JSON.parse(line);
    if (chunk.error) throw new Error(chunk.error);

    const message = chunk.message || {};
    if (message.thinking) yield { type: "reasoning", text: message.thinking };
    if (message.content) yield message.content;
    for (const call of message.tool_calls || []) {
      yield { type: "tool-call", name: call.function.name, input: call.function.arguments ?? {} };
    }

    if (chunk.done) {
      yield { type: "usage", inputTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count };
      yield {
        type: "finish",
        reason: chunk.done_reason === "length" ? "length" : "stop",
        raw: chunk.done_reason,
      };
    }
  }
}

export async function models(ctx) {
  const response = await ctx.request(base(ctx) + "/api/tags", { headers: headers(ctx) });
  const body = await response.json();
  return (body.models || []).map((model) => model.name);
}
`;

const GOOGLE = String.raw`// Gemini, through Google's Generative Language API, with Imagen or Gemini's
// own image models for pictures.
//
// chat() streams a reply, image() draws, and models() fills the model list.
// Everything request and ctx carry is described under "How a script works".

const BASE = "https://generativelanguage.googleapis.com/v1beta";

function base(ctx) {
  return ctx.baseUrl || BASE;
}

// The key rides in a header rather than the query string, so it never lands in
// a log that records URLs.
function headers(ctx) {
  return { "x-goog-api-key": ctx.apiKey || "" };
}

function modelPath(model) {
  return "/models/" + model.replace(/^models\//, "");
}

function toContents(request) {
  const contents = [];

  for (const message of request.messages) {
    const parts = [];

    for (const part of message.content) {
      // Gemini returns a signature with some parts that has to travel back with
      // them. chat() below keeps it in meta for exactly this.
      const signed = part.meta?.thoughtSignature ? { thoughtSignature: part.meta.thoughtSignature } : {};

      if (part.type === "text" && (part.text || signed.thoughtSignature)) {
        parts.push({ text: part.text, ...signed });
      } else if (part.type === "file" && part.data) {
        parts.push({ inlineData: { mimeType: part.mediaType, data: part.data } });
      } else if (part.type === "file" && part.text) {
        parts.push({ text: part.text });
      } else if (part.type === "tool-call") {
        parts.push({ functionCall: { name: part.name, args: part.input ?? {} }, ...signed });
      } else if (part.type === "tool-result") {
        parts.push({ functionResponse: { name: part.name, response: { result: part.output } } });
      }
    }

    if (parts.length === 0) continue;
    const role = message.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }

  return contents;
}

const FINISH = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content-filter",
  RECITATION: "content-filter",
  BLOCKLIST: "content-filter",
  PROHIBITED_CONTENT: "content-filter",
  SPII: "content-filter",
};

export async function* chat(request, ctx) {
  const config = {};
  if (request.maxOutputTokens) config.maxOutputTokens = request.maxOutputTokens;
  if (request.temperature !== undefined) config.temperature = request.temperature;
  if (request.topP !== undefined) config.topP = request.topP;
  if (request.topK !== undefined) config.topK = request.topK;
  if (request.stopSequences?.length) config.stopSequences = request.stopSequences;
  if (request.seed !== undefined) config.seed = request.seed;
  // To see Gemini's thinking as it happens, uncomment this.
  // config.thinkingConfig = { includeThoughts: true };

  const body = { contents: toContents(request), generationConfig: config };
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };

  if (request.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.parameters,
        })),
      },
    ];
    const choice = request.toolChoice;
    const calling = {
      mode: choice === "required" || typeof choice === "object" ? "ANY" : choice === "none" ? "NONE" : "AUTO",
    };
    if (typeof choice === "object") calling.allowedFunctionNames = [choice.name];
    body.toolConfig = { functionCallingConfig: calling };
  }

  const url = base(ctx) + modelPath(request.model) + ":streamGenerateContent?alt=sse";
  const response = await ctx.request(url, { method: "POST", headers: headers(ctx), json: body });

  let finish;

  for await (const { data } of ctx.sse(response)) {
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));

    const usage = chunk.usageMetadata;
    if (usage) {
      yield {
        type: "usage",
        inputTokens: usage.promptTokenCount,
        outputTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
        reasoningTokens: usage.thoughtsTokenCount,
        cachedInputTokens: usage.cachedContentTokenCount,
      };
    }

    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts || []) {
      const meta = part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : undefined;
      if (part.functionCall) {
        yield { type: "tool-call", name: part.functionCall.name, input: part.functionCall.args ?? {}, meta };
      } else if (part.thought) {
        if (part.text) yield { type: "reasoning", text: part.text };
      } else if (typeof part.text === "string") {
        yield { type: "text", text: part.text, meta };
      }
    }

    if (candidate?.finishReason) finish = candidate.finishReason;
  }

  if (finish) yield { type: "finish", reason: FINISH[finish] || "other", raw: finish };
}

export async function models(ctx) {
  const found = [];
  let token = "";

  for (let page = 0; page < 20; page++) {
    const query = "?pageSize=200" + (token ? "&pageToken=" + encodeURIComponent(token) : "");
    const response = await ctx.request(base(ctx) + "/models" + query, { headers: headers(ctx) });
    const body = await response.json();
    for (const model of body.models || []) {
      const methods = model.supportedGenerationMethods || [];
      found.push({
        id: model.name.replace(/^models\//, ""),
        label: model.displayName,
        chat: methods.includes("generateContent"),
        image: methods.includes("predict") || model.name.includes("image"),
      });
    }
    if (!body.nextPageToken) break;
    token = body.nextPageToken;
  }

  return found;
}

export const defaultImageModel = "imagen-4.0-generate-001";

// Imagen takes an aspect ratio rather than a size, so the nearest one it offers
// is used.
function aspectRatio(request) {
  if (request.aspectRatio) return request.aspectRatio;
  const [width, height] = (request.size || "1024x1024").split("x").map(Number);
  const offered = { "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4, "16:9": 16 / 9, "9:16": 9 / 16 };
  const target = width / height;
  return Object.keys(offered).sort(
    (a, b) => Math.abs(offered[a] - target) - Math.abs(offered[b] - target),
  )[0];
}

export async function image(request, ctx) {
  // Gemini's own image models answer through generateContent, one picture a call.
  if (request.model.replace(/^models\//, "").startsWith("gemini")) {
    const response = await ctx.request(base(ctx) + modelPath(request.model) + ":generateContent", {
      method: "POST",
      headers: headers(ctx),
      json: {
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      },
    });
    const body = await response.json();
    const parts = body.candidates?.[0]?.content?.parts || [];
    return parts.filter((part) => part.inlineData).map((part) => part.inlineData.data);
  }

  const response = await ctx.request(base(ctx) + modelPath(request.model) + ":predict", {
    method: "POST",
    headers: headers(ctx),
    json: {
      instances: [{ prompt: request.prompt }],
      parameters: { sampleCount: request.n, aspectRatio: aspectRatio(request) },
    },
  });
  const body = await response.json();
  return (body.predictions || []).map((prediction) => prediction.bytesBase64Encoded);
}
`;

const SD_WEBUI = String.raw`// Stable Diffusion, through the AUTOMATIC1111 or Forge WebUI started with --api.
// It draws and does not chat, so it is offered for image generation and not as
// an engine to talk to.
//
// image() draws and models() lists the installed checkpoints. Everything
// request and ctx carry is described under "How a script works".

const BASE = "http://127.0.0.1:7860";

function base(ctx) {
  return ctx.baseUrl || BASE;
}

// For a WebUI started with --api-auth, set the key to user:password.
function headers(ctx) {
  return ctx.apiKey ? { authorization: "Basic " + Buffer.from(ctx.apiKey).toString("base64") } : {};
}

export async function models(ctx) {
  const response = await ctx.request(base(ctx) + "/sdapi/v1/sd-models", { headers: headers(ctx) });
  const checkpoints = await response.json();
  return checkpoints.map((checkpoint) => ({
    id: checkpoint.title,
    label: checkpoint.model_name,
    chat: false,
    image: true,
  }));
}

// The WebUI renders a batch in one call, so several can be asked for at once.
export const maxImagesPerCall = 4;

export async function image(request, ctx) {
  const [width, height] = (request.size || "1024x1024").split("x").map(Number);
  const body = { prompt: request.prompt, width, height, batch_size: request.n, steps: 25 };
  if (request.seed !== undefined) body.seed = request.seed;
  // "default" draws with whichever checkpoint the WebUI already has loaded.
  if (request.model && request.model !== "default") {
    body.override_settings = { sd_model_checkpoint: request.model };
  }

  const response = await ctx.request(base(ctx) + "/sdapi/v1/txt2img", {
    method: "POST",
    headers: headers(ctx),
    json: body,
  });
  const result = await response.json();
  // A batch of more than one comes back with a contact-sheet grid in front of
  // the individual pictures, so only the last n are kept.
  return result.images.slice(-request.n);
}
`;

const SCRATCH = String.raw`// A script that talks to nothing, so the shape of one is easy to see before it
// is pointed at something real.
//
// chat() is handed the conversation and yields its reply a piece at a time.
// Replace the body with a call to anything: an HTTP API, a model server on your
// network, a queue in front of a GPU. Everything request and ctx carry is
// described under "How a script works".

export async function* chat(request, ctx) {
  const last = request.messages.filter((message) => message.role === "user").pop();
  const said = (last?.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");

  // Streamed a word at a time, the way a real model would.
  for (const word of ("You said: " + said).split(/(\s+)/)) {
    yield word;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  // To call a real endpoint instead:
  //
  //   const response = await ctx.request(ctx.baseUrl + "/generate", {
  //     method: "POST",
  //     headers: { authorization: "Bearer " + ctx.apiKey },
  //     json: { model: request.model, prompt: said },
  //   });
  //   const body = await response.json();
  //   yield body.text;
  //
  // For a streamed answer, read it with ctx.sse(response) for server-sent
  // events, or ctx.lines(response) for one JSON object per line.
}

// Fills the model list. Return ids, or { id, label } objects.
export function models() {
  return ["echo"];
}
`;

/**
 * In the order they are offered. The three people ask for by name come first;
 * "from scratch" comes last because it is the one that does nothing until it
 * is changed.
 */
export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: "ollama",
    label: "Ollama",
    hint: "Ollama's own /api/chat, with thinking and tool calls. No key.",
    kind: "ollama",
    does: ["chat", "models"],
    name: "Ollama script",
    baseUrl: "http://localhost:11434",
    apiKeyEnv: null,
    model: KINDS.ollama.suggestedModels[0] ?? "llama3.2",
    keyUrl: null,
    script: OLLAMA,
  },
  {
    id: "openai",
    label: "ChatGPT",
    hint: "OpenAI's Chat Completions and Images APIs.",
    kind: "openai",
    does: ["chat", "image", "models"],
    name: "ChatGPT script",
    baseUrl: null,
    apiKeyEnv: KINDS.openai.defaultApiKeyEnv,
    model: KINDS.openai.suggestedModels[0] ?? "gpt-4.1",
    keyUrl: "https://platform.openai.com/api-keys",
    script: OPENAI,
  },
  {
    id: "anthropic",
    label: "Claude",
    hint: "Anthropic's Messages API, with tool use and extended thinking.",
    kind: "anthropic",
    does: ["chat", "models"],
    name: "Claude script",
    baseUrl: null,
    apiKeyEnv: KINDS.anthropic.defaultApiKeyEnv,
    model: KINDS.anthropic.suggestedModels[0] ?? "claude-sonnet-4-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
    script: ANTHROPIC,
  },
  {
    id: "google",
    label: "Gemini",
    hint: "Google's generateContent for chat, and Imagen for pictures.",
    kind: "google",
    does: ["chat", "image", "models"],
    name: "Gemini script",
    baseUrl: null,
    apiKeyEnv: KINDS.google.defaultApiKeyEnv,
    model: KINDS.google.suggestedModels[0] ?? "gemini-2.5-pro",
    keyUrl: "https://aistudio.google.com/apikey",
    script: GOOGLE,
  },
  {
    id: "openai_compatible",
    label: "OpenAI-compatible",
    hint: "Any server that copies OpenAI's API, at a base URL you set.",
    kind: "openai_compatible",
    does: ["chat", "image", "models"],
    name: "OpenAI-compatible script",
    baseUrl: null,
    apiKeyEnv: null,
    model: "",
    keyUrl: null,
    script: OPENAI_COMPATIBLE,
  },
  {
    id: "sd_webui",
    label: "Stable Diffusion WebUI",
    hint: "AUTOMATIC1111 or Forge, started with --api. Draws only.",
    kind: null,
    does: ["image", "models"],
    name: "Stable Diffusion",
    baseUrl: "http://127.0.0.1:7860",
    apiKeyEnv: null,
    model: "default",
    keyUrl: null,
    script: SD_WEBUI,
  },
  {
    id: "scratch",
    label: "From scratch",
    hint: "Talks to nothing. The shape of a script, ready to point at any API.",
    kind: null,
    does: ["chat", "models"],
    name: "My engine",
    baseUrl: null,
    apiKeyEnv: null,
    model: "echo",
    keyUrl: null,
    script: SCRATCH,
  },
];

/** The template that mirrors a built-in kind, falling back to the OpenAI shape. */
export function templateForKind(kind: string): ScriptTemplate {
  return (
    SCRIPT_TEMPLATES.find((template) => template.kind === kind) ??
    SCRIPT_TEMPLATES.find((template) => template.id === "openai_compatible")!
  );
}
