/**
 * A script, as an AI SDK language model.
 *
 * `runtime.ts` loads the module; this file is the translation on either side of
 * it. Inbound, the SDK's prompt becomes a plainer shape someone can write
 * against without learning the SDK: one list of messages, parts with obvious
 * names, tool results already turned into text. Outbound, whatever the script
 * yields becomes the SDK's stream protocol, so `streamText` and everything built
 * on it — chat, the gateway, the built-in coding engine — cannot tell a script
 * from a vendor.
 *
 * The translation is deliberately lossy in one direction only. Things a script
 * is unlikely to need and could not send anywhere — a provider's opaque file
 * reference, an image returned by a tool, a pending approval — are left out of
 * the request rather than handed over as noise. Nothing a script *yields* is
 * lost: text, reasoning, tool calls, usage and why it stopped all have a place
 * on the other side.
 *
 * ## `meta`, and why it exists
 *
 * Some APIs return an opaque value that has to be sent back on the next request
 * or that request fails — Anthropic's thinking signatures, Gemini's thought
 * signatures. Any text, reasoning or tool-call event can carry `meta`. It is
 * stored with the message as that part's provider metadata under `script`, and
 * it comes back on the same part of the next request. The script decides what
 * goes in it; nothing in ModelDock reads it.
 *
 * ## The first event is awaited before the stream is returned
 *
 * A vendor provider makes its request inside `doStream` and throws there if the
 * request is refused. Doing the same here — pulling the script's first event
 * before handing back a stream — is what lets the SDK's own retry treat a
 * script's 429 the way it treats OpenAI's, and makes a rejected key fail the
 * call outright rather than arrive as an error inside an otherwise empty reply.
 */

import { randomUUID } from "node:crypto";

import type {
  JSONObject,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4ToolResultOutput,
  LanguageModelV4Usage,
  SharedV4FileData,
  SharedV4Warning,
} from "@ai-sdk/provider";

import {
  ScriptError,
  annotate,
  loadScript,
  preview,
  scriptContext,
  type ScriptContext,
  type ScriptModule,
} from "./runtime.js";

/** Where a script's `meta` lives on a part. One key, so it cannot collide with a vendor's. */
const META = "script";

/** One piece of a message, as a script sees it. */
export type ScriptPart =
  | { type: "text"; text: string; meta?: JSONObject }
  | { type: "reasoning"; text: string; meta?: JSONObject }
  /**
   * An attachment. `data` is base64 and is what almost every file carries: the
   * SDK downloads a linked file before a script is called, so `url` appears only
   * when that was not possible, and `text` only for a file that was text already.
   */
  | {
      type: "file";
      mediaType: string;
      filename?: string;
      data?: string;
      url?: string;
      text?: string;
    }
  | { type: "tool-call"; id: string; name: string; input: unknown; meta?: JSONObject }
  /** `output` is always a string: JSON is serialised, text is passed as it was. */
  | { type: "tool-result"; id: string; name: string; output: string; isError: boolean };

export interface ScriptMessage {
  role: "user" | "assistant" | "tool";
  content: ScriptPart[];
}

export interface ScriptTool {
  name: string;
  description: string | undefined;
  /** JSON Schema, exactly as the tool declared it. */
  parameters: unknown;
}

/** Everything `chat()` is given about the turn. */
export interface ScriptChatRequest {
  model: string;
  /** Every system message, joined. Most APIs take one, and it goes first. */
  system: string | undefined;
  messages: ScriptMessage[];
  tools: ScriptTool[];
  toolChoice: "auto" | "none" | "required" | { name: string } | undefined;
  maxOutputTokens: number | undefined;
  temperature: number | undefined;
  topP: number | undefined;
  topK: number | undefined;
  presencePenalty: number | undefined;
  frequencyPenalty: number | undefined;
  stopSequences: string[] | undefined;
  seed: number | undefined;
  responseFormat: LanguageModelV4CallOptions["responseFormat"];
  reasoning: LanguageModelV4CallOptions["reasoning"];
}

