/**
 * The berth: what is currently docked.
 *
 * This is the only saturated colour in ModelDock. Everything else — sidebar,
 * messages, panels — stays in the neutral range on purpose, so that switching
 * from Claude to a local Llama re-tints exactly one dot and moves nothing
 * else. That restraint *is* the argument: the workspace is yours and constant,
 * and the engine is a detail you can change without disturbing it.
 *
 * A connection whose key is missing shows the same shape with a hollow dot
 * rather than an error state, because "not set up yet" is a normal condition
 * on a machine with four providers configured and one key exported.
 */

import { useEffect, useRef, useState } from "react";

import type { AgentView, ConnectionView } from "../lib/api";

interface BerthProps {
  connection: ConnectionView | null;
  /** Set on a coding session, where the agent picks its own model. */
  agent?: AgentView | null;
  model: string | null;
  connections: ConnectionView[];
  onSelect: (connectionId: string, model?: string) => void;
  disabled?: boolean;
}

/**
 * A coding session, shown in the same chip with no colour at all.
 *
 * That is the honest signal and worth stating plainly: colour here means
 * ModelDock chose the model. An agent chooses its own, so it gets ink and a
 * hollow dot. Giving Code its own accent would say the opposite.
 */
function AgentBerth({ agent, model }: { agent: AgentView; model: string | null }) {
  return (
    <div
      className="flex items-center gap-2 rounded-[var(--radius)] border px-2.5 py-1.5 text-[0.8125rem]"
      style={{ borderColor: "var(--line)" }}
      title={agent.problem ?? agent.hint}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ boxShadow: "inset 0 0 0 1.5px var(--ink-3)" }}
      />
      <span className="font-mono tracking-tight" style={{ color: "var(--ink-2)" }}>
        {agent.label}
      </span>
      {model && (
        <>
          <span aria-hidden style={{ color: "var(--ink-3)" }}>
            ·
          </span>
          <span className="font-mono tracking-tight" style={{ color: "var(--ink-3)" }}>
            {model}
          </span>
        </>
      )}
    </div>
  );
}

export function Berth({ connection, agent, model, connections, onSelect, disabled }: BerthProps) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const previous = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const shownModel = model || connection?.model || null;

  // The one orchestrated moment in the app: on a provider change the chip
  // takes its new colour and the label swaps. Nothing else animates, which is
  // what makes this legible rather than decorative.
  useEffect(() => {
    if (previous.current && previous.current !== connection?.id) {
      setFlash(true);
      const timer = window.setTimeout(() => setFlash(false), 480);
      return () => window.clearTimeout(timer);
    }
    previous.current = connection?.id ?? null;
  }, [connection?.id]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const accent = connection?.ready ? connection.accent : "var(--ink-3)";

  // On a coding session there is nothing to dock: the agent is fixed for the
  // thread and picks its own model, so the chip becomes a label.
  if (agent) return <AgentBerth agent={agent} model={model} />;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="group flex items-center gap-2 rounded-[var(--radius)] border px-2.5 py-1.5 text-[0.8125rem] transition-colors hover:bg-[var(--wash)] disabled:opacity-50"
        style={{ borderColor: "var(--line)" }}
      >
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full transition-[background-color,box-shadow] duration-500"
          style={{
            background: connection?.ready ? accent : "transparent",
            boxShadow: connection?.ready
              ? `0 0 0 ${flash ? "4px" : "0px"} color-mix(in srgb, ${accent} 22%, transparent)`
              : `inset 0 0 0 1.5px var(--ink-3)`,
          }}
        />
        <span
          key={connection?.id ?? "none"}
          className="font-mono tracking-tight"
          style={{
            color: connection?.ready ? accent : "var(--ink-2)",
            animation: flash ? "berth-swap 420ms ease-out" : undefined,
          }}
        >
          {connection?.name ?? "No connection"}
        </span>
        {shownModel && (
          <>
            <span aria-hidden style={{ color: "var(--ink-3)" }}>
              ·
            </span>
            <span className="font-mono tracking-tight" style={{ color: "var(--ink-2)" }}>
              {shownModel}
            </span>
          </>
        )}
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="size-3.5 shrink-0 opacity-50"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-30 mt-1.5 w-[19rem] overflow-hidden rounded-[var(--radius)] border shadow-lg"
          style={{ background: "var(--surface)", borderColor: "var(--line)" }}
        >
          <p
            className="px-3 pb-1.5 pt-2.5 text-[0.6875rem] font-medium uppercase tracking-wider"
            style={{ color: "var(--ink-3)" }}
          >
            Docked engine
          </p>

          {connections.length === 0 && (
            <p className="px-3 pb-3 text-[0.8125rem]" style={{ color: "var(--ink-2)" }}>
              No connections yet.
            </p>
          )}

          {connections.map((item) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={item.id === connection?.id}
              onClick={() => {
                onSelect(item.id);
                setOpen(false);
              }}
              className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--wash)]"
            >
              <span
                aria-hidden
                className="mt-1.5 size-2 shrink-0 rounded-full"
                style={{
                  background: item.ready ? item.accent : "transparent",
                  boxShadow: item.ready ? undefined : "inset 0 0 0 1.5px var(--ink-3)",
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate text-[0.8125rem] font-medium">{item.name}</span>
                  {item.id === connection?.id && (
                    <span className="text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
                      current
                    </span>
                  )}
                </span>
                <span
                  className="block truncate font-mono text-[0.6875rem]"
                  style={{ color: "var(--ink-3)" }}
                >
                  {item.model}
                </span>
                {!item.ready && item.problem && (
                  <span className="mt-0.5 block text-[0.6875rem]" style={{ color: "var(--ink-2)" }}>
                    {item.problem}
                  </span>
                )}
              </span>
            </button>
          ))}

          <p
            className="border-t px-3 py-2 text-[0.6875rem]"
            style={{ borderColor: "var(--line)", color: "var(--ink-3)" }}
          >
            Switching keeps this conversation. Only the next reply changes.
          </p>
        </div>
      )}
    </div>
  );
}
