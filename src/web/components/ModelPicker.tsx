/**
 * Choosing a model.
 *
 * The list is whatever the provider says it has, asked for over the connection
 * you already configured — not a table in this repository, which would be wrong
 * within a month and wrong invisibly. See `providers/models.ts`.
 *
 * The custom option is not a separate mode or a second control. The filter box
 * *is* the custom field: type anything, and if it does not match something in
 * the list you are offered it verbatim. That matters more than it sounds,
 * because the case it covers is the common one — a model released this week, a
 * private deployment name, an endpoint that publishes no list at all — and a
 * picker that can only offer what it was told about would make those the one
 * thing you cannot do.
 *
 * So the listing is an accelerator, never a gate. Every path through this
 * component ends with a model id you could have typed yourself, and a provider
 * that is unreachable, keyless or simply has no `/models` endpoint degrades to
 * exactly that rather than to a dead end.
 *
 * A custom *engine* is the other half of "custom", and deliberately not here.
 * An API ModelDock does not speak at all is a connection of its own, written as
 * a script — see `ScriptEditor.tsx`. This field chooses a model on an engine
 * that already exists, one of those included.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ModelInfo } from "../lib/api";

interface ModelPickerProps {
  value: string | null;
  onPick: (model: string) => void;
  /**
   * How to ask. Null when there is nothing to ask with yet — no key, no base
   * URL — in which case this is a plain text field and says why.
   */
  load: (() => Promise<ModelInfo[]>) | null;
  /** Fetch on mount rather than waiting to be asked. */
  autoLoad?: boolean;
  /** Why listing is unavailable, when `load` is null. */
  blocked?: string | null;
  /** Rows before the list scrolls. The berth is tighter than a settings form. */
  compact?: boolean;
  /**
   * Which models lead. The image picker wants the ones that draw, the chat
   * picker the ones that talk; the rest are always one click away.
   */
  prefer?: "chat" | "image";
}

export function ModelPicker({
  value,
  onPick,
  load,
  autoLoad,
  blocked,
  compact,
  prefer = "chat",
}: ModelPickerProps) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  // A fetch that outlives its component — the berth popover closes constantly —
  // must not set state afterwards.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!load) return;
    setBusy(true);
    setFailure(null);
    try {
      const found = await load();
      if (alive.current) setModels(found);
    } catch (error) {
      if (alive.current) setFailure((error as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [load]);

  useEffect(() => {
    if (autoLoad && load && models === null && !busy && !failure) void refresh();
  }, [autoLoad, load, models, busy, failure, refresh]);

  const typed = query.trim();

  const { shown, hiddenCount } = useMemo(() => {
    const all = models ?? [];
    const matching = typed
      ? all.filter((model) => model.id.toLowerCase().includes(typed.toLowerCase()))
      : all;
    const preferred = matching.filter((model) => (prefer === "image" ? model.image : model.chat));

    // A list with none of the preferred kind — a script that did not say, an
    // endpoint with unusual names — is shown whole, rather than as an empty box
    // with "Show 12 more" under it.
    if (preferred.length === 0) return { shown: matching, hiddenCount: 0 };

    const rest = matching.filter((model) => !preferred.includes(model));
    return {
      shown: showAll ? [...preferred, ...rest] : preferred,
      hiddenCount: rest.length,
    };
  }, [models, typed, showAll, prefer]);

  // Offered whenever what is typed is not already an exact id in the list. This
  // is the whole custom-model affordance, and it is why an unreachable provider
  // is an inconvenience rather than a wall.
  const exact = (models ?? []).some((model) => model.id === typed);
  const offerTyped = typed.length > 0 && !exact;

  const pick = (model: string) => {
    onPick(model);
    setQuery("");
  };

  return (
    <div>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          // Enter takes the one obvious candidate: an exact or single match,
          // otherwise whatever was typed.
          if (shown.length === 1) pick(shown[0]!.id);
          else if (typed) pick(typed);
        }}
        placeholder={models ? "Filter, or type any model id" : "Type a model id"}
        aria-label="Model"
        className="w-full rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[0.8125rem] outline-none placeholder:text-[var(--ink-3)]"
        style={{
          borderColor: "var(--line)",
          background: "var(--paper)",
          fontFamily: "var(--font-mono)",
        }}
      />

      <div
        className="mt-1.5 flex items-center gap-2 text-[0.6875rem]"
        style={{ color: "var(--ink-3)" }}
      >
        {load ? (
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy}
            className="transition-colors hover:text-[var(--ink)] disabled:opacity-50"
          >
            {busy ? "Asking…" : models ? `${models.length} available · refresh` : "List models"}
          </button>
        ) : (
          <span>{blocked ?? "Add a key to list what is available."}</span>
        )}

        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll((current) => !current)}
            className="ml-auto transition-colors hover:text-[var(--ink)]"
          >
            {showAll
              ? prefer === "image"
                ? "Image models only"
                : "Chat models only"
              : `Show ${hiddenCount} more`}
          </button>
        )}
      </div>

      {/*
        A failure here is upstream and usually fixable — a wrong base URL, a
        rejected key, an endpoint with no list at all — so the provider's own
        sentence is shown in full, and the field above still works.
      */}
      {failure && (
        <p className="mt-1.5 text-[0.6875rem]" style={{ color: "var(--danger)" }}>
          {failure}
        </p>
      )}

      {(offerTyped || shown.length > 0) && (
        <ul
          className="mt-1.5 overflow-y-auto rounded-[var(--radius-sm)] border"
          style={{
            borderColor: "var(--line)",
            maxHeight: compact ? "11rem" : "15rem",
            background: "var(--paper)",
          }}
        >
          {offerTyped && (
            <li>
              <button
                type="button"
                onClick={() => pick(typed)}
                className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--wash)]"
              >
                <span className="truncate font-mono text-[0.75rem]">{typed}</span>
                <span
                  className="ml-auto shrink-0 text-[0.6875rem]"
                  style={{ color: "var(--ink-3)" }}
                >
                  use as typed
                </span>
              </button>
            </li>
          )}

          {shown.map((model) => (
            <li key={model.id}>
              <button
                type="button"
                onClick={() => pick(model.id)}
                aria-current={model.id === value ? "true" : undefined}
                className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--wash)]"
                style={{ background: model.id === value ? "var(--wash)" : undefined }}
              >
                <span className="truncate font-mono text-[0.75rem]">{model.id}</span>
                {model.label && model.label !== model.id && (
                  <span
                    className="ml-auto shrink-0 truncate text-[0.6875rem]"
                    style={{ color: "var(--ink-3)" }}
                  >
                    {model.label}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
