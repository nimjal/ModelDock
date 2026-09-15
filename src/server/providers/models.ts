/**
 * Asking a provider what it can actually run.
 *
 * A hard-coded list of model ids goes stale the week after it is written, and
 * the failure is invisible until someone sends a message and gets a 404 from a
 * vendor. Every provider ModelDock speaks to publishes its own list, so the
 * picker asks — the key is already there, and the endpoint is authoritative in
 * a way this repository never will be.
 *
 * Deliberately *not* the AI SDK. The SDK's job is turning a model id into a
 * `LanguageModel`, and it has no listing surface because listing is not part of
 * any inference protocol — it is four unrelated REST endpoints that happen to
 * be adjacent. Reaching for them directly here keeps `registry.ts` a pure
 * mapping and keeps this file honest about being glue.
 *
 * A script lists through its own `models()` export, when it has one. That is
 * the fifth shape, and the only one this file does not know the wire format of.
 *
 * **Nothing is hidden.** Every id the endpoint returns is passed on, with
 * `chat` and `image` marking what it looks like. A picker that silently dropped
 * a model would be indistinguishable from a provider that never had it, and the
 * flags are a guess about naming — so the guess is something the screen can
 * ignore, not a deletion.
 */

import { annotate, loadScript, preview, scriptContext } from "../scripts/runtime.js";
import type { ConnectionKind } from "./catalog.js";
import { ConnectionError } from "./registry.js";

export interface ModelInfo {
  id: string;
  /** The provider's own display name, when it gives one. */
  label: string | null;
  /**
   * Whether this looks like a conversational model.
   *
   * A guess everywhere except Google, which says so outright, and scripts that
   * say. The chat picker shows these first and keeps the rest behind a toggle.
   */
  chat: boolean;
  /**
   * Whether this looks like something that draws. The same kind of guess, for
   * the image picker, which shows these first.
   */
  image: boolean;
}

/** Long enough for a cold endpoint, short enough that a wrong URL fails visibly. */
const TIMEOUT_MS = 15_000;

/** Base URLs for the kinds that do not carry one on the row. */
const ANTHROPIC_BASE = "https://api.anthropic.com/v1";
const OPENAI_BASE = "https://api.openai.com/v1";
const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Ids that name something other than a chat model.
 *
 * Matched on the id because that is all an OpenAI-shaped `/models` response
 * carries — it reports no modality. Being wrong here costs a model one section
 * in a list, which is why a guess is acceptable at all.
 */
const NOT_CHAT =
  /(^|[-_/])(embed|embedding|embeddings|whisper|tts|moderation|rerank|reranker|dall-e|dalle|sora|clip|stable-diffusion|sdxl|flux|imagen|veo|transcribe|speech|audio|image|vision-encoder|guard|bge|gte|e5)([-_.]|$)/i;

/**
 * Ids that name an image model.
 *
 * Narrower than `NOT_CHAT` on purpose. Being wrong there demotes a model; being
 * wrong here would put a chat model at the top of a list of things that draw.
 */
const DRAWS =
  /(^|[-_/.])(dall-e|dalle|gpt-image|imagen|image|flux|sdxl|stable-diffusion|sd3|recraft|ideogram)([-_.:/]|\d|$)/i;

function looksConversational(id: string): boolean {
  return !NOT_CHAT.test(id);
}

function looksLikeImage(id: string): boolean {
  return DRAWS.test(id);
}

export interface ListTarget {
  kind: ConnectionKind;
  baseUrl?: string | null;
  apiKey?: string | null;
  /** Only used in messages, so a failure names the thing the person clicked. */
  label?: string;
  /** The module source, for a script connection. */
  script?: string | null;
}

/** Trailing slashes are common in a pasted base URL and break path joins. */
function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * One fetch, with the failure modes turned into sentences.
 *
 * Every message here names both what went wrong and where to fix it, because
 * this call is usually someone's first minute in the app and "Failed to fetch"
 * is not a diagnosis.
 */
async function get(url: string, headers: Record<string, string>, who: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const reason =
      (error as Error).name === "TimeoutError" ? "did not answer in time" : "could not be reached";
    throw new ConnectionError(`${who} ${reason}. Check the base URL and that you are online.`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new ConnectionError(`${who} rejected that key.`);
  }
  if (response.status === 404) {
    throw new ConnectionError(
      `${who} has no model list at ${url}. The base URL may be missing its /v1, or this endpoint may not publish one — enter a model name instead.`,
    );
  }
  if (!response.ok) {
    throw new ConnectionError(`${who} answered ${response.status} when asked for its models.`);
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ConnectionError(
      `${who} answered with something that is not JSON. Is that base URL right?`,
    );
  }
}

/** The OpenAI `/models` shape, which every vendor kind here uses except Google. */
interface OpenAiList {
  data?: { id?: unknown; display_name?: unknown }[];
}

function fromOpenAiShape(payload: unknown, who: string): ModelInfo[] {
  const rows = (payload as OpenAiList)?.data;
  if (!Array.isArray(rows)) {
    throw new ConnectionError(`${who} answered in a shape ModelDock did not recognise.`);
  }

  return rows
    .map((row) => (typeof row?.id === "string" ? row.id : null))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id, label: null, chat: looksConversational(id), image: looksLikeImage(id) }));
}

/**
 * Anthropic pages its list, so it is followed to the end.
 *
 * Twenty pages is a ceiling rather than an expectation — it exists so a
 * misbehaving `has_more` cannot spin here forever.
 */
