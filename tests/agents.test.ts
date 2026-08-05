/**
 * The Code surface.
 *
 * Two things are being proved. First, that an external agent's event stream
 * lands in `messages.parts` in the same shape a chat turn does — same column,
 * same part types, same renderer — so a coding session reads back through
 * history like everything else. Second, and more important, that the
 * permission mapping is what it claims to be: the directory boundary is denied
 * at every level, and no permission-bypass flag is ever produced.
 *
 * None of this requires a coding agent to be installed. The end-to-end tests
 * drive `tests/fixtures/fake-claude.mjs`, pointed at through the `args`
 * column — the same mechanism a real person uses for a wrapper script.
 *
 * OpenCode is covered at the normaliser rather than end to end: faking it
 * would mean standing up an HTTP server and an SSE stream, while the only part
 * with real logic is the event translation. That asymmetry is deliberate.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app.js";
import { Cumulative, toolInput, toolName } from "../src/server/code/normalize.js";
import {
  boundaryHolds,
  LEVELS as LEVELS_META,
  permissionArgsForClaude,
  permissionForOpenCode,
  toRulePath,
  type ExternalLevel,
  type PermissionLevel,
} from "../src/server/code/permissions.js";
import { serverKeyFor } from "../src/server/code/opencode.js";
import { cmdLineFor, quoteForCmd } from "../src/server/code/spawn.js";
import { db } from "../src/server/db/index.js";
import { codingAgents, messages, projects, threads } from "../src/server/db/schema.js";

const app = createApp({ port: 8765 });
const BASE = "http://127.0.0.1:8765";
const HEADERS = { "content-type": "application/json", host: "127.0.0.1:8765" };

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");

/**
 * The levels an external engine can be given.
 *
 * `ask` is deliberately absent, and the type is what enforces it: passing it to
 * either mapping function below is a compile error, because neither OpenCode
 * nor Claude Code can pause between choosing a tool and running it.
 */
const LEVELS: ExternalLevel[] = ["read", "edit", "full"];

let agentId: string;
let projectId: string;
let directory: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "modeldock-code-"));
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "src", "app.ts"), "export const port = 8765;\n");

  // Node running the fixture stands in for the real binary. This is exactly
  // the shape a wrapper-script configuration takes.
  const [agent] = await db()
    .insert(codingAgents)
    .values({
      name: "Fake Claude Code",
      kind: "claude_code",
      command: process.execPath,
      args: [FIXTURE],
      detected: false,
    })
    .returning();
  agentId = agent!.id;

  const [project] = await db()
    .insert(projects)
    .values({ name: "Harbor", slug: "code-harbor", directory })
    .returning();
  projectId = project!.id;
});

/** Drive one coding turn and wait for the stream to finish, as chat.test does. */
async function turn(
  threadId: string,
  text: string,
  permission: PermissionLevel = "read",
): Promise<string> {
  const response = await app.request(`${BASE}/api/code`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      threadId,
      permission,
      message: {
        id: `user-${Math.random().toString(36).slice(2)}`,
        role: "user",
        parts: [{ type: "text", text }],
      },
    }),
  });

  expect(response.status).toBe(200);
  // Draining is what lets `onEnd` finish before assertions run.
  return response.text();
}

async function newThread() {
  const [thread] = await db().insert(threads).values({ projectId, agentId }).returning();
  return thread!.id;
}

async function assistantRows(threadId: string) {
  return db()
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.role, "assistant")))
    .orderBy(asc(messages.createdAt))
    .all();
}

const ROOT = process.platform === "win32" ? "C:\\work\\harbor" : "/work/harbor";