export interface ScriptModelSettings {
  /** The connection's name, used in every message a person might see. */
  name: string;
  script: string;
  baseUrl: string | null;
  apiKey: string | null;
  modelId: string;
}

// ---------------------------------------------------------------------------
// Inbound: the SDK's prompt, in the shape a script reads.
// ---------------------------------------------------------------------------

function metaOf(options: Record<string, JSONObject> | undefined): JSONObject | undefined {
  const meta = options?.[META];
  return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : undefined;
}

function withMeta<T extends object>(
  part: T,
  meta: JSONObject | undefined,
): T & { meta?: JSONObject } {
  return meta ? { ...part, meta } : part;
}

function filePart(
  mediaType: string,
  filename: string | undefined,
  data: SharedV4FileData,
): ScriptPart | null {
  const base = { type: "file" as const, mediaType, ...(filename ? { filename } : {}) };

  switch (data.type) {
    case "data":
      return {
        ...base,
        data: typeof data.data === "string" ? data.data : Buffer.from(data.data).toString("base64"),
      };
    case "url":
      return { ...base, url: data.url.toString() };
    case "text":
      return { ...base, text: data.text };
    default:
      // A provider's own file reference means nothing to any other endpoint.
      return null;
  }
}

function outputOf(output: LanguageModelV4ToolResultOutput): { output: string; isError: boolean } {
  switch (output.type) {
    case "text":
      return { output: output.value, isError: false };
    case "error-text":
      return { output: output.value, isError: true };
    case "json":
      return { output: JSON.stringify(output.value), isError: false };
    case "error-json":
      return { output: JSON.stringify(output.value), isError: true };
    case "execution-denied":
      return {
        output: output.reason ? `Not run: ${output.reason}` : "Not run: the call was declined.",
        isError: true,
      };
    case "content":
      return {
        output: output.value
          .flatMap((item) => (item.type === "text" ? [item.text] : []))
          .join("\n"),
        isError: false,
      };
    default:
      return { output: "", isError: false };
  }
}

function toMessages(prompt: LanguageModelV4Prompt): {
  system: string | undefined;
  messages: ScriptMessage[];
} {
  const system: string[] = [];
  const messages: ScriptMessage[] = [];

  for (const message of prompt) {
    switch (message.role) {
      case "system":
        system.push(message.content);
        break;

      case "user": {
        const content: ScriptPart[] = [];
        for (const part of message.content) {
          if (part.type === "text") {
            content.push({ type: "text", text: part.text });
          } else {
            const file = filePart(part.mediaType, part.filename, part.data);
            if (file) content.push(file);
          }
        }
        messages.push({ role: "user", content });
        break;
      }

      case "assistant": {
        const content: ScriptPart[] = [];
        for (const part of message.content) {
          const meta = metaOf(part.providerOptions);
          if (part.type === "text") {
            content.push(withMeta({ type: "text" as const, text: part.text }, meta));
          } else if (part.type === "reasoning") {
            content.push(withMeta({ type: "reasoning" as const, text: part.text }, meta));
          } else if (part.type === "tool-call") {
            content.push(
              withMeta(
                {
                  type: "tool-call" as const,
                  id: part.toolCallId,
                  name: part.toolName,
                  input: part.input,
                },
                meta,
              ),
            );
          } else if (part.type === "file") {
            const file = filePart(part.mediaType, part.filename, part.data);
            if (file) content.push(file);
          }
          // Provider-executed results, reasoning files and custom parts belong
          // to the vendor that produced them, and are left out.
        }
        messages.push({ role: "assistant", content });
        break;
      }

      case "tool": {
        const content: ScriptPart[] = [];
        for (const part of message.content) {
          if (part.type !== "tool-result") continue;
          content.push({
            type: "tool-result",
            id: part.toolCallId,
            name: part.toolName,
            ...outputOf(part.output),
          });
        }
        messages.push({ role: "tool", content });
        break;
      }
    }
  }

  return { system: system.length > 0 ? system.join("\n\n") : undefined, messages };
}

