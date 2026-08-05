/**
 * The spine.
 *
 * Threads first, grouped by when they were last touched, because that is what
 * people actually navigate by. Projects sit below as contexts you can drop
 * into — not folders that conversations have to be filed in first. A thread
 * with no project is the normal case, not an orphan.
 */

import { useState } from "react";

import type { ProjectView, ThreadView } from "../lib/api";

export type Surface =
  | { kind: "thread"; id: string }
  | { kind: "project"; id: string }
  | { kind: "memory" }
  | { kind: "skills" }
  | { kind: "connections" }
  | { kind: "settings" };

interface SidebarProps {
  threads: ThreadView[];
  projects: ProjectView[];
  surface: Surface;
  onSelect: (surface: Surface) => void;
  onNewChat: () => void;
  onNewProject: (name: string) => Promise<void>;
  /** Absent when no agent is installed, or no project has a directory. */
  onNewCodeSession?: () => void;
  onSearch: () => void;
  /** Below `md` the rail is a drawer; at `md` and up it is always present. */
  open: boolean;
  onClose: () => void;
}

/** Buckets by recency. Empty groups are dropped by the caller. */
function group(threads: ThreadView[]): { label: string; items: ThreadView[] }[] {
  const now = Date.now();
  const day = 86_400_000;
  const buckets: Record<string, ThreadView[]> = {
    Today: [],
    Yesterday: [],
    "Previous 7 days": [],
    Older: [],
  };

  for (const thread of threads) {
    const age = now - thread.updatedAt;
    if (age < day) buckets.Today!.push(thread);
    else if (age < day * 2) buckets.Yesterday!.push(thread);
    else if (age < day * 7) buckets["Previous 7 days"]!.push(thread);
    else buckets.Older!.push(thread);
  }

  return Object.entries(buckets)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}

export function Sidebar({
  threads,
  projects,
  surface,
  onSelect,
  onNewChat,
  onNewProject,
  onNewCodeSession,
  onSearch,
  open,
  onClose,
}: SidebarProps) {
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");

  const cancel = () => {
    setNaming(false);
    setDraft("");
  };

  const create = async () => {
    const name = draft.trim();
    if (!name) return cancel();
    cancel();
    await onNewProject(name);
  };

  return (
    <>
      {/* Only reachable below md, where the rail floats over the content. */}
      {open && (
        <div
          aria-hidden
          onClick={onClose}
          className="fixed inset-0 z-30 md:hidden"
          style={{ background: "color-mix(in srgb, var(--ink) 30%, transparent)" }}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[16.5rem] shrink-0 flex-col border-r transition-transform md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ background: "var(--wash)", borderColor: "var(--line)" }}
      >
        <div className="px-3 pb-1 pt-3.5">
          <p className="px-1.5 pb-3 text-[0.8125rem] font-semibold tracking-tight">ModelDock</p>

          <button
            type="button"
            onClick={onNewChat}
            className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[0.8125rem] transition-colors hover:bg-[var(--surface)]"
            style={{ borderColor: "var(--line-strong)" }}
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
            </svg>
            New chat
          </button>

          {/* Hidden entirely when there is no agent installed or no project with
            a directory — not shown disabled. Neither is a broken state. */}
          {onNewCodeSession && (
            <button
              type="button"
              onClick={onNewCodeSession}
              className="mt-1.5 flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[0.8125rem] transition-colors hover:bg-[var(--surface)]"
              style={{ color: "var(--ink-2)" }}
            >
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className="size-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path
                  d="M6 4.5L2.5 8L6 11.5M10 4.5L13.5 8L10 11.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              New code session
            </button>
          )}

          <button
            type="button"
            onClick={onSearch}
            className="mt-1.5 flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[0.8125rem] transition-colors hover:bg-[var(--surface)]"
            style={{ color: "var(--ink-2)" }}
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="7" cy="7" r="4" />
              <path d="M10 10l3 3" strokeLinecap="round" />
            </svg>
            Search
            <kbd className="ml-auto font-mono text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
              ⌘K
            </kbd>
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {threads.length === 0 && (
            <p className="px-1.5 py-2 text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
              No conversations yet.
            </p>
          )}

          {group(threads).map(({ label, items }) => (
            <div key={label} className="mb-3">
              <p
                className="px-1.5 pb-1 text-[0.6875rem] font-medium uppercase tracking-wider"
                style={{ color: "var(--ink-3)" }}
              >
                {label}
              </p>
              {items.map((thread) => (
                <Row
                  key={thread.id}
                  active={surface.kind === "thread" && surface.id === thread.id}
                  onClick={() => onSelect({ kind: "thread", id: thread.id })}
                >
                  {thread.title ?? "New chat"}
                </Row>
              ))}
            </div>
          ))}

          {/* Rendered even when empty: until this group exists there is nowhere
            to discover that projects are a thing, let alone make one. */}
          <div className="group/projects mb-3">
            <div className="flex items-center justify-between px-1.5 pb-1">
              <p
                className="text-[0.6875rem] font-medium uppercase tracking-wider"
                style={{ color: "var(--ink-3)" }}
              >
                Projects
              </p>
              {!naming && (
                <button
                  type="button"
                  aria-label="New project"
                  onClick={() => setNaming(true)}
                  className="text-[0.8125rem] leading-none opacity-0 transition-opacity focus:opacity-100 group-hover/projects:opacity-100"
                  style={{ color: "var(--ink-3)" }}
                >
                  +
                </button>
              )}
            </div>

            {naming && (
              <input
                autoFocus
                value={draft}
                placeholder="Project name"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={cancel}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void create();
                  if (event.key === "Escape") cancel();
                }}
                className="mb-1 w-full rounded-[var(--radius-sm)] px-1.5 py-1 text-[0.8125rem] outline-none placeholder:text-[var(--ink-3)]"
                style={{ background: "var(--surface)", boxShadow: "inset 0 0 0 1px var(--line)" }}
              />
            )}

            {projects.map((project) => (
              <Row
                key={project.id}
                active={surface.kind === "project" && surface.id === project.id}
                onClick={() => onSelect({ kind: "project", id: project.id })}
              >
                {project.name}
              </Row>
            ))}

            {projects.length === 0 && !naming && (
              <Row active={false} onClick={() => setNaming(true)}>
                New project
              </Row>
            )}
          </div>
        </nav>

        <div className="border-t px-3 py-2" style={{ borderColor: "var(--line)" }}>
          <Row active={surface.kind === "memory"} onClick={() => onSelect({ kind: "memory" })}>
            Memory
          </Row>
          <Row active={surface.kind === "skills"} onClick={() => onSelect({ kind: "skills" })}>
            Skills
          </Row>
          <Row
            active={surface.kind === "connections"}
            onClick={() => onSelect({ kind: "connections" })}
          >
            Connections
          </Row>
          <Row active={surface.kind === "settings"} onClick={() => onSelect({ kind: "settings" })}>
            Settings
          </Row>
        </div>
      </aside>
    </>
  );
}

function Row({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className="block w-full truncate rounded-[var(--radius-sm)] px-1.5 py-1 text-left text-[0.8125rem] transition-colors hover:bg-[var(--surface)]"
      style={{
        background: active ? "var(--surface)" : undefined,
        color: active ? "var(--ink)" : "var(--ink-2)",
        boxShadow: active ? "inset 0 0 0 1px var(--line)" : undefined,
      }}
    >
      {children}
    </button>
  );
}
