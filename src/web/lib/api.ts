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
  /** The source of a script connection, for the editor. Null on every other kind. */
  script: string | null;
  /**
   * What the connection can be asked for. Known from the kind for a vendor, and
   * asked of the module for a script — the berth leaves out what cannot chat.
   */
  capabilities: { chat: boolean; image: boolean; models: boolean };
  ready: boolean;
  problem: string | null;
}

export interface KindSpec {
  kind: string;
  label: string;
  defaultApiKeyEnv: string | null;
  defaultBaseUrl: string | null;
  baseUrlEditable: boolean;
  baseUrlRequired: boolean;
  requiresApiKey: boolean;
  namedKeyRequired: boolean;
  suggestedModels: string[];
  accent: string;
  hint: string;
}

/**
 * Where a custom engine starts. See `scripts/templates.ts`.
 *
 * `kind` names the built-in connection kind a template reimplements, which is
 * how "Customise it as a script" on an existing connection finds its own.
 */
export interface ScriptTemplate {
  id: string;
  label: string;
  hint: string;
  kind: string | null;
  does: ("chat" | "image" | "models")[];
  name: string;
  baseUrl: string | null;
  apiKeyEnv: string | null;
  model: string;
  keyUrl: string | null;
  script: string;
}

/** What a script exports, or why it does not load. */
export interface ScriptInspection {
  chat: boolean;
  image: boolean;
  models: boolean;
  defaultImageModel: string | null;
  problem: string | null;
}

/** One trial turn through a draft script. A failure keeps whatever arrived before it. */
export interface ScriptTrial {
  ok: boolean;
  text?: string;
  reasoning?: string | null;
  toolCalls?: { name: string; input: unknown }[];
  finishReason?: string | null;
  usage?: { input: number | null; output: number | null };
  error?: string | null;
  ms: number;
}

/** A named service, pre-filled. See `providers/catalog.ts` for kind vs preset. */
export interface ProviderPreset {
  id: string;
  label: string;
  kind: string;
  baseUrl: string | null;
  apiKeyEnv: string | null;
  models: string[];
  keyUrl: string | null;
  hint: string;
}

/**
 * One model a provider says it can run. `chat` and `image` are guesses from the
 * id, except where the provider — Google, or a script — says outright.
 */
export interface ModelInfo {
  id: string;
  label: string | null;
  chat: boolean;
  image: boolean;
}

/**
 * What ModelDock knows about one environment variable — never its value.
 *
 * `tail` is the last four characters, which is enough to recognise a key
 * without revealing one. There is no route that returns the rest.
 */
export interface KeyStatus {
  name: string;
  set: boolean;
  source: "file" | "environment" | null;
  tail: string | null;
  shadowsEnvironment: boolean;
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

/** A connection that could be asked to draw. Ineligible kinds are absent. */
export interface ImageCandidate {
  id: string;
  name: string;
  kind: string;
  ready: boolean;
  suggestedModels: string[];
  defaultModel: string;
  hint: string;
}

/**
 * The workspace's two settings.
 *
 * `resolved*` on the defaults answers "what would a new chat actually start
 * on", which is not the same question as what is stored — a default pointing
 * at a deleted connection falls through. `images.active` is non-null exactly
 * when the model is offered a `generate_image` tool.
 */
export interface WorkspaceView {
  defaults: {
    connectionId: string | null;
    model: string | null;
    resolvedConnectionId: string | null;
    resolvedName: string | null;
    ready: boolean;
  };
  images: {
    connectionId: string | null;
    model: string | null;
    active: { connectionId: string; name: string; model: string } | null;
    eligible: ImageCandidate[];
    kinds: {
      kind: string;
      defaultModel: string;
      suggestedModels: string[];
      sizes: string[];
      hint: string;
    }[];
  };
}

export interface DiffLine {
  kind: "same" | "add" | "remove";
  text: string;
}

/** What pointing one tool at ModelDock would change, before anything is written. */
export interface HandoffTarget {
  kind: "claude_code" | "opencode";
  label: string;
  path: string;
  hint: string;
  after: string;
  exists: boolean;
  applied: boolean;
  current: string;
  proposed: string;
  diff: DiffLine[];
  problem: string | null;
  modelCount: number;
}

export interface HandoffView {
  gateway: {
    origin: string;
    openaiBaseUrl: string;
    anthropicBaseUrl: string;
    /**
     * The gateway's own token — generated here, worthless off this machine,
     * and the one credential this API returns. Provider keys still never
     * cross this boundary; see the note on `routes/handoff.ts`.
     */
    token: string;
    tokenPath: string;
    modelCount: number;
    problems: { connection: string; problem: string }[];
    models: { id: string; connection: string; label: string | null }[];
  };
  targets: HandoffTarget[];
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

