/**
 * First run.
 *
 * The screen exists because the honest version of BYOK — "export a variable and
 * restart" — is a bad first five minutes and a worse first impression. It fails
 * silently in the wrong shell, it cannot be fixed from inside the app, and it
 * asks someone to learn their platform's export syntax before they have seen a
 * single reply. So a key can be typed here.
 *
 * That does not soften the rule underneath it, and the screen says so in one
 * line rather than burying it. The key goes to `~/.modeldock/keys.env` on this
 * machine and into the process environment; the database still stores the
 * *name* of a variable and nothing else, so the store is still a file you can
 * back up, copy or sync without it becoming a credential leak. Someone who
 * already exports their keys never has to come here, and nothing they did stops
 * working.
 *
 * The list is long on purpose. Most of it is one wire protocol with a base URL
 * filled in — see `providers/catalog.ts` — and the cost of another row is a
 * row. The point of a workspace that treats the engine as a detail is that the
 * detail is genuinely yours to pick, which is not a claim a list of three
 * providers can make.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  api,
  type ConnectionView,
  type KeyStatus,
  type KindSpec,
  type ProviderPreset,
} from "../lib/api";
import { ModelPicker } from "./ModelPicker";

/** Base URLs differ by trailing slash and case far more often than in substance. */
const sameUrl = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").replace(/\/+$/, "").toLowerCase() === (b ?? "").replace(/\/+$/, "").toLowerCase();

export function Welcome({
  onChanged,
  onDone,
}: {
  onChanged: () => void;
  /** Leaving, whether set up or skipped. */
  onDone: () => void;
}) {
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [kinds, setKinds] = useState<KindSpec[]>([]);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [keys, setKeys] = useState<KeyStatus[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [where, setWhere] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [connectionData, keyData] = await Promise.all([api.connections(), api.keys()]);
    setPresets(connectionData.presets);
    setKinds(connectionData.kinds);
    setConnections(connectionData.connections);
    setKeys(keyData.keys);
    setWhere(keyData.path);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    await load();
    onChanged();
  };

  /**
   * The row this preset already has, if any.
   *
   * Matters because the four seeded connections are presets that already exist:
   * finishing setup for Anthropic must update that row rather than collide with
   * its unique name. For an OpenAI-shaped service the base URL is what
   * identifies it — the kind is shared by a dozen of them.
   */
  const connectionFor = (preset: ProviderPreset) =>
    connections.find(
      (item) =>
        item.kind === preset.kind &&
        (preset.kind === "openai_compatible" ? sameUrl(item.baseUrl, preset.baseUrl) : true),
    ) ?? null;

  const keyFor = (name: string | null) =>
    (name ? keys.find((key) => key.name === name) : null) ?? null;

  const ready = connections.filter((item) => item.ready);

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-10">
      <header className="mb-7">
        <h1 className="text-[1.375rem] font-semibold tracking-tight">Pick an engine</h1>
        <p className="mt-2 text-[0.875rem] leading-relaxed" style={{ color: "var(--ink-2)" }}>
          Your conversations, projects and memory stay here whichever one you choose — and you can
          add more later, or change mid-conversation without losing the thread.
        </p>
        <p className="mt-2.5 text-[0.8125rem] leading-relaxed" style={{ color: "var(--ink-3)" }}>
          A key you enter is written to{" "}
          <span className="font-mono">{where ?? "~/.modeldock/keys.env"}</span> on this machine and
          read from the environment when a message is sent. It never goes into the database, so the
          store can be backed up or synced without carrying a credential. Already export your keys?
          They are picked up as-is — just choose a model.
        </p>
      </header>

      <ul className="flex flex-col">
        {presets.map((preset) => (
          <PresetRow
            key={preset.id}
            preset={preset}
            spec={kinds.find((kind) => kind.kind === preset.kind)}
            connection={connectionFor(preset)}
            keyStatus={keyFor(preset.apiKeyEnv)}
            open={expanded === preset.id}
            onToggle={() => setExpanded((current) => (current === preset.id ? null : preset.id))}
            onChanged={refresh}
          />
        ))}
      </ul>

      <div className="mt-7 flex items-center gap-3">
        <button
          type="button"
          onClick={onDone}
          className="rounded-[var(--radius-sm)] px-3 py-1.5 text-[0.8125rem] font-medium disabled:opacity-40"
          style={{ background: "var(--ink)", color: "var(--paper)" }}
          disabled={ready.length === 0}
        >
          Start chatting
        </button>
        <button
          type="button"
          onClick={onDone}
          className="text-[0.8125rem] transition-colors hover:text-[var(--ink)]"
          style={{ color: "var(--ink-3)" }}
        >
          {ready.length === 0 ? "Skip for now" : "Later"}
        </button>
        <span className="ml-auto text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
          {ready.length === 0
            ? "Nothing set up yet"
            : `${ready.length} ready · ${ready.map((item) => item.name).join(", ")}`}
        </span>
      </div>
    </div>
  );
}

