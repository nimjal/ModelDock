/**
 * Which connection kinds can draw, and what each one calls its models.
 *
 * Pure metadata, exactly like `providers/catalog.ts` — no SDK is touched here,
 * so the UI and the resolver can both read it without pulling in a provider
 * package. The split is the same one that file explains, for the same reason.
 *
 * Not every kind appears, and that absence is the useful part. Anthropic has no
 * image model, so an Anthropic connection is simply not offered as somewhere to
 * generate images, and `KINDS` below is what the picker filters on. This is a
 * fact about the vendor rather than a limitation of ModelDock, and stating it as
 * data means the screen can say so instead of offering a choice that 404s.
 *
 * `suggestedModels` is a fallback, not a catalogue — the same rule
 * `providers/catalog.ts` sets out. Every endpoint here publishes its own list
 * and the picker asks; these matter only before a key exists to ask with.
 */

import type { ConnectionKind } from "../providers/catalog.js";

export interface ImageKindSpec {
  kind: ConnectionKind;
  /**
   * Used when the workspace names a connection but no model.
   *
   * Empty for the open-ended kinds: a local server serves whatever it was
   * started with, and guessing a model id for someone's own box would produce
   * a confident 404 rather than a useful default.
   */
  defaultModel: string;
  suggestedModels: string[];
  /** Sizes worth offering. `size` is passed straight to the provider. */
  sizes: string[];
  hint: string;
}

/**
 * The kinds that can generate an image.
 *
 * A partial record on purpose: `imageKindFor` returning undefined *is* the
 * answer to "can this connection draw", so a kind is either here with real
 * values or absent, and there is no third state where it is listed but marked
 * unsupported.
 */
export const IMAGE_KINDS: Partial<Record<ConnectionKind, ImageKindSpec>> = {
  openai: {
    kind: "openai",
    defaultModel: "gpt-image-1",
    suggestedModels: ["gpt-image-1", "gpt-image-1-mini", "dall-e-3"],
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    hint: "Uses the same OPENAI_API_KEY as your OpenAI chat connection.",
  },
  google: {
    kind: "google",
    defaultModel: "imagen-4.0-generate-001",
    suggestedModels: [
      "imagen-4.0-generate-001",
      "imagen-4.0-fast-generate-001",
      "gemini-2.5-flash-image",
    ],
    sizes: ["1024x1024", "1408x768", "768x1408"],
    hint: "Uses the same GOOGLE_GENERATIVE_AI_API_KEY as your Gemini chat connection.",
  },
  /**
   * Ollama is OpenAI-shaped and reaches the same code path, but it is listed
   * separately because the sentence someone needs is different: most Ollama
   * builds serve no image endpoint at all, and being told that here is better
   * than being told it by a 404 after typing a prompt.
   */
  ollama: {
    kind: "ollama",
    defaultModel: "",
    suggestedModels: [],
    sizes: ["512x512", "1024x1024"],
    hint: "Only if your local server exposes /v1/images/generations — most Ollama builds do not.",
  },
  openai_compatible: {
    kind: "openai_compatible",
    defaultModel: "",
    suggestedModels: [],
    sizes: ["512x512", "1024x1024", "1024x1536"],
    hint: "Any endpoint with /v1/images/generations — LocalAI, ComfyUI behind a shim, a proxy, your own server.",
  },
};

export const IMAGE_KIND_LIST: ImageKindSpec[] = Object.values(IMAGE_KINDS);

/** The spec for a kind, or undefined when that kind cannot generate images. */
export function imageKindFor(kind: string): ImageKindSpec | undefined {
  return IMAGE_KINDS[kind as ConnectionKind];
}

/** Whether a connection of this kind can be offered as an image engine. */
export function canGenerateImages(kind: string): boolean {
  return Boolean(imageKindFor(kind));
}

/** What the tool asks for when the caller says nothing. */
export const DEFAULT_SIZE = "1024x1024";

/**
 * A ceiling on one call.
 *
 * Images are stored inline in `messages.parts` as data URLs, so every one of
 * them is bytes in the database *and* bytes in every sync push for the rest of
 * that row's life. Four at a time is a limit worth having for that reason
 * rather than for any provider's sake.
 */
export const MAX_IMAGES = 4;