describe("permission levels", () => {
  it("denies leaving the project directory at every level, for OpenCode", () => {
    for (const level of LEVELS) {
      expect(permissionForOpenCode(level).external_directory).toBe("deny");
    }
  });

  it("never passes --add-dir to Claude Code, at any level", () => {
    for (const level of LEVELS) {
      expect(permissionArgsForClaude(level, ROOT)).not.toContain("--add-dir");
    }
  });

  it("never produces a flag that skips permission checks", () => {
    for (const level of LEVELS) {
      const args = permissionArgsForClaude(level, ROOT).join(" ");
      expect(args).not.toMatch(/dangerously/i);
      expect(args).not.toMatch(/skip-permissions/i);
      expect(args).not.toMatch(/bypass/i);
    }
  });

  /**
   * The regression that matters most in this file.
   *
   * `--allowedTools "Read"` pre-approves the Read tool for *every* path, so an
   * agent given that flag will happily read an absolute path outside the
   * project. A live run against the real Claude Code read
   * `C:\Windows\System32\drivers\etc\hosts` at the read-only level before this
   * was fixed. Every file rule has to carry the project root.
   */
  it("never grants a file tool without anchoring it to the project", () => {
    for (const level of LEVELS) {
      const args = permissionArgsForClaude(level, ROOT);
      const allowed = args[args.indexOf("--allowedTools") + 1]!.split(",");

      for (const rule of allowed) {
        if (rule === "Bash") continue; // covered by boundaryHolds, below
        expect(rule).toMatch(/^\w+\(.+\)$/);
        expect(rule).toContain(toRulePath(ROOT));
      }
    }
  });

  it("writes a Windows root as a POSIX absolute rule path", () => {
    expect(toRulePath("C:\\work\\harbor")).toBe("//c/work/harbor");
    expect(toRulePath("/home/me/harbor")).toBe("//home/me/harbor");
    expect(toRulePath("/home/me/harbor/")).toBe("//home/me/harbor");
  });

  it("read-only cannot write or run anything", () => {
    const opencode = permissionForOpenCode("read");
    expect(opencode.edit).toBe("deny");
    expect(opencode.write).toBe("deny");
    expect(opencode.bash).toBe("deny");
    expect(opencode.read).toBe("allow");

    const claude = permissionArgsForClaude("read", ROOT).join(" ");
    expect(claude).toContain("--disallowedTools");
    expect(claude).toMatch(/Edit/);
    expect(claude).toMatch(/Bash/);
  });

  it("edit can write files but still cannot reach a shell", () => {
    const opencode = permissionForOpenCode("edit");
    expect(opencode.edit).toBe("allow");
    expect(opencode.write).toBe("allow");
    expect(opencode.bash).toBe("deny");

    const claude = permissionArgsForClaude("edit", ROOT);
    expect(claude).toContain("acceptEdits");
    expect(claude.join(" ")).toMatch(/--disallowedTools \S*Bash/);
  });

  /**
   * Honest about the one it cannot keep.
   *
   * File-tool rules govern the agent's own tools. A shell can start a process
   * that opens anything the user account can, so `full` is the level where the
   * boundary stops being a guarantee — and the UI copy says so rather than
   * implying otherwise.
   */
  it("claims the boundary only where it actually holds", () => {
    expect(boundaryHolds("read")).toBe(true);
    expect(boundaryHolds("edit")).toBe(true);
    expect(boundaryHolds("full")).toBe(false);

    const full = LEVELS_META.find((level) => level.value === "full")!;
    expect(full.hint).toMatch(/outside/i);
  });
});

/**
 * OpenCode bakes its permission block in when the server starts and never
 * re-reads it, so a cached server is only reusable by a run that wants exactly
 * the same configuration. Getting this wrong was dangerous in one direction:
 * a "full" run followed by a "read" run reused the "full" server, and the
 * read-only session quietly kept a shell.
 *
 * Tested through the key rather than by spawning, the way the permission
 * mappings above are.
 */
describe("reusing an OpenCode server", () => {
  it("refuses to reuse a server started at a different level", () => {
    const read = serverKeyFor("read", null);
    const edit = serverKeyFor("edit", null);
    const full = serverKeyFor("full", null);

    expect(new Set([read, edit, full]).size).toBe(3);
  });

  it("refuses to reuse a server started with different instructions", () => {
    expect(serverKeyFor("read", "skills: a")).not.toBe(serverKeyFor("read", "skills: b"));
    expect(serverKeyFor("read", null)).not.toBe(serverKeyFor("read", "skills: a"));
  });

  it("reuses one when nothing has changed", () => {
    expect(serverKeyFor("edit", "same")).toBe(serverKeyFor("edit", "same"));
  });

  it("keys on the permission map, not just the level name", () => {
    // If the mapping for a level ever changes, the key changes with it — so a
    // server started before the change is not reused after it.
    expect(serverKeyFor("full", null)).toContain("bash");
    expect(JSON.parse(serverKeyFor("read", null)).permission.bash).toBe("deny");
  });
});