function PresetRow({
  preset,
  spec,
  connection,
  keyStatus,
  open,
  onToggle,
  onChanged,
}: {
  preset: ProviderPreset;
  spec: KindSpec | undefined;
  connection: ConnectionView | null;
  keyStatus: KeyStatus | null;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [name, setName] = useState(preset.label);
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? preset.baseUrl ?? "");
  const [model, setModel] = useState(connection?.model ?? preset.models[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * Whether to offer a key field, and whether one is actually required.
   *
   * These are two different questions and the *kind* can only answer the
   * second, badly. `openai_compatible` has `requiresApiKey: false` because the
   * protocol does not demand one — a local vLLM server takes none. But most
   * presets on that kind are hosted services that plainly do: OpenRouter, Groq,
   * DeepSeek and the rest all want a key, and reading the kind's flag would
   * leave every one of them with no field to type it into.
   *
   * So the preset decides. It names a variable if a key belongs anywhere, and
   * publishes a `keyUrl` if that key is obtained rather than optional — which
   * is what separates a hosted service from "something else", where a key may
   * or may not be wanted and either is fine.
   */
  const showKey = Boolean(preset.apiKeyEnv);
  const needsKey = showKey && (spec?.requiresApiKey === true || Boolean(preset.keyUrl));
  const hasKey = Boolean(keyStatus?.set);
  const editableUrl = spec?.baseUrlEditable ?? preset.kind === "openai_compatible";

  // Listing needs something to authenticate with and somewhere to ask. Until
  // both exist the picker stays a plain text field and says which is missing —
  // it never becomes the reason you cannot proceed.
  const canList = (!needsKey || hasKey) && (!editableUrl || baseUrl.trim().length > 0);

  const loadModels = useCallback(
    async () =>
      (
        await api.probeModels({
          kind: preset.kind,
          baseUrl: baseUrl.trim() || preset.baseUrl,
          apiKeyEnv: preset.apiKeyEnv,
          label: preset.label,
        })
      ).models,
    [preset.kind, preset.baseUrl, preset.apiKeyEnv, preset.label, baseUrl],
  );

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Save the key, then immediately ask what it can run.
   *
   * One action rather than two: a key with no model chosen is not yet a working
   * connection, and making someone press a second button to discover that is
   * the kind of small tax that adds up to "this was fiddly".
   */
  const saveKey = () =>
    run(async () => {
      if (!preset.apiKeyEnv) return;
      await api.saveKey(preset.apiKeyEnv, secret);
      setSecret("");
      await onChanged();

      if (model) return;
      try {
        const { models } = await api.probeModels({
          kind: preset.kind,
          baseUrl: baseUrl.trim() || preset.baseUrl,
          apiKeyEnv: preset.apiKeyEnv,
          label: preset.label,
        });
        const first = models.find((item) => item.chat) ?? models[0];
        if (first) setModel(first.id);
      } catch {
        // The key saved; only the convenience of a pre-picked model was lost,
        // and the picker below says why in its own words.
      }
    });

  const forgetKey = () =>
    run(async () => {
      if (!preset.apiKeyEnv) return;
      await api.deleteKey(preset.apiKeyEnv);
      await onChanged();
    });

  const use = () =>
    run(async () => {
      const body = {
        // `??` would not catch a name cleared to empty, which is the only way
        // this is ever wrong — and the server would reject it a moment later.
        name: connection?.name ?? (name.trim() || preset.label),
        kind: preset.kind,
        baseUrl: baseUrl.trim() || preset.baseUrl,
        model: model.trim(),
        apiKeyEnv: preset.apiKeyEnv,
      };

      // Update rather than insert when this preset already has a row — the four
      // seeded connections are presets, and `connections.name` is unique.
      if (connection) await api.updateConnection(connection.id, body);
      else await api.createConnection(body);
      await onChanged();
    });

  const status = useMemo(() => {
    if (connection?.ready) return `Ready · ${connection.model}`;
    if (hasKey)
      return keyStatus?.source === "file"
        ? "Key saved · pick a model"
        : "Key found in your environment";
    if (!showKey) return "No key needed";
    return needsKey ? "Not set up" : "Key optional";
  }, [connection, showKey, needsKey, hasKey, keyStatus]);

  return (
    <li className="border-b" style={{ borderColor: "var(--line)" }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-3 py-3 text-left transition-colors hover:bg-[var(--wash)]"
      >
        <span
          aria-hidden
          className="mt-1.5 size-2 shrink-0 rounded-full"
          style={{
            background: connection?.ready ? connection.accent : "transparent",
            boxShadow: connection?.ready ? undefined : "inset 0 0 0 1.5px var(--ink-3)",
          }}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[0.875rem] font-medium">{preset.label}</span>
          <span className="block text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
            {preset.hint}
          </span>
        </span>
        <span className="shrink-0 pt-0.5 text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
          {status}
        </span>
      </button>

      {open && (
        <div className="pb-4 pl-5">
          {showKey && (
            <div className="mb-3">
              <div className="mb-1 flex items-baseline gap-2">
                <span
                  className="text-[0.6875rem] font-medium uppercase tracking-wider"
                  style={{ color: "var(--ink-3)" }}
                >
                  API key
                </span>
                {preset.keyUrl && (
                  <a
                    href={preset.keyUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-[0.6875rem] underline decoration-dotted underline-offset-2"
                    style={{ color: "var(--ink-3)" }}
                  >
                    where to get one
                  </a>
                )}
              </div>

              {hasKey ? (
                <div
                  className="flex items-center gap-2 text-[0.75rem]"
                  style={{ color: "var(--ink-2)" }}
                >
                  <span className="font-mono">{preset.apiKeyEnv}</span>
                  <span style={{ color: "var(--ink-3)" }}>
                    {keyStatus?.tail ? `ends ${keyStatus.tail}` : "set"} ·{" "}
                    {keyStatus?.source === "file" ? "saved here" : "from your environment"}
                  </span>
                  {keyStatus?.source === "file" && (
                    <button
                      type="button"
                      onClick={() => void forgetKey()}
                      disabled={busy}
                      className="ml-auto text-[0.6875rem] transition-colors hover:text-[var(--ink)]"
                      style={{ color: "var(--ink-3)" }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && secret.trim()) void saveKey();
                    }}
                    placeholder={`Paste your ${preset.label} key`}
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
                    disabled={busy || !secret.trim()}
                    className="shrink-0 rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)] disabled:opacity-40"
                    style={{ borderColor: "var(--line-strong)" }}
                  >
                    Save
                  </button>
                </div>
              )}
              <p className="mt-1 text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
                Stored as <span className="font-mono">{preset.apiKeyEnv}</span> outside the
                database.
              </p>
            </div>
          )}

          {preset.id === "custom" && (
            <Field label="Name" value={name} onChange={setName} placeholder="What to call it" />
          )}

          {editableUrl && (
            <Field
              label="Base URL"
              value={baseUrl}
              onChange={setBaseUrl}
              placeholder="https://…/v1"
              mono
            />
          )}

          <div className="mb-3">
            <span
              className="mb-1 block text-[0.6875rem] font-medium uppercase tracking-wider"
              style={{ color: "var(--ink-3)" }}
            >
              Model
            </span>
            {model && (
              <p className="mb-1.5 font-mono text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
                {model}
              </p>
            )}
            <ModelPicker
              value={model}
              onPick={setModel}
              load={canList ? loadModels : null}
              autoLoad={canList && !model}
              blocked={
                needsKey && !hasKey
                  ? "Add a key above to see what this provider has."
                  : "Give it a base URL to see what it is serving."
              }
            />
          </div>

          {failure && (
            <p className="mb-2 text-[0.75rem]" style={{ color: "var(--danger)" }}>
              {failure}
            </p>
          )}

          <button
            type="button"
            onClick={() => void use()}
            disabled={busy || !model.trim()}
            className="rounded-[var(--radius-sm)] px-3 py-1 text-[0.75rem] font-medium disabled:opacity-40"
            style={{ background: "var(--ink)", color: "var(--paper)" }}
          >
            {connection ? "Update" : "Add"} {preset.label}
          </button>
        </div>
      )}
    </li>
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
    <label className="mb-3 block">
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
    </label>
  );
}
