/**
 * Trying a script before it is saved.
 *
 * The editor's two buttons, and nothing else. `check` loads the module and
 * reports what it exports, or the syntax error and where it is. `try` sends one
 * short message through `chat()` using the same adapter a conversation uses, so
 * a script that works here works in a thread — and one that fails here fails
 * with the sentence the thread would have shown.
 *
 * Both run the code they are sent, which is the point of them. They sit behind
 * the same loopback and Origin checks as the rest of `/api` (see `app.ts`), and
 * they store nothing: a script reaches the database only through
 * `POST /connections`.
 */

import { streamText } from "ai";
import { Hono } from "hono";

import { resolveApiKey } from "../providers/registry.js";
import { ScriptLanguageModel } from "../scripts/language.js";
import { inspectScript } from "../scripts/runtime.js";

export const scriptRoutes = new Hono();

/** Long enough for a cold local model to load; short enough to notice a hang. */
const TRY_TIMEOUT_MS = 90_000;

interface Draft {
  script?: string;
  name?: string;
  baseUrl?: string | null;
  apiKeyEnv?: string | null;
  model?: string;
  prompt?: string;
}

const nameOf = (draft: Draft) => draft.name?.trim() || "This script";

scriptRoutes.post("/scripts/check", async (c) => {
  const draft = await c.req.json<Draft>();
  const inspection = await inspectScript({ name: nameOf(draft), script: draft.script ?? "" });
  return c.json({ inspection });
});

/**
 * One turn, reported whole.
 *
 * Always a 200 with `ok` in the body. A script that fails is this route working
 * — the failure *is* the answer — and the editor wants the partial reply and
 * the timing alongside it, which an error status would throw away.
 */
scriptRoutes.post("/scripts/try", async (c) => {
  const draft = await c.req.json<Draft>();
  const name = nameOf(draft);
  const started = Date.now();

  let apiKey: string | null;
  try {
    apiKey = resolveApiKey({ kind: "script", apiKeyEnv: draft.apiKeyEnv?.trim() || null, name });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message, ms: Date.now() - started });
  }

  const model = new ScriptLanguageModel({
    name,
    script: draft.script ?? "",
    baseUrl: draft.baseUrl?.trim() || null,
    apiKey,
    modelId: draft.model?.trim() ?? "",
  });

  let text = "";
  let reasoning = "";
  const toolCalls: { name: string; input: unknown }[] = [];
  let finishReason: string | null = null;
  let usage: { input: number | null; output: number | null } = { input: null, output: null };
  let failure: string | null = null;

  const describe = (error: unknown) => {
    if (error instanceof Error && error.name === "TimeoutError") {
      return `${name} did not finish within ${TRY_TIMEOUT_MS / 1000} seconds.`;
    }
    return error instanceof Error ? error.message : String(error);
  };

  try {
    const result = streamText({
      model,
      prompt: draft.prompt?.trim() || "Say hello in five words.",
      // A failure should come back as it happened, not after two retries.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(TRY_TIMEOUT_MS),
      // Reported in the response below rather than logged to the terminal.
      onError: () => undefined,
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          text += part.text;
          break;
        case "reasoning-delta":
          reasoning += part.text;
          break;
        case "tool-call":
          toolCalls.push({ name: part.toolName, input: part.input });
          break;
        case "finish":
          finishReason = part.finishReason;
          usage = {
            input: part.totalUsage.inputTokens ?? null,
            output: part.totalUsage.outputTokens ?? null,
          };
          break;
        case "error":
          failure = describe(part.error);
          break;
        default:
          break;
      }
    }
  } catch (error) {
    failure = describe(error);
  }

  return c.json({
    ok: failure === null,
    text,
    reasoning: reasoning || null,
    toolCalls,
    finishReason,
    usage,
    error: failure,
    ms: Date.now() - started,
  });
});
