/**
 * Skills: the folders, the index, and what actually reaches the model.
 *
 * Two claims are load-bearing here. First, that only names and descriptions
 * are injected — if a body ever leaks into the index, thirty installed skills
 * silently become an enormous system prompt. Second, that a broken SKILL.md
 * shows up as broken rather than disappearing, because a feature that fails
 * silently is one people stop trusting.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "../src/server/db/index.js";
import { projects } from "../src/server/db/schema.js";
import { asList, parseFrontmatter } from "../src/server/skills/frontmatter.js";
import { loadSkillIndex, renderSkillIndex, syncSkills } from "../src/server/skills/scan.js";
import { skillTools } from "../src/server/skills/tools.js";

/** Write a skill folder the way a person would. */
function writeSkill(
  root: string,
  slug: string,
  frontmatter: string,
  body = "Do the thing.",
): string {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
  return dir;
}

let globalRoot: string;
let projectDir: string;
let projectId: string;

beforeAll(async () => {
  // setup.ts points MODELDOCK_HOME at a temp dir, so the global skills root
  // for this test file is inside it and cannot touch a real installation.
  globalRoot = join(process.env.MODELDOCK_HOME!, "skills");
  mkdirSync(globalRoot, { recursive: true });

  writeSkill(
    globalRoot,
    "changelog",
    "name: changelog\ndescription: Write release notes in the house style.\ntriggers: [release, notes]",
    "Group by user-visible change, not by commit.",
  );
  writeSkill(
    globalRoot,
    "pdf-forms",
    'name: "pdf-forms"\ndescription: Fill and flatten PDF forms.',
  );
  // Deliberately broken: no description.
  writeSkill(globalRoot, "half-written", "name: half-written");

  projectDir = mkdtempSync(join(tmpdir(), "modeldock-skillproj-"));
  const projectRoot = join(projectDir, ".modeldock", "skills");
  mkdirSync(projectRoot, { recursive: true });

  writeSkill(
    projectRoot,
    "changelog",
    "name: changelog\ndescription: This repo's own changelog rules.",
    "Ship notes go in CHANGELOG.md.",
  );
  const deploy = writeSkill(
    projectRoot,
    "deploy",
    "name: deploy\ndescription: Ship to production.",
  );
  writeFileSync(join(deploy, "checklist.md"), "1. Run the tests\n2. Tag the release\n");

  const [project] = await db()
    .insert(projects)
    .values({ name: "Harbor", slug: "skills-harbor", directory: projectDir })
    .returning();
  projectId = project!.id;

  await syncSkills(db(), {});
  await syncSkills(db(), { projectId, directory: projectDir });
});

describe("frontmatter", () => {
  it("reads plain key/value pairs and separates the body", () => {
    const { data, body } = parseFrontmatter("---\nname: a\ndescription: b\n---\n\nThe body.");
    expect(data.name).toBe("a");
    expect(data.description).toBe("b");
    expect(body).toBe("The body.");
  });

  it("tolerates CRLF line endings", () => {
    const { data } = parseFrontmatter("---\r\nname: a\r\ndescription: b\r\n---\r\n\r\nBody");
    expect(data.name).toBe("a");
  });

  it("tolerates a byte-order mark before the fence", () => {
    const { data } = parseFrontmatter("﻿---\nname: a\ndescription: b\n---\nBody");
    expect(data.name).toBe("a");
  });

  it("strips matching quotes", () => {
    const { data } = parseFrontmatter(`---\nname: "quoted"\ndescription: 'single'\n---\n`);
    expect(data.name).toBe("quoted");
    expect(data.description).toBe("single");
  });

  it("reads an inline array", () => {
    const { data } = parseFrontmatter("---\ntriggers: [a, b, c]\n---\n");
    expect(data.triggers).toEqual(["a", "b", "c"]);
  });

  it("reads a dash list", () => {
    const { data } = parseFrontmatter("---\ntriggers:\n  - a\n  - b\n---\n");
    expect(data.triggers).toEqual(["a", "b"]);
  });

  it("keeps a key it does not recognise, so another tool's file still loads", () => {
    const { data } = parseFrontmatter("---\nname: a\nlicense: MIT\nallowed-tools: Read\n---\n");
    expect(data.license).toBe("MIT");
    expect(data["allowed-tools"]).toBe("Read");
  });

  it("treats a file with no fence as all body", () => {
    const { data, body } = parseFrontmatter("Just some markdown.");
    expect(data).toEqual({});
    expect(body).toBe("Just some markdown.");
  });

  it("reads a comma-separated string as a list", () => {
    expect(asList("a, b ,c")).toEqual(["a", "b", "c"]);
  });
});

