/**
 * The wire, thinly.
 *
 * The merge is tested against two live stores in `sync.test.ts` with no
 * sockets involved, because that is where the behaviour worth protecting is.
 * What is left for here is the part a loopback transport cannot show: that
 * pairing actually gates access, that an unpaired device is refused, and —
 * most importantly — that adding an inbound listener did not quietly open the
 * main app to the network.
 *
 * That last one is the reason the peer listener is a separate app on a separate
 * port at all, so it gets a test rather than a comment.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app.js";
import { createDb, type Db } from "../src/server/db/index.js";
import { connections } from "../src/server/db/schema.js";
import { put } from "../src/server/db/write.js";
import {
  createPeerApp,
  decodeCode,
  encodeCode,
  mintInvite,
  clearInvite,
} from "../src/server/sync/peer-http.js";
import { deviceId, listPeers } from "../src/server/sync/peers.js";

let host: Db;
let app: ReturnType<typeof createPeerApp>;

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeAll(() => {
  host = createDb(join(process.env.MODELDOCK_HOME!, "peer-host.db"));
  app = createPeerApp(host);
});

afterAll(() => clearInvite());

describe("the pairing code", () => {
  it("survives a round trip through a terminal", () => {
    const code = { host: "192.168.1.20", port: 8766, invite: "s3cret_value-xyz" };
    const decoded = decodeCode(encodeCode(code));

    expect(decoded).toMatchObject(code);
  });

  it("refuses something that is not one, with a readable message", () => {
    expect(() => decodeCode("hello")).toThrow(/pairing code/i);
    expect(() => decodeCode("v1.not-base64!!")).toThrow(/readable/i);
  });
});

describe("joining", () => {
  it("refuses a wrong invite", async () => {
    mintInvite();

    const response = await app.request(
      "/pair",
      json({ invite: "wrong", deviceId: "device-x", label: "laptop" }),
    );

    expect(response.status).toBe(403);
  });

  it("refuses when no pairing is open", async () => {
    clearInvite();

    const response = await app.request(
      "/pair",
      json({ invite: "anything", deviceId: "device-x", label: "laptop" }),
    );

    expect(response.status).toBe(403);
  });

  it("trades a valid invite for a lasting token, once", async () => {
    const invite = mintInvite();

    const first = await app.request(
      "/pair",
      json({ invite, deviceId: "device-laptop", label: "laptop" }),
    );
    expect(first.status).toBe(200);

    const body = (await first.json()) as { token: string; deviceId: string };
    expect(body.token).toBeTruthy();
    expect(body.deviceId).toBe(deviceId());
    expect(listPeers().some((peer) => peer.id === "device-laptop")).toBe(true);

    // Single use: the short-lived secret has been through a terminal, so it is
    // spent the moment it works.
    const second = await app.request(
      "/pair",
      json({ invite, deviceId: "device-other", label: "other" }),
    );
    expect(second.status).toBe(403);
  });
});

describe("exchanging changes", () => {
  let token: string;

  beforeAll(async () => {
    const invite = mintInvite();
    const response = await app.request(
      "/pair",
      json({ invite, deviceId: "device-peer", label: "peer" }),
    );
    token = ((await response.json()) as { token: string }).token;
  });

  const authed = (body: unknown) => ({
    ...json(body),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  });

  it("refuses a pull with no token", async () => {
    const response = await app.request("/pull", json({ since: 0 }));
    expect(response.status).toBe(401);
  });

  it("refuses a pull with a token that was never issued", async () => {
    const response = await app.request("/pull", {
      ...json({ since: 0 }),
      headers: { "content-type": "application/json", authorization: "Bearer made-up" },
    });
    expect(response.status).toBe(401);
  });

  it("hands over what it has to a paired device", async () => {
    put(host, connections, { name: "Over the wire", kind: "anthropic", model: "m" });

    const response = await app.request("/pull", authed({ since: 0 }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      changes: { tbl: string; cols: Record<string, unknown> }[];
      clock: number;
    };

    const change = body.changes.find((entry) => entry.tbl === "connections");
    expect(change?.cols.name).toBe("Over the wire");
    // The peer's wall clock, so the caller can notice a skew it cannot fix.
    expect(body.clock).toBeGreaterThan(0);
  });

  it("accepts a push from a paired device", async () => {
    const response = await app.request(
      "/push",
      authed({
        changes: [
          {
            seq: 1,
            tbl: "connections",
            rowId: "01PUSHEDFROMTHEOTHERSIDE00",
            at: Date.now(),
            origin: "device-peer",
            cols: { id: "01PUSHEDFROMTHEOTHERSIDE00", name: "Pushed", kind: "openai", model: "m" },
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(
      host
        .select()
        .from(connections)
        .all()
        .some((row) => row.name === "Pushed"),
    ).toBe(true);
  });
});

/**
 * The whole reason inbound pairing is a second app on a second port.
 *
 * `app.ts` refuses anything not claiming a loopback Host, and that has to stay
 * true — otherwise pairing two machines would put chat, memory and provider
 * configuration on the network alongside the three endpoints that needed to be
 * there.
 */
describe("the main app", () => {
  it("still refuses a Host it could not have produced", async () => {
    const main = createApp({ port: 8765 });

    const response = await main.request("http://127.0.0.1:8765/api/health", {
      headers: { host: "modeldock.example.com" },
    });

    expect(response.status).toBe(403);
  });

  it("has no peer endpoints on it", async () => {
    const main = createApp({ port: 8765 });

    for (const path of ["/api/pair", "/api/push", "/api/pull"]) {
      const response = await main.request(`http://127.0.0.1:8765${path}`, {
        ...json({}),
        headers: { "content-type": "application/json", host: "127.0.0.1:8765" },
      });
      expect(response.status, path).toBe(404);
    }
  });
});
