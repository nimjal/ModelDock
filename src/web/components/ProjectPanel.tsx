/**
 * A project's own screen.
 *
 * Threads and memory side by side, because those are the two things a project
 * actually is. The directory field binds the file-reading surfaces to a
 * checkout, and reports whether the path it was given is really there — a
 * setting that silently does nothing is worse than one that says why.
 */

import { useCallback, useEffect, useState } from "react";

import {
  api,
  type AgentView,
  type ProjectStatus,
  type ProjectView,
  type ThreadView,
} from "../lib/api";
import { MemoryPanel } from "./MemoryPanel";
import { SkillsPanel } from "./SkillsPanel";

interface ProjectPanelProps {
  project: ProjectView;
  projects: ProjectView[];
  onOpenThread: (id: string) => void;
  onNewThread: (projectId: string) => void;
  /** Absent when no coding agent is installed. */
  onNewCodeSession?: (projectId: string) => void;
  agents?: AgentView[];
  onChanged: () => void;
  onDeleted: () => void;
}

export function ProjectPanel({
  project,
  projects,
  onOpenThread,
  onNewThread,
  onNewCodeSession,
  agents = [],
  onChanged,
  onDeleted,
}: ProjectPanelProps) {
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [tab, setTab] = useState<"threads" | "memory" | "skills" | "settings">("threads");

  const load = useCallback(async () => {
    const data = await api.threads(project.id);
    setThreads(data.threads);
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-8">
      <header className="mb-5">
        <h1 className="text-[1.25rem] font-semibold tracking-tight">{project.name}</h1>
        {project.description && (
          <p className="mt-1 text-[0.8125rem]" style={{ color: "var(--ink-2)" }}>
            {project.description}
          </p>
        )}
      </header>

      <div className="mb-5 flex gap-4 border-b" style={{ borderColor: "var(--line)" }}>
        {(["threads", "memory", "skills", "settings"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className="-mb-px border-b-2 pb-2 text-[0.8125rem] capitalize transition-colors"
            style={{
              borderColor: tab === item ? "var(--ink)" : "transparent",
              color: tab === item ? "var(--ink)" : "var(--ink-3)",
            }}
          >
            {item === "threads" ? "Conversations" : item}
          </button>
        ))}
      </div>

      {tab === "threads" && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onNewThread(project.id)}
              className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)]"
              style={{ borderColor: "var(--line-strong)" }}
            >
              New chat in this project
            </button>

            {/* Only when there is both an agent and a directory to work in. */}
            {onNewCodeSession && project.directory && (
              <button
                type="button"
                onClick={() => onNewCodeSession(project.id)}
                className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-[var(--wash)]"
                style={{ borderColor: "var(--line)", color: "var(--ink-2)" }}
              >
                New code session
              </button>
            )}
          </div>

          {threads.length === 0 ? (
            <p className="text-[0.8125rem]" style={{ color: "var(--ink-3)" }}>
              Nothing here yet.
            </p>
          ) : (
            <ul className="flex flex-col">
              {threads.map((thread) => (
                <li key={thread.id} className="border-b" style={{ borderColor: "var(--line)" }}>
                  <button
                    type="button"
                    onClick={() => onOpenThread(thread.id)}
                    className="w-full truncate py-2.5 text-left text-[0.875rem] transition-colors hover:text-[var(--ink)]"
                  >
                    {thread.title ?? "New chat"}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <Adopt projectId={project.id} onChanged={reload} />
        </>
      )}

      {tab === "memory" && (
        <div className="-mx-5 -mt-8">
          <MemoryPanel projects={projects} projectId={project.id} onChanged={onChanged} />
        </div>
      )}

      {tab === "skills" && (
        <div className="-mx-5 -mt-8">
          <SkillsPanel projectId={project.id} onChanged={onChanged} />
        </div>
      )}

      {tab === "settings" && (
        <ProjectSettings
          project={project}
          agents={agents}
          onChanged={onChanged}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}

/**
 * Move an existing loose conversation into this project.
 *
 * A chat with no project is the normal case here, so the useful direction is
 * adoption after the fact — you realise three messages in that this belongs
 * somewhere. The route already existed; only the affordance was missing.
 */
function Adopt({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [loose, setLoose] = useState<ThreadView[]>([]);

  useEffect(() => {
    if (!open) return;
    void api.threads("none").then((data) => setLoose(data.threads));
  }, [open]);

  const adopt = async (id: string) => {
    await api.updateThread(id, { projectId });
    setLoose((current) => current.filter((thread) => thread.id !== id));
    onChanged();
  };

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-[0.75rem] transition-colors hover:text-[var(--ink)]"
        style={{ color: "var(--ink-3)" }}
      >
        {open ? "Hide" : "Add an existing conversation"}
      </button>

      {open &&
        (loose.length === 0 ? (
          <p className="mt-2 text-[0.8125rem]" style={{ color: "var(--ink-3)" }}>
            Every conversation already belongs to a project.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {loose.map((thread) => (
              <li
                key={thread.id}
                className="group flex items-center gap-3 border-b py-2"
                style={{ borderColor: "var(--line)" }}
              >
                <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
                  {thread.title ?? "New chat"}
                </span>
                <button
                  type="button"
                  onClick={() => void adopt(thread.id)}
                  className="text-[0.6875rem] opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                  style={{ color: "var(--ink-3)" }}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function ProjectSettings({
  project,
  agents,
  onChanged,
  onDeleted,
}: {
  project: ProjectView;
  agents: AgentView[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [directory, setDirectory] = useState(project.directory ?? "");
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [echo, setEcho] = useState("");

  // Re-checked after every save, because the whole point is to tell someone
  // their path is wrong at the moment they typed it.
  const check = useCallback(async () => {
    setStatus(await api.projectStatus(project.id).catch(() => null));
  }, [project.id]);

  useEffect(() => {
    void check();
  }, [check]);

  const save = async () => {
    await api.updateProject(project.id, { name, description, directory });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
    onChanged();
    await check();
  };

  const remove = async () => {
    await api.deleteProject(project.id);
    onDeleted();
  };

  return (
    <div className="max-w-lg">
      <label className="mb-3 block">
        <span
          className="block text-[0.6875rem] font-medium uppercase tracking-wider"
          style={{ color: "var(--ink-3)" }}
        >
          Name
        </span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-1 w-full rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[0.8125rem] outline-none"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}
        />
      </label>

      <label className="mb-3 block">
        <span
          className="block text-[0.6875rem] font-medium uppercase tracking-wider"
          style={{ color: "var(--ink-3)" }}
        >
          Description
        </span>
        <textarea
          value={description}
          rows={2}
          onChange={(event) => setDescription(event.target.value)}
          className="mt-1 w-full resize-none rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[0.8125rem] outline-none"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}
        />
      </label>

      <label className="mb-3 block">
        <span
          className="block text-[0.6875rem] font-medium uppercase tracking-wider"
          style={{ color: "var(--ink-3)" }}
        >
          Directory
        </span>
        <input
          value={directory}
          onChange={(event) => setDirectory(event.target.value)}
          placeholder="Optional"
          className="mt-1 w-full rounded-[var(--radius-sm)] border px-2.5 py-1.5 font-mono text-[0.8125rem] outline-none placeholder:text-[var(--ink-3)]"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}
        />
        <span
          className="mt-1 block text-[0.6875rem]"
          style={{ color: status?.problem ? "var(--danger)" : "var(--ink-3)" }}
        >
          {describe(status)}
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          className="rounded-[var(--radius-sm)] px-3 py-1 text-[0.75rem] font-medium"
          style={{ background: "var(--ink)", color: "var(--paper)" }}
        >
          Save
        </button>
        {saved && (
          <span className="text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
            Saved
          </span>
        )}
      </div>

      {/* What Code would run here. Listed rather than configured: the agent a
          session uses is whichever is ready, and saying which one plainly
          beats a dropdown with one entry. */}
      <div className="mt-8">
        <p
          className="text-[0.6875rem] font-medium uppercase tracking-wider"
          style={{ color: "var(--ink-3)" }}
        >
          Code
        </p>
        {agents.length === 0 ? (
          <p className="mt-1 text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
            No coding agent found. Install OpenCode or Claude Code, then run{" "}
            <span className="font-mono">modeldock doctor</span>.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {agents.map((agent) => (
              <li key={agent.id} className="text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
                {agent.label}
                {agent.version ? ` · ${agent.version}` : ""}
                {agent.ready ? "" : ` — ${agent.problem ?? "not available"}`}
              </li>
            ))}
          </ul>
        )}
        {!project.directory && agents.some((agent) => agent.ready) && (
          <p className="mt-1 text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
            Set a directory above to start a coding session here.
          </p>
        )}
      </div>

      {/* Hidden until wanted, and it asks you to type the name — a project is
          cheap to remake but its memories are not, and there are no modals
          anywhere else in this app to borrow a confirmation from. */}
      <div className="group mt-10 border-t pt-4" style={{ borderColor: "var(--line)" }}>
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-[0.6875rem] opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
            style={{ color: "var(--ink-3)" }}
          >
            Delete this project
          </button>
        ) : (
          <div>
            <p className="text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
              Type <span style={{ color: "var(--ink)" }}>{project.name}</span> to delete it. Its
              conversations become loose rather than going with it. Nothing is lost.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                autoFocus
                value={echo}
                onChange={(event) => setEcho(event.target.value)}
                className="w-56 rounded-[var(--radius-sm)] border px-2.5 py-1 text-[0.8125rem] outline-none"
                style={{ borderColor: "var(--line)", background: "var(--surface)" }}
              />
              <button
                type="button"
                disabled={echo !== project.name}
                onClick={() => void remove()}
                className="rounded-[var(--radius-sm)] px-3 py-1 text-[0.75rem] font-medium transition-opacity disabled:opacity-30"
                style={{ background: "var(--danger)", color: "var(--paper)" }}
              >
                Delete
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  setEcho("");
                }}
                className="text-[0.75rem] transition-colors hover:text-[var(--ink)]"
                style={{ color: "var(--ink-3)" }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One line saying whether the directory is real, in the `doctor` register. */
function describe(status: ProjectStatus | null): string {
  if (!status) return "Checking…";
  if (!status.directory) return "Optional. Set it to let conversations here read the files.";
  if (status.problem) return status.problem;
  if (!status.readable) return "That directory cannot be read.";
  return `Readable${status.isGitRepo ? " · git repo" : ""} · conversations here can read it`;
}
