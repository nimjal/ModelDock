/**
 * Connections.
 *
 * The screen is built around one fact people get wrong about BYOK: the database
 * never sees the key. A connection stores the *name* of an environment
 * variable, and this list reports whether that variable currently has a value —
 * so the common failure, a key exported in one shell but not the one that
 * started the server, is visible here rather than as a mysterious error
 * mid-conversation.
 *
 * A key can also be typed in, which does not weaken that. The value goes to
 * `~/.modeldock/keys.env` and into the environment; the row still holds a name.
 * Each connection says which source its key came from, because when a saved key
 * and an exported one disagree, that is the only thing worth knowing.
 *
 * Three ways in, on purpose. The guided screen covers a long list of services
 * with their URLs and key pages filled in and is where almost everyone should
 * start; the form describes a vendor or OpenAI-shaped endpoint by hand; and a
 * custom script covers what neither can — any API at all, starting from a
 * template of one ModelDock already speaks. Every built-in connection can also
 * be copied into a script, for the case of "this, but sending one thing more".
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  api,
  type ConnectionView,
  type KeyStatus,
  type KindSpec,
  type ScriptTemplate,
} from "../lib/api";
import { ModelPicker } from "./ModelPicker";
import { ScriptEditor, type ScriptStart } from "./ScriptEditor";

export function ConnectionsPanel({
  onChanged,
  onSetUp,
  startScript,
}: {
  onChanged?: () => void;
  /** Opens the guided provider list. */
  onSetUp?: () => void;
  /** Open with a new custom engine under way — how the berth and Settings arrive here. */
  startScript?: boolean;
}) {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [kinds, setKinds] = useState<KindSpec[]>([]);
  const [templates, setTemplates] = useState<ScriptTemplate[]>([]);
  const [keys, setKeys] = useState<KeyStatus[]>([]);
  const [keysPath, setKeysPath] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** The custom-engine editor at the top, and what it opened with. `key` remounts it. */
  const [scripting, setScripting] = useState<(ScriptStart & { key: number }) | null>(
    startScript ? { key: 0 } : null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const editor = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [data, keyData] = await Promise.all([api.connections(), api.keys()]);
    setConnections(data.connections);
    setKinds(data.kinds);
    setTemplates(data.templates);
    setKeys(keyData.keys);
    setKeysPath(keyData.path);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // "Customise it as a script" is pressed on a row further down, and the editor
  // it opens is at the top — so the page goes to it rather than leaving it
  // somewhere above the fold.
  const hasTemplates = templates.length > 0;
  useEffect(() => {
    if (scripting && hasTemplates) {
      editor.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [scripting?.key, hasTemplates]);

  const openScript = (start: ScriptStart = {}) => {
    setAdding(false);
    setScripting({ ...start, key: Date.now() });
  };

  const drop = async (id: string) => {
    await api.deleteConnection(id);
    await load();
    onChanged?.();
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-8">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[1.25rem] font-semibold tracking-tight">Connections</h1>
          <p className="mt-1 text-[0.8125rem]" style={{ color: "var(--ink-2)" }}>
            The database stores the name of the variable holding your key, never the key itself.
            {keysPath && (
              <>
                {" "}
                Keys saved here live in <span className="font-mono">{keysPath}</span>.
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onSetUp && (
            <button
              type="button"
              onClick={onSetUp}
              className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)]"
              style={{ borderColor: "var(--line-strong)" }}
            >
              Browse providers
            </button>
          )}
          <button
            type="button"
            onClick={() => (scripting ? setScripting(null) : openScript())}
            className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)]"
            style={{ borderColor: "var(--line)" }}
          >
            {scripting ? "Close script" : "Custom script"}
          </button>
          <button
            type="button"
            onClick={() => {
              setScripting(null);
              setAdding((value) => !value);
            }}
            className="rounded-[var(--radius-sm)] px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)]"
            style={{ color: "var(--ink-2)" }}
          >
            {adding ? "Cancel" : "Add by hand"}
          </button>
        </div>
      </header>

      {scripting && hasTemplates && (
        <div ref={editor} className="mb-6 scroll-mt-4">
          <ScriptEditor
            key={scripting.key}
            templates={templates}
            start={scripting}
            onCancel={() => setScripting(null)}
            onSaved={async () => {
              setScripting(null);
              await load();
              onChanged?.();
            }}
          />
        </div>
      )}

      {adding && (
        <ConnectionForm
          // A script is described by its own editor, not by these fields.
          kinds={kinds.filter((item) => item.kind !== "script")}
          onCancel={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await load();
            onChanged?.();
          }}
          onError={setFailure}
        />
      )}

      {failure && (
        <p className="mb-4 text-[0.8125rem]" style={{ color: "var(--danger)" }}>
          {failure}
        </p>
      )}

      <ul className="flex flex-col">
        {connections.map((item) => (
          <ConnectionRow
            key={item.id}
            item={item}
            templates={templates}
            keyStatus={keys.find((key) => key.name === item.apiKeyEnv) ?? null}
            onChanged={async () => {
              await load();
              onChanged?.();
            }}
            onCustomise={openScript}
            onRemove={() => void drop(item.id)}
          />
        ))}
      </ul>
    </div>
  );
}

