/**
 * The one place the page talks to the server.
 *
 * Every call goes through `request`, so an error from any route surfaces the
 * server's own message rather than a generic failure. The server writes those
 * messages for people to read — "ANTHROPIC_API_KEY is not set in this
 * environment" is the entire fix, and it should reach the screen intact.
 */

export interface ConnectionView {
  id: string;
  name: string;
  kind: string;
  label: string;
  accent: string;
  baseUrl: string | null;
  model: string;
  apiKeyEnv: string | null;
  apiKeySet: boolean;
  ready: boolean;
  problem: string | null;
}

export interface KindSpec {
  kind: string;
  label: string;
  defaultApiKeyEnv: string | null;
  defaultBaseUrl: string | null;
  baseUrlEditable: boolean;
  requiresApiKey: boolean;
  suggestedModels: string[];
  accent: string;
  hint: string;
}

export interface ProjectView {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  directory: string | null;
  defaultConnectionId: string | null;
  threadCount: number;
  memoryCount: number;
  updatedAt: number;
}

/** Whether a project's directory is really there and really readable. */
export interface ProjectStatus {
  directory: string | null;
  exists: boolean;
  readable: boolean;
  isGitRepo: boolean;
  problem?: string;
}

/**
 * How much a coding agent may do in a run. Chosen per run in the composer.
 *
 * `ask` is not a further rung on the ladder — it is `full` with a stop before
 * each call — and not every agent can offer it, which is why `AgentView` says
 * which ones a given agent honours rather than the UI assuming.
 */
export type PermissionLevel = "read" | "edit" | "full" | "ask";

/** A coding agent found on this machine. Never carries a token, only `tokenSet`. */
export interface AgentView {
  id: string;
  name: string;
  kind: "opencode" | "claude_code" | "builtin";
  label: string;
  hint: string;
  installHint: string;
  command: string | null;
  version: string | null;
  baseUrl: string | null;
  authTokenEnv: string | null;
  tokenSet: boolean;
  detected: boolean;
  /** Set only on the built-in engine: the connection it runs the loop on. */
  connectionId: string | null;
  /** What this agent can be asked for, from the server's own catalog. */
  levels: PermissionLevel[];
  ready: boolean;
  problem: string | null;
}

/** A skill folder, as indexed from disk. The folder remains the truth. */
export interface SkillView {
  id: string;
  slug: string;
  scope: "global" | "project";
  projectId: string | null;
  name: string;
  description: string;
  triggers: string[] | null;
  path: string;
  problem: string | null;
}

