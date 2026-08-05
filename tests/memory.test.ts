/**
 * Memory scoping.
 *
 * The rule is small and has to be exactly right: global memories reach every
 * turn, project memories reach only their own project, and a chat with no
 * project never sees another project's context.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "../src/server/db/index.js";
import { memories, projects } from "../src/server/db/schema.js";
import { buildSystemPrompt, loadMemories, renderMemoryBlock } from "../src/server/memory/inject.js";
import { syncSkills } from "../src/server/skills/scan.js";

let harbor: string;
let atlas: string;

beforeAll(async () => {
  const [a] = await db().insert(projects).values({ name: "Harbor", slug: "harbor" }).returning();
  const [b] = await db().insert(projects).values({ name: "Atlas", slug: "atlas" }).returning();
  harbor = a!.id;
  atlas = b!.id;

  await db()
    .insert(memories)
    .values([
      { scope: "global", title: "Prefers pnpm over npm", body: "", kind: "preference" },
      { scope: "project", projectId: harbor, title: "Harbor uses Postgres 16", body: "Not MySQL." },
      { scope: "project", projectId: atlas, title: "Atlas is Go", body: "" },
    ]);
});

describe("scope", () => {
  it("sends only global memories to a chat with no project", async () => {
    const rows = await loadMemories(db(), null);
    const titles = rows.map((row) => row.title);

    expect(titles).toContain("Prefers pnpm over npm");
    expect(titles).not.toContain("Harbor uses Postgres 16");
    expect(titles).not.toContain("Atlas is Go");
  });

  it("sends global plus the project's own, and no other project's", async () => {
    const titles = (await loadMemories(db(), harbor)).map((row) => row.title);

    expect(titles).toContain("Prefers pnpm over npm");
    expect(titles).toContain("Harbor uses Postgres 16");
    expect(titles).not.toContain("Atlas is Go");
  });
});

describe("the block", () => {
  it("separates always-on context from project context", async () => {
    const block = renderMemoryBlock(await loadMemories(db(), harbor))!;

    expect(block).toContain("## Always");
    expect(block).toContain("## This project");
    expect(block.indexOf("## Always")).toBeLessThan(block.indexOf("## This project"));
  });

  it("does not repeat a title as its own body", () => {
    const block = renderMemoryBlock([
      {
        id: "1",
        scope: "global",
        projectId: null,
        kind: "fact",
        title: "Ships on Fridays",
        body: "Ships on Fridays",
        sourceThreadId: null,
        pinned: false,
        createdAt: 0,
        updatedAt: 0,
        deletedAt: null,
      },
    ])!;

    expect(block).toContain("- Ships on Fridays");
    expect(block).not.toContain("Ships on Fridays — Ships on Fridays");
  });

  it("is null when there is nothing to say", () => {
    expect(renderMemoryBlock([])).toBeNull();
  });

  it("puts pinned memories first so truncation keeps them", async () => {
    await db()
      .insert(memories)
      .values({ scope: "global", title: "Pinned and important", body: "", pinned: true });

    const rows = await loadMemories(db(), null);
    expect(rows[0]!.title).toBe("Pinned and important");
  });
});

describe("the system prompt", () => {
  it("names the project and carries its memory", async () => {
    const prompt = await buildSystemPrompt(db(), harbor, "Harbor");

    expect(prompt).toContain('The current project is "Harbor"');
    expect(prompt).toContain("Harbor uses Postgres 16");
  });

  it("still works with no memories and no project", async () => {
    const prompt = await buildSystemPrompt(db(), null, null);
    expect(prompt).toContain("ModelDock");
    expect(prompt).not.toContain("## This project");
  });

  it("says what the assistant may do with a project's files, and what it may not", async () => {
    const directory = mkdtempSync(join(tmpdir(), "modeldock-prompt-"));
    const prompt = await buildSystemPrompt(db(), harbor, "Harbor", directory);

    expect(prompt).toContain(directory);
    // The limit has to be stated, not just implied by the absent tool.
    expect(prompt).toContain("You cannot change them");
  });

  it("says nothing about files when the project has no directory", async () => {
    const prompt = await buildSystemPrompt(db(), harbor, "Harbor");
    expect(prompt).not.toContain("You can read files");
  });

  it("carries the skill index, but never a skill's body", async () => {
    const root = join(process.env.MODELDOCK_HOME!, "skills", "changelog");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "SKILL.md"),
      "---\nname: changelog\ndescription: Write release notes.\n---\n\nSECRET-BODY-MARKER",
    );
    await syncSkills(db(), {});

    const prompt = await buildSystemPrompt(db(), null, null);
    expect(prompt).toContain("Write release notes.");
    expect(prompt).not.toContain("SECRET-BODY-MARKER");
  });
});