describe("scanning", () => {
  it("finds skills in both scopes", async () => {
    const rows = await loadSkillIndex(db(), projectId);
    const slugs = rows.map((row) => row.slug).sort();
    expect(slugs).toEqual(["changelog", "deploy", "half-written", "pdf-forms"]);
  });

  it("lets a project skill shadow a global one with the same slug", async () => {
    const rows = await loadSkillIndex(db(), projectId);
    const changelog = rows.find((row) => row.slug === "changelog");
    expect(changelog!.scope).toBe("project");
    expect(changelog!.description).toBe("This repo's own changelog rules.");
  });

  it("shows only global skills to a chat with no project", async () => {
    const rows = await loadSkillIndex(db(), null);
    expect(rows.every((row) => row.scope === "global")).toBe(true);
    expect(rows.some((row) => row.slug === "deploy")).toBe(false);
  });

  it("records a broken skill as a problem rather than dropping it", async () => {
    const rows = await loadSkillIndex(db(), projectId);
    const broken = rows.find((row) => row.slug === "half-written");
    expect(broken).toBeDefined();
    expect(broken!.problem).toMatch(/description/);
  });

  it("soft-deletes a skill whose folder has gone", async () => {
    const doomed = writeSkill(
      globalRoot,
      "temporary",
      "name: temporary\ndescription: Briefly here.",
    );
    await syncSkills(db(), {});
    expect((await loadSkillIndex(db(), null)).some((row) => row.slug === "temporary")).toBe(true);

    rmSync(doomed, { recursive: true, force: true });
    await syncSkills(db(), {});
    expect((await loadSkillIndex(db(), null)).some((row) => row.slug === "temporary")).toBe(false);
  });
});

describe("the index sent to the model", () => {
  it("carries names and descriptions but never a body", async () => {
    const block = renderSkillIndex(await loadSkillIndex(db(), projectId), { withPaths: false })!;

    expect(block).toContain("changelog");
    expect(block).toContain("This repo's own changelog rules.");
    expect(block).toContain("Fill and flatten PDF forms.");

    // The whole bargain of progressive disclosure.
    expect(block).not.toContain("Ship notes go in CHANGELOG.md.");
    expect(block).not.toContain("Group by user-visible change");
  });

  it("leaves broken skills out of what the model is told", async () => {
    const block = renderSkillIndex(await loadSkillIndex(db(), projectId), { withPaths: false })!;
    expect(block).not.toContain("half-written");
  });

  it("names absolute paths for a coding agent, which reads files itself", async () => {
    const block = renderSkillIndex(await loadSkillIndex(db(), projectId), { withPaths: true })!;
    expect(block).toContain("SKILL.md");
    expect(block).not.toContain("load_skill");
  });

  it("says nothing at all when there are no skills", () => {
    expect(renderSkillIndex([], { withPaths: false })).toBeNull();
  });
});

describe("loading a skill on demand", () => {
  const tools = () => skillTools({ db: db(), projectId });

  const run = async (name: "load_skill" | "read_skill_file", input: Record<string, unknown>) => {
    const execute = tools()[name].execute as unknown as (
      input: unknown,
      options: unknown,
    ) => Promise<Record<string, unknown>>;
    return execute(input, {});
  };

  it("returns the body with the frontmatter stripped", async () => {
    const result = await run("load_skill", { slug: "deploy" });
    expect(result.instructions).toBe("Do the thing.");
    expect(String(result.instructions)).not.toContain("description:");
  });

  it("resolves a shadowed slug to the project's version", async () => {
    const result = await run("load_skill", { slug: "changelog" });
    expect(result.instructions).toBe("Ship notes go in CHANGELOG.md.");
  });

  it("lists the supporting files beside a skill", async () => {
    const result = await run("load_skill", { slug: "deploy" });
    expect(result.files).toEqual(["checklist.md"]);
  });

  it("reads a supporting file", async () => {
    const result = await run("read_skill_file", { slug: "deploy", file: "checklist.md" });
    expect(String(result.content)).toContain("Tag the release");
  });

  it("refuses to read outside the skill folder", async () => {
    const result = await run("read_skill_file", { slug: "deploy", file: "../../../secret.txt" });
    expect(String(result.error)).toContain("outside");
    expect(result.content).toBeUndefined();
  });

  it("reports an unknown slug rather than throwing", async () => {
    const result = await run("load_skill", { slug: "no-such-skill" });
    expect(String(result.error)).toContain("No skill");
  });

  it("refuses to load a broken skill, and says why", async () => {
    const result = await run("load_skill", { slug: "half-written" });
    expect(String(result.error)).toMatch(/description/);
  });
});
