/**
 * Sync, from the web UI's side.
 *
 * Outbound only, and on the ordinary loopback app — so "Sync now" is a button
 * like any other. The *inbound* half deliberately does not live here: it is a
 * separate listener on a separate port, because accepting a peer on this app
 * would mean exposing every route on it. See `sync/peer-http.ts`.
 *
 * Tokens never appear in a response, the same rule `connections.ts` follows for
 * API keys.
 */

import { Hono } from "hono";

import { db } from "../db/index.js";
import { head } from "../sync/changelog.js";
import { deviceId, listPeers, removePeer } from "../sync/peers.js";
import { syncAll } from "../sync/run.js";
import { HttpError } from "../errors.js";

export const syncRoutes = new Hono();

syncRoutes.get("/sync", async (c) => {
  return c.json({
    device: deviceId(),
    seq: head(db()),
    peers: listPeers().map((peer) => ({
      id: peer.id,
      label: peer.label,
      url: peer.url,
      pushedThrough: peer.pushedThrough,
      pulledThrough: peer.pulledThrough,
      // Never the token. It is a credential like any other.
      paired: Boolean(peer.token),
    })),
  });
});

syncRoutes.post("/sync/run", async (c) => {
  return c.json(await syncAll(db()));
});

syncRoutes.delete("/sync/peers/:id", async (c) => {
  const id = c.req.param("id");
  if (!removePeer(id)) throw new HttpError(404, `Not paired with ${id}.`);
  return c.json({ ok: true });
});
