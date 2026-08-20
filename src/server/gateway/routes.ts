/**
 * The gateway's HTTP surface: `/v1`.
 *
 * Mounted outside `/api` because it is not ModelDock's own API — it is two
 * other people's APIs, served from here so that anything already able to speak
 * one of them can use every model on this machine. `/v1/models` and
 * `/v1/chat/completions` are OpenAI's; `/v1/messages` is Anthropic's. A client
 * configured for either sees exactly what it expects.
 *
 * Everything is a translation of `run.ts`'s single stream into one of two
 * framings. The streaming and non-streaming forms of each protocol share their
 * accumulation logic rather than being written twice, because the difference
 * between them is when bytes are sent, not what they contain.
 */

import { Hono } from "hono";

import { db } from "../db/index.js";
import { HttpError } from "../errors.js";
import { messageId, readAnthropicRequest, stopReason, type AnthropicBody } from "./anthropic.js";
import { gatewayCatalog, gatewayConnections } from "./catalog.js";
import { completionId, finishReason, readOpenAiRequest, type OpenAiBody } from "./openai.js";
import { SSE_HEADERS, resolveRequest, runGateway, sse } from "./run.js";
import { checkGatewayToken } from "./token.js";

export const gatewayRoutes = new Hono();

/**
 * Every gateway route needs the token. See `token.ts` for why this one surface
 * asks for a credential when the rest of the app does not.
 *
 * The 401 body follows OpenAI's error shape, which Anthropic clients also
 * tolerate, and says what to do rather than only that something was wrong.
 */
gatewayRoutes.use("*", async (c, next) => {
  if (!checkGatewayToken(c.req.raw.headers)) {
    return c.json(
      {
        error: {
          type: "authentication_error",
          message:
            "This ModelDock gateway needs its token. Find it in Settings under Connect your tools, and send it as `Authorization: Bearer <token>` or `x-api-key: <token>`.",
        },
      },
      401,
    );
  }
  await next();
});

/** A tool call accumulated across a stream, in the order it was started. */
interface PendingCall {
  id: string;
  name: string;
  input: string;
}

/**
 * Read the SDK stream once, into everything either protocol could need.
 *
 * `onPart` is where a streaming route emits as it goes; the collected totals
 * are what a non-streaming route answers with at the end. Sharing the walk
 * means the two forms cannot disagree about what the model said.
 */
async function walk(
  stream: AsyncIterable<Record<string, unknown>>,
  onPart: (part: Record<string, unknown>) => void | Promise<void>,
): Promise<{
  text: string;
  reasoning: string;
  calls: PendingCall[];
  finish: string;
  usage: { input: number; output: number };
  error: string | null;
}> {
  let text = "";
  let reasoning = "";
  const calls: PendingCall[] = [];
  let finish = "stop";
  let usage = { input: 0, output: 0 };
  let error: string | null = null;

  for await (const part of stream) {
    switch (part.type) {
      case "text-delta":
        text += String(part.text ?? "");
        break;
      case "reasoning-delta":
        reasoning += String(part.text ?? "");
        break;
      case "tool-call":
        calls.push({
          id: String(part.toolCallId ?? ""),
          name: String(part.toolName ?? ""),
          input: JSON.stringify(part.input ?? {}),
        });
        break;
      case "finish": {
        finish = String(part.finishReason ?? "stop");
        const total = part.totalUsage as
          | { inputTokens?: number; outputTokens?: number }
          | undefined;
        usage = { input: total?.inputTokens ?? 0, output: total?.outputTokens ?? 0 };
        break;
      }
      case "error":
        error = describe(part.error);
        break;
      default:
        break;
    }

    await onPart(part);
  }

  return { text, reasoning, calls, finish, usage, error };
}

/** A provider failure as a sentence, whatever shape it arrived in. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "The provider failed mid-stream.";
}

/* ------------------------------------------------------------------ models */

/**
 * Every model on this machine, in OpenAI's listing shape.
 *
 * Served at both paths because a client configured for one protocol will ask
 * the path its own vendor documents, and the answer is the same either way.
 */
