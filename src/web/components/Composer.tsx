/**
 * The input.
 *
 * Grows with what is typed up to a ceiling, then scrolls. Enter sends and
 * Shift+Enter breaks the line — the convention every chat interface shares,
 * and not worth being clever about.
 */

import { useEffect, useRef, useState } from "react";

import type { PermissionLevel } from "../lib/api";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  placeholder: string;
  disabled?: boolean;
  /** Waiting on an approval above, which is a different thing from busy. */
  waiting?: boolean;
  /** Present only on a coding session; a chat has nothing to permit. */
  permission?: PermissionLevel;
  onPermission?: (level: PermissionLevel) => void;
  /**
   * The levels *this* thread's agent can honour, from `GET /agents`.
   *
   * Sent by the server rather than assumed here, because it varies: only the
   * built-in engine can pause between choosing a tool and running it, so only
   * it offers "Ask each time".
   */
  levels?: PermissionLevel[];
}

const MAX_HEIGHT = 320;

/**
 * How much the agent may do this run.
 *
 * The labels and hints come from the server — `permissions.ts` is the single
 * statement of what a level means, and it travels here through `GET /agents`.
 * This copy is the fallback for a failed fetch, and deliberately does not
 * include "Ask each time": an agent that cannot honour it must never be offered
 * it, and a hard-coded list cannot know which agent this is.
 *
 * Styled like every other quiet control here — mono, `--ink-3`, no colour,
 * because Code is not a different app.
 */
const FALLBACK_LEVELS: { value: PermissionLevel; label: string; hint: string }[] = [
  { value: "read", label: "Read only", hint: "Reads files in this project. Changes nothing." },
  { value: "edit", label: "Edit files", hint: "Writes files in this project. No shell." },
  {
    value: "full",
    label: "Edit and run",
    hint: "Writes files and runs commands. A shell can reach outside the project.",
  },
];

/**
 * Offered only where an agent says it can honour it.
 *
 * Last in the list rather than after "Edit files", because it is not further
 * along the ladder — it is "Edit and run" with a stop before each call.
 */
const EXTRA_LEVELS: { value: PermissionLevel; label: string; hint: string }[] = [
  {
    value: "ask",
    label: "Ask each time",
    hint: "Writes files and runs commands here, and asks before each one.",
  },
];

function Level({
  value,
  onChange,
  levels,
}: {
  value: PermissionLevel;
  onChange: (level: PermissionLevel) => void;
  levels: { value: PermissionLevel; label: string; hint: string }[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Same dismissal mechanics as the Berth popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = levels.find((level) => level.value === value) ?? levels[0]!;

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="font-mono text-[0.6875rem] transition-colors hover:text-[var(--ink)]"
        style={{ color: "var(--ink-3)" }}
      >
        {current.label} ▾
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-30 mb-1.5 w-[15rem] rounded-[var(--radius)] border p-1 shadow-lg"
          style={{ background: "var(--surface)", borderColor: "var(--line)" }}
        >
          {levels.map((level) => (
            <button
              key={level.value}
              type="button"
              role="option"
              aria-selected={level.value === value}
              onClick={() => {
                onChange(level.value);
                setOpen(false);
              }}
              className="block w-full rounded-[var(--radius-sm)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--wash)]"
            >
              <span
                className="block text-[0.8125rem]"
                style={{ color: level.value === value ? "var(--ink)" : "var(--ink-2)" }}
              >
                {level.label}
              </span>
              <span className="block text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
                {level.hint}
              </span>
            </button>
          ))}
          <p
            className="px-2 pb-1 pt-1.5 text-[0.6875rem]"
            style={{ color: "var(--ink-3)", borderTop: "1px solid var(--line)" }}
          >
            Never outside this project&rsquo;s directory, at any level.
          </p>
        </div>
      )}
    </div>
  );
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  placeholder,
  disabled,
  waiting,
  permission,
  onPermission,
  levels,
}: ComposerProps) {
  const field = useRef<HTMLTextAreaElement>(null);

  // Narrowed to what this agent can honour, keeping the server's own wording.
  const offered = levels?.length
    ? FALLBACK_LEVELS.concat(EXTRA_LEVELS).filter((level) => levels.includes(level.value))
    : FALLBACK_LEVELS;

  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  return (
    <div
      className="rounded-[var(--radius)] border transition-shadow focus-within:border-[var(--line-strong)]"
      style={{ background: "var(--surface)", borderColor: "var(--line)" }}
    >
      <textarea
        ref={field}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!busy && value.trim()) onSend();
          }
        }}
        className="block w-full resize-none bg-transparent px-3.5 pb-1.5 pt-3 text-[0.9375rem] outline-none placeholder:text-[var(--ink-3)] disabled:opacity-50"
        style={{ maxHeight: MAX_HEIGHT }}
      />

      <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
        <div className="flex min-w-0 items-center gap-3">
          {/* Only on a coding session. A chat has nothing to permit. */}
          {permission && onPermission && (
            <Level value={permission} onChange={onPermission} levels={offered} />
          )}
          <span className="truncate text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
            {waiting
              ? "Waiting on you — approve the command above."
              : "Enter to send · Shift+Enter for a new line"}
          </span>
        </div>

        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)]"
            style={{ borderColor: "var(--line)" }}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !value.trim()}
            className="rounded-[var(--radius-sm)] px-3 py-1 text-[0.75rem] font-medium transition-opacity disabled:opacity-30"
            style={{ background: "var(--ink)", color: "var(--paper)" }}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