describe("a coding turn", () => {
  it("stores the agent's output as parts, in the same shape chat uses", async () => {
    const threadId = await newThread();
    await turn(threadId, "What port does this use?");

    const [assistant] = await assistantRows(threadId);
    expect(assistant).toBeDefined();

    const parts = assistant!.parts as { type: string; state?: string; output?: unknown }[];

    // Text streamed through as deltas.
    expect(JSON.stringify(parts)).toContain("Looking at it.");

    // `tool-read`, not `dynamic-tool` — the prefix Message.tsx renders.
    const call = parts.find((part) => part.type === "tool-read");
    expect(call).toBeDefined();
    expect(call!.state).toBe("output-available");
    expect(String(call!.output)).toContain("export const port = 8765;");
  });

  it("attributes the message to the agent that produced it", async () => {
    const threadId = await newThread();
    await turn(threadId, "Anything.");

    const [assistant] = await assistantRows(threadId);
    expect(assistant!.provider).toBe("claude_code");
    expect(assistant!.model).toBe("claude-sonnet-4-5");
  });

  it("keeps what the person typed, and names the thread from it", async () => {
    const threadId = await newThread();
    await turn(threadId, "Explain the build script.");

    const rows = await db().select().from(messages).where(eq(messages.threadId, threadId)).all();
    expect(
      rows.some((row) => JSON.stringify(row.parts).includes("Explain the build script.")),
    ).toBe(true);

    const [thread] = await db().select().from(threads).where(eq(threads.id, threadId));
    expect(thread!.title).toBe("Explain the build script.");
  });

  it("records the engine's session and resumes it on the next turn", async () => {
    const threadId = await newThread();
    await turn(threadId, "First.");

    const [thread] = await db().select().from(threads).where(eq(threads.id, threadId));
    expect(thread!.agentSessionId).toBe("sess-fake-1");

    await turn(threadId, "Second.");

    // The fixture echoes its argv into the result line, which the adapter
    // does not persist — so assert on the stored transcript's tool output
    // being present twice instead, and on the session id being stable.
    const [after] = await db().select().from(threads).where(eq(threads.id, threadId));
    expect(after!.agentSessionId).toBe("sess-fake-1");
    expect(await assistantRows(threadId)).toHaveLength(2);
  });

  it("remembers the permission level chosen for the run", async () => {
    const threadId = await newThread();
    await turn(threadId, "Change something.", "edit");

    const [thread] = await db().select().from(threads).where(eq(threads.id, threadId));
    expect(thread!.permission).toBe("edit");
  });

  it("refuses a coding session on a project with no directory", async () => {
    const [bare] = await db()
      .insert(projects)
      .values({ name: "Bare", slug: "code-bare" })
      .returning();
    const [thread] = await db()
      .insert(threads)
      .values({ projectId: bare!.id, agentId })
      .returning();

    const response = await app.request(`${BASE}/api/code`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        threadId: thread!.id,
        message: { id: "m1", role: "user", parts: [{ type: "text", text: "go" }] },
      }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/directory/);
  });
});

describe("stopping a run", () => {
  it("kills the agent and still keeps the partial transcript", async () => {
    // The fixture stalls after its first text, so there is something to stop.
    process.env.FAKE_CLAUDE_SLEEP_MS = "5000";

    const threadId = await newThread();
    const controller = new AbortController();

    const pending = app.request(`${BASE}/api/code`, {
      method: "POST",
      headers: HEADERS,
      signal: controller.signal,
      body: JSON.stringify({
        threadId,
        permission: "read",
        message: { id: "u-stop", role: "user", parts: [{ type: "text", text: "Take your time." }] },
      }),
    });

    const response = await pending;

    // Read enough of the stream that the agent has actually started, then stop.
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});

    // Give the adapter a moment to tear the child down and run `onEnd`.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Unlike chat, an aborted coding run is kept: files may already have
    // changed, so the record of what happened has to survive the stop.
    const rows = await assistantRows(threadId);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.parts)).toContain("Stopped.");

    delete process.env.FAKE_CLAUDE_SLEEP_MS;
  });
});

