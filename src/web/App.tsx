/**
 * The shell.
 *
 * Holds the three things every surface needs — threads, projects, connections
 * — and the current surface. State lives here rather than in a store because
 * there is not much of it and a router would be ceremony for an app with one
 * window and no URLs to share.
 *
 * The header is the same in every surface: what is docked, on the right,
 * always. It is the only place colour appears.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Berth } from "./components/Berth";
import { ChatViewLoader } from "./components/ChatView";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectionsPanel } from "./components/ConnectionsPanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { ProjectPanel } from "./components/ProjectPanel";
import { SettingsPanel, type Theme } from "./components/SettingsPanel";
import { Sidebar, type Surface } from "./components/Sidebar";
import { SkillsPanel } from "./components/SkillsPanel";
import {
  api,
  type AgentView,
  type ConnectionView,
  type ProjectView,
  type ThreadView,
} from "./lib/api";

export function App() {
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [surface, setSurface] = useState<Surface>({ kind: "connections" });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("modeldock.theme") as Theme) ?? "system",
  );
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    localStorage.setItem("modeldock.theme", theme);
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);

  const refresh = useCallback(async () => {
    const [threadData, projectData, connectionData, agentData] = await Promise.all([
      api.threads(),
      api.projects(),
      api.connections(),
      // Detection is cached server-side, so this is cheap after the first call.
      // A failure here must not take the whole app down: no agents simply
      // means the Code entry point stays hidden.
      api.agents().catch(() => ({ agents: [] as AgentView[] })),
    ]);
    setThreads(threadData.threads);
    setProjects(projectData.projects);
    setConnections(connectionData.connections);
    setAgents(agentData.agents);
    return threadData.threads;
  }, []);

  // Open on the most recent conversation, or on Connections if there is
  // nothing to reach yet — the one screen that can actually be acted on.
  //
  // Guarded because this creates a row: StrictMode runs effects twice in
  // development, and without the latch that means two empty threads on every
  // start.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    void (async () => {
      const [threadData, connectionData] = await Promise.all([api.threads(), api.connections()]);
      const ready = connectionData.connections.some((item) => item.ready);
      if (threadData.threads[0]) {
        setSurface({ kind: "thread", id: threadData.threads[0].id });
      } else if (ready) {
        const { thread } = await api.createThread({});
        setSurface({ kind: "thread", id: thread.id });
      }
      await refresh();
      setBooted(true);
    })();
  }, [refresh]);

  const activeThread =
    surface.kind === "thread" ? threads.find((item) => item.id === surface.id) : undefined;
  const activeProject =
    surface.kind === "project"
      ? projects.find((item) => item.id === surface.id)
      : activeThread?.projectId
        ? projects.find((item) => item.id === activeThread.projectId)
        : undefined;

  const activeConnection =
    connections.find((item) => item.id === activeThread?.connectionId) ??
    connections.find((item) => item.id === activeProject?.defaultConnectionId) ??
    connections.find((item) => item.ready) ??
    connections[0] ??
    null;

  const activeAgent = agents.find((item) => item.id === activeThread?.agentId) ?? null;

  /**
   * Whether a coding session can be started at all.
   *
   * Both halves are required, and if either is missing the entry point is
   * hidden rather than shown disabled: an agent that is not installed and a
   * project with no directory are both "not applicable here", not "broken".
   */
  const readyAgent = agents.find((item) => item.ready) ?? null;
  const codeable = projects.filter((item) => item.directory);
  const canCode = Boolean(readyAgent) && codeable.length > 0;

  const newChat = async (projectId?: string) => {
    const { thread } = await api.createThread({ projectId: projectId ?? null });
    await refresh();
    setSurface({ kind: "thread", id: thread.id });
  };

  const newCodeSession = async (projectId?: string) => {
    const project = projectId
      ? projects.find((item) => item.id === projectId)
      : activeProject?.directory
        ? activeProject
        : codeable[0];
    if (!readyAgent || !project?.directory) return;

    const { thread } = await api.createThread({
      projectId: project.id,
      agentId: readyAgent.id,
      permission: "read",
    });
    await refresh();
    setSurface({ kind: "thread", id: thread.id });
  };

  /**
   * The swap. One column changes; the conversation is untouched.
   *
   * Outside a thread there is nothing to re-point, so picking a connection
   * starts a chat on it — which is what someone choosing an engine from an
   * empty screen is asking for anyway.
   */
  const dock = async (connectionId: string) => {
    if (activeThread) {
      await api.updateThread(activeThread.id, { connectionId, model: null });
      await refresh();
      return;
    }
    const { thread } = await api.createThread({ connectionId });
    await refresh();
    setSurface({ kind: "thread", id: thread.id });
  };

  const newProject = async (name: string) => {
    const { project } = await api.createProject({ name });
    await refresh();
    setSurface({ kind: "project", id: project.id });
  };

  const remember = async (text: string) => {
    const title = text.replace(/\s+/g, " ").trim().slice(0, 90);
    await api.createMemory({
      title,
      body: "",
      scope: activeProject ? "project" : "global",
      projectId: activeProject?.id ?? null,
      sourceThreadId: activeThread?.id ?? null,
    });
  };

  // Picking anything on a phone should also dismiss the drawer it was picked
  // from; at md and up the rail is permanent and this is a no-op.
  const goTo = (next: Surface) => {
    setSurface(next);
    setNavOpen(false);
  };

  return (
    <div className="flex h-full">
      <Sidebar
        threads={threads}
        projects={projects}
        surface={surface}
        onSelect={goTo}
        onNewChat={() => void newChat()}
        onNewProject={newProject}
        onNewCodeSession={canCode ? () => void newCodeSession() : undefined}
        onSearch={() => setPaletteOpen(true)}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex h-[3.25rem] shrink-0 items-center gap-3 border-b px-4 md:px-5"
          style={{ borderColor: "var(--line)" }}
        >
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Show conversations"
            className="-ml-1 shrink-0 rounded-[var(--radius-sm)] p-1.5 transition-colors hover:bg-[var(--wash)] md:hidden"
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M2.5 4h11M2.5 8h11M2.5 12h11" strokeLinecap="round" />
            </svg>
          </button>

          <p className="min-w-0 flex-1 truncate text-[0.8125rem]" style={{ color: "var(--ink-2)" }}>
            {activeProject ? (
              <>
                <button
                  type="button"
                  onClick={() => goTo({ kind: "project", id: activeProject.id })}
                  className="transition-colors hover:underline"
                  style={{ color: "var(--ink)" }}
                >
                  {activeProject.name}
                </button>
                {surface.kind === "thread" && activeThread?.title ? ` · ${activeThread.title}` : ""}
              </>
            ) : surface.kind === "thread" ? (
              (activeThread?.title ?? "New chat")
            ) : (
              ""
            )}
          </p>

          <Berth
            connection={activeConnection}
            agent={activeAgent}
            // An agent reports its model per reply, which the message hover
            // row already shows; the chip only names the agent.
            model={activeAgent ? null : (activeThread?.model ?? null)}
            connections={connections}
            onSelect={(id) => void dock(id)}
          />
        </header>

        {/*
          Chat owns its own scrolling — the transcript scrolls while the
          composer stays pinned — so it is not wrapped. Every other surface is
          an ordinary scrolling document.
        */}
        {booted && surface.kind === "thread" ? (
          <ChatViewLoader
            threadId={surface.id}
            connection={activeConnection}
            agent={activeAgent}
            projectName={activeProject?.name ?? null}
            projectDirectory={activeProject?.directory ?? null}
            onThreadChanged={() => void refresh()}
            onRemember={(text) => void remember(text)}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {surface.kind === "project" && activeProject && (
              <ProjectPanel
                project={activeProject}
                projects={projects}
                onOpenThread={(id) => goTo({ kind: "thread", id })}
                onNewThread={(projectId) => void newChat(projectId)}
                onNewCodeSession={
                  readyAgent ? (projectId) => void newCodeSession(projectId) : undefined
                }
                agents={agents}
                onChanged={() => void refresh()}
                // Its conversations survive as loose threads, so landing on
                // the newest one is the least disorienting place to end up.
                onDeleted={() => {
                  void refresh().then((rest) => {
                    setSurface(
                      rest[0] ? { kind: "thread", id: rest[0].id } : { kind: "connections" },
                    );
                  });
                }}
              />
            )}

            {surface.kind === "skills" && <SkillsPanel onChanged={() => void refresh()} />}
            {surface.kind === "memory" && (
              <MemoryPanel projects={projects} onChanged={() => void refresh()} />
            )}

            {surface.kind === "connections" && (
              <ConnectionsPanel onChanged={() => void refresh()} />
            )}

            {surface.kind === "settings" && <SettingsPanel theme={theme} onTheme={setTheme} />}
          </div>
        )}
      </main>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        threads={threads}
        projects={projects}
        onSelect={goTo}
        onNewChat={() => void newChat()}
        onNewProject={() => void newProject("Untitled project")}
        onNewCodeSession={canCode ? () => void newCodeSession() : undefined}
      />
    </div>
  );
}
