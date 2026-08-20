/**
 * The OpenAI wire protocol, spoken by ModelDock.
 *
 * `/v1/chat/completions` and `/v1/models`, which between them are what every
 * OpenAI-shaped client needs — OpenCode, Continue, Aider, a `curl`, anything
 * configured with a base URL and a key. The models on the other side are
 * whichever ones this machine has connections for, so a client pointed here
 * gets Claude and Gemini and a local Llama through one endpoint that only
 * knows how to speak OpenAI.
 *
 * This file is a translator and nothing else. It converts a request into the
 * AI SDK's vocabulary, hands it to `run.ts`, and converts what comes back. No
 * decision about which model, which key or which tools may run is made here.
 */

import type { AssistantContent, JSONValue, ModelMessage, ToolResultPart, UserContent } from "ai";

import { HttpError } from "../errors.js";
import type { DeclaredTool, GatewayRequest } from "./run.js";

/** The SDK spells this inline on `ToolResultPart`; naming it keeps the code short. */
type ToolResultOutput = ToolResultPart["output"];

/** One message as an OpenAI client sends it. */
interface OpenAiMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | { type: string; text?: string; image_url?: { url?: string } }[] | null;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAiBody {
  model?: string;
  messages?: OpenAiMessage[];
  stream?: boolean;
  tools?: {
    type?: string;
    function?: { name?: string; description?: string; parameters?: unknown };
  }[];
  tool_choice?: string | { function?: { name?: string } };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
}

/** Arguments arrive as a JSON *string*; the SDK wants the value. */
function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Passed through as a string rather than rejected: a provider that emitted
    // unparsable arguments is the one at fault, and the model on the other side
    // is often able to recover when it sees what it actually said.
    return raw;
  }
}

/** The multimodal content array, reduced to the parts the SDK understands. */
function userContent(message: OpenAiMessage): UserContent | string {
  if (typeof message.content === "string" || !message.content) return message.content ?? "";

  const parts: Exclude<UserContent, string> = [];
  for (const part of message.content) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image_url" && part.image_url?.url) {
      // Both a data: URL and an http one; the SDK handles the download.
      parts.push({ type: "image", image: new URL(part.image_url.url) });
    }
  }
  return parts.length > 0 ? parts : "";
}

/**
 * OpenAI messages in, `ModelMessage[]` out, with `system` lifted off.
 *
 * The system prompt is separated because the AI SDK takes it as its own
 * parameter and because Anthropic requires it that way on the wire — a system
 * message left in the array would be sent as a user turn to Claude.
 *
 * Several leading system messages are joined rather than the last one winning:
 * clients that append their own preamble to a user's do so expecting both to
 * apply.
 */
export function toModelMessages(messages: OpenAiMessage[]): {
  system: string | undefined;
  messages: ModelMessage[];
} {
  const system: string[] = [];
  const out: ModelMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      // `developer` is the newer spelling of `system`; both mean the same here.
      case "system":
      case "developer": {
        const text = typeof message.content === "string" ? message.content : "";
        if (text) system.push(text);
        break;
      }

      case "user":
        out.push({ role: "user", content: userContent(message) as UserContent });
        break;

      case "assistant": {
        const content: Exclude<AssistantContent, string> = [];
        const text = typeof message.content === "string" ? message.content : "";
        if (text) content.push({ type: "text", text });

        for (const call of message.tool_calls ?? []) {
          content.push({
            type: "tool-call",
            toolCallId: call.id ?? "",
            toolName: call.function?.name ?? "",
            input: parseArguments(call.function?.arguments),
          });
        }

        out.push({ role: "assistant", content: content.length > 0 ? content : text });
        break;
      }

      case "tool": {
        const text = typeof message.content === "string" ? message.content : "";
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.tool_call_id ?? "",
              toolName: message.name ?? "",
              // `json` where it parses, `text` where it does not. A tool that
              // returned prose should not be presented to the model as a
              // string containing a broken JSON document.
              output: jsonOrText(text),
            },
          ],
        });
        break;
      }

      default:
        break;
    }
  }

  return { system: system.length > 0 ? system.join("\n\n") : undefined, messages: out };
}

/**
 * A tool result as the model should see it.
 *
 * `json` where the text parses and `text` where it does not, because a tool
 * that returned prose should not be handed to the model as a string containing
 * a broken JSON document — and one that returned structured data should not be
 * flattened into a quoted blob.
 */
function jsonOrText(text: string): ToolResultOutput {
  try {
    return { type: "json", value: JSON.parse(text) as JSONValue };
  } catch {
    return { type: "text", value: text };
  }
}

function toolChoice(choice: OpenAiBody["tool_choice"]): GatewayRequest["toolChoice"] {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    if (choice === "auto" || choice === "none" || choice === "required") return choice;
    return undefined;
  }
  return choice.function?.name ? { name: choice.function.name } : undefined;
}

/** The whole request, normalised. */
export function readOpenAiRequest(body: OpenAiBody): GatewayRequest {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpError(400, "`messages` is required and must not be empty.");
  }

  const { system, messages } = toModelMessages(body.messages);

  const tools: DeclaredTool[] = (body.tools ?? [])
    .filter((item) => item.function?.name)
    .map((item) => ({
      name: item.function!.name!,
      description: item.function!.description,
      parameters: item.function!.parameters,
    }));

  return {
    model: body.model ?? "",
    system,
    messages,
    tools,
    toolChoice: toolChoice(body.tool_choice),
    maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    stopSequences: typeof body.stop === "string" ? [body.stop] : body.stop,
  };
}

/** OpenAI's finish reasons, which are not quite the SDK's. */
export function finishReason(reason: string, hadToolCall: boolean): string {
  if (hadToolCall) return "tool_calls";
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content-filter":
      return "content_filter";
    case "tool-calls":
      return "tool_calls";
    default:
      return "stop";
  }
}

export function completionId(): string {
  return `chatcmpl-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
