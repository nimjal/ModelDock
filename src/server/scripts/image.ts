/**
 * A script, as an AI SDK image model.
 *
 * The twin of `language.ts`, and much smaller, because drawing has no stream and
 * no tools: a prompt goes in and pictures come out. What a script returns is
 * read generously — base64, a `data:` URL, an `https:` link or raw bytes — since
 * image APIs disagree about all four, and making every script convert would move
 * the same few lines into every script.
 *
 * Links are fetched here, through the same `ctx.request` a script uses, so a
 * provider that answers with a short-lived URL still produces an image stored
 * in the conversation rather than one that stops loading next week. See
 * `images/tools.ts` for why generated images are kept inline.
 */

import type {
  ImageModelV4,
  ImageModelV4CallOptions,
  ImageModelV4File,
  ImageModelV4Result,
} from "@ai-sdk/provider";

import {
  ScriptError,
  annotate,
  loadScript,
  preview,
  scriptContext,
  type ScriptContext,
} from "./runtime.js";
import type { ScriptModelSettings } from "./language.js";

/** An image handed to `image()` to edit or vary. Base64 in `data`, or a link. */
export interface ScriptImageFile {
  mediaType?: string;
  data?: string;
  url?: string;
}

/** Everything `image()` is given. */
export interface ScriptImageRequest {
  model: string;
  prompt: string;
  n: number;
  /** `{width}x{height}`, when one was asked for. */
  size: string | undefined;
  /** `{width}:{height}`, when one was asked for. */
  aspectRatio: string | undefined;
  seed: number | undefined;
  files: ScriptImageFile[];
  mask: ScriptImageFile | undefined;
}

function fileOf(input: ImageModelV4File): ScriptImageFile {
  if (input.type === "url") return { url: input.url };
  return {
    mediaType: input.mediaType,
    data: typeof input.data === "string" ? input.data : Buffer.from(input.data).toString("base64"),
  };
}

/** One returned picture, as base64, whichever of the accepted forms it came in. */
async function base64Of(item: unknown, ctx: ScriptContext, who: string): Promise<string> {
  if (typeof item === "string") {
    const text = item.trim();

    if (text.startsWith("data:")) {
      const comma = text.indexOf(",");
      if (comma === -1)
        throw new ScriptError(`${who}'s image() returned a data: URL with no data in it.`);
      const header = text.slice(5, comma);
      const body = text.slice(comma + 1);
      return header.endsWith(";base64")
        ? body
        : Buffer.from(decodeURIComponent(body)).toString("base64");
    }

    if (/^https?:\/\//i.test(text)) {
      const response = await ctx.request(text);
      return Buffer.from(await response.arrayBuffer()).toString("base64");
    }

    if (text) return text.replace(/\s+/g, "");
  }

  if (item instanceof Uint8Array || item instanceof ArrayBuffer) {
    return Buffer.from(item instanceof ArrayBuffer ? new Uint8Array(item) : item).toString(
      "base64",
    );
  }

  if (typeof item === "object" && item !== null) {
    const record = item as Record<string, unknown>;
    const inner = record.base64 ?? record.url ?? record.data;
    if (inner !== undefined) return base64Of(inner, ctx, who);
  }

  throw new ScriptError(
    `${who}'s image() returned ${preview(item)}, which is not an image. Return base64, a data: or https: URL, or bytes — or a list of them.`,
  );
}

export class ScriptImageModel implements ImageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "script";
  readonly modelId: string;

  /**
   * Asked of the script, which may export `maxImagesPerCall`. Undefined means
   * one, and the SDK makes as many calls as it needs — so a script that ignores
   * `n` still returns the number of pictures that was asked for.
   */
  readonly maxImagesPerCall: () => Promise<number | undefined>;

  private readonly settings: ScriptModelSettings;

  constructor(settings: ScriptModelSettings) {
    this.settings = settings;
    this.modelId = settings.modelId;

    this.maxImagesPerCall = async () => {
      try {
        const declared = (await loadScript(settings)).maxImagesPerCall;
        return typeof declared === "number" && Number.isInteger(declared) && declared > 0
          ? declared
          : undefined;
      } catch {
        // A script that does not load says so from doGenerate, with the sentence
        // that belongs to the failure rather than to this question.
        return undefined;
      }
    };
  }

  async doGenerate(options: ImageModelV4CallOptions): Promise<ImageModelV4Result> {
    const { name, baseUrl, apiKey } = this.settings;
    const module = await loadScript(this.settings);

    if (typeof module.image !== "function") {
      throw new ScriptError(`${name}'s script has no image() export, so it cannot draw.`);
    }

    const ctx = scriptContext({
      name,
      model: this.modelId,
      baseUrl,
      apiKey,
      signal: options.abortSignal,
    });

    const request: ScriptImageRequest = {
      model: this.modelId,
      prompt: options.prompt ?? "",
      n: options.n,
      size: options.size,
      aspectRatio: options.aspectRatio,
      seed: options.seed,
      files: (options.files ?? []).map(fileOf),
      mask: options.mask ? fileOf(options.mask) : undefined,
    };

    let result: unknown;
    try {
      result = await module.image(request, ctx);
    } catch (error) {
      throw annotate(error);
    }

    const items = Array.isArray(result)
      ? result
      : result === null || result === undefined
        ? []
        : [result];
    const images = await Promise.all(items.map((item) => base64Of(item, ctx, name)));

    if (images.length === 0) throw new ScriptError(`${name}'s image() returned no images.`);

    return {
      images,
      warnings: [],
      response: { timestamp: new Date(), modelId: this.modelId, headers: undefined },
    };
  }
}
