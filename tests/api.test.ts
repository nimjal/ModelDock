/**
 * The HTTP surface: what it refuses, and what it never says out loud.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/server/app.js";
import { db } from "../src/server/db/index.js";
import { connections, projects, threads } from "../src/server/db/schema.js";

interface ProjectStatusBody {
  directory: string | null;
  exists: boolean;
  readable: boolean;
  isGitRepo: boolean;
  problem?: string;
}

const app = createApp({ port: 8765 });
const BASE = "http://127.0.0.1:8765";

/**
 * `app.request` builds a Request object directly, with no wire to carry a
 * Host header, so every call has to send the one a browser would. The
 * rejection cases below override it deliberately.
 */
const HEADERS = { "content-type": "application/json", host: "127.0.0.1:8765" };

const json = (body: unknown) => ({
  method: "POST",
  headers: HEADERS,
  body: JSON.stringify(body),
});

describe("origin and host checks", () => {
  it("refuses a request claiming a Host it could not have produced", async () => {
    const response = await app.request(`${BASE}/api/health`, {
      headers: { host: "evil.example.com" },
    });
    expect(response.status).toBe(403);
  });

  it("refuses a write carrying another site's Origin", async () => {
    const response = await app.request(`${BASE}/api/projects`, {
      ...json({ name: "Sneaky" }),
      headers: { ...HEADERS, origin: "https://evil.example.com" },
    });
    expect(response.status).toBe(403);
  });

  it("allows a write with no Origin, which cannot have come from a page", async () => {
    const response = await app.request(`${BASE}/api/projects`, json({ name: "Local Tool" }));
    expect(response.status).toBe(201);
  });
});

describe("connections", () => {
  it("never returns a key, only whether the variable is set", async () => {
    process.env.LEAK_CHECK_KEY = "sk-must-not-appear";

    await app.request(
      `${BASE}/api/connections`,
      json({
        name: "Leaky",
        kind: "anthropic",
        model: "claude-sonnet-4-5",
        apiKeyEnv: "LEAK_CHECK_KEY",
      }),
    );

    const body = await (await app.request(`${BASE}/api/connections`, { headers: HEADERS })).text();

    expect(body).toContain("LEAK_CHECK_KEY");
    expect(body).toContain('"apiKeySet":true');
    expect(body).not.toContain("sk-must-not-appear");
  });

  it("rejects a duplicate name with a message rather than a stack trace", async () => {
    const body = { name: "Twice", kind: "openai", model: "gpt-4.1" };
    await app.request(`${BASE}/api/connections`, json(body));

    const response = await app.request(`${BASE}/api/connections`, json(body));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/already exists/);
  });
});

describe("projects", () => {
  it("gives colliding names distinct slugs", async () => {
    const one = (await (
      await app.request(`${BASE}/api/projects`, json({ name: "Same Name" }))
    ).json()) as {
      project: { slug: string };
    };
    const two = (await (
      await app.request(`${BASE}/api/projects`, json({ name: "Same Name" }))
    ).json()) as {
      project: { slug: string };
    };

    expect(one.project.slug).toBe("same-name");
    expect(two.project.slug).toBe("same-name-2");
  });

  it("frees a deleted project's threads instead of destroying them", async () => {
    const created = (await (
      await app.request(`${BASE}/api/projects`, json({ name: "Doomed" }))
    ).json()) as { project: { id: string } };

    const [thread] = await db()
      .insert(threads)
      .values({ projectId: created.project.id, title: "Worth keeping" })
      .returning();

    await app.request(`${BASE}/api/projects/${created.project.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });

    const listed = (await (
      await app.request(`${BASE}/api/threads`, { headers: HEADERS })
    ).json()) as {
      threads: { id: string; projectId: string | null }[];
    };

    const survivor = listed.threads.find((row) => row.id === thread!.id);
    expect(survivor, "the thread should outlive its project").toBeDefined();
    expect(survivor!.projectId).toBeNull();
  });

  /**
   * Detaching a thread used to leave its `updatedAt` alone, so the sidebar went
   * on sorting it by a time that no longer described it — and a delta sync would
   * have replicated the project's deletion while missing that its threads had
   * moved out of it.
   */
  it("moves a detached thread's timestamp, because the thread changed", async () => {
    const created = (await (
      await app.request(`${BASE}/api/projects`, json({ name: "Also doomed" }))
    ).json()) as { project: { id: string } };

    const [thread] = await db()
      .insert(threads)
      .values({ projectId: created.project.id, title: "Moved out" })
      .returning();

    await app.request(`${BASE}/api/projects/${created.project.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });

    const [after] = await db().select().from(threads).where(eq(threads.id, thread!.id)).all();

    expect(after!.projectId).toBeNull();
    expect(after!.updatedAt).toBeGreaterThan(thread!.updatedAt);
  });
});