function toRequest(
  options: LanguageModelV4CallOptions,
  model: string,
  warnings: SharedV4Warning[],
): ScriptChatRequest {
  const { system, messages } = toMessages(options.prompt);

  const tools: ScriptTool[] = [];
  for (const tool of options.tools ?? []) {
    if (tool.type === "function") {
      tools.push({ name: tool.name, description: tool.description, parameters: tool.inputSchema });
    } else {
      warnings.push({
        type: "unsupported",
        feature: `provider tool ${tool.name}`,
        details: "A script is only given function tools.",
      });
    }
  }

  const choice = options.toolChoice;

  return {
    model,
    system,
    messages,
    tools,
    toolChoice: !choice
      ? undefined
      : choice.type === "tool"
        ? { name: choice.toolName }
        : choice.type,
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
    topP: options.topP,
    topK: options.topK,
    presencePenalty: options.presencePenalty,
    frequencyPenalty: options.frequencyPenalty,
    stopSequences: options.stopSequences,
    seed: options.seed,
    responseFormat: options.responseFormat,
    reasoning: options.reasoning,
  };
}

// ---------------------------------------------------------------------------
// Outbound: whatever the script yields, checked and normalised.
// ---------------------------------------------------------------------------

type Finish = LanguageModelV4FinishReason["unified"];

const REASONS: ReadonlySet<string> = new Set<Finish>([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
]);

type ScriptEvent =
  | { type: "text" | "reasoning"; text: string; meta?: JSONObject }
  | { type: "tool-call"; id: string; name: string; input: string; meta?: JSONObject }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
    }
  | { type: "finish"; reason: Finish | undefined; raw: string | undefined };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function unexpected(value: unknown, who: string, why?: string): ScriptError {
  return new ScriptError(
    `${who}'s chat() yielded ${preview(value)}${why ? ` — ${why}` : ""}. Yield text, or an object whose type is text, reasoning, tool-call, usage or finish.`,
  );
}

function normalise(value: unknown, who: string): ScriptEvent | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value ? { type: "text", text: value } : null;
  if (!isObject(value)) throw unexpected(value, who);

  const meta = isObject(value.meta) ? (value.meta as JSONObject) : undefined;

  switch (value.type) {
    case "text":
    case "reasoning": {
      if (typeof value.text !== "string")
        throw unexpected(value, who, `a ${value.type} event needs text`);
      // An empty delta is noise, unless it is how a signature arrives.
      if (!value.text && !meta) return null;
      return { type: value.type, text: value.text, ...(meta ? { meta } : {}) };
    }

    case "tool-call": {
      if (typeof value.name !== "string" || !value.name) {
        throw unexpected(value, who, "a tool-call needs a name");
      }
      const input =
        value.input === undefined
          ? "{}"
          : typeof value.input === "string"
            ? value.input
            : JSON.stringify(value.input);
      return {
        type: "tool-call",
        // Plenty of APIs never name their calls. The SDK needs an id to match a
        // result to its call, so one is made up rather than asked for.
        id: typeof value.id === "string" && value.id ? value.id : `call_${randomUUID()}`,
        name: value.name,
        input,
        ...(meta ? { meta } : {}),
      };
    }

    case "usage":
      return {
        type: "usage",
        inputTokens: count(value.inputTokens),
        outputTokens: count(value.outputTokens),
        reasoningTokens: count(value.reasoningTokens),
        cachedInputTokens: count(value.cachedInputTokens),
      };

    case "finish": {
      const reason = value.reason;
      return {
        type: "finish",
        reason:
          reason === undefined
            ? undefined
            : typeof reason === "string" && REASONS.has(reason)
              ? (reason as Finish)
              : "other",
        raw:
          typeof value.raw === "string"
            ? value.raw
            : typeof reason === "string"
              ? reason
              : undefined,
      };
    }

    default:
      throw unexpected(value, who);
  }
}

const isIterable = (value: unknown): value is AsyncIterable<unknown> | Iterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  (Symbol.asyncIterator in value || Symbol.iterator in value);

/**
 * Call `chat()` and yield what it produces, however it chose to produce it.
 *
 * An async generator is the documented form, but returning a string, an array
 * of events or a promise of either works too — a script that answers in one
 * piece should not have to learn `function*` to say so.
 */