  connections: () =>
    request<{
      connections: ConnectionView[];
      kinds: KindSpec[];
      presets: ProviderPreset[];
      templates: ScriptTemplate[];
    }>("/connections"),
  createConnection: (body: Partial<ConnectionView>) =>
    post<{ connection: ConnectionView }>("/connections", body),
  updateConnection: (id: string, body: Partial<ConnectionView>) =>
    patch<{ connection: ConnectionView }>(`/connections/${id}`, body),
  deleteConnection: (id: string) => remove<{ ok: true }>(`/connections/${id}`),

  /** Asked of the provider itself, with the key resolved server-side. */
  models: (connectionId: string) =>
    request<{ models: ModelInfo[] }>(`/connections/${connectionId}/models`),
  /** The same question before a connection exists — first-run setup uses this. */
  probeModels: (body: {
    kind: string;
    baseUrl?: string | null;
    apiKeyEnv?: string | null;
    label?: string;
    /** A draft script's source, so its models() can be asked before it is saved. */
    script?: string | null;
  }) => post<{ models: ModelInfo[] }>("/models", body),

  /**
   * A draft script, before it is saved. `checkScript` loads it and reports what
   * it exports; `tryScript` runs one short turn through it. Neither stores anything.
   */
  checkScript: (body: { script: string; name?: string }) =>
    post<{ inspection: ScriptInspection }>("/scripts/check", body),
  tryScript: (body: {
    script: string;
    name?: string;
    baseUrl?: string | null;
    apiKeyEnv?: string | null;
    model?: string;
    prompt?: string;
  }) => post<ScriptTrial>("/scripts/try", body),

  /**
   * Keys are write-only across this boundary.
   *
   * `keys()` reports whether a variable is set and where from; `saveKey` sends
   * a value one way. Nothing here can read a key back, which is the property
   * that lets the rest of the API stay free of them entirely.
   */
  keys: () => request<{ keys: KeyStatus[]; path: string; home: string }>("/keys"),
  saveKey: (name: string, value: string) =>
    request<{ key: KeyStatus }>(`/keys/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  deleteKey: (name: string) =>
    request<{ key: KeyStatus }>(`/keys/${encodeURIComponent(name)}`, { method: "DELETE" }),

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

  /** Where a new chat starts, and which connection draws. */
  workspace: () => request<WorkspaceView>("/workspace"),
  updateWorkspace: (body: {
    defaultConnectionId?: string | null;
    defaultModel?: string | null;
    imageConnectionId?: string | null;
    imageModel?: string | null;
  }) => patch<WorkspaceView>("/workspace", body),

  /**
   * The gateway, and what pointing each tool at it would change.
   *
   * `handoff()` only computes; nothing is written until `applyHandoff`.
   */
  handoff: () => request<HandoffView>("/handoff"),
  applyHandoff: (kind: string) =>
    post<{ plan: HandoffTarget; backupPath: string | null }>(`/handoff/${kind}/apply`, {}),
  revertHandoff: (kind: string) =>
    post<{ plan: HandoffTarget; backupPath: string | null }>(`/handoff/${kind}/revert`, {}),
  rotateGatewayToken: () => post<{ token: string; stale: string[] }>("/handoff/rotate", {}),

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
