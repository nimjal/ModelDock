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
 * **Nothing is hidden.** Every id the endpoint returns is passed on, with
 * `chat` marking whether it looks like something you can hold a conversation
 * with. A picker that silently dropped a model would be indistinguishable from
 * a provider that never had it, and the filter is a guess about naming — so the
 * guess is a flag the screen can ignore, not a deletion.
 */

import type { ConnectionKind } from "./catalog.js";
import { ConnectionError } from "./registry.js";

export interface ModelInfo {
  id: string;
  /** The provider's own display name, when it gives one. */
  label: string | null;
  /**
   * Whether this looks like a conversational model.
   *
   * A guess everywhere except Google, which says so outright. The picker shows
   * these first and keeps the rest behind a toggle.
   */
  chat: boolean;
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

function looksConversational(id: string): boolean {
  return !NOT_CHAT.test(id);
}

export interface ListTarget {
  kind: ConnectionKind;
  baseUrl?: string | null;
  apiKey?: string | null;
  /** Only used in messages, so a failure names the thing the person clicked. */
  label?: string;
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

/** The OpenAI `/models` shape, which every kind here uses except Google. */
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
    .map((id) => ({ id, label: null, chat: looksConversational(id) }));
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
 * guessed.
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
      models.push({
        id: row.name.replace(/^models\//, ""),
        label: typeof row.displayName === "string" ? row.displayName : null,
        chat: methods.includes("generateContent"),
      });
    }

    if (typeof payload.nextPageToken !== "string" || !payload.nextPageToken) break;
    token = payload.nextPageToken;
  }

  return models;
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
