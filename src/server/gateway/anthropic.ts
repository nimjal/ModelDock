/**
 * The Anthropic wire protocol, spoken by ModelDock.
 *
 * `/v1/messages`, which exists for one concrete reason: Claude Code speaks
 * only this. Point `ANTHROPIC_BASE_URL` at ModelDock and Claude Code will POST
 * here — and because the model on the other side is whichever connection the
 * requested id names, that is how Claude Code ends up running on Gemini, or on
 * a local Llama, without knowing anything has changed.
 *
 * That inversion is worth naming. The rest of this codebase drives Claude Code
 * as a subprocess and owns the transcript; this file is the other direction
 * entirely — Claude Code owns the session and ModelDock is the model. Both are
 * the same claim from opposite ends: the engine is a detail.
 *
 * The event sequence below is Anthropic's and is followed exactly, because a
 * client parsing a stream is far less forgiving than one parsing a response.
 * `message_start`, then per block `content_block_start` → `content_block_delta`
 * → `content_block_stop`, then `message_delta` carrying the stop reason, then
 * `message_stop`.
 */

import type { AssistantContent, JSONValue, ModelMessage, ToolResultPart, UserContent } from "ai";

import { HttpError } from "../errors.js";
import type { DeclaredTool, GatewayRequest } from "./run.js";

type ToolResultOutput = ToolResultPart["output"];

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | { type?: string; text?: string }[];
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

export interface AnthropicBody {
  model?: string;
  messages?: AnthropicMessage[];
  system?: string | { type?: string; text?: string }[];
  max_tokens?: number;
  stream?: boolean;
  tools?: { name?: string; description?: string; input_schema?: unknown }[];
  tool_choice?: { type?: string; name?: string };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
}

/** `system` is a string or a block array; both mean one prompt. */
function readSystem(system: AnthropicBody["system"]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system || undefined;

  const text = system
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return text || undefined;
}

/** A tool result block's content, which may be prose or blocks. */
function resultText(content: AnthropicBlock["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function jsonOrText(text: string): ToolResultOutput {
  try {
    return { type: "json", value: JSON.parse(text) as JSONValue };
  } catch {
    return { type: "text", value: text };
  }
}

/**
 * Anthropic messages in, `ModelMessage[]` out.
 *
 * The awkward part is `tool_result`: Anthropic puts it in a **user** message,
 * while the AI SDK — and OpenAI — model it as its own `tool` role. So a user
 * turn carrying tool results has to be split into a tool message and, if there
 * was also prose alongside, a user message after it. Getting that ordering
 * wrong is what makes an agent loop appear to work for one turn and then lose
 * its tool results on the second.
 */
export function toModelMessages(messages: AnthropicMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const blocks = message.content ?? [];

    if (message.role === "assistant") {
      const content: Exclude<AssistantContent, string> = [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "thinking" && typeof block.text === "string") {
          content.push({ type: "reasoning", text: block.text });
        } else if (block.type === "tool_use") {
          content.push({
            type: "tool-call",
            toolCallId: block.id ?? "",
            toolName: block.name ?? "",
            input: block.input ?? {},
          });
        }
      }
      if (content.length > 0) out.push({ role: "assistant", content });
      continue;
    }

    // A user turn: tool results first, then whatever else was in it.
    const results = blocks.filter((block) => block.type === "tool_result");
    const rest = blocks.filter((block) => block.type !== "tool_result");

    if (results.length > 0) {
      out.push({
        role: "tool",
        content: results.map((block) => ({
          type: "tool-result" as const,
          toolCallId: block.tool_use_id ?? "",
          // Anthropic does not repeat the tool name on a result; the SDK wants
          // one, and the id is what actually correlates the pair.
          toolName: "",
          output: block.is_error
            ? { type: "error-text" as const, value: resultText(block.content) }
            : jsonOrText(resultText(block.content)),
        })),
      });
    }

    const content: Exclude<UserContent, string> = [];
    for (const block of rest) {
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "image" && block.source) {
        const source = block.source;
        if (source.type === "url" && source.url) {
          content.push({ type: "image", image: new URL(source.url) });
        } else if (source.data) {
          content.push({
            type: "image",
            image: source.data,
            mediaType: source.media_type ?? "image/png",
          });
        }
      }
    }
    if (content.length > 0) out.push({ role: "user", content });
  }

  return out;
}

function toolChoice(choice: AnthropicBody["tool_choice"]): GatewayRequest["toolChoice"] {
  if (!choice?.type) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return choice.name ? { name: choice.name } : undefined;
    default:
      return undefined;
  }
}

export function readAnthropicRequest(body: AnthropicBody): GatewayRequest {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpError(400, "`messages` is required and must not be empty.");
  }

  const tools: DeclaredTool[] = (body.tools ?? [])
    .filter((item) => item.name)
    .map((item) => ({
      name: item.name!,
      description: item.description,
      parameters: item.input_schema,
    }));

  return {
    model: body.model ?? "",
    system: readSystem(body.system),
    messages: toModelMessages(body.messages),
    tools,
    toolChoice: toolChoice(body.tool_choice),
    // Required by the real API and by Claude Code, which always sends one. The
    // fallback exists only for a hand-written `curl`.
    maxOutputTokens: body.max_tokens ?? 4096,
    temperature: body.temperature,
    topP: body.top_p,
    stopSequences: body.stop_sequences,
  };
}

/** The SDK's finish reasons, in Anthropic's vocabulary. */
export function stopReason(reason: string, hadToolCall: boolean): string {
  if (hadToolCall) return "tool_use";
  switch (reason) {
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    case "tool-calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

export function messageId(): string {
  return `msg_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
