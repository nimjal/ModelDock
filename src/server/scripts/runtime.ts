/**
 * Custom engines: a connection whose behaviour is a script rather than a vendor.
 *
 * Every other kind in `providers/catalog.ts` is a wire protocol ModelDock already
 * speaks. This one is the escape hatch for everything else — a model server with
 * its own API, a research endpoint, a queue in front of a GPU, a vendor that
 * shipped last week — written as a small JavaScript module that ModelDock loads
 * and calls. `language.ts` and `image.ts` wrap that module in the AI SDK's own
 * model interfaces, so chat, the gateway, the built-in coding engine and
 * `generate_image` run a script exactly as they run a vendor, and none of them
 * learns that scripts exist.
 *
 * ## What a script is trusted with
 *
 * Everything this process has. It is imported into ModelDock itself, with full
 * Node — the filesystem, the network, `process.env`. That is deliberate, and it
 * is worth being plain about rather than dressing up: `node:vm` is not a
 * security boundary, and wrapping a script in one would be a promise this file
 * could not keep. A script is code the person wrote or pasted on their own
 * machine, in the same category as the wrapper command a coding agent row points
 * at, and it is protected in the same ways:
 *
 *   - it can only arrive through the loopback API, behind the Host and Origin
 *     checks in `app.ts`;
 *   - it **never syncs** (`sync/tables.ts`), in either direction, so pairing a
 *     device is never a way for that device to run code on this one.
 *
 * ## How it is loaded
 *
 * As an ES module from a `data:` URL, cached by content. No file is written, so
 * there is nothing to clean up and nothing another process could swap out
 * between writing and importing. Two consequences follow, and the editor states
 * both rather than leaving them to be discovered:
 *
 *   - A script can import Node's built-ins (`node:crypto`) but not files or
 *     packages. A `data:` module has no directory to resolve them from.
 *   - A module, once imported, stays in memory for the life of the process. Each
 *     distinct version of a script is a few kilobytes and is loaded only when it
 *     is checked or used, so an afternoon of editing costs less than one
 *     generated image in the database.
 *
 * A `sourceURL` comment is appended so a runtime error names
 * `modeldock-script/<name>.js:12` rather than a kilobyte of base64. V8 honours
 * it for stack frames but not for syntax errors, which is why `syntaxDetail`
 * exists.
 */

import type { ChildProcess } from "node:child_process";
import { hash } from "node:crypto";

import { APICallError } from "ai";

import { killTree, spawnCommand } from "../code/spawn.js";

/** A failure that is the script's, or the script's configuration's, with a sentence to show. */
export class ScriptError extends Error {}

/** An imported script. Every export is optional; `inspectScript` reports which exist. */
export interface ScriptModule {
  chat?: unknown;
  image?: unknown;
  models?: unknown;
  defaultImageModel?: unknown;
  maxImagesPerCall?: unknown;
}

export interface ScriptSource {
  /** The connection's name, used in messages and in stack traces. */
  name: string;
  script: string | null | undefined;
}

/** A value, short enough to put in a sentence. */
export function preview(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}…` : value);
  }
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json.length > 120 ? `${json.slice(0, 117)}…` : json;
  } catch {
    /* circular, or otherwise unserialisable — fall through to String */
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Every version of every script this process has imported, by content. */
const modules = new Map<string, Promise<ScriptModule>>();

/** What a stack frame calls the script. A slug, so no name can break the comment. */
function fileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `modeldock-script/${slug || "script"}.js`;
}

/**
 * Import a script, once per distinct version.
 *
 * A failure is cached along with successes. The same source fails the same way
 * every time, and the connection list asks on every refresh — re-running a
 * syntax check per refresh would be work with a known answer.
 */
export function loadScript(source: ScriptSource): Promise<ScriptModule> {
  const script = source.script ?? "";
  if (!script.trim()) {
    return Promise.reject(new ScriptError(`"${source.name}" has no script yet.`));
  }

  const file = fileName(source.name);
  const key = hash("sha256", `${file}\n${script}`);

  let loading = modules.get(key);
  if (!loading) {
    const url = `data:text/javascript;base64,${Buffer.from(`${script}\n//# sourceURL=${file}\n`).toString("base64")}`;
    loading = (import(/* @vite-ignore */ url) as Promise<ScriptModule>).catch(
      async (error: unknown) => {
        throw new ScriptError(await explain(error, script));
      },
    );
    modules.set(key, loading);
  }
  return loading;
}

/** The base64 of a `data:` URL is never something a person wants in a sentence. */
const clean = (message: string) =>
  message.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, "the script");

async function explain(error: unknown, script: string): Promise<string> {
  if (error instanceof SyntaxError) {
    return `The script does not parse. ${(await syntaxDetail(script)) ?? error.message}`;
  }

  const message = clean(error instanceof Error ? error.message : String(error));
  const code = (error as { code?: unknown } | null)?.code;

  if (
    code === "ERR_UNSUPPORTED_RESOLVE_REQUEST" ||
    code === "ERR_MODULE_NOT_FOUND" ||
    /resolve module specifier/i.test(message)
  ) {
    return `The script imports something it cannot reach: ${message}. A script can import Node's built-in modules, such as node:crypto, but not files or packages.`;
  }

  const line = scriptLine(error);
  return `The script failed while loading${line ? ` (line ${line})` : ""}: ${message}`;
}

