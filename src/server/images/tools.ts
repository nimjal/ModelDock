/**
 * Letting the model draw.
 *
 * The tool is offered to whichever model is answering, and it dispatches to
 * whichever connection the workspace named for images — which are almost never
 * the same one. Anthropic publishes no image model, so "Claude, holding a
 * conversation, calling out to OpenAI or a local endpoint for a picture" is the
 * *normal* arrangement rather than a workaround. That indirection is the whole
 * feature: the model answering and the model drawing are two independent
 * columns, and neither locks in the other.
 *
 * Scope is closed over by the caller, exactly as in `memoryTools` and
 * `fileTools`: the engine is resolved once per turn and the model never gets to
 * name a provider, a key or an endpoint.
 *
 * ## Why `toModelOutput` is not optional here
 *
 * A generated image is one to three megabytes of base64. It has to reach two
 * places and must not reach a third:
 *
 *   - the stored message parts, so the transcript still shows it after a
 *     reload — that is `output`, which is what gets persisted and rendered;
 *   - the person, via `Message.tsx`, which reads that same part;
 *   - **not** the model's context window, which is what `toModelOutput`
 *     prevents. Without it the SDK sends the whole tool result back as JSON on
 *     the very next step, so a two-image conversation would push several
 *     megabytes of base64 through a context window on every subsequent turn —
 *     expensive, slow, and on most providers simply over the limit.
 *
 * The catch worth knowing: `toModelOutput` is applied by
 * `convertToModelMessages`, so **every caller rebuilding history from the store
 * has to pass this tool set to it**, not just to `streamText`. Miss that and
 * the base64 stays out of the loop within a turn and comes flooding back on the
 * next one, which is the kind of bug that only shows up on a long conversation.
 * `routes/chat.ts` and `code/builtin.ts` both do it; `tests/images.test.ts`
 * asserts it.
 */

import { generateImage, tool } from "ai";
import { z } from "zod";

import { ConnectionError } from "../providers/registry.js";
import type { ImageEngine } from "../workspace.js";
import { DEFAULT_SIZE, MAX_IMAGES, imageKindFor } from "./catalog.js";
import { resolveImageModel } from "./registry.js";

/** One generated image, as it is stored and as the page renders it. */
export interface GeneratedImage {
  /** A `data:` URL. Inline on purpose — see the note in `catalog.ts`. */
  url: string;
  mediaType: string;
}

export interface ImageToolResult {
  images?: GeneratedImage[];
  prompt?: string;
  model?: string;
  size?: string;
  error?: string;
}

export interface ImageToolContext {
  engine: ImageEngine;
}

/**
 * `{ size }` only when the provider takes free-form sizes.
 *
 * Google's Imagen rejects a `size` and wants an aspect ratio instead, so
 * passing one through would turn every call into a 400. The AI SDK exposes both
 * parameters and leaves the choice to the caller, so the choice is made here
 * rather than pushed onto the model as a parameter it would have to guess.
 */
function sizing(kind: string, size: string): { size?: `${number}x${number}` } {
  if (kind === "google") return {};
  return { size: size as `${number}x${number}` };
}

export function imageTools({ engine }: ImageToolContext) {
  const spec = imageKindFor(engine.connection.kind);

  return {
    generate_image: tool({
      description: [
        "Generate an image from a text description and show it to the person.",
        "Use it when they ask for a picture, a diagram, an illustration, a logo, a mockup or a visual variation of one.",
        "Describe the subject, the composition and the style in the prompt — the image model sees only this prompt and none of the conversation.",
        "The image is displayed automatically, so do not attempt to describe it back in detail afterwards.",
      ].join(" "),
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            "A full description of the image to make. Self-contained: the image model cannot see the conversation.",
          ),
        size: z
          .string()
          .describe(
            `Pixel size as {width}x{height}. Suggested: ${(spec?.sizes ?? [DEFAULT_SIZE]).join(", ")}.`,
          )
          .default(DEFAULT_SIZE),
        n: z
          .number()
          .int()
          .min(1)
          .max(MAX_IMAGES)
          .describe("How many variations to generate. Prefer 1 unless asked for options.")
          .default(1),
      }),

      execute: async ({ prompt, size, n }): Promise<ImageToolResult> => {
        try {
          const model = resolveImageModel(engine.connection, engine.model);

          const result = await generateImage({
            model,
            prompt,
            n,
            ...sizing(engine.connection.kind, size),
          });

          return {
            prompt,
            model: engine.model,
            size,
            images: result.images.map((image) => ({
              url: `data:${image.mediaType};base64,${image.base64}`,
              mediaType: image.mediaType,
            })),
          };
        } catch (error) {
          // Returned, not thrown, for the reason `files/tools.ts` sets out: a
          // thrown `execute` can end the turn, while a returned error lets the
          // model tell the person what went wrong and offer to try again.
          const message =
            error instanceof ConnectionError
              ? error.message
              : `Could not generate that image: ${(error as Error).message}`;
          return { error: message };
        }
      },

      /**
       * What the *model* sees. Never the bytes.
       *
       * Deliberately says the image is already displayed, because the most
       * common failure without that sentence is a model that assumes the tool
       * returned a link it now has to present, and writes a paragraph of
       * markdown pointing at a URL that does not exist.
       */
      toModelOutput: ({ output }) => {
        if (output.error) return { type: "text", value: output.error };

        const count = output.images?.length ?? 0;
        return {
          type: "text",
          value:
            count === 0
              ? "The image model returned nothing."
              : `Generated ${count} image${count === 1 ? "" : "s"} with ${output.model}${
                  output.size ? ` at ${output.size}` : ""
                }. ${count === 1 ? "It is" : "They are"} already shown to the person in this conversation — do not describe the contents back to them, just respond to what they asked.`,
        };
      },
    }),
  };
}
