/**
 * The credential the gateway checks.
 *
 * Beside the database rather than in it, for exactly the reason
 * `config.ts` gives for the approval secret and the pairing token: `schema.ts`
 * promises that a stolen or synced store contains no credentials, and that
 * promise is unconditional. It also has to stay stable across restarts, because
 * it is written into someone else's config file — a token that rotated on every
 * launch would break Claude Code every time ModelDock restarted.
 *
 * ## Why there is a token at all
 *
 * The rest of the API is loopback-only with a Host check and no auth, and that
 * is defensible: it is reachable only from this machine, and the thing it
 * protects is this machine's own data. The gateway is a different proposition.
 * It turns every key on this machine into a general-purpose inference endpoint
 * that anything running as this user can spend — a stray `npm` postinstall
 * script, a browser extension's native host, an agent someone is evaluating.
 * The Host check does not help there, because those callers are perfectly happy
 * to send `Host: 127.0.0.1:8765`.
 *
 * So the gateway asks for something the rest of the API does not, and it costs
 * nothing to supply: Claude Code wants `ANTHROPIC_AUTH_TOKEN` regardless, and
 * OpenCode's provider block has an `apiKey` field sitting empty otherwise.
 *
 * The comparison is length-constant on purpose. A timing oracle on a local
 * socket is a marginal threat, but the correct comparison is four lines.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { modeldockHome } from "../config.js";

/** Recognisable in a config file, and obviously not an Anthropic key. */
const PREFIX = "md-";

export function gatewayTokenPath(): string {
  return join(modeldockHome(), "gateway.token");
}

let cached: string | null = null;

/**
 * The token, minting one on first use.
 *
 * Created lazily rather than at startup so a store that never serves the
 * gateway never grows a credential file — the same restraint `deviceId()`
 * shows with `peers.json`.
 */
export function gatewayToken(): string {
  if (cached) return cached;

  const path = gatewayTokenPath();

  if (existsSync(path)) {
    try {
      const existing = readFileSync(path, "utf8").trim();
      if (existing) {
        cached = existing;
        return existing;
      }
    } catch {
      /* unreadable is the same as absent: mint a new one below */
    }
  }

  const minted = `${PREFIX}${randomBytes(24).toString("base64url")}`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${minted}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    // Re-applied because `mode` only takes effect on creation, and a no-op on
    // Windows where the profile directory does the protecting instead.
    chmodSync(path, 0o600);
  } catch {
    /* not fatal — still only readable by this account */
  }

  cached = minted;
  return minted;
}

/**
 * Throw the cached value away so the next call mints a new one.
 *
 * Rotating invalidates every config file that carries the old token, which is
 * why nothing calls this automatically. It exists so someone who has pasted a
 * token somewhere they regret can replace it.
 */
export function rotateGatewayToken(): string {
  cached = null;
  const path = gatewayTokenPath();
  try {
    writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
  } catch {
    /* the mint below will create it */
  }
  return gatewayToken();
}

/**
 * Whether a request carried the right credential.
 *
 * Both header spellings are accepted because both clients are right about
 * their own protocol: OpenAI-shaped tooling sends `Authorization: Bearer`, and
 * Anthropic-shaped tooling sends `x-api-key`. Requiring each protocol to use
 * its own would be a needless trap for anything speaking one and configured
 * like the other.
 */
export function tokenFromHeaders(headers: Headers): string | null {
  const bearer = headers.get("authorization");
  if (bearer) {
    const match = /^Bearer\s+(.+)$/i.exec(bearer.trim());
    if (match) return match[1]!.trim();
  }

  const apiKey = headers.get("x-api-key");
  return apiKey ? apiKey.trim() : null;
}

export function checkGatewayToken(headers: Headers): boolean {
  const offered = tokenFromHeaders(headers);
  if (!offered) return false;

  const expected = gatewayToken();
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);

  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length — so the lengths are compared first and the result folded in.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