/**
 * Where a syntax error is, with the line and a caret.
 *
 * `import()` reports only "Unexpected token '='", which in a forty-line editor
 * is a riddle. `node --check` parses without running anything and says where, so
 * on this one failure path — never on a script that loads — it is asked. Null
 * when it cannot say, and the bare message stands.
 */
function syntaxDetail(script: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child: ChildProcess;
    try {
      child = spawnCommand(process.execPath, ["--check", "--input-type=module"], {
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch {
      finish(null);
      return;
    }

    let stderr = "";
    const timer = setTimeout(() => {
      killTree(child);
      finish(null);
    }, 5_000);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(parseCheck(stderr));
    });
    child.stdin?.on("error", () => {
      /* it exited before reading everything, which `close` reports */
    });
    child.stdin?.end(script);
  });
}

function parseCheck(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/);
  const at = /^\[stdin\]:(\d+)$/.exec(lines[0] ?? "");
  const reason = lines.find((line) => line.startsWith("SyntaxError: "));
  if (!at || !reason) return null;

  const caret = /^\s*\^+\s*$/.test(lines[2] ?? "") ? [lines[2]!] : [];
  return [
    `Line ${at[1]}: ${reason.slice("SyntaxError: ".length)}`,
    "",
    lines[1] ?? "",
    ...caret,
  ].join("\n");
}

/**
 * The line of the script an error was thrown from, when its stack says.
 *
 * Frames name the `sourceURL` in plain Node, but a runtime that formats stacks
 * itself — a test runner, a source-map handler — can report the module's real
 * URL instead. Both are matched: nothing else in ModelDock is imported from a
 * `data:` URL, so a frame there is always a script's.
 */
export function scriptLine(error: unknown): number | null {
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  const match =
    /modeldock-script\/[^:\s)]*\.js:(\d+):\d+/.exec(stack) ??
    /data:text\/javascript;base64,[A-Za-z0-9+/=]+:(\d+):\d+/.exec(stack);
  return match ? Number(match[1]) : null;
}

const annotated = new WeakSet<Error>();

/**
 * An error thrown from inside a script, with the line it came from.
 *
 * A reply that fails with "Cannot read properties of undefined" and nothing
 * else sends someone hunting through every property access in their script.
 * Errors that already carry their own sentence — ModelDock's, an HTTP failure,
 * a cancellation — are passed through untouched.
 */
export function annotate(error: unknown): unknown {
  if (!(error instanceof Error)) return new ScriptError(`The script threw ${preview(error)}.`);

  if (
    error instanceof ScriptError ||
    APICallError.isInstance(error) ||
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    annotated.has(error)
  ) {
    return error;
  }

  const line = scriptLine(error);
  if (line !== null) {
    try {
      error.message = `${error.message} (line ${line} of the script)`;
    } catch {
      /* a frozen error keeps its own message */
    }
  }
  annotated.add(error);
  return error;
}

export interface ScriptInspection {
  chat: boolean;
  image: boolean;
  models: boolean;
  defaultImageModel: string | null;
  /** Why this script cannot be used at all, or null when it can. */
  problem: string | null;
}

/**
 * What a script offers, without calling any of it.
 *
 * Importing runs the module's top level, and nothing more. This is how the
 * connection list, the image picker and the gateway find out whether a given
 * script chats, draws or lists — the kind cannot know.
 */
export async function inspectScript(source: ScriptSource): Promise<ScriptInspection> {
  let module: ScriptModule;
  try {
    module = await loadScript(source);
  } catch (error) {
    return {
      chat: false,
      image: false,
      models: false,
      defaultImageModel: null,
      problem: (error as Error).message,
    };
  }

  const found = {
    chat: typeof module.chat === "function",
    image: typeof module.image === "function",
    models: typeof module.models === "function",
    defaultImageModel:
      typeof module.defaultImageModel === "string" && module.defaultImageModel.trim()
        ? module.defaultImageModel.trim()
        : null,
  };

  return {
    ...found,
    problem:
      found.chat || found.image
        ? null
        : "The script exports neither chat() nor image(), so there is nothing for ModelDock to call.",
  };
}

// ---------------------------------------------------------------------------
// The `ctx` a script is handed
// ---------------------------------------------------------------------------

