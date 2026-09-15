/**
 * A stored connection becomes a live model here, and nowhere else.
 *
 * Every surface in ModelDock — chat now, code and cowork later — goes through
 * `resolveModel`, so "swap the provider" is one row change with no code path
 * that knows or cares which vendor answered. That is the whole anti-lock-in
 * claim, expressed as a single function.
 *
 * Keys are read from the environment at call time. They are never stored on
 * the connection row, never logged, and never returned to the browser; the
 * database holds the *name* of a variable, not its value.
 *
 * A `script` connection is the one arm that is not a vendor. It still returns a
 * `LanguageModel` — `scripts/language.ts` wraps the module in the SDK's own
 * interface — so nothing downstream of this function has to know it exists.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import type { Connection } from "../db/schema.js";
import { ScriptLanguageModel } from "../scripts/language.js";
import { KINDS } from "./catalog.js";

export class ConnectionError extends Error {}

/**
 * What a script connection with no script says.
 *
 * Worded for the case it usually is: a row that arrived from another device,
 * where the script deliberately did not follow it. See `sync/tables.ts`.
 */
export function noScript(name: string): string {
  return `"${name}" has no script on this machine. Scripts never sync between devices — open it under Connections to add one here.`;
}

/** The API key for a connection, or null when the kind does not need one. */
export function resolveApiKey(
  connection: Pick<Connection, "kind" | "apiKeyEnv" | "name">,
): string | null {
  const spec = KINDS[connection.kind];
  if (!connection.apiKeyEnv) {
    if (spec?.requiresApiKey) {
      throw new ConnectionError(
        `Connection "${connection.name}" has no API key variable set. ${spec.label} needs one.`,
      );
    }
    return null;
  }

  const value = process.env[connection.apiKeyEnv];
  if (!value) {
    // A kind that needs no key can still be given one. For most kinds that is
    // optional, but a script names a variable only because it uses one — see
    // `namedKeyRequired` in the catalog.
    if (spec?.requiresApiKey || spec?.namedKeyRequired) {
      throw new ConnectionError(
        `${connection.apiKeyEnv} is not set in this environment, so "${connection.name}" cannot be used yet.`,
      );
    }
    return null;
  }
  return value;
}

/**
 * Everything that has to be true before a connection can answer a turn.
 *
 * Synchronous, so for a script it checks that there *is* one and no more.
 * Whether it loads is asynchronous and asked separately — by the Connections
 * screen, `doctor` and the gateway — through `inspectScript`.
 */
export function checkConnection(connection: Connection): { ok: boolean; problem?: string } {
  if (connection.kind === "script" && !connection.script?.trim()) {
    return { ok: false, problem: noScript(connection.name) };
  }

  try {
    resolveApiKey(connection);
  } catch (error) {
    return { ok: false, problem: (error as Error).message };
  }

  const spec = KINDS[connection.kind];
  if (spec?.baseUrlRequired && !connection.baseUrl) {
    return { ok: false, problem: `"${connection.name}" needs a base URL.` };
  }
  if (!connection.model) {
    return { ok: false, problem: `"${connection.name}" has no model set.` };
  }
  return { ok: true };
}

/**
 * Connection row in, language model out.
 *
 * `modelOverride` is how the model picker changes model without changing
 * provider — the connection stays put and only the model id moves.
 */
export function resolveModel(connection: Connection, modelOverride?: string | null): LanguageModel {
  const apiKey = resolveApiKey(connection);
  const model = modelOverride?.trim() || connection.model;

  if (!model) {
    throw new ConnectionError(`Connection "${connection.name}" has no model set.`);
  }

  switch (connection.kind) {
    case "anthropic":
      return createAnthropic({ apiKey: apiKey ?? undefined })(model);

    case "openai":
      return createOpenAI({ apiKey: apiKey ?? undefined })(model);

    case "google":
      return createGoogleGenerativeAI({ apiKey: apiKey ?? undefined })(model);

    case "ollama":
    case "openai_compatible": {
      const baseURL = connection.baseUrl?.trim();
      if (!baseURL) {
        throw new ConnectionError(
          `Connection "${connection.name}" needs a base URL before it can be used.`,
        );
      }
      return createOpenAICompatible({
        name: connection.name,
        baseURL,
        // Some local servers reject a bearer token they never asked for, so
        // an absent key stays absent rather than becoming an empty string.
        ...(apiKey ? { apiKey } : {}),
      })(model);
    }

    case "script": {
      // Only emptiness is checked here. Whether the script parses is found out
      // when it is first called, because loading is asynchronous and this
      // function is not — and the Connections screen has said so already.
      if (!connection.script?.trim()) throw new ConnectionError(noScript(connection.name));
      return new ScriptLanguageModel({
        name: connection.name,
        script: connection.script,
        baseUrl: connection.baseUrl,
        apiKey,
        modelId: model,
      });
    }

    default: {
      // Exhaustive: a new kind added to the schema will fail to compile here
      // until it is handled above.
      const unreachable: never = connection.kind;
      throw new ConnectionError(`Unknown connection kind: ${String(unreachable)}`);
    }
  }
}