async function listing() {
  const catalog = await gatewayCatalog(db());
  const created = Math.floor(Date.now() / 1000);

  return {
    object: "list",
    data: catalog.models.map((model) => ({
      id: model.id,
      object: "model",
      created,
      // The connection it came from, which is the honest answer to "who owns
      // this model" and what a picker should group by.
      owned_by: model.connectionName,
      display_name: model.label ?? model.model,
    })),
    // Not part of either vendor's schema, and deliberately included: a client
    // that ignores it loses nothing, and a person debugging why a provider is
    // missing from the list gets told rather than left guessing.
    modeldock: { problems: catalog.problems },
  };
}

gatewayRoutes.get("/models", async (c) => c.json(await listing()));

/* --------------------------------------------------------------- OpenAI */

gatewayRoutes.post("/chat/completions", async (c) => {
  const body = await c.req.json<OpenAiBody>().catch(() => {
    throw new HttpError(400, "The request body was not valid JSON.");
  });

  const request = readOpenAiRequest(body);
  const rows = await gatewayConnections(db());
  const { connection, model } = resolveRequest(rows, request.model);

  const result = runGateway(connection, { ...request, model, signal: c.req.raw.signal });
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const name = body.model ?? model;

  if (body.stream !== true) {
    const walked = await walk(result.fullStream as never, () => {});
    if (walked.error && !walked.text && walked.calls.length === 0) {
      throw new HttpError(502, walked.error);
    }

    return c.json({
      id,
      object: "chat.completion",
      created,
      model: name,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: walked.text || null,
            ...(walked.reasoning ? { reasoning_content: walked.reasoning } : {}),
            ...(walked.calls.length > 0
              ? {
                  tool_calls: walked.calls.map((call, index) => ({
                    index,
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: call.input },
                  })),
                }
              : {}),
          },
          finish_reason: finishReason(walked.finish, walked.calls.length > 0),
        },
      ],
      usage: {
        prompt_tokens: walked.usage.input,
        completion_tokens: walked.usage.output,
        total_tokens: walked.usage.input + walked.usage.output,
      },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: unknown) => controller.enqueue(encoder.encode(sse(null, chunk)));

      const frame = (delta: Record<string, unknown>, reason: string | null = null) => ({
        id,
        object: "chat.completion.chunk",
        created,
        model: name,
        choices: [{ index: 0, delta, finish_reason: reason }],
      });

      // The role arrives once, in its own chunk, before any content — which is
      // what OpenAI does and what several clients assume.
      send(frame({ role: "assistant", content: "" }));

      // Indexes are assigned as calls start, because a client assembling
      // arguments from deltas keys on the index rather than on the id.
      const indexes = new Map<string, number>();

      try {
        const walked = await walk(result.fullStream as never, (part) => {
          switch (part.type) {
            case "text-delta":
              send(frame({ content: String(part.text ?? "") }));
              break;

            case "reasoning-delta":
              send(frame({ reasoning_content: String(part.text ?? "") }));
              break;

            case "tool-input-start": {
              const index = indexes.size;
              indexes.set(String(part.id ?? ""), index);
              send(
                frame({
                  tool_calls: [
                    {
                      index,
                      id: String(part.id ?? ""),
                      type: "function",
                      function: { name: String(part.toolName ?? ""), arguments: "" },
                    },
                  ],
                }),
              );
              break;
            }

            case "tool-input-delta": {
              const index = indexes.get(String(part.id ?? "")) ?? 0;
              send(
                frame({
                  tool_calls: [{ index, function: { arguments: String(part.delta ?? "") } }],
                }),
              );
              break;
            }

            /**
             * The whole call, for providers that never streamed its input.
             *
             * Without this a non-streaming tool provider behind the gateway
             * would emit a `tool-call` the client never saw the arguments for.
             */
            case "tool-call": {
              const callId = String(part.toolCallId ?? "");
              if (indexes.has(callId)) break;
              const index = indexes.size;
              indexes.set(callId, index);
              send(
                frame({
                  tool_calls: [
                    {
                      index,
                      id: callId,
                      type: "function",
                      function: {
                        name: String(part.toolName ?? ""),
                        arguments: JSON.stringify(part.input ?? {}),
                      },
                    },
                  ],
                }),
              );
              break;
            }

            default:
              break;
          }
        });

        send(frame({}, finishReason(walked.finish, walked.calls.length > 0)));
        controller.enqueue(encoder.encode(sse(null, "[DONE]")));
      } catch (error) {
        // Mid-stream the status line is long gone, so a failure has to be said
        // in the stream itself rather than as an HTTP error.
        send({ error: { type: "api_error", message: describe(error) } });
        controller.enqueue(encoder.encode(sse(null, "[DONE]")));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
});

