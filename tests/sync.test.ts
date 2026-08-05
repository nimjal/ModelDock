/**
 * Two devices, one store.
 *
 * These are the tests that decide whether Cloud Chat is trustworthy, and they
 * run against two live databases with an in-process transport — no ports, no
 * sockets, no timing. The HTTP layer is tested separately and thinly, because
 * what can actually be wrong here is the merge, not the plumbing.
 *
 * The properties being protected, in order of how badly they would hurt:
 *
 *   1. Concurrent edits to *different* columns of one row both survive. A
 *      row-level merge would silently discard one.
 *   2. Concurrent edits to the *same* column pick the same winner on both
 *      sides. Disagreeing here is the worst failure available: both devices
 *      believe they have converged and neither reports anything.
 *   3. Nothing machine-local travels.
 *   4. Running the exchange twice changes nothing.
 */

import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { createDb, type Db } from "../src/server/db/index.js";
import {
  codingAgents,
  connections,
  memories,
  messages,
  projects,
  threads,
} from "../src/server/db/schema.js";
import { patch, put } from "../src/server/db/write.js";
import { seedIfEmpty } from "../src/server/seed.js";
import { applyChanges, changesSince, head } from "../src/server/sync/changelog.js";
import { keepsValue, renameLoser, wins } from "../src/server/sync/merge.js";
import {
  exchange,
  serveRequest,
  type Cursor,
  type Transport,
} from "../src/server/sync/transport.js";

/**
 * Two stores in the one MODELDOCK_HOME this worker was given.
 *
 * `setup.ts` hands each test file a directory, not a database, so putting two
 * files in it needs nothing special — but it does need `closeDb()` to close
 * every handle rather than only the most recent one, which is why that was
 * fixed before any of this was written.
 */
function stores(): { a: Db; b: Db } {
  const home = process.env.MODELDOCK_HOME!;
  const tag = Math.random().toString(36).slice(2);
  return {
    a: createDb(join(home, `a-${tag}.db`)),
    b: createDb(join(home, `b-${tag}.db`)),
  };
}

/** A transport that hands changes straight to the other database. */
function loopback(peer: Db, deviceId: string): Transport {
  const server = serveRequest(peer);
  return {
    label: "loopback",
    deviceId,
    push: async (changes) => server.push(changes),
    pull: async (since, limit) => server.pull(since, limit),
  };
}

const fresh = (): Cursor => ({ pushedThrough: 0, pulledThrough: 0 });

/** Sync both ways, the way `modeldock sync` does. */
async function syncBoth(a: Db, b: Db, cursors: { ab: Cursor; ba: Cursor }) {
  const forward = await exchange(a, loopback(b, "device-b"), cursors.ab);
  cursors.ab = forward.cursor;
  const back = await exchange(b, loopback(a, "device-a"), cursors.ba);
  cursors.ba = back.cursor;
  return { forward, back };
}

let a: Db;
let b: Db;
let cursors: { ab: Cursor; ba: Cursor };

beforeEach(() => {
  ({ a, b } = stores());
  cursors = { ab: fresh(), ba: fresh() };
});

describe("the merge rule, on its own", () => {
  it("prefers the later write", () => {
    expect(wins({ at: 2, origin: "x" }, { at: 1, origin: "z" })).toBe(true);
    expect(wins({ at: 1, origin: "z" }, { at: 2, origin: "x" })).toBe(false);
  });

  it("breaks a tie the same way on both devices", () => {
    const earlier = { at: 5, origin: "aaa" };
    const later = { at: 5, origin: "bbb" };

    // Whichever side is asked, the answer names the same winner.
    expect(wins(later, earlier)).toBe(true);
    expect(wins(earlier, later)).toBe(false);
  });

  it("treats a change with nothing local as new", () => {
    expect(wins({ at: 1, origin: "x" }, undefined)).toBe(true);
  });

  it("ignores a device's own change coming back", () => {
    const same = { at: 7, origin: "x" };
    expect(wins(same, same)).toBe(false);
  });

  it("renames a unique-column loser identically on both sides", () => {
    const older = { createdAt: 100, id: "01ABCDEF" };
    const newer = { createdAt: 200, id: "01ZYXWVU" };

    expect(keepsValue(older, newer)).toBe(true);
    expect(keepsValue(newer, older)).toBe(false);
    // Pure function of the row, so both devices compute the same string.
    expect(renameLoser("harbor", newer.id)).toBe(renameLoser("harbor", newer.id));
    expect(renameLoser("harbor", "01ZYXWVU")).toBe("harbor-xwvu");
  });
});

describe("carrying a change across", () => {
  it("moves a row that only one device has", async () => {
    put(a, connections, { name: "Claude", kind: "anthropic", model: "m" });

    await syncBoth(a, b, cursors);

    const [landed] = b.select().from(connections).all();
    expect(landed?.name).toBe("Claude");
  });

  it("carries a whole thread with its messages, foreign keys satisfied", async () => {
    const project = put(a, projects, { name: "Harbor", slug: "harbor" });
    const thread = put(a, threads, { projectId: project.id, title: "Sharding" });
    put(a, messages, { threadId: thread.id, role: "user", parts: [{ type: "text", text: "Hi" }] });
    put(a, messages, {
      threadId: thread.id,
      role: "assistant",
      parts: [{ type: "text", text: "Yo" }],
    });

    await syncBoth(a, b, cursors);

    expect(b.select().from(projects).all()).toHaveLength(1);
    expect(b.select().from(threads).all()).toHaveLength(1);
    // The apply order is what makes this pass: a message inserted before its
    // thread would violate the foreign key.
    expect(b.select().from(messages).all()).toHaveLength(2);
  });

  it("changes nothing when run again", async () => {
    put(a, connections, { name: "Claude", kind: "anthropic", model: "m" });
    await syncBoth(a, b, cursors);

    const before = JSON.stringify(b.select().from(connections).all());
    const second = await syncBoth(a, b, cursors);

    expect(JSON.stringify(b.select().from(connections).all())).toBe(before);
    expect(second.forward.pushed).toBe(0);
    expect(b.select().from(connections).all()).toHaveLength(1);
  });
});

