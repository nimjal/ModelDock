/**
 * Talking to another ModelDock over HTTP.
 *
 * Two halves. The client half is a `Transport` the CLI drives. The server half
 * is a **second listener on a second port**, and that separation is the whole
 * security design.
 *
 * `app.ts` refuses any request that does not claim a loopback Host, and its
 * comment explains why in detail. Widening that to accept a LAN address would
 * expose *every* route — chat, memory, provider configuration, the lot — when
 * the only thing another device needs is three endpoints. So the main app is
 * left exactly as it is, and pairing gets its own tiny app that serves no UI,
 * reads no configuration, and answers three handlers behind a bearer token.
 *
 * It is also off unless asked for. `modeldock pair --host` or
 * `modeldock serve --sync` starts it; nothing else does.
 *
 * **No TLS.** Traffic is plaintext on a local network, authenticated with a
 * bearer token, and message contents are in it. That is stated plainly here and
 * in the README rather than implied away — the answer for an untrusted network
 * is WireGuard or Tailscale, which is what people actually use. The pairing
 * code reserves a `fingerprint` field for a later pinned-certificate version.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import type { Db } from "../db/index.js";
import type { Change } from "./changelog.js";
import { deviceId, savePeer, type Peer } from "./peers.js";
import { serveRequest, type Transport } from "./transport.js";

/** Long enough to walk to the other machine, short enough to be forgotten. */
const INVITE_MS = 10 * 60 * 1000;

interface Invite {
  secret: string;
  expires: number;
}

/** Single-use, in memory: an invite that outlives the process is a liability. */
let invite: Invite | null = null;

export interface PairingCode {
  host: string;
  port: number;
  invite: string;
  /** Reserved for a pinned-certificate version. Unused today. */
  fingerprint?: string;
}

export function encodeCode(code: PairingCode): string {
  return `v1.${Buffer.from(JSON.stringify(code), "utf8").toString("base64url")}`;
}

export function decodeCode(raw: string): PairingCode {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("v1.")) {
    throw new Error("That does not look like a pairing code.");
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(trimmed.slice(3), "base64url").toString("utf8"),
    ) as PairingCode;

    if (!parsed.host || !parsed.port || !parsed.invite) throw new Error("incomplete");
    return parsed;
  } catch {
    throw new Error("That pairing code is not readable. Copy the whole line.");
  }
}

/** Mint the short-lived secret that a joiner trades for a lasting one. */
export function mintInvite(): string {
  const secret = randomBytes(32).toString("base64url");
  invite = { secret, expires: Date.now() + INVITE_MS };
  return secret;
}

export function clearInvite(): void {
  invite = null;
}

/** Constant-time, because this compares a secret against attacker input. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

/**
 * The inbound app: three routes, no UI, no configuration.
 *
 * Deliberately not mounted on the main app. See the header.
 */
export function createPeerApp(db: Db) {
  const app = new Hono();
  const server = serveRequest(db);

  /**
   * Trade a valid invite for a lasting token.
   *
   * The short-lived secret is the one that travels through a chat window or a
   * terminal's scrollback; the long-lived one is minted here and never leaves
   * the two machines that hold it.
   */
  app.post("/pair", async (c) => {
    const body = await c.req.json<{ invite?: string; deviceId?: string; label?: string }>();

    if (!invite || Date.now() > invite.expires) {
      clearInvite();
      return c.json({ error: "No pairing is open. Run `modeldock pair --host` again." }, 403);
    }

    if (!body.invite || !sameSecret(invite.secret, body.invite)) {
      return c.json({ error: "That pairing code is not valid." }, 403);
    }

    if (!body.deviceId)
      return c.json({ error: "The joining device did not identify itself." }, 400);

    // Single use, spent whether or not the rest succeeds.
    clearInvite();

    const token = randomBytes(32).toString("base64url");

    savePeer({
      id: body.deviceId,
      label: body.label ?? "a device",
      // The joiner always initiates, so this side never needs to reach back.
      url: "",
      token,
      pushedThrough: 0,
      pulledThrough: 0,
    });

    return c.json({ token, deviceId: deviceId(), label: hostLabel() });
  });

  /** Everything below needs the lasting token. */
  app.use("/push", authorize);
  app.use("/pull", authorize);

  app.post("/push", async (c) => {
    const body = await c.req.json<{ changes?: Change[] }>();
    return c.json(server.push(body.changes ?? []));
  });

  app.post("/pull", async (c) => {
    const body = await c.req.json<{ since?: number; limit?: number }>();
    return c.json(server.pull(body.since ?? 0, body.limit));
  });

  return app;
}

/** Any paired device's token is accepted; there is nothing to scope per peer. */
async function authorize(
  c: { req: { header: (name: string) => string | undefined } },
  next: () => Promise<void>,
) {
  const { listPeers } = await import("./peers.js");
  const token = bearer(c.req.header("authorization"));
  const known = listPeers().some((peer) => peer.token && token && sameSecret(peer.token, token));

  if (!known) {
    return new Response(JSON.stringify({ error: "Not paired with this device." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  await next();
  return undefined;
}

function hostLabel(): string {
  return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "a device";
}

let listener: { close: () => void; port: number } | null = null;

/** Start answering peers. Off unless someone asked for it. */
export function startPeerServer(db: Db, port = 0): Promise<{ port: number }> {
  if (listener) return Promise.resolve({ port: listener.port });

  return new Promise((resolve) => {
    const app = createPeerApp(db);
    const handle = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
      listener = { close: () => handle.close(), port: info.port };
      resolve({ port: info.port });
    });
  });
}

export function stopPeerServer(): void {
  listener?.close();
  listener = null;
  clearInvite();
}

/** The client half: what `modeldock sync` drives. */
export function httpTransport(peer: Peer): Transport {
  const call = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${peer.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${peer.token}` },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `${peer.label} answered ${response.status}.`);
    }

    return (await response.json()) as T;
  };

  return {
    label: peer.label,
    deviceId: peer.id,
    push: (changes) => call("/push", { changes }),
    pull: (since, limit) => call("/pull", { since, limit }),
  };
}

/** Join a host that is showing a pairing code. */
export async function pairWith(code: PairingCode, label: string): Promise<Peer> {
  const url = `http://${code.host}:${code.port}`;

  const response = await fetch(`${url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite: code.invite, deviceId: deviceId(), label }),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `Pairing failed (${response.status}).`);
  }

  const body = (await response.json()) as { token: string; deviceId: string; label: string };

  const peer: Peer = {
    id: body.deviceId,
    label: body.label,
    url,
    token: body.token,
    pushedThrough: 0,
    pulledThrough: 0,
  };

  savePeer(peer);
  return peer;
}
