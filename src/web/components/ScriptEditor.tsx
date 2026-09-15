/**
 * Writing a custom engine.
 *
 * Every other way into ModelDock chooses from protocols it already speaks. This
 * one is for the API it does not: a short JavaScript module that is handed the
 * conversation and streams back a reply. `scripts/runtime.ts` sets out what a
 * script is given and what it is trusted with, and the reference under the
 * editor says the same thing in fewer words.
 *
 * Nobody starts from a blank page. The templates include Ollama, ChatGPT and
 * Claude written out as scripts, so the common case — a provider ModelDock
 * already supports, with one thing changed — begins as something that works.
 * Choosing a template fills in the connection's fields as well as its code, and
 * asks first when that would throw away edits.
 *
 * The code field is a textarea with line numbers and nothing cleverer. A syntax
 * error comes back from the server with its line and a caret, which is what an
 * editor's squiggle would have said, without shipping an editor to say it.
 *
 * Check and Try are the loop that matters. Check loads the module and reports
 * what it exports; Try runs one short turn through the same adapter a
 * conversation uses, so what works here works in a thread. Neither saves.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  api,
  type ConnectionView,
  type KeyStatus,
  type ScriptInspection,
  type ScriptTemplate,
  type ScriptTrial,
} from "../lib/api";
import { ModelPicker } from "./ModelPicker";

export interface ScriptDraft {
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  script: string;
}

/** What opens the editor: a template to start from, and fields laid over it. */
export interface ScriptStart {
  templateId?: string;
  initial?: Partial<ScriptDraft>;
}

/** One line of code. The gutter and the textarea have to agree on it exactly. */
const LINE = "1.25rem";
/** Eighteen lines: a whole function in view, and still room on a laptop screen. */
const HEIGHT = "22.5rem";

const REFERENCE = `export async function* chat(request, ctx)   one turn: yield the reply as it arrives
export async function image(request, ctx)   return pictures
export async function models(ctx)           optional: fills the model list
export const defaultImageModel = "…"        optional: used when Settings names none
export const maxImagesPerCall = 4           optional: how many image() makes at once

request, for chat
  model, system, messages, tools, toolChoice, maxOutputTokens,
  temperature, topP, topK, stopSequences, seed, responseFormat
  messages  [{ role: "user" | "assistant" | "tool", content: [part, …] }]
  part      { type: "text", text }
            { type: "reasoning", text }
            { type: "file", mediaType, data }       data is base64
            { type: "tool-call", id, name, input }
            { type: "tool-result", id, name, output, isError }
  tools     [{ name, description, parameters }]    parameters is JSON Schema

yield
  "some text"
  { type: "reasoning", text }
  { type: "tool-call", id, name, input }
  { type: "usage", inputTokens, outputTokens }
  { type: "finish", reason: "stop" | "length" | "tool-calls" | "content-filter" }
  Text, reasoning and tool calls can carry meta: { … }, which comes back on the
  same part next turn, for APIs that want a signature returned.

request, for image
  model, prompt, n, size, aspectRatio, seed
return
  base64, a data: or https: URL, or bytes; one, or a list

ctx
  model, baseUrl, apiKey, signal, name
  ctx.request(url, { method, headers, json })   fetch, with a readable error on failure
  ctx.sse(response)                             each server-sent event, as { event, data }
  ctx.lines(response)                           each line of a newline-delimited stream`;

