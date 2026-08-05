/**
 * Connections.
 *
 * The screen is built around one fact people get wrong about BYOK: ModelDock
 * never sees the key. The form asks for the *name* of an environment
 * variable, and the list reports whether that variable is currently set in
 * the process that launched the app. So the common failure — a key exported
 * in one shell but not the one that started the server — is visible here
 * rather than as a mysterious error mid-conversation.
 */

import { useCallback, useEffect, useState } from "react";

import { api, type ConnectionView, type KindSpec } from "../lib/api";

export function ConnectionsPanel({ onChanged }: { onChanged?: () => void }) {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [kinds, setKinds] = useState<KindSpec[]>([]);
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api.connections();
    setConnections(data.connections);
    setKinds(data.kinds);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const drop = async (id: string) => {
    await api.deleteConnection(id);
    await load();
    onChanged?.();
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-8">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[1.25rem] font-semibold tracking-tight">Connections</h1>
          <p className="mt-1 text-[0.8125rem]" style={{ color: "var(--ink-2)" }}>
            ModelDock stores the name of the variable holding your key, never the key itself.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding((value) => !value)}
          className="shrink-0 rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)]"
          style={{ borderColor: "var(--line-strong)" }}
        >
          {adding ? "Cancel" : "Add"}
        </button>
      </header>

      {adding && (
        <ConnectionForm
          kinds={kinds}
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
          <li
            key={item.id}
            className="group flex items-start gap-3 border-b py-3"
            style={{ borderColor: "var(--line)" }}
          >
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
              <p className="font-mono text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
                {item.model}
                {item.baseUrl ? ` · ${item.baseUrl}` : ""}
              </p>
              <p className="mt-1 text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
                {item.ready
                  ? item.apiKeyEnv
                    ? `Ready — ${item.apiKeyEnv} is set`
                    : "Ready — no key needed"
                  : item.problem}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void drop(item.id)}
              className="text-[0.6875rem] opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
              style={{ color: "var(--ink-3)" }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
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
      <Field label="Model" value={model} onChange={setModel} placeholder="Model id" mono />
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
        hint="The name of an environment variable. Its value is read when a message is sent and never stored."
      />

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
          className="rounded-[var(--radius-sm)] px-3 py-1 text-[0.75rem] font-medium"
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