/* ------------------------------------------------------------ Anthropic */

gatewayRoutes.post("/messages", async (c) => {
  const body = await c.req.json<AnthropicBody>().catch(() => {
    throw new HttpError(400, "The request body was not valid JSON.");
  });

  const request = readAnthropicRequest(body);
  const rows = await gatewayConnections(db());
  const { connection, model } = resolveRequest(rows, request.model);

  const result = runGateway(connection, { ...request, model, signal: c.req.raw.signal });
  const id = messageId();
  const name = body.model ?? model;

  if (body.stream !== true) {
    const walked = await walk(result.fullStream as never, () => {});
    if (walked.error && !walked.text && walked.calls.length === 0) {
      throw new HttpError(502, walked.error);
    }

    const content: unknown[] = [];
    if (walked.text) content.push({ type: "text", text: walked.text });
    for (const call of walked.calls) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: safeParse(call.input),
      });
    }

    return c.json({
      id,
      type: "message",
      role: "assistant",
      model: name,
      content,
      stop_reason: stopReason(walked.finish, walked.calls.length > 0),
      stop_sequence: null,
      usage: { input_tokens: walked.usage.input, output_tokens: walked.usage.output },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sse(event, data)));

      send("message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: name,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      /**
       * Anthropic numbers content blocks and requires every one to be opened
       * and closed. The SDK's parts do not carry a block index, so one is kept
       * here — and whichever block is open has to be closed before the next
       * one opens, which is what `close()` is for.
       */
      let index = -1;
      let open: "text" | "thinking" | "tool" | null = null;
      const blocks = new Map<string, number>();

      const close = () => {
        if (open === null) return;
        send("content_block_stop", { type: "content_block_stop", index });
        open = null;
      };

      const start = (kind: "text" | "thinking" | "tool", block: unknown) => {
        close();
        index++;
        open = kind;
        send("content_block_start", { type: "content_block_start", index, content_block: block });
      };

      try {
        const walked = await walk(result.fullStream as never, (part) => {
          switch (part.type) {
            case "text-delta": {
              if (open !== "text") start("text", { type: "text", text: "" });
              send("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "text_delta", text: String(part.text ?? "") },
              });
              break;
            }

            case "reasoning-delta": {
              if (open !== "thinking") start("thinking", { type: "thinking", thinking: "" });
              send("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "thinking_delta", thinking: String(part.text ?? "") },
              });
              break;
            }

            case "tool-input-start": {
              start("tool", {
                type: "tool_use",
                id: String(part.id ?? ""),
                name: String(part.toolName ?? ""),
                input: {},
              });
              blocks.set(String(part.id ?? ""), index);
              break;
            }

            case "tool-input-delta": {
              if (open !== "tool") break;
              send("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: String(part.delta ?? "") },
              });
              break;
            }

            // As on the OpenAI side: a provider that never streamed the input
            // still has to produce a complete block.
            case "tool-call": {
              const callId = String(part.toolCallId ?? "");
              if (blocks.has(callId)) break;
              start("tool", {
                type: "tool_use",
                id: callId,
                name: String(part.toolName ?? ""),
                input: {},
              });
              blocks.set(callId, index);
              send("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(part.input ?? {}),
                },
              });
              break;
            }

            default:
              break;
          }
        });

        close();

        send("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: stopReason(walked.finish, walked.calls.length > 0),
            stop_sequence: null,
          },
          usage: { input_tokens: walked.usage.input, output_tokens: walked.usage.output },
        });
        send("message_stop", { type: "message_stop" });
      } catch (error) {
        close();
        send("error", { type: "error", error: { type: "api_error", message: describe(error) } });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
});

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}