function ConnectionRow({
  item,
  templates,
  keyStatus,
  onChanged,
  onCustomise,
  onRemove,
}: {
  item: ConnectionView;
  templates: ScriptTemplate[];
  keyStatus: KeyStatus | null;
  onChanged: () => void | Promise<void>;
  onCustomise: (start: ScriptStart) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const loadModels = useCallback(async () => (await api.models(item.id)).models, [item.id]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
      await onChanged();
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const scripted = item.kind === "script";
  // The template that reimplements this row's own kind, so a copy starts from
  // something that already speaks to the same place.
  const mirror = scripted
    ? null
    : (templates.find((template) => template.kind === item.kind) ?? null);

  const source =
    keyStatus?.source === "file"
      ? "saved here"
      : keyStatus?.source === "environment"
        ? "from your environment"
        : null;

  return (
    <li className="group border-b py-3" style={{ borderColor: "var(--line)" }}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-1.5 size-2 shrink-0 rounded-full"
          style={{
            background: item.ready ? item.accent : "transparent",
            boxShadow: item.ready ? undefined : "inset 0 0 0 1.5px var(--ink-3)",
          }}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[0.875rem] font-medium">{item.name}</p>
          <p className="truncate font-mono text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
            {scripted ? "script · " : ""}
            {item.model}
            {item.baseUrl ? ` · ${item.baseUrl}` : ""}
          </p>
          <p className="mt-1 text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
            {item.ready
              ? `${
                  item.apiKeyEnv
                    ? `Ready — ${item.apiKeyEnv}${source ? `, ${source}` : ""}`
                    : "Ready — no key needed"
                }${scripted && !item.capabilities.chat ? " · draws only" : ""}`
              : item.problem}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-0.5">
          <button
            type="button"
            onClick={() => setEditing((value) => !value)}
            className="text-[0.6875rem] transition-colors hover:text-[var(--ink)]"
            style={{ color: "var(--ink-3)" }}
          >
            {editing ? "Done" : scripted ? "Edit script" : item.ready ? "Change" : "Set up"}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="text-[0.6875rem] opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
            style={{ color: "var(--ink-3)" }}
          >
            Remove
          </button>
        </div>
      </div>

      {editing && scripted && templates.length > 0 && (
        <div className="mt-3 pl-5">
          <ScriptEditor
            templates={templates}
            connectionId={item.id}
            start={{
              initial: {
                name: item.name,
                baseUrl: item.baseUrl ?? "",
                apiKeyEnv: item.apiKeyEnv ?? "",
                model: item.model,
                script: item.script ?? "",
              },
            }}
            onCancel={() => setEditing(false)}
            onSaved={async () => {
              setEditing(false);
              await onChanged();
            }}
          />
        </div>
      )}

      {editing && !scripted && (
        <div className="mt-3 pl-5">
          {item.apiKeyEnv && (
            <div className="mb-3">
              <span
                className="mb-1 block text-[0.6875rem] font-medium uppercase tracking-wider"
                style={{ color: "var(--ink-3)" }}
              >
                {item.apiKeyEnv}
              </span>
              <div className="flex gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder={
                    keyStatus?.set
                      ? `Replace the current key${keyStatus.tail ? ` (ends ${keyStatus.tail})` : ""}`
                      : "Paste the key"
                  }
                  className="min-w-0 flex-1 rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[0.8125rem] outline-none placeholder:text-[var(--ink-3)]"
                  style={{
                    borderColor: "var(--line)",
                    background: "var(--paper)",
                    fontFamily: "var(--font-mono)",
                  }}
                />
                <button
                  type="button"
                  disabled={busy || !secret.trim()}
                  onClick={() =>
                    void run(async () => {
                      await api.saveKey(item.apiKeyEnv!, secret);
                      setSecret("");
                    })
                  }
                  className="shrink-0 rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)] disabled:opacity-40"
                  style={{ borderColor: "var(--line-strong)" }}
                >
                  Save
                </button>
                {keyStatus?.source === "file" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => void (await api.deleteKey(item.apiKeyEnv!)))
                    }
                    className="shrink-0 text-[0.6875rem] transition-colors hover:text-[var(--ink)] disabled:opacity-40"
                    style={{ color: "var(--ink-3)" }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          )}

          <span
            className="mb-1 block text-[0.6875rem] font-medium uppercase tracking-wider"
            style={{ color: "var(--ink-3)" }}
          >
            Model
          </span>
          <ModelPicker
            value={item.model}
            load={item.ready ? loadModels : null}
            blocked="Add a key above to see what this provider has."
            onPick={(model) =>
              void run(async () => void (await api.updateConnection(item.id, { model })))
            }
          />

          {failure && (
            <p className="mt-2 text-[0.75rem]" style={{ color: "var(--danger)" }}>
              {failure}
            </p>
          )}

          {mirror && (
            <p className="mt-3 text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
              Need it to send something this connection does not?{" "}
              <button
                type="button"
                onClick={() =>
                  onCustomise({
                    templateId: mirror.id,
                    initial: {
                      name: `${item.name} script`,
                      baseUrl: item.baseUrl ?? "",
                      apiKeyEnv: item.apiKeyEnv ?? "",
                      model: item.model,
                    },
                  })
                }
                className="underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--ink)]"
              >
                Customise it as a script
              </button>{" "}
              — a new connection with these settings, starting from the {mirror.label} template.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function ConnectionForm({
  kinds,
  onCancel,
  onSaved,
  onError,
}: {
  kinds: KindSpec[];
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [kind, setKind] = useState(kinds[0]?.kind ?? "anthropic");
  const spec = kinds.find((item) => item.kind === kind);

  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");

  // Changing kind re-primes the fields with that provider's conventions.
  useEffect(() => {
    if (!spec) return;
    setName((value) => value || spec.label);
    setModel(spec.suggestedModels[0] ?? "");
    setBaseUrl(spec.defaultBaseUrl ?? "");
    setApiKeyEnv(spec.defaultApiKeyEnv ?? "");
  }, [kind, spec]);

  // Listing needs somewhere to ask and, usually, something to ask with. The
  // variable named here has to already hold a value — this form describes an
  // endpoint, and the guided screen is where a key gets typed.
  const canList = Boolean(!spec?.baseUrlEditable || baseUrl.trim());
  const loadModels = useCallback(
    async () =>
      (await api.probeModels({ kind, baseUrl: baseUrl.trim() || null, apiKeyEnv, label: name }))
        .models,
    [kind, baseUrl, apiKeyEnv, name],
  );

  const save = async () => {
    try {
      await api.createConnection({ name, kind, model, baseUrl, apiKeyEnv });
      await onSaved();
    } catch (error) {
      onError((error as Error).message);
    }
  };

  return (
    <div
      className="mb-6 rounded-[var(--radius)] border p-3.5"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}
    >
      <div className="mb-3 flex flex-wrap gap-1.5">
        {kinds.map((item) => (
          <button
            key={item.kind}
            type="button"
            onClick={() => setKind(item.kind)}
            className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors"
            style={{
              borderColor: item.kind === kind ? "var(--line-strong)" : "var(--line)",
              background: item.kind === kind ? "var(--wash)" : undefined,
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {spec && (
        <p className="mb-3 text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
          {spec.hint}
        </p>
      )}

      <Field label="Name" value={name} onChange={setName} placeholder="What to call it" />
      {spec?.baseUrlEditable && (
        <Field
          label="Base URL"
          value={baseUrl}
          onChange={setBaseUrl}
          placeholder="https://…/v1"
          mono
        />
      )}
      <Field
        label="API key variable"
        value={apiKeyEnv}
        onChange={setApiKeyEnv}
        placeholder={spec?.requiresApiKey ? "PROVIDER_API_KEY" : "Leave empty if none"}
        mono
        hint="The name of an environment variable. Its value is read when a message is sent and never stored in the database."
      />

      <div className="mb-2.5">
        <span
          className="block text-[0.6875rem] font-medium uppercase tracking-wider"
          style={{ color: "var(--ink-3)" }}
        >
          Model
        </span>
        {model && (
          <p className="mb-1.5 mt-1 font-mono text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
            {model}
          </p>
        )}
        <div className="mt-1">
          <ModelPicker
            value={model}
            onPick={setModel}
            load={canList ? loadModels : null}
            blocked="Give it a base URL to see what it is serving."
          />
        </div>
      </div>

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
          disabled={!model.trim() || !name.trim()}
          className="rounded-[var(--radius-sm)] px-3 py-1 text-[0.75rem] font-medium disabled:opacity-40"
          style={{ background: "var(--ink)", color: "var(--paper)" }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  hint?: string;
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
        className="mt-1 w-full rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[0.8125rem] outline-none placeholder:text-[var(--ink-3)]"
        style={{
          borderColor: "var(--line)",
          background: "var(--paper)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
        }}
      />
      {hint && (
        <span className="mt-1 block text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}
