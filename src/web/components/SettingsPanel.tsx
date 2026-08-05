/**
 * Settings, and the health report.
 *
 * The checks are the same ones `modeldock doctor` prints. BYOK setups fail
 * for environmental reasons more often than for interesting ones, so the
 * answer to "why isn't this working" should be on screen rather than in a
 * terminal.
 */

import { useEffect, useState } from "react";

import { api, type Check, type PeerView } from "../lib/api";

export type Theme = "system" | "light" | "dark";

export function SettingsPanel({
  theme,
  onTheme,
}: {
  theme: Theme;
  onTheme: (theme: Theme) => void;
}) {
  const [checks, setChecks] = useState<Check[]>([]);
  const [home, setHome] = useState("");
  const [counts, setCounts] = useState({ threads: 0, projects: 0, memories: 0 });

  useEffect(() => {
    void api.health().then((data) => {
      setChecks(data.checks);
      setHome(data.home);
      setCounts(data.counts);
    });
  }, []);

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-8">
      <h1 className="mb-6 text-[1.25rem] font-semibold tracking-tight">Settings</h1>

      <section className="mb-8">
        <h2 className="mb-2 text-[0.8125rem] font-medium">Appearance</h2>
        <div className="flex gap-1.5">
          {(["system", "light", "dark"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onTheme(option)}
              className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] capitalize transition-colors"
              style={{
                borderColor: theme === option ? "var(--line-strong)" : "var(--line)",
                background: theme === option ? "var(--wash)" : undefined,
              }}
            >
              {option}
            </button>
          ))}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-[0.8125rem] font-medium">Status</h2>
        <ul className="flex flex-col">
          {checks.map((check) => (
            <li
              key={check.label}
              className="flex items-start gap-3 border-b py-2"
              style={{ borderColor: "var(--line)" }}
            >
              <span
                aria-hidden
                className="mt-1.5 size-1.5 shrink-0 rounded-full"
                style={{
                  background:
                    check.status === "ok"
                      ? "var(--focus)"
                      : check.status === "warn"
                        ? "var(--ink-3)"
                        : "var(--danger)",
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[0.8125rem]">{check.label}</span>
                <span
                  className="block break-words text-[0.75rem]"
                  style={{ color: "var(--ink-2)" }}
                >
                  {check.detail}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-[0.8125rem] font-medium">Your data</h2>
        <p className="text-[0.8125rem]" style={{ color: "var(--ink-2)" }}>
          {counts.threads} conversations · {counts.projects} projects · {counts.memories} memories,
          in one SQLite file you own:
        </p>
        <p className="mt-1 break-all font-mono text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
          {home}
        </p>
      </section>

      <Devices />
    </div>
  );
}

/**
 * Other machines this store is on.
 *
 * Pairing is a terminal job — it involves a code someone reads off one screen
 * and types on another, and a listener that should not be running unless asked
 * for. What belongs here is the part with no ceremony: seeing what is paired,
 * and catching up now rather than waiting.
 */
function Devices() {
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = () => void api.sync().then((data) => setPeers(data.peers));
  useEffect(load, []);

  const now = async () => {
    setBusy(true);
    setResult(null);
    try {
      const report = await api.syncNow();
      const failed = report.peers.filter((peer) => peer.error);
      setResult(
        failed.length > 0
          ? failed.map((peer) => `${peer.peer}: ${peer.error}`).join(" · ")
          : `Pushed ${report.pushed}, pulled ${report.pulled}.`,
      );
      load();
    } catch (error) {
      setResult((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-[0.8125rem] font-medium">Other devices</h2>

      {peers.length === 0 ? (
        <p className="text-[0.8125rem]" style={{ color: "var(--ink-2)" }}>
          Not paired with anything. Run{" "}
          <code className="font-mono text-[0.75rem]">modeldock pair --host</code> on the machine
          that is usually on, then follow what it prints on the other one.
        </p>
      ) : (
        <>
          <ul className="mb-3 flex flex-col">
            {peers.map((peer) => (
              <li
                key={peer.id}
                className="flex items-center justify-between border-b py-2"
                style={{ borderColor: "var(--line)" }}
              >
                <span className="text-[0.8125rem]">{peer.label}</span>
                <span className="font-mono text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
                  {peer.url || "joins us"}
                </span>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void now()}
              disabled={busy}
              className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)] disabled:opacity-40"
              style={{ borderColor: "var(--line)" }}
            >
              {busy ? "Syncing…" : "Sync now"}
            </button>
            {result && (
              <span className="text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
                {result}
              </span>
            )}
          </div>
        </>
      )}

      <p className="mt-3 text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
        Devices talk directly to each other over your network, with no server in between. The
        connection is not encrypted — over anything but a network you trust, put it behind WireGuard
        or Tailscale.
      </p>
    </section>
  );
}