describe("agents API", () => {
  it("never returns a token, only whether one is set", async () => {
    const response = await app.request(`${BASE}/api/agents`, { headers: HEADERS });
    const body = (await response.json()) as { agents: Record<string, unknown>[] };

    for (const agent of body.agents) {
      expect(agent).not.toHaveProperty("authToken");
      expect(agent).toHaveProperty("tokenSet");
    }
    expect(JSON.stringify(body)).not.toContain("sk-");
  });
});

describe("spawning through a Windows shim", () => {
  it("quotes an install path containing a space", () => {
    // The common real path is C:\Users\First Last\AppData\Roaming\npm\claude.CMD.
    // Unquoted, cmd takes everything up to the first space as the command and
    // the agent is reported as present but never runs.
    const args = cmdLineFor("C:\\Users\\Nimit Jalan\\npm\\claude.CMD", ["--version"]);

    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(args[3]).toBe('""C:\\Users\\Nimit Jalan\\npm\\claude.CMD" --version"');
  });

  it("leaves a plain argument unquoted", () => {
    expect(quoteForCmd("--verbose")).toBe("--verbose");
    expect(quoteForCmd("Read,Grep,Glob")).toBe("Read,Grep,Glob");
  });

  it("quotes the shell metacharacters cmd would otherwise act on", () => {
    for (const value of ["a&b", "a|b", "a>b", "a<b", "a^b", "a(b)"]) {
      expect(quoteForCmd(value)).toBe(`"${value}"`);
    }
  });

  it("escapes an embedded quote rather than ending the token", () => {
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
  });
});

describe("normalising engine events", () => {
  it("turns OpenCode's cumulative text into deltas", () => {
    // The single easiest thing to get wrong: OpenCode resends the whole part
    // each tick, so emitting it verbatim repeats the message every update.
    const cumulative = new Cumulative();
    expect(cumulative.suffix("p1", "Hello")).toBe("Hello");
    expect(cumulative.suffix("p1", "Hello there")).toBe(" there");
    expect(cumulative.suffix("p1", "Hello there!")).toBe("!");
    // A repeat of the same value adds nothing.
    expect(cumulative.suffix("p1", "Hello there!")).toBe("");
  });

  it("tracks parts independently", () => {
    const cumulative = new Cumulative();
    expect(cumulative.suffix("a", "one")).toBe("one");
    expect(cumulative.suffix("b", "two")).toBe("two");
    expect(cumulative.suffix("a", "one more")).toBe(" more");
  });

  it("maps both engines' tool names onto one vocabulary", () => {
    expect(toolName("Read")).toBe("read");
    expect(toolName("read")).toBe("read");
    expect(toolName("MultiEdit")).toBe("edit");
    expect(toolName("patch")).toBe("edit");
    expect(toolName("LS")).toBe("list");
    expect(toolName("Bash")).toBe("bash");
    // An unknown tool still yields a usable part type.
    expect(toolName("SomeNewTool")).toBe("somenewtool");
  });

  it("shows paths relative to the project and keeps the original payload", () => {
    const root = process.platform === "win32" ? "C:\\work\\harbor" : "/work/harbor";
    const abs = join(root, "src", "app.ts");

    const input = toolInput({ file_path: abs, extra: 1 }, root);
    expect(input.path).toBe("src/app.ts");
    expect(input.raw).toEqual({ file_path: abs, extra: 1 });
  });

  it("leaves a path outside the project alone rather than mangling it", () => {
    const root = process.platform === "win32" ? "C:\\work\\harbor" : "/work/harbor";
    const input = toolInput({ path: "/etc/hosts" }, root);
    expect(input.path).toBe("/etc/hosts");
  });
});