describe("threads", () => {
  it("creates a chat with no project and no connection", async () => {
    // The inversion the rewrite is for: this must not require setup.
    const response = await app.request(`${BASE}/api/threads`, json({}));
    expect(response.status).toBe(201);

    const body = (await response.json()) as { thread: { projectId: null; connectionId: null } };
    expect(body.thread.projectId).toBeNull();
    expect(body.thread.connectionId).toBeNull();
  });

  it("reports a missing thread as 404, not 500", async () => {
    const response = await app.request(`${BASE}/api/threads/nope`, { headers: HEADERS });
    expect(response.status).toBe(404);
  });
});

/**
 * A directory that is merely stored is a directory nobody can tell is wrong.
 * This is the `doctor` idea applied to one form field.
 */
describe("project directory status", () => {
  it("says a project with no directory has none, without inventing a problem", async () => {
    const [project] = await db()
      .insert(projects)
      .values({ name: "Contextual", slug: "status-contextual" })
      .returning();

    const response = await app.request(`${BASE}/api/projects/${project!.id}/status`, {
      headers: HEADERS,
    });
    const body = (await response.json()) as ProjectStatusBody;

    expect(response.status).toBe(200);
    expect(body.directory).toBeNull();
    expect(body.problem).toBeUndefined();
  });

  it("reports a real directory as readable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "modeldock-status-"));
    const [project] = await db()
      .insert(projects)
      .values({ name: "Real", slug: "status-real", directory })
      .returning();

    const response = await app.request(`${BASE}/api/projects/${project!.id}/status`, {
      headers: HEADERS,
    });
    const body = (await response.json()) as ProjectStatusBody;

    expect(body.exists).toBe(true);
    expect(body.readable).toBe(true);
    expect(body.isGitRepo).toBe(false);
    expect(body.problem).toBeUndefined();
  });

  it("reports a path that is not there, rather than pretending it works", async () => {
    const [project] = await db()
      .insert(projects)
      .values({
        name: "Missing",
        slug: "status-missing",
        directory: join(tmpdir(), "modeldock-does-not-exist-9f3c"),
      })
      .returning();

    const response = await app.request(`${BASE}/api/projects/${project!.id}/status`, {
      headers: HEADERS,
    });
    const body = (await response.json()) as ProjectStatusBody;

    expect(body.exists).toBe(false);
    expect(body.readable).toBe(false);
    expect(body.problem).toMatch(/No directory/);
  });

  it("reports a missing project as 404, not 500", async () => {
    const response = await app.request(`${BASE}/api/projects/nope/status`, { headers: HEADERS });
    expect(response.status).toBe(404);
  });
});

describe("chat preconditions", () => {
  it("explains that no connection is set up rather than failing obscurely", async () => {
    // Nothing usable exists in this file's store until the tests above run,
    // so ask on a thread whose connection cannot resolve.
    await db().delete(connections);

    const [thread] = await db().insert(threads).values({}).returning();
    const response = await app.request(
      `${BASE}/api/chat`,
      json({
        threadId: thread!.id,
        message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/No connection set up/);
  });
});