async function* events(
  module: ScriptModule,
  request: ScriptChatRequest,
  ctx: ScriptContext,
  who: string,
): AsyncGenerator<ScriptEvent> {
  if (typeof module.chat !== "function") {
    throw new ScriptError(
      `${who}'s script has no chat() export, so it cannot hold a conversation. If it draws, choose it under Image generation in Settings instead.`,
    );
  }

  try {
    let result: unknown = module.chat(request, ctx);
    if (result instanceof Promise) result = await result;

    if (typeof result === "string" || !isIterable(result)) {
      const one = normalise(result, who);
      if (one) yield one;
      return;
    }

    for await (const value of result) {
      const next = normalise(value, who);
      if (next) yield next;
    }
  } catch (error) {
    throw annotate(error);
  }
}

/** Usage and the reason for stopping, which arrive as events but are reported once. */
class Tally {
  private usage: Extract<ScriptEvent, { type: "usage" }> = { type: "usage" };
  private reason: Finish | undefined;
  private raw: string | undefined;
  sawToolCall = false;

  /** True when the event was bookkeeping and has been fully consumed. */
  take(event: ScriptEvent): event is Extract<ScriptEvent, { type: "usage" | "finish" }> {
    if (event.type === "tool-call") this.sawToolCall = true;

    if (event.type === "usage") {
      // Latest wins, field by field. APIs report running totals, and they report
      // input and output at different points in the stream.
      for (const key of [
        "inputTokens",
        "outputTokens",
        "reasoningTokens",
        "cachedInputTokens",
      ] as const) {
        if (event[key] !== undefined) this.usage[key] = event[key];
      }
      return true;
    }

    if (event.type === "finish") {
      this.reason = event.reason;
      this.raw = event.raw;
      return true;
    }

    return false;
  }

  finishReason(failed: boolean): LanguageModelV4FinishReason {
    if (failed) return { unified: "error", raw: this.raw };
    // Several APIs say "stop" when they stop to call a tool. The SDK and the
    // gateway both read "tool-calls" as the signal, so a call wins over the word.
    if (this.sawToolCall && (this.reason === undefined || this.reason === "stop")) {
      return { unified: "tool-calls", raw: this.raw };
    }
    return { unified: this.reason ?? "stop", raw: this.raw };
  }

  totals(): LanguageModelV4Usage {
    const { inputTokens, outputTokens, reasoningTokens, cachedInputTokens } = this.usage;
    return {
      inputTokens: {
        total: inputTokens,
        noCache:
          inputTokens !== undefined && cachedInputTokens !== undefined
            ? inputTokens - cachedInputTokens
            : inputTokens,
        cacheRead: cachedInputTokens,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: outputTokens,
        text:
          outputTokens !== undefined && reasoningTokens !== undefined
            ? outputTokens - reasoningTokens
            : outputTokens,
        reasoning: reasoningTokens,
      },
    };
  }
}

const metadata = (meta: JSONObject | undefined) =>
  meta ? { providerMetadata: { [META]: meta } } : {};

