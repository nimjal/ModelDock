/**
 * The part of a gateway request that is the same in both protocols.
 *
 * `openai.ts` and `anthropic.ts` differ only in how a request is spelled and
 * how a response is framed. Everything between those two points — finding the
 * connection, resolving the model, declaring the caller's tools, running the
 * turn — is one thing, and it lives here so the two wire formats cannot drift
 * into two slightly different products.
 *
 * ## Tools are declared, never executed
 *
 * This is the single most important property of the gateway and worth stating
 * plainly. A caller like Claude Code or OpenCode owns its own agentic loop: it
 * sends its tool definitions, expects to be told which one to call, runs it
 * *itself* in its own sandbox with its own permissions, and sends the result
 * back on the next request. ModelDock is a model endpoint in the middle of that
 * loop, not a participant in it.
 *
 * So every tool declared here is `inputSchema` and nothing else — no `execute`.
 * The SDK's own behaviour then does the right thing: a tool with no executor
 * ends the step and surfaces the call. `stopWhen` is left at its default of one
 * step for the same reason. If ModelDock ever ran a caller's tool on its
 * behalf, it would be running someone else's agent's file writes with no
 * permission level and no approval — the exact thing `code/permissions.ts`
 * exists to prevent.
 */

import {
  jsonSchema,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";

import type { Connection } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { ConnectionError, resolveModel } from "../providers/registry.js";
import { resolveGatewayModel, type GatewayCatalog } from "./catalog.js";

/** A tool as either protocol describes it, once the spelling is normalised. */
export interface DeclaredTool {
  name: string;
  description?: string;
  /** JSON Schema, passed through untouched. */
  parameters: unknown;
}

export interface GatewayRequest {
  model: string;
  system?: string;
  messages: ModelMessage[];
  tools?: DeclaredTool[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  signal?: AbortSignal;
}

/**
 * Caller's tool definitions in, an AI SDK tool set out.
 *
 * `jsonSchema()` wraps the schema without validating it against a Zod shape,
 * which is exactly right here: the schema came from another program and is that
 * program's business. Rejecting one this file did not understand would break a
 * client over a disagreement about JSON Schema drafts.
 */
function declare(tools: DeclaredTool[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;

  const set: ToolSet = {};
  for (const item of tools) {
    if (!item.name) continue;
    set[item.name] = tool({
      description: item.description,
      // An absent or malformed schema becomes "an object with anything in it"
      // rather than a 400. Some clients send no parameters for a no-arg tool.
      inputSchema: jsonSchema(
        (item.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
      ),
      // Deliberately no `execute`. See the note at the top of this file.
    });
  }
  return Object.keys(set).length > 0 ? set : undefined;
}

/** Both protocols spell tool choice differently; the SDK spells it once. */
function choose(choice: GatewayRequest["toolChoice"]) {
  if (!choice) return undefined;
  if (typeof choice === "object") return { type: "tool" as const, toolName: choice.name };
  return choice;
}

export interface Resolved {
  connection: Connection;
  /** The provider's own model id, with the namespace stripped. */
  model: string;
}

/**
 * Turn `<connection>/<model>` into something runnable, or fail readably.
 *
 * The 404 lists what is actually available, because the alternative is a client
 * reporting "model not found" for a name that differs from a real one by a
 * hyphen, and no way to see the real one without leaving the tool.
 */
export function resolveRequest(rows: Connection[], id: string, catalog?: GatewayCatalog): Resolved {
  if (!id) throw new HttpError(400, "No model was named in the request.");

  const found = resolveGatewayModel(rows, id);
  if (found) return { connection: found.connection, model: found.model };

  const known = catalog?.models
    .slice(0, 8)
    .map((model) => model.id)
    .join(", ");

  throw new HttpError(
    404,
    `No model "${id}" on this ModelDock. Models are named <connection>/<model>${
      known ? ` — for example ${known}` : ""
    }. Ask GET /v1/models for the full list.`,
  );
}

/**
 * Run one turn.
 *
 * The result's `fullStream` is what both protocol adapters read; neither takes
 * the SDK's UI-message stream, because both are producing a vendor's wire
 * format rather than this app's own transcript.
 */
export function runGateway(connection: Connection, request: GatewayRequest) {
  let model: LanguageModel;
  try {
    model = resolveModel(connection, request.model);
  } catch (error) {
    // The provider's own sentence, which usually names the environment
    // variable to set — far more useful in a terminal than a 500.
    if (error instanceof ConnectionError) throw new HttpError(400, error.message);
    throw error;
  }

  return streamText({
    model,
    system: request.system,
    messages: request.messages,
    tools: declare(request.tools),
    toolChoice: choose(request.toolChoice),
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature,
    topP: request.topP,
    stopSequences: request.stopSequences,
    abortSignal: request.signal,
  });
}

/** SSE framing, used by both adapters. */
export function sse(event: string | null, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return event ? `event: ${event}\ndata: ${payload}\n\n` : `data: ${payload}\n\n`;
}

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Nothing here is proxied today, but a gateway that gets put behind one and
  // then buffers is a very confusing failure.
  "x-accel-buffering": "no",
} as const;
