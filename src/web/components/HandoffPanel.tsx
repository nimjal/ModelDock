/**
 * Connect your tools.
 *
 * ModelDock serves every model this machine can reach on one local endpoint,
 * in both wire protocols, so Claude Code and OpenCode can run on any of them.
 * This panel is the button that sets that up — and the preview that has to come
 * before it.
 *
 * ## Why a diff and not just a button
 *
 * This is the only place ModelDock writes outside its own directory, into files
 * people have hand-edited and care about. So the interaction is deliberately
 * three steps rather than one: see exactly what would change, apply it, and be
 * told where the backup went. "Undo" is a first-class control next to "Apply"
 * rather than something to look up afterwards.
 *
 * The diff uses no colour. Added and removed lines are marked with `+` and `−`
 * and separated by weight and a rule — the berth still owns the only saturated
 * thing on screen, and a red/green diff would be two more.
 */

import { useCallback, useEffect, useState } from "react";

import { api, type HandoffTarget, type HandoffView } from "../lib/api";

export function HandoffPanel() {
  const [view, setView] = useState<HandoffView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.handoff());
    } catch (error) {
      setFailure((error as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (kind: string, what: "apply" | "revert") => {
    setBusy(kind);
    setFailure(null);
    setNote(null);
    try {
      const result =
        what === "apply" ? await api.applyHandoff(kind) : await api.revertHandoff(kind);
      setNote(
        what === "apply"
          ? `${result.plan.label}: ${result.plan.after}${
              result.backupPath ? ` A copy of the original is at ${result.backupPath}.` : ""
            }`
          : `${result.plan.label} no longer points at ModelDock.`,
      );
      setOpen(null);
      await load();
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!view) {
    return (
      <section className="mb-8">
        <h2 className="mb-2 text-[0.8125rem] font-medium">Connect your tools</h2>
        <p className="text-[0.8125rem]" style={{ color: "var(--ink-3)" }}>
          {failure ?? "Loading…"}
        </p>
      </section>
    );
  }

  const { gateway, targets } = view;

  return (
    <section className="mb-8">
      <h2 className="mb-1 text-[0.8125rem] font-medium">Connect your tools</h2>
      <p className="mb-3 text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
        ModelDock serves every model it can reach —{" "}
        <strong style={{ fontWeight: 500 }}>{gateway.modelCount}</strong> right now — on one local
        endpoint, speaking both the OpenAI and Anthropic protocols. Point a coding agent at it and
        it runs on your connections, with the keys staying here.
      </p>

      <div className="mb-4 flex flex-col">
        {targets.map((target) => (
          <Target
            key={target.kind}
            target={target}
            busy={busy === target.kind}
            open={open === target.kind}
            onToggle={() => setOpen((current) => (current === target.kind ? null : target.kind))}
            onApply={() => void act(target.kind, "apply")}
            onRevert={() => void act(target.kind, "revert")}
          />
        ))}
      </div>

      {note && (
        <p className="mb-3 text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
          {note}
        </p>
      )}
      {failure && (
        <p className="mb-3 text-[0.75rem]" style={{ color: "var(--danger)" }}>
          {failure}
        </p>
      )}

      <Manual gateway={gateway} onRotated={() => void load()} />

      {gateway.problems.length > 0 && (
        <div className="mt-4">
          <p
            className="mb-1 text-[0.6875rem] font-medium uppercase tracking-wider"
            style={{ color: "var(--ink-3)" }}
          >
            Not included
          </p>
          {/*
            A connection that could not be listed is named rather than silently
            missing — the same instinct as `doctor`. Its own configured model is
            still exported; only its full catalogue is absent.
          */}
          {gateway.problems.map((problem) => (
            <p
              key={problem.connection}
              className="text-[0.75rem]"
              style={{ color: "var(--ink-2)" }}
            >
              <span style={{ color: "var(--ink)" }}>{problem.connection}</span> — {problem.problem}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

function Target({
  target,
  busy,
  open,
  onToggle,
  onApply,
  onRevert,
}: {
  target: HandoffTarget;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onApply: () => void;
  onRevert: () => void;
}) {
  const changes = target.diff.filter((line) => line.kind !== "same").length;

  return (
    <div className="border-b py-3 last:border-b-0" style={{ borderColor: "var(--line)" }}>
      <div className="flex items-baseline gap-2">
        <span className="text-[0.8125rem] font-medium">{target.label}</span>
        {target.applied && (
          <span className="text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
            connected
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {!target.problem && !target.applied && (
            <button
              type="button"
              onClick={onToggle}
              className="text-[0.6875rem] transition-colors hover:text-[var(--ink)]"
              style={{ color: "var(--ink-3)" }}
            >
              {open ? "Hide changes" : `Preview ${changes} line${changes === 1 ? "" : "s"}`}
            </button>
          )}

          {target.applied ? (
            <button
              type="button"
              onClick={onRevert}
              disabled={busy}
              className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)] disabled:opacity-40"
              style={{ borderColor: "var(--line)" }}
            >
              {busy ? "Working…" : "Disconnect"}
            </button>
          ) : (
            <button
              type="button"
              onClick={onApply}
              disabled={busy || Boolean(target.problem)}
              className="rounded-[var(--radius-sm)] px-2.5 py-1 text-[0.75rem] transition-opacity hover:opacity-85 disabled:opacity-40"
              style={{ background: "var(--ink)", color: "var(--paper)" }}
            >
              {busy ? "Writing…" : target.exists ? "Connect" : "Create config"}
            </button>
          )}
        </div>
      </div>

      <p className="mt-0.5 text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
        {target.problem ?? target.hint}
      </p>
      <p className="mt-0.5 break-all font-mono text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
        {target.path}
        {target.exists ? "" : " — will be created"}
      </p>

      {open && !target.problem && <Diff target={target} />}
    </div>
  );
}

/**
 * The change, in full.
 *
 * Unchanged lines around a change are kept so the edit can be located in its
 * file; long stretches of them are collapsed, because an OpenCode config with
 * two hundred model entries is not something anyone reads top to bottom.
 */
function Diff({ target }: { target: HandoffTarget }) {
  const lines = collapse(target.diff);

  return (
    <div
      className="scroll-x mt-2 max-h-[22rem] overflow-y-auto rounded-[var(--radius-sm)] border"
      style={{ borderColor: "var(--line)", background: "var(--paper)" }}
    >
      <pre className="px-2.5 py-2 font-mono text-[0.6875rem] leading-relaxed">
        {lines.map((row) =>
          row.line === null ? (
            <div key={row.key} className="my-1 border-t" style={{ borderColor: "var(--line)" }} />
          ) : (
            <div
              key={row.key}
              style={{
                color:
                  row.line.kind === "same"
                    ? "var(--ink-3)"
                    : row.line.kind === "add"
                      ? "var(--ink)"
                      : "var(--ink-2)",
                fontWeight: row.line.kind === "add" ? 500 : 400,
                textDecoration: row.line.kind === "remove" ? "line-through" : undefined,
              }}
            >
              {row.line.kind === "add" ? "+ " : row.line.kind === "remove" ? "− " : "  "}
              {row.line.text}
            </div>
          ),
        )}
      </pre>
    </div>
  );
}

/** A row to render: a diff line, or `null` standing for an elided run. */
interface DiffRow {
  /**
   * Derived from the line's position in the *source* diff and its content,
   * which together identify it uniquely and do not shift when the rendered
   * list collapses differently — unlike the rendered index, which does.
   */
  key: string;
  line: HandoffTarget["diff"][number] | null;
}

/** Keep three unchanged lines either side of an edit; elide the rest. */
function collapse(diff: HandoffTarget["diff"]): DiffRow[] {
  const keep = new Set<number>();
  diff.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let i = Math.max(0, index - 3); i <= Math.min(diff.length - 1, index + 3); i++) {
      keep.add(i);
    }
  });

  const out: DiffRow[] = [];
  let elided = false;
  diff.forEach((line, index) => {
    if (keep.has(index)) {
      out.push({ key: `${index}:${line.kind}:${line.text}`, line });
      elided = false;
    } else if (!elided) {
      out.push({ key: `gap:${index}`, line: null });
      elided = true;
    }
  });
  return out;
}

/** For anything ModelDock has no button for — which is most tools. */
function Manual({
  gateway,
  onRotated,
}: {
  gateway: HandoffView["gateway"];
  onRotated: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="border-t pt-3" style={{ borderColor: "var(--line)" }}>
      <button
        type="button"
        onClick={() => setShown((value) => !value)}
        className="text-[0.75rem] transition-colors hover:text-[var(--ink)]"
        style={{ color: "var(--ink-3)" }}
      >
        {shown ? "Hide endpoint details" : "Set up something else by hand"}
      </button>

      {shown && (
        <div className="mt-2 flex flex-col gap-2">
          <Field label="OpenAI-compatible base URL" value={gateway.openaiBaseUrl} />
          <Field label="Anthropic base URL" value={gateway.anthropicBaseUrl} />
          <Field
            label="API key / token"
            value={revealed ? gateway.token : "•".repeat(24)}
            copy={gateway.token}
            action={
              <button
                type="button"
                onClick={() => setRevealed((value) => !value)}
                className="text-[0.6875rem] transition-colors hover:text-[var(--ink)]"
                style={{ color: "var(--ink-3)" }}
              >
                {revealed ? "Hide" : "Show"}
              </button>
            }
          />

          <p className="text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
            Models are named <code className="font-mono">&lt;connection&gt;/&lt;model&gt;</code>.
            The token only works on this machine and is stored at {gateway.tokenPath}.{" "}
            <button
              type="button"
              onClick={() => {
                void api.rotateGatewayToken().then(onRotated);
              }}
              className="underline transition-colors hover:text-[var(--ink)]"
            >
              Rotate it
            </button>{" "}
            if you have pasted it somewhere you regret — every tool above will need connecting
            again.
          </p>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  copy,
  action,
}: {
  label: string;
  value: string;
  copy?: string;
  action?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <p className="text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
        {label}
      </p>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded-[var(--radius-sm)] border px-2 py-1 font-mono text-[0.75rem]"
          style={{ borderColor: "var(--line)", background: "var(--paper)" }}
        >
          {value}
        </code>
        {action}
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(copy ?? value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          className="shrink-0 text-[0.6875rem] transition-colors hover:text-[var(--ink)]"
          style={{ color: "var(--ink-3)" }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