async function listAnthropic(apiKey: string): Promise<ModelInfo[]> {
  const headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  const models: ModelInfo[] = [];
  let after: string | null = null;

  for (let page = 0; page < 20; page++) {
    const url = `${ANTHROPIC_BASE}/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
    const payload = (await get(url, headers, "Anthropic")) as {
      data?: { id?: unknown; display_name?: unknown }[];
      has_more?: unknown;
      last_id?: unknown;
    };

    for (const row of payload.data ?? []) {
      if (typeof row?.id !== "string") continue;
      models.push({
        id: row.id,
        label: typeof row.display_name === "string" ? row.display_name : null,
        chat: true,
        image: false,
      });
    }

    if (payload.has_more !== true || typeof payload.last_id !== "string") break;
    after = payload.last_id;
  }

  return models;
}

/**
 * Google names models `models/gemini-…` and says outright which ones can hold a
 * conversation, so this is the one kind where `chat` is reported rather than
 * guessed. Imagen is the models that `predict`.
 */
async function listGoogle(apiKey: string): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  let token: string | null = null;

  for (let page = 0; page < 20; page++) {
    const url = `${GOOGLE_BASE}/models?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
    // The key rides in a header rather than the query string, so it cannot end
    // up in a proxy log or a redirect's Referer.
    const payload = (await get(url, { "x-goog-api-key": apiKey }, "Google")) as {
      models?: { name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }[];
      nextPageToken?: unknown;
    };

    for (const row of payload.models ?? []) {
      if (typeof row?.name !== "string") continue;
      const methods = Array.isArray(row.supportedGenerationMethods)
        ? row.supportedGenerationMethods
        : [];
      const id = row.name.replace(/^models\//, "");
      models.push({
        id,
        label: typeof row.displayName === "string" ? row.displayName : null,
        chat: methods.includes("generateContent"),
        image: methods.includes("predict") || looksLikeImage(id),
      });
    }

    if (typeof payload.nextPageToken !== "string" || !payload.nextPageToken) break;
    token = payload.nextPageToken;
  }

  return models;
}

/**
 * A script's own list, from its `models()` export.
 *
 * Entries can be bare ids or `{ id, label, chat, image }`, and whatever a script
 * leaves out is guessed from the id, the same as for an OpenAI-shaped list. An
 * entry that is neither is skipped rather than failing the whole list — one odd
 * entry should not cost someone the other forty.
 *
 * Raced against the timeout as well as handed a signal, because a script is
 * free to ignore the signal, and a listing that never answers is a picker that
 * never stops saying "Asking…".
 */
async function listScript(target: ListTarget, who: string): Promise<ModelInfo[]> {
  const module = await loadScript({ name: who, script: target.script });

  if (typeof module.models !== "function") {
    throw new ConnectionError(
      `${who}'s script has no models() export, so there is no list to fetch — enter a model name instead.`,
    );
  }

  const ctx = scriptContext({
    name: who,
    model: "",
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ConnectionError(`${who}'s models() did not answer in time.`)),
      TIMEOUT_MS,
    );
  });

  let listed: unknown;
  try {
    listed = await Promise.race([Promise.resolve(module.models(ctx)), late]);
  } catch (error) {
    throw annotate(error);
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(listed)) {
    throw new ConnectionError(`${who}'s models() returned ${preview(listed)} rather than a list.`);
  }

  return listed.flatMap((entry): ModelInfo[] => {
    if (typeof entry === "string") {
      return entry
        ? [
            {
              id: entry,
              label: null,
              chat: looksConversational(entry),
              image: looksLikeImage(entry),
            },
          ]
        : [];
    }
    if (typeof entry !== "object" || entry === null) return [];

    const { id, label, chat, image } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id) return [];

    return [
      {
        id,
        label: typeof label === "string" && label ? label : null,
        chat: typeof chat === "boolean" ? chat : looksConversational(id),
        image: typeof image === "boolean" ? image : looksLikeImage(id),
      },
    ];
  });
}

/**
 * What can this connection run right now?
 *
 * Sorted so the conversational ones come first and each group is alphabetical —
 * the order an endpoint returns is arbitrary and often insertion order, which
 * reads as random.
 */
export async function listModels(target: ListTarget): Promise<ModelInfo[]> {
  const who = target.label?.trim() || "That endpoint";
  const key = target.apiKey?.trim();

  let models: ModelInfo[];

  switch (target.kind) {
    case "anthropic": {
      if (!key) throw new ConnectionError("Anthropic needs a key before it can list its models.");
      models = await listAnthropic(key);
      break;
    }

    case "google": {
      if (!key) throw new ConnectionError("Google needs a key before it can list its models.");
      models = await listGoogle(key);
      break;
    }

    case "openai": {
      if (!key) throw new ConnectionError("OpenAI needs a key before it can list its models.");
      models = fromOpenAiShape(
        await get(`${OPENAI_BASE}/models`, { authorization: `Bearer ${key}` }, "OpenAI"),
        "OpenAI",
      );
      break;
    }

    case "ollama":
    case "openai_compatible": {
      const base = target.baseUrl?.trim();
      if (!base)
        throw new ConnectionError(`${who} needs a base URL before it can list its models.`);
      // Absent rather than empty: a local server that never asked for a token
      // can reject one it did not expect.
      const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
      models = fromOpenAiShape(await get(`${trimUrl(base)}/models`, headers, who), who);
      break;
    }

    case "script": {
      models = await listScript({ ...target, apiKey: key }, who);
      break;
    }

    default: {
      const unreachable: never = target.kind;
      throw new ConnectionError(`Unknown connection kind: ${String(unreachable)}`);
    }
  }

  return models.sort((a, b) => {
    if (a.chat !== b.chat) return a.chat ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}