export interface ThreadView {
  id: string;
  projectId: string | null;
  title: string | null;
  connectionId: string | null;
  model: string | null;
  /** Set when this thread is a coding session rather than a chat. */
  agentId: string | null;
  agentSessionId: string | null;
  permission: PermissionLevel | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryView {
  id: string;
  scope: "global" | "project";
  projectId: string | null;
  kind: "fact" | "preference" | "instruction";
  title: string;
  body: string;
  sourceThreadId: string | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Check {
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new ApiError(message);
  }

  return payload as T;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const remove = <T>(path: string) => request<T>(path, { method: "DELETE" });

export const api = {
  health: () =>
    request<{
      home: string;
      checks: Check[];
      counts: { threads: number; projects: number; memories: number };
    }>("/health"),

  connections: () => request<{ connections: ConnectionView[]; kinds: KindSpec[] }>("/connections"),
  createConnection: (body: Partial<ConnectionView>) =>
    post<{ connection: ConnectionView }>("/connections", body),
  updateConnection: (id: string, body: Partial<ConnectionView>) =>
    patch<{ connection: ConnectionView }>(`/connections/${id}`, body),
  deleteConnection: (id: string) => remove<{ ok: true }>(`/connections/${id}`),

  projects: () => request<{ projects: ProjectView[] }>("/projects"),
  projectStatus: (id: string) => request<ProjectStatus>(`/projects/${id}/status`),
  createProject: (body: { name: string; description?: string; directory?: string }) =>
    post<{ project: ProjectView }>("/projects", body),
  updateProject: (id: string, body: Partial<ProjectView>) =>
    patch<{ project: ProjectView }>(`/projects/${id}`, body),
  deleteProject: (id: string) => remove<{ ok: true }>(`/projects/${id}`),

  threads: (projectId?: string) =>
    request<{ threads: ThreadView[] }>(
      `/threads${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),
  thread: (id: string) =>
    request<{ thread: ThreadView; messages: StoredMessage[] }>(`/threads/${id}`),
  createThread: (body: {
    projectId?: string | null;
    connectionId?: string | null;
    agentId?: string | null;
    permission?: PermissionLevel | null;
  }) => post<{ thread: ThreadView }>("/threads", body),
  updateThread: (id: string, body: Partial<ThreadView> & { archived?: boolean }) =>
    patch<{ thread: ThreadView }>(`/threads/${id}`, body),
  deleteThread: (id: string) => remove<{ ok: true }>(`/threads/${id}`),

  memories: (params?: { scope?: string; projectId?: string; q?: string }) => {
    const query = new URLSearchParams();
    if (params?.scope) query.set("scope", params.scope);
    if (params?.projectId) query.set("projectId", params.projectId);
    if (params?.q) query.set("q", params.q);
    const suffix = query.toString();
    return request<{ memories: MemoryView[] }>(`/memories${suffix ? `?${suffix}` : ""}`);
  },
  memoryPreview: (projectId?: string | null) =>
    request<{ block: string | null; count: number }>(
      `/memories/preview${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),
  agents: () =>
    request<{
      agents: AgentView[];
      kinds: { kind: string; label: string; hint: string; installHint: string }[];
      levels: { value: PermissionLevel; label: string; hint: string }[];
    }>("/agents"),
  detectAgents: () => post<{ agents: AgentView[] }>("/agents/detect", {}),
  updateAgent: (id: string, body: Partial<AgentView>) =>
    patch<{ agent: AgentView }>(`/agents/${id}`, body),
  deleteAgent: (id: string) => remove<{ ok: true }>(`/agents/${id}`),

  skills: (projectId?: string | null) =>
    request<{ skills: SkillView[]; roots: { global: string; project: string | null } }>(
      `/skills${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),
  skillPreview: (projectId?: string | null) =>
    request<{ block: string | null; count: number }>(
      `/skills/preview${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),
  skill: (id: string) =>
    request<{ skill: SkillView; instructions: string | null }>(`/skills/${id}`),
  scanSkills: (projectId?: string | null) =>
    post<{ ok: true; count: number }>("/skills/scan", { projectId: projectId ?? null }),

  createMemory: (body: Partial<MemoryView>) => post<{ memory: MemoryView }>("/memories", body),
  updateMemory: (id: string, body: Partial<MemoryView>) =>
    patch<{ memory: MemoryView }>(`/memories/${id}`, body),
  deleteMemory: (id: string) => remove<{ ok: true }>(`/memories/${id}`),

  /** Outbound only. Pairing is a terminal job — see `sync/peer-http.ts`. */
  sync: () => request<{ device: string; seq: number; peers: PeerView[] }>("/sync"),
  syncNow: () => post<SyncReport>("/sync/run", {}),
  unpair: (id: string) => remove<{ ok: true }>(`/sync/peers/${id}`),
};

/** A paired device. Never carries the token, only whether one exists. */
export interface PeerView {
  id: string;
  label: string;
  url: string;
  pushedThrough: number;
  pulledThrough: number;
  paired: boolean;
}

export interface SyncReport {
  peers: { peer: string; pushed: number; pulled: number; skew?: string; error?: string }[];
  pushed: number;
  pulled: number;
  seeded: number;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: unknown[];
  provider: string | null;
  model: string | null;
  createdAt: number;
}
