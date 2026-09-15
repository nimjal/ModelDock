/**
 * A stored connection becomes a live image model here, and nowhere else.
 *
 * The deliberate twin of `providers/registry.ts`: same shape, same exhaustive
 * switch, same rule that keys are read from the environment at call time and
 * never stored on the row. Keeping the two files parallel is what lets "which
 * provider draws" be a column change in the same way "which provider answers"
 * already is.
 *
 * The one place they differ is the `anthropic` arm, and it is worth being
 * explicit rather than clever about it: Anthropic publishes no image model, so
 * that case throws with a sentence saying what to do instead. It is not a gap
 * to be filled in later — the `default` arm's exhaustiveness check is what
 * makes a new connection kind fail to compile here until someone decides
 * whether it can draw, and folding Anthropic into that default would lose the
 * distinction between "cannot" and "not thought about yet".
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ImageModel } from "ai";

import type { Connection } from "../db/schema.js";
import { ConnectionError, noScript, resolveApiKey } from "../providers/registry.js";
import { ScriptImageModel } from "../scripts/image.js";
import { imageKindFor } from "./catalog.js";

/**
 * Connection row in, image model out.
 *
 * `modelOverride` works exactly as it does for language models: the connection
 * stays put and only the model id moves, so someone can keep one OpenAI
 * connection and switch between `gpt-image-1` and `dall-e-3` on it.
 */
export function resolveImageModel(
  connection: Connection,
  modelOverride?: string | null,
): ImageModel {
  const spec = imageKindFor(connection.kind);

  // Capability first, before the key and before the model. A provider that has
  // no image model at all should say so — reporting a missing API key for
  // Anthropic would send someone off to find a key that was never the problem.
  if (!spec) {
    if (connection.kind === "anthropic") {
      throw new ConnectionError(
        "Anthropic does not offer an image model. Point image generation at OpenAI, Google, or a local endpoint — the model you chat with does not have to be the one that draws.",
      );
    }
    throw new ConnectionError(`${connection.name} cannot generate images.`);
  }

  // A script has no kind-wide default. `imageEngine` resolves one from the
  // module before it gets here; a caller that did not gets the connection's own
  // model, which for a script that only draws is the image model anyway.
  const model =
    modelOverride?.trim() ||
    spec.defaultModel ||
    (connection.kind === "script" ? connection.model : "");
  if (!model) {
    throw new ConnectionError(
      `"${connection.name}" has no image model set. Choose one in Settings under Image generation.`,
    );
  }

  const apiKey = resolveApiKey(connection);

  switch (connection.kind) {
    // Unreachable: the capability check above has already thrown for every kind
    // with no spec, and Anthropic is the only one. Kept so the `never` in the
    // default arm still makes a newly added kind fail to compile here.
    case "anthropic":
      throw new ConnectionError(
        "Anthropic does not offer an image model. Point image generation at OpenAI, Google, or a local endpoint — the model you chat with does not have to be the one that draws.",
      );

    case "openai":
      return createOpenAI({ apiKey: apiKey ?? undefined }).image(model);

    case "google":
      return createGoogleGenerativeAI({ apiKey: apiKey ?? undefined }).image(model);

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
        // Absent rather than empty, for the reason `providers/registry.ts`
        // gives: a local server can reject a bearer token it never asked for.
        ...(apiKey ? { apiKey } : {}),
      }).imageModel(model);
    }

    case "script": {
      // Whether the module actually exports `image()` is asked when it is
      // called, and reported in a sentence; see `scripts/image.ts`.
      if (!connection.script?.trim()) throw new ConnectionError(noScript(connection.name));
      return new ScriptImageModel({
        name: connection.name,
        script: connection.script,
        baseUrl: connection.baseUrl,
        apiKey,
        modelId: model,
      });
    }

    default: {
      // Exhaustive: a new kind added to the schema will fail to compile here
      // until someone decides whether it can draw.
      const unreachable: never = connection.kind;
      throw new ConnectionError(`Unknown connection kind: ${String(unreachable)}`);
    }
  }
}