export function ScriptEditor({
  templates,
  connectionId,
  start,
  onSaved,
  onCancel,
}: {
  templates: ScriptTemplate[];
  /** Set when editing a saved script connection. Otherwise saving creates one. */
  connectionId?: string;
  start?: ScriptStart;
  onSaved: (connection: ConnectionView) => void | Promise<void>;
  onCancel: () => void;
}) {
  const hintId = useId();

  // An existing script opens as itself; anything else opens on a template.
  const opening =
    templates.find((template) => template.id === start?.templateId) ??
    (start?.initial?.script ? null : (templates[0] ?? null));

  const [draft, setDraft] = useState<ScriptDraft>(() => ({
    name: start?.initial?.name ?? opening?.name ?? "",
    baseUrl: start?.initial?.baseUrl ?? opening?.baseUrl ?? "",
    apiKeyEnv: start?.initial?.apiKeyEnv ?? opening?.apiKeyEnv ?? "",
    model: start?.initial?.model ?? opening?.model ?? "",
    script: start?.initial?.script ?? opening?.script ?? "",
  }));
  const [templateId, setTemplateId] = useState<string | null>(opening?.id ?? null);
  /** The script as it was last loaded, so "would this discard edits?" has an answer. */
  const [baseline, setBaseline] = useState(draft.script);
  const [pending, setPending] = useState<ScriptTemplate | null>(null);

  const [keys, setKeys] = useState<KeyStatus[]>([]);
  const [secret, setSecret] = useState("");

  const [inspection, setInspection] = useState<ScriptInspection | null>(null);
  const [checkedScript, setCheckedScript] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const [prompt, setPrompt] = useState("Say hello in five words.");
  const [trial, setTrial] = useState<ScriptTrial | null>(null);
  const [trying, setTrying] = useState(false);

  const [showReference, setShowReference] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const gutter = useRef<HTMLPreElement>(null);
  const escaped = useRef(false);

  // The draft as the latest render sees it, for work started from an effect.
  const latest = useRef(draft);
  latest.current = draft;

  const update = (changes: Partial<ScriptDraft>) =>
    setDraft((current) => ({ ...current, ...changes }));

  const loadKeys = useCallback(async () => {
    try {
      setKeys((await api.keys()).keys);
    } catch {
      /* the key field still works; it just cannot say whether one is set */
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const check = useCallback(async () => {
    const { script, name } = latest.current;
    if (!script.trim()) {
      setInspection(null);
      setCheckedScript(null);
      return;
    }
    setChecking(true);
    try {
      setInspection((await api.checkScript({ script, name })).inspection);
    } catch (error) {
      setInspection({
        chat: false,
        image: false,
        models: false,
        defaultImageModel: null,
        problem: (error as Error).message,
      });
    } finally {
      setCheckedScript(script);
      setChecking(false);
    }
  }, []);

  // On opening, and whenever a template replaces the script, so what a script
  // offers is on screen before anyone thinks to ask.
  useEffect(() => {
    void check();
  }, [templateId, check]);

  const apply = (template: ScriptTemplate) => {
    setPending(null);
    setTrial(null);
    setBaseline(template.script);
    setDraft((current) => ({
      // A saved connection keeps its name, and so does a new one that has been
      // given a name of its own rather than a template's.
      name:
        connectionId ||
        (current.name.trim() && !templates.some((item) => item.name === current.name))
          ? current.name
          : template.name,
      baseUrl: template.baseUrl ?? "",
      apiKeyEnv: template.apiKeyEnv ?? "",
      model: template.model,
      script: template.script,
    }));
    setTemplateId(template.id);
  };

  const choose = (template: ScriptTemplate) => {
    if (draft.script.trim() && draft.script !== baseline) setPending(template);
    else apply(template);
  };

  const attempt = async () => {
    const { script, name, baseUrl, apiKeyEnv, model } = latest.current;
    if (!script.trim() || trying) return;
    setTrying(true);
    setTrial(null);
    try {
      setTrial(
        await api.tryScript({
          script,
          name,
          baseUrl: baseUrl.trim() || null,
          apiKeyEnv: apiKeyEnv.trim() || null,
          model: model.trim(),
          prompt,
        }),
      );
    } catch (error) {
      setTrial({ ok: false, error: (error as Error).message, ms: 0 });
    } finally {
      setTrying(false);
    }
    // Trying loaded the module, so this answer is already cached server-side.
    if (checkedScript !== script) void check();
  };

  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const body = {
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim() || null,
        apiKeyEnv: draft.apiKeyEnv.trim() || null,
        model: draft.model.trim(),
        script: draft.script,
      };
      const { connection } = connectionId
        ? await api.updateConnection(connectionId, body)
        : await api.createConnection({ ...body, kind: "script" });
      setBaseline(draft.script);
      await onSaved(connection);
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async () => {
    const name = draft.apiKeyEnv.trim();
    if (!name || !secret.trim()) return;
    setFailure(null);
    try {
      await api.saveKey(name, secret);
      setSecret("");
      await loadKeys();
    } catch (error) {
      setFailure((error as Error).message);
    }
  };

  const onCodeKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void attempt();
      return;
    }
    // Tab indents, which is what anyone typing code expects — so Escape first
    // is the way out, and the hint under the editor says so.
    if (event.key === "Escape") {
      escaped.current = true;
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && !escaped.current) {
      event.preventDefault();
      const target = event.currentTarget;
      const { selectionStart, selectionEnd, value } = target;
      update({ script: `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}` });
      requestAnimationFrame(() => {
        target.selectionStart = selectionStart + 2;
        target.selectionEnd = selectionStart + 2;
      });
      return;
    }
    escaped.current = false;
  };

  const template = templates.find((item) => item.id === templateId) ?? null;
  const keyName = draft.apiKeyEnv.trim();
  const keyStatus = keys.find((key) => key.name === keyName) ?? null;
  const lines = draft.script.split("\n").length;

  const fresh = checkedScript === draft.script ? inspection : null;
  const canChat = fresh && !fresh.problem ? fresh.chat : null;
  const exports = fresh
    ? [fresh.chat && "chat()", fresh.image && "image()", fresh.models && "models()"].filter(Boolean)
    : [];

  const loadModels = useCallback(
    async () =>
      (
        await api.probeModels({
          kind: "script",
          script: latest.current.script,
          baseUrl: latest.current.baseUrl.trim() || null,
          apiKeyEnv: latest.current.apiKeyEnv.trim() || null,
          label: latest.current.name.trim() || "This script",
        })
      ).models,
    [],
  );

  return (
    <div
      className="rounded-[var(--radius)] border p-3.5"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <div className="mb-3">
        <p className="text-[0.875rem] font-medium">{connectionId ? "Script" : "Custom engine"}</p>
        <p className="mt-0.5 text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
          A short JavaScript module that talks to any API. ModelDock hands it the conversation and
          it streams back the reply — or, with an <code className="font-mono">image()</code>{" "}
          function, the pictures.
        </p>
      </div>

      <Label>Start from</Label>
      <div className="flex flex-wrap gap-1.5">
        {templates.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => choose(item)}
            title={item.hint}
            aria-pressed={item.id === templateId}
            className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)]"
            style={{
              borderColor: item.id === templateId ? "var(--line-strong)" : "var(--line)",
              background: item.id === templateId ? "var(--wash)" : undefined,
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {pending ? (
        <div
          className="mt-2 flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[0.75rem]"
          style={{ borderColor: "var(--line-strong)", background: "var(--paper)" }}
        >
          <span style={{ color: "var(--ink-2)" }}>
            Replace your edited script with the {pending.label} template?
          </span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => apply(pending)}
              className="font-medium transition-colors hover:text-[var(--ink)]"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="transition-colors hover:text-[var(--ink)]"
              style={{ color: "var(--ink-3)" }}
            >
              Keep mine
            </button>
          </span>
        </div>
      ) : (
        template && (
          <p className="mt-1.5 text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
            {template.hint}
            {template.keyUrl && (
              <>
                {" "}
                <a
                  href={template.keyUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline decoration-dotted underline-offset-2"
                >
                  Where to get a key
                </a>
              </>
            )}
          </p>
        )
      )}

      <div className="mt-3 grid gap-x-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field
            label="Name"
            value={draft.name}
            onChange={(name) => update({ name })}
            placeholder="What to call it"
          />
        </div>
        <Field
          label="Base URL"
          value={draft.baseUrl}
          onChange={(baseUrl) => update({ baseUrl })}
          placeholder="Optional: the script can hard-code one"
          mono
        />
        <Field
          label="API key variable"
          value={draft.apiKeyEnv}
          onChange={(apiKeyEnv) => update({ apiKeyEnv })}
          placeholder="Optional, e.g. MY_API_KEY"
          mono
        />
      </div>

      {keyName && (
        <div className="-mt-1 mb-2.5">
          {keyStatus?.set ? (
            <p className="text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
              <span className="font-mono">{keyName}</span> is set
              {keyStatus.tail ? `, ending ${keyStatus.tail}` : ""} —{" "}
              {keyStatus.source === "file" ? "saved here" : "from your environment"}. The script
              reads it as <span className="font-mono">ctx.apiKey</span>.
            </p>
          ) : (
            <div className="flex gap-2">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveKey();
                }}
                placeholder={`Paste the value for ${keyName}, unless it is already exported`}
                className="min-w-0 flex-1 rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[0.8125rem] outline-none placeholder:text-[var(--ink-3)]"
                style={{
                  borderColor: "var(--line)",
                  background: "var(--paper)",
                  fontFamily: "var(--font-mono)",
                }}
              />
              <button
                type="button"
                onClick={() => void saveKey()}
                disabled={!secret.trim()}
                className="shrink-0 rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)] disabled:opacity-40"
                style={{ borderColor: "var(--line-strong)" }}
              >
                Save key
              </button>
            </div>
          )}
        </div>
      )}

      <div className="mb-3">
        <Label>Model</Label>
        {draft.model && (
          <p className="mb-1.5 font-mono text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
            {draft.model}
          </p>
        )}
        <ModelPicker
          compact
          value={draft.model}
          onPick={(model) => update({ model })}
          load={draft.script.trim() && canChat !== false ? loadModels : null}
          prefer={canChat === false ? "image" : "chat"}
          blocked={
            fresh && !fresh.problem && !fresh.models
              ? "This script has no models() to list. Any id it understands will do."
              : "Write the script to list what it can run."
          }
        />
      </div>

      <div className="mb-1 flex items-baseline justify-between gap-3">
        <Label>Script</Label>
        <button
          type="button"
          onClick={() => setShowReference((value) => !value)}
          aria-expanded={showReference}
          className="text-[0.6875rem] transition-colors hover:text-[var(--ink)]"
          style={{ color: "var(--ink-3)" }}
        >
          {showReference ? "Hide how a script works" : "How a script works"}
        </button>
      </div>

      {showReference && (
        <div
          className="mb-2 rounded-[var(--radius-sm)] border px-3 py-2.5"
          style={{ borderColor: "var(--line)", background: "var(--paper)" }}
        >
          <div className="overflow-x-auto">
            <pre
              className="font-mono text-[0.6875rem] leading-relaxed"
              style={{ color: "var(--ink-2)" }}
            >
              {REFERENCE}
            </pre>
          </div>
          <p className="mt-2 text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
            A script runs inside ModelDock with everything Node can do — it is not sandboxed, so
            treat one from someone else like any program you would run. It can import Node's
            built-in modules, but not files or packages, and it stays on this machine: scripts never
            sync to your other devices.
          </p>
        </div>
      )}

      <div
        className="flex overflow-hidden rounded-[var(--radius-sm)] border"
        style={{ borderColor: "var(--line)", background: "var(--paper)" }}
      >
        <pre
          ref={gutter}
          aria-hidden
          className="shrink-0 select-none overflow-hidden border-r py-2 pl-2.5 pr-2 text-right font-mono text-[0.75rem]"
          style={{
            borderColor: "var(--line)",
            color: "var(--ink-3)",
            lineHeight: LINE,
            height: HEIGHT,
            // Room to scroll past the textarea's own horizontal scrollbar, so the
            // last numbers still line up with the last lines.
            paddingBottom: "2rem",
          }}
        >
          {Array.from({ length: lines }, (_, index) => index + 1).join("\n")}
        </pre>
        <textarea
          value={draft.script}
          onChange={(event) => update({ script: event.target.value })}
          onScroll={(event) => {
            if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onKeyDown={onCodeKey}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          aria-label="Script"
          aria-describedby={hintId}
          className="min-w-0 flex-1 resize-none bg-transparent px-2.5 py-2 font-mono text-[0.75rem] outline-none"
          style={{ lineHeight: LINE, height: HEIGHT, whiteSpace: "pre", tabSize: 2 }}
        />
      </div>
      <p id={hintId} className="mt-1 text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
        Tab indents; Escape then Tab moves on. Ctrl+Enter tries it.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void check()}
          disabled={checking || !draft.script.trim()}
          className="shrink-0 rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)] disabled:opacity-40"
          style={{ borderColor: "var(--line-strong)" }}
        >
          {checking ? "Checking…" : "Check"}
        </button>
        <input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void attempt();
          }}
          aria-label="Message to try the script with"
          disabled={canChat === false}
          className="min-w-[10rem] flex-1 rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.8125rem] outline-none disabled:opacity-40"
          style={{ borderColor: "var(--line)", background: "var(--paper)" }}
        />
        <button
          type="button"
          onClick={() => void attempt()}
          disabled={trying || !draft.script.trim() || canChat === false}
          className="shrink-0 rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)] disabled:opacity-40"
          style={{ borderColor: "var(--line-strong)" }}
        >
          {trying ? "Running…" : "Try it"}
        </button>
      </div>

      {fresh &&
        (fresh.problem ? (
          <pre
            className="mt-2 whitespace-pre-wrap font-mono text-[0.75rem]"
            style={{ color: "var(--danger)" }}
          >
            {fresh.problem}
          </pre>
        ) : (
          <p className="mt-2 text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
            Loads, and exports {exports.join(", ")}.
            {!fresh.chat &&
              " It draws and does not chat, so it is offered under Image generation in Settings rather than as an engine to talk to."}
          </p>
        ))}
      {inspection && !fresh && !checking && (
        <p className="mt-2 text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
          Changed since the last check.
        </p>
      )}

      {trial && <Trial trial={trial} />}

      {failure && (
        <p className="mt-3 text-[0.75rem]" style={{ color: "var(--danger)" }}>
          {failure}
        </p>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-[var(--radius-sm)] px-2.5 py-1 text-[0.75rem]"
          style={{ color: "var(--ink-2)" }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !draft.name.trim() || !draft.model.trim() || !draft.script.trim()}
          title={
            draft.model.trim()
              ? undefined
              : "Give it a model: any id the script understands, even one it ignores."
          }
          className="rounded-[var(--radius-sm)] px-3 py-1 text-[0.75rem] font-medium disabled:opacity-40"
          style={{ background: "var(--ink)", color: "var(--paper)" }}
        >
          {connectionId ? "Save" : "Add engine"}
        </button>
      </div>
    </div>
  );
}

