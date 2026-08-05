/**
 * The write layer, and the rule that there is only one of it.
 *
 * Two things are being protected here. The first is that a row change and its
 * changelog entry are atomic — if that ever stops being true, two devices
 * quietly disagree and nothing fails loudly enough to notice. The second is
 * that nobody bypasses `db/write.ts`, which is asserted by scanning the source
 * rather than by hoping: the audit that produced this layer found the previous
 * convention (`{ updatedAt: Date.now() }`, hand-copied) already broken in two
 * places.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDb } from "../src/server/db/index.js";
import { changelog, connections, projects, skills } from "../src/server/db/schema.js";
import { bury, patch, patchWhere, put, stamp } from "../src/server/db/write.js";

const store = () => createDb(":memory:");

const log = (db: ReturnType<typeof store>) => db.select().from(changelog).all();

describe("the clock", () => {
  it("never goes backwards, even within a millisecond", () => {
    const stamps = Array.from({ length: 500 }, () => stamp());
    const sorted = [...stamps].sort((a, b) => a - b);

    expect(stamps).toEqual(sorted);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it("gives a row an updatedAt that is never earlier than its createdAt", () => {
    const db = store();
    const row = put(db, connections, { name: "A", kind: "anthropic", model: "m" });
    const after = patch(db, connections, row.id, { model: "n" })!;

    expect(row.updatedAt).toBe(row.createdAt);
    expect(after.updatedAt).toBeGreaterThan(after.createdAt);
  });
});

describe("writing a row", () => {
  it("logs every column on insert, so a peer can recreate the row", () => {
    const db = store();
    const row = put(db, connections, { name: "A", kind: "anthropic", model: "m" });

    const [entry, ...rest] = log(db);
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({ tbl: "connections", rowId: row.id, at: row.updatedAt });
    // NOT NULL columns the caller never mentioned have to be in there.
    expect(entry!.cols).toEqual(
      expect.arrayContaining(["id", "name", "kind", "model", "createdAt"]),
    );
  });

  it("logs only what changed on update", () => {
    const db = store();
    const row = put(db, connections, { name: "A", kind: "anthropic", model: "m" });
    patch(db, connections, row.id, { model: "n" });

    const entries = log(db);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.cols).toEqual(["model", "updatedAt"]);
  });

  it("records a soft delete as an ordinary column change", () => {
    const db = store();
    const row = put(db, connections, { name: "A", kind: "anthropic", model: "m" });
    const gone = bury(db, connections, row.id)!;

    expect(gone.deletedAt).toBeGreaterThan(0);
    expect(log(db)[1]!.cols).toEqual(["deletedAt", "updatedAt"]);
  });

  it("stamps and logs every row a bulk update touched", () => {
    const db = store();
    const project = put(db, projects, { name: "P", slug: "p" });
    put(db, connections, { name: "A", kind: "anthropic", model: "m" });
    put(db, connections, { name: "B", kind: "openai", model: "m" });

    const touched = patchWhere(db, connections, eq(connections.kind, "anthropic"), {
      model: "changed",
    });

    expect(touched).toHaveLength(1);
    expect(project.id).toBeTruthy();

    // Three inserts logged every column; only the bulk update logged just the
    // two it actually changed.
    const updates = log(db).filter((entry) => entry.cols.length === 2);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ tbl: "connections", rowId: touched[0]!.id });
    expect(updates[0]!.cols).toEqual(["model", "updatedAt"]);
  });
});

describe("atomicity", () => {
  it("leaves no log entry behind when the write fails", () => {
    const db = store();
    put(db, connections, { name: "taken", kind: "anthropic", model: "m" });
    const before = log(db).length;

    // `connections.name` is UNIQUE, so this insert cannot land.
    expect(() => put(db, connections, { name: "taken", kind: "openai", model: "m" })).toThrow();

    expect(log(db)).toHaveLength(before);
    expect(db.select().from(connections).all()).toHaveLength(1);
  });
});

describe("what does not travel", () => {
  it("never logs a skill, because the folder on disk is the truth", () => {
    const db = store();
    const row = put(db, skills, {
      slug: "s",
      scope: "global",
      name: "S",
      path: "/tmp/s",
    });
    patch(db, skills, row.id, { description: "changed" });

    expect(log(db)).toHaveLength(0);
    expect(db.select().from(skills).all()).toHaveLength(1);
  });
});

describe("rows every machine creates for itself", () => {
  it("gives the seeded connections the same ids on two fresh stores", async () => {
    const { seedIfEmpty } = await import("../src/server/seed.js");

    const a = store();
    const b = store();
    await seedIfEmpty(a);
    await seedIfEmpty(b);

    const ids = (db: ReturnType<typeof store>) =>
      db
        .select()
        .from(connections)
        .all()
        .map((row) => row.id)
        .sort();

    expect(ids(a)).toEqual(ids(b));
    expect(ids(a)).toHaveLength(4);

    // The payoff: merging these two stores yields four connections, not eight
    // with four UNIQUE-name collisions.
    expect(new Set([...ids(a), ...ids(b)]).size).toBe(4);
  });

  it("does not seed twice", async () => {
    const { seedIfEmpty } = await import("../src/server/seed.js");

    const db = store();
    await seedIfEmpty(db);
    await seedIfEmpty(db);

    expect(db.select().from(connections).all()).toHaveLength(4);
  });
});

describe("the one-write-surface rule", () => {
  const root = new URL("../src/server/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

  /**
   * The two files allowed to write, and why there are two.
   *
   * `db/write.ts` is where anything this device decides to do goes. The sync
   * applier is the other end of the same pipe: it writes rows that arrived from
   * another device, keeping the stamp and the origin they were *given* rather
   * than minting new ones — which is exactly what `write.ts` exists to prevent
   * a caller doing by accident. It also has to apply a whole batch in one
   * transaction so a half-applied sync cannot exist.
   *
   * Adding a third entry to this list should feel like a decision. That is the
   * point of the list.
   */
  const ALLOWED = [join("db", "write.ts"), join("sync", "changelog.ts")];

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.isFile() && path.endsWith(".ts") ? [path] : [];
    });
  }

  it("keeps every insert and update in one of the two write surfaces", () => {
    const offenders = sources(root)
      .filter((path) => !ALLOWED.some((allowed) => path.endsWith(allowed)))
      .filter((path) => /\.(insert|update)\(/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(root.length));

    expect(offenders).toEqual([]);
  });

  it("has exactly the two it expects, so a third is a deliberate change", () => {
    const writers = sources(root)
      .filter((path) => /\.(insert|update)\(/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(root.length));

    expect(writers.sort()).toEqual(ALLOWED.sort());
  });
});