export class ScriptLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "script";
  readonly modelId: string;
  /**
   * Empty, so the SDK downloads any linked file before the script is called and
   * a script always receives bytes. Asking every script to fetch URLs itself
   * would be a chore most of them would get subtly wrong.
   */
  readonly supportedUrls = {};

  private readonly settings: ScriptModelSettings;

  constructor(settings: ScriptModelSettings) {
    this.settings = settings;
    this.modelId = settings.modelId;
  }

  private async begin(options: LanguageModelV4CallOptions, signal: AbortSignal) {
    const { name, script, baseUrl, apiKey } = this.settings;
    const warnings: SharedV4Warning[] = [];
    const request = toRequest(options, this.modelId, warnings);
    const module = await loadScript({ name, script });
    const ctx = scriptContext({ name, model: this.modelId, baseUrl, apiKey, signal });
    return { warnings, iterator: events(module, request, ctx, name) };
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { warnings, iterator } = await this.begin(
      options,
      options.abortSignal ?? new AbortController().signal,
    );

    const content: LanguageModelV4Content[] = [];
    const tally = new Tally();

    for await (const event of iterator) {
      if (tally.take(event)) continue;

      if (event.type === "tool-call") {
        content.push({
          type: "tool-call",
          toolCallId: event.id,
          toolName: event.name,
          input: event.input,
          ...metadata(event.meta),
        });
        continue;
      }

      // Consecutive pieces of the same kind are one block, as in the stream.
      const last = content.at(-1);
      if (last && (last.type === "text" || last.type === "reasoning") && last.type === event.type) {
        last.text += event.text;
        if (event.meta) {
          last.providerMetadata = { [META]: { ...last.providerMetadata?.[META], ...event.meta } };
        }
      } else {
        content.push({ type: event.type, text: event.text, ...metadata(event.meta) });
      }
    }

    return {
      content,
      finishReason: tally.finishReason(false),
      usage: tally.totals(),
      warnings,
      response: { modelId: this.modelId, timestamp: new Date() },
    };
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    // Its own controller, so cancelling the stream can stop a script's request
    // even when the caller passed no signal of its own.
    const abort = new AbortController();
    const forward = () => abort.abort(options.abortSignal?.reason);
    if (options.abortSignal?.aborted) forward();
    else options.abortSignal?.addEventListener("abort", forward, { once: true });
    const detach = () => options.abortSignal?.removeEventListener("abort", forward);

    let begun: Awaited<ReturnType<ScriptLanguageModel["begin"]>>;
    let first: IteratorResult<ScriptEvent>;
    try {
      begun = await this.begin(options, abort.signal);
      first = await begun.iterator.next();
    } catch (error) {
      detach();
      throw error;
    }

    const { warnings, iterator } = begun;
    const modelId = this.modelId;
    const tally = new Tally();
    let open: { type: "text" | "reasoning"; id: string; meta?: JSONObject } | null = null;
    let blocks = 0;
    let done = false;

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        const emit = (part: LanguageModelV4StreamPart) => {
          if (!done) controller.enqueue(part);
        };

        const closeBlock = () => {
          if (!open) return;
          const extra = metadata(open.meta);
          emit(
            open.type === "text"
              ? { type: "text-end", id: open.id, ...extra }
              : { type: "reasoning-end", id: open.id, ...extra },
          );
          open = null;
        };

        const push = (event: ScriptEvent) => {
          if (tally.take(event)) return;

          if (event.type === "tool-call") {
            closeBlock();
            emit({ type: "tool-input-start", id: event.id, toolName: event.name });
            emit({ type: "tool-input-delta", id: event.id, delta: event.input });
            emit({ type: "tool-input-end", id: event.id });
            emit({
              type: "tool-call",
              toolCallId: event.id,
              toolName: event.name,
              input: event.input,
              ...metadata(event.meta),
            });
            return;
          }

          let block = open;
          if (!block || block.type !== event.type) {
            closeBlock();
            block = { type: event.type, id: String(blocks++) };
            open = block;
            emit(
              event.type === "text"
                ? { type: "text-start", id: block.id }
                : { type: "reasoning-start", id: block.id },
            );
          }

          if (event.meta) block.meta = { ...block.meta, ...event.meta };
          const extra = metadata(event.meta);
          emit(
            event.type === "text"
              ? { type: "text-delta", id: block.id, delta: event.text, ...extra }
              : { type: "reasoning-delta", id: block.id, delta: event.text, ...extra },
          );
        };

        emit({ type: "stream-start", warnings });
        emit({ type: "response-metadata", modelId, timestamp: new Date() });

        let failed = false;
        try {
          if (!first.done) push(first.value);
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            push(next.value);
          }
        } catch (error) {
          failed = true;
          closeBlock();
          emit({ type: "error", error });
        }

        closeBlock();
        emit({ type: "finish", finishReason: tally.finishReason(failed), usage: tally.totals() });
        detach();
        if (!done) {
          done = true;
          controller.close();
        }
      },

      async cancel() {
        done = true;
        detach();
        abort.abort();
        await iterator.return(undefined).catch(() => undefined);
      },
    });

    return { stream };
  }
}