describe("two devices changing the same thread", () => {
  it("keeps both edits when they touch different columns", async () => {
    const thread = put(a, threads, { title: "Original" });
    await syncBoth(a, b, cursors);

    // A renames it; B archives it. Neither should lose.
    patch(a, threads, thread.id, { title: "Renamed on A" });
    patch(b, threads, thread.id, { archivedAt: 12345 });

    await syncBoth(a, b, cursors);

    for (const [name, store] of [
      ["a", a],
      ["b", b],
    ] as const) {
      const [row] = store.select().from(threads).all();
      expect(row!.title, `${name} kept the rename`).toBe("Renamed on A");
      expect(row!.archivedAt, `${name} kept the archive`).toBe(12345);
    }
  });

  it("picks the same winner on both sides for the same column", async () => {
    const thread = put(a, threads, { title: "Original" });
    await syncBoth(a, b, cursors);

    patch(b, threads, thread.id, { title: "From B" });
    // Later, so it wins wherever the question is asked.
    patch(a, threads, thread.id, { title: "From A", updatedAt: Date.now() + 10_000 });

    await syncBoth(a, b, cursors);

    const titleA = a.select().from(threads).all()[0]!.title;
    const titleB = b.select().from(threads).all()[0]!.title;

    expect(titleA).toBe(titleB);
    expect(titleA).toBe("From A");
  });

  it("does not resurrect something deleted, when the other edit is older", async () => {
    const memory = put(a, memories, { scope: "global", title: "Old", body: "x" });
    await syncBoth(a, b, cursors);

    patch(b, memories, memory.id, { title: "Renamed" });
    patch(a, memories, memory.id, { deletedAt: Date.now() + 10_000 });

    await syncBoth(a, b, cursors);

    for (const store of [a, b]) {
      const [row] = store.select().from(memories).all();
      // Deleted *and* renamed: per-column merge means both edits are real, and
      // the row being gone does not undo the rename that also happened.
      expect(row!.deletedAt).toBeTruthy();
      expect(row!.title).toBe("Renamed");
    }
  });
});

describe("what stays on the machine that wrote it", () => {
  it("never sends a project's directory", async () => {
    put(a, projects, { name: "Harbor", slug: "harbor", directory: "/home/a/harbor" });

    await syncBoth(a, b, cursors);

    const [landed] = b.select().from(projects).all();
    expect(landed?.name).toBe("Harbor");
    // The path exists on A and means nothing on B.
    expect(landed?.directory).toBeNull();
  });

  it("sends a coding agent's identity but not where it is installed", async () => {
    put(a, codingAgents, {
      name: "Claude Code",
      kind: "claude_code",
      command: "/home/a/.local/bin/claude",
      version: "1.2.3",
      detected: true,
    });

    await syncBoth(a, b, cursors);

    const [landed] = b.select().from(codingAgents).all();
    // The row has to travel, because threads.agentId points at it.
    expect(landed?.name).toBe("Claude Code");
    // But B has no such binary, and saying otherwise would be a lie that shows
    // up as a broken Code button.
    expect(landed?.command).toBeNull();
    expect(landed?.detected).toBe(false);
  });

  it("never logs a skill at all", async () => {
    put(a, projects, { name: "Harbor", slug: "harbor" });

    const logged = changesSince(a, 0, 500).map((change) => change.tbl);
    expect(logged).not.toContain("skills");
    expect(logged).not.toContain("changelog");
  });

  it("does not let a peer name a table that is not synced", () => {
    const applied = applyChanges(b, [
      {
        seq: 1,
        tbl: "changelog",
        rowId: "x",
        at: Date.now(),
        origin: "attacker",
        cols: { tbl: "nonsense" },
      },
      {
        seq: 2,
        tbl: "skills",
        rowId: "y",
        at: Date.now(),
        origin: "attacker",
        cols: { path: "/etc" },
      },
    ]);

    expect(applied).toBe(0);
  });
});

describe("two machines that both started fresh", () => {
  it("converges to four connections rather than eight", async () => {
    await seedIfEmpty(a);
    await seedIfEmpty(b);

    await syncBoth(a, b, cursors);

    // The deterministic seed ids are what make this work: without them the two
    // sets of four rows collide on the UNIQUE name and neither device can hold
    // both.
    expect(a.select().from(connections).all()).toHaveLength(4);
    expect(b.select().from(connections).all()).toHaveLength(4);
  });
});

describe("three devices", () => {
  it("carries a change through the middle one", async () => {
    const c = createDb(
      join(process.env.MODELDOCK_HOME!, `c-${Math.random().toString(36).slice(2)}.db`),
    );

    put(a, connections, { name: "Claude", kind: "anthropic", model: "m" });

    // A → B, then B → C. C never spoke to A.
    await syncBoth(a, b, cursors);
    const bc = { ab: fresh(), ba: fresh() };
    await syncBoth(b, c, bc);

    const [landed] = c.select().from(connections).all();
    expect(landed?.name).toBe("Claude");

    // The change kept A's origin the whole way, which is what stops it being
    // mistaken for a new edit each hop.
    const onC = changesSince(c, 0, 500).find((change) => change.tbl === "connections");
    expect(onC?.origin).toBeTruthy();
    expect(head(c)).toBeGreaterThan(0);
  });
});