/** One trial turn: what it thought, what it said, what it called, and how it ended. */
function Trial({ trial }: { trial: ScriptTrial }) {
  const calls = (trial.toolCalls ?? [])
    .map((call) => `→ ${call.name}(${JSON.stringify(call.input)})`)
    .join("\n");

  const facts = [
    trial.finishReason ? `stopped: ${trial.finishReason}` : null,
    trial.usage && (trial.usage.input !== null || trial.usage.output !== null)
      ? `${trial.usage.input ?? "?"} in · ${trial.usage.output ?? "?"} out`
      : null,
    `${(trial.ms / 1000).toFixed(1)}s`,
  ].filter(Boolean);

  return (
    <div
      className="mt-2 rounded-[var(--radius-sm)] border px-2.5 py-2"
      style={{ borderColor: "var(--line)", background: "var(--paper)" }}
    >
      {trial.reasoning && (
        <p
          className="mb-1.5 whitespace-pre-wrap text-[0.75rem] italic"
          style={{ color: "var(--ink-3)" }}
        >
          {trial.reasoning}
        </p>
      )}
      {trial.text ? (
        <p className="whitespace-pre-wrap text-[0.8125rem]">{trial.text}</p>
      ) : (
        trial.ok &&
        !calls && (
          <p className="text-[0.8125rem]" style={{ color: "var(--ink-3)" }}>
            It finished without saying anything.
          </p>
        )
      )}
      {calls && (
        <pre
          className="mt-1 whitespace-pre-wrap font-mono text-[0.75rem]"
          style={{ color: "var(--ink-2)" }}
        >
          {calls}
        </pre>
      )}
      {trial.error && (
        <pre
          className="mt-1 whitespace-pre-wrap font-mono text-[0.75rem]"
          style={{ color: "var(--danger)" }}
        >
          {trial.error}
        </pre>
      )}
      <p className="mt-1.5 text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
        {facts.join(" · ")}
      </p>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="mb-1 block text-[0.6875rem] font-medium uppercase tracking-wider"
      style={{ color: "var(--ink-3)" }}
    >
      {children}
    </span>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="mb-2.5 block">
      <span
        className="block text-[0.6875rem] font-medium uppercase tracking-wider"
        style={{ color: "var(--ink-3)" }}
      >
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="mt-1 w-full rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[0.8125rem] outline-none placeholder:text-[var(--ink-3)]"
        style={{
          borderColor: "var(--line)",
          background: "var(--paper)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
        }}
      />
    </label>
  );
}