export interface ScriptRequestInit extends Omit<RequestInit, "body"> {
  body?: RequestInit["body"];
  /** Sent as JSON, with the content type set. */
  json?: unknown;
}

export interface ServerSentEvent {
  event: string | null;
  data: string;
}

export interface ScriptContext {
  readonly name: string;
  readonly model: string;
  /** The connection's base URL with trailing slashes removed, or null. */
  readonly baseUrl: string | null;
  /** The value of the connection's key variable, read now, or null. */
  readonly apiKey: string | null;
  /** Aborts when the turn is stopped. Handed to `fetch` by `request` already. */
  readonly signal: AbortSignal;
  /** `fetch`, with a JSON shorthand and a readable error for any non-2xx answer. */
  request(url: string, init?: ScriptRequestInit): Promise<Response>;
  /** Each server-sent event in a streamed response. */
  sse(response: Response): AsyncGenerator<ServerSentEvent>;
  /** Each non-empty line of a newline-delimited response. */
  lines(response: Response): AsyncGenerator<string>;
}

export interface ContextInput {
  name: string;
  model: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  signal?: AbortSignal;
}

export function scriptContext(input: ContextInput): ScriptContext {
  const signal = input.signal ?? new AbortController().signal;

  return Object.freeze({
    name: input.name,
    model: input.model,
    baseUrl: input.baseUrl?.trim().replace(/\/+$/, "") || null,
    apiKey: input.apiKey || null,
    signal,
    request: (url: string, init?: ScriptRequestInit) => send(input.name, url, signal, init),
    sse,
    lines,
  });
}

/** Where a URL points, for a message. Never the path, which can carry a key. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** The useful sentence in an error body, whichever of the common shapes it has. */
function describeBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const nested = record.error;
      const candidates = [
        typeof nested === "string" ? nested : (nested as { message?: unknown } | null)?.message,
        record.message,
        record.detail,
      ];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      }
    }
  } catch {
    /* not JSON, so it is shown as text */
  }

  const flat = trimmed.replace(/\s+/g, " ");
  return flat.length > 300 ? `${flat.slice(0, 297)}…` : flat;
}

/**
 * `ctx.request`.
 *
 * A refused request becomes an `APICallError`, the SDK's own type, with the
 * status on it. That is not decoration: it is what lets `streamText` retry a
 * script's 429 or 503 the way it retries a vendor's, and what makes the message
 * someone sees name the service and quote what it said.
 */
async function send(
  who: string,
  url: string,
  signal: AbortSignal,
  init: ScriptRequestInit = {},
): Promise<Response> {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new ScriptError(
      `${who} tried to call ${preview(url)}, which is not a full http(s) address. Is the base URL set on this connection?`,
    );
  }

  const { json, headers, body, signal: own, ...rest } = init;
  const merged = new Headers(headers);
  let payload = body;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    if (!merged.has("content-type")) merged.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: Object.fromEntries(merged.entries()),
      body: payload,
      signal: own ?? signal,
    });
  } catch (error) {
    // A stopped turn is not a network failure, and must not be reported as one.
    if (signal.aborted || own?.aborted || (error as Error).name === "AbortError") throw error;
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const reason = cause?.code ?? cause?.message ?? (error as Error).message;
    throw new ScriptError(
      `${who} could not reach ${originOf(url)} (${reason}). Check the address, and that the server is running.`,
    );
  }

  if (response.ok) return response;

  const text = await response.text().catch(() => "");
  const detail = describeBody(text);
  const status = response.status;
  const lead =
    status === 401 || status === 403
      ? `${who} was refused (${status}) — check the key`
      : `${who} answered ${status}`;

  throw new APICallError({
    message: detail ? `${lead}: ${detail}` : lead,
    url,
    requestBodyValues: json,
    statusCode: status,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    responseBody: text,
  });
}

/** A response body as lines, however it happens to be chunked. */
async function* rawLines(response: Response): AsyncGenerator<string> {
  if (!response?.body) throw new ScriptError("That response has no body to read.");

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut = buffer.indexOf("\n");
    while (cut !== -1) {
      yield buffer.slice(0, cut).replace(/\r$/, "");
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer) yield buffer.replace(/\r$/, "");
}

/** `ctx.sse`: the event-stream format, per the HTML standard, minus reconnection. */
async function* sse(response: Response): AsyncGenerator<ServerSentEvent> {
  let event: string | null = null;
  let data: string[] = [];

  for await (const line of rawLines(response)) {
    if (line === "") {
      if (data.length > 0) yield { event, data: data.join("\n") };
      event = null;
      data = [];
      continue;
    }
    if (line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }

  if (data.length > 0) yield { event, data: data.join("\n") };
}

/** `ctx.lines`: newline-delimited JSON and anything else shaped like it. */
async function* lines(response: Response): AsyncGenerator<string> {
  for await (const line of rawLines(response)) {
    if (line.trim()) yield line;
  }
}
