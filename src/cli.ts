#!/usr/bin/env node
/**
 * `npx modeldock`.
 *
 * Three commands and no configuration step: start the workspace, print what
 * is wrong, or serve memory over MCP. The database is created and migrated on
 * first open, so a machine that has never seen ModelDock gets a working app
 * from one command.
 */

import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import open from "open";

import { createApp } from "./server/app.js";
import { stopOpencodeServer } from "./server/code/opencode.js";
import { DEFAULT_PORT, HOST, modeldockHome } from "./server/config.js";
import { db } from "./server/db/index.js";
import { stopAllRuns } from "./server/routes/code.js";
import { runChecks } from "./server/routes/health.js";
import { seedIfEmpty } from "./server/seed.js";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

interface Options {
  port: number;
  openBrowser: boolean;
  /** `pair --host`: wait for another device instead of joining one. */
  host: boolean;
  /** The port the peer listener answers on. 0 lets the OS choose. */
  syncPort: number;
  /** A pairing code, for `pair <code>`. */
  code: string | null;
}

function parse(argv: string[]): { command: string; options: Options } {
  const options: Options = {
    port: DEFAULT_PORT,
    openBrowser: true,
    host: false,
    syncPort: 8766,
    code: null,
  };
  let command = "serve";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--port" || arg === "-p") {
      const value = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(value)) throw new Error("--port needs a number");
      options.port = value;
    } else if (arg === "--sync-port") {
      const value = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(value)) throw new Error("--sync-port needs a number");
      options.syncPort = value;
    } else if (arg === "--no-open") {
      options.openBrowser = false;
    } else if (arg === "--host") {
      options.host = true;
    } else if (arg === "--help" || arg === "-h") {
      command = "help";
    } else if (!arg.startsWith("-")) {
      if (command === "pair" && !options.code) options.code = arg;
      else command = arg;
    }
  }

  return { command, options };
}

const HELP = `ModelDock — a unified AI workspace you own.

  modeldock                Start the workspace and open it
  modeldock doctor         Report what is and is not set up
  modeldock mcp            Serve memory over MCP on stdio

  modeldock pair --host    Show a code another device can join with
  modeldock pair <code>    Join a device that is showing a code
  modeldock sync           Exchange changes with every paired device
  modeldock peers          List the devices this one is paired with

Options
  -p, --port <number>      Port to listen on (default ${DEFAULT_PORT})
      --sync-port <number> Port to accept peers on (default 8766)
      --no-open            Do not open a browser
  -h, --help               This

Everything lives in ${modeldockHome()}
`;

/**
 * Serve the built page alongside the API.
 *
 * Hono handles /api; anything else is a file from the bundle, falling back to
 * index.html so the app owns its own routing. Paths are resolved and checked
 * to stay inside the bundle — this listens on a socket, so a `..` in a
 * request must not be able to read the filesystem.
 */
async function servePage(pathname: string): Promise<Response> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const candidate = normalize(join(WEB_ROOT, decodeURIComponent(requested)));

  const inside = candidate === WEB_ROOT || candidate.startsWith(WEB_ROOT + sep);
  const target = inside ? candidate : join(WEB_ROOT, "index.html");

  try {
    const body = await readFile(target);
    return new Response(new Uint8Array(body), {
      headers: { "content-type": MIME[extname(target)] ?? "application/octet-stream" },
    });
  } catch {
    // An unknown path is a client route, not a 404.
    try {
      const fallback = await readFile(join(WEB_ROOT, "index.html"));
      return new Response(new Uint8Array(fallback), {
        headers: { "content-type": MIME[".html"]! },
      });
    } catch {
      return new Response("ModelDock was not built. Run: npm run build", { status: 500 });
    }
  }
}

/**
 * Pair two devices.
 *
 * Only the joiner ever initiates, on purpose. The host sits and waits, so it
 * never needs to know how to reach the other machine — which means a laptop
 * behind NAT can pair with, and later sync to, a desktop, and only the desktop
 * has to be reachable. Making it symmetric would require both to be.
 */
async function pair(options: Options): Promise<number> {
  const { decodeCode, encodeCode, mintInvite, pairWith, startPeerServer, stopPeerServer } =
    await import("./server/sync/peer-http.js");

  if (options.host) {
    const { port } = await startPeerServer(db(), options.syncPort);
    const code = encodeCode({ host: localAddress(), port, invite: mintInvite() });

    console.log(`\nListening on http://0.0.0.0:${port} — anything on this network can reach it.`);
    console.log(
      "This is plaintext on your local network. Over anything else, use WireGuard or Tailscale.\n",
    );
    console.log("Run this on the other machine, within ten minutes:\n");
    console.log(`  modeldock pair ${code}\n`);
    console.log("Ctrl-C when it has joined.\n");

    return await new Promise<number>((resolveExit) => {
      const stop = () => {
        stopPeerServer();
        resolveExit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  }

  if (!options.code) {
    console.error("Give the code from `modeldock pair --host`, or pass --host to show one.");
    return 1;
  }

  const peer = await pairWith(decodeCode(options.code), localAddress());
  console.log(`\n  ok    paired with "${peer.label}"\n`);
  console.log("Now run `modeldock sync` here whenever you want to catch up.\n");
  return 0;
}

/** A label and a reachable address — best effort, and shown so it can be corrected. */
function localAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

async function main(): Promise<number> {
  const { command, options } = parse(process.argv.slice(2));

  if (command === "help") {
    console.log(HELP);
    return 0;
  }

  if (command === "mcp") {
    const { startMcpServer } = await import("./server/mcp/server.js");
    await startMcpServer();
    return 0;
  }

  await seedIfEmpty(db());

  if (command === "doctor") {
    const checks = await runChecks();
    console.log(`ModelDock — ${modeldockHome()}\n`);
    for (const check of checks) {
      const mark = check.status === "ok" ? "ok  " : check.status === "warn" ? "warn" : "fail";
      console.log(`  ${mark}  ${check.label.padEnd(14)} ${check.detail}`);
    }
    console.log();
    return checks.some((check) => check.status === "fail") ? 1 : 0;
  }

  if (command === "peers") {
    const { listPeers, deviceId } = await import("./server/sync/peers.js");
    const peers = listPeers();

    console.log(`This device — ${deviceId()}\n`);
    if (peers.length === 0) {
      console.log("  Not paired with anything. Run `modeldock pair --host` on one machine.\n");
      return 0;
    }
    for (const peer of peers) {
      console.log(`  ${peer.label.padEnd(20)} ${peer.url || "(joins us)"}`);
    }
    console.log();
    return 0;
  }

  if (command === "sync") {
    const { syncAll, summarise } = await import("./server/sync/run.js");
    const report = await syncAll(db());

    for (const peer of report.peers) {
      if (peer.error) console.log(`  fail  ${peer.peer.padEnd(20)} ${peer.error}`);
      else
        console.log(`  ok    ${peer.peer.padEnd(20)} pushed ${peer.pushed}, pulled ${peer.pulled}`);
      // Nothing here can fix a clock, so say it rather than resolve edits in
      // the wrong order silently.
      if (peer.skew) console.log(`  warn  ${"".padEnd(20)} ${peer.skew}; edits may resolve oddly`);
    }

    console.log(`\n${summarise(report)}\n`);
    return report.peers.some((peer) => peer.error) ? 1 : 0;
  }

  if (command === "pair") {
    return await pair(options);
  }

  if (command !== "serve") {
    console.error(`Unknown command "${command}". Try: modeldock --help`);
    return 1;
  }

  const app = createApp({ port: options.port });

  const server = serve({
    fetch: (request) => {
      const url = new URL(request.url);
      return url.pathname.startsWith("/api") ? app.fetch(request) : servePage(url.pathname);
    },
    hostname: HOST,
    port: options.port,
  });

  const url = `http://${HOST}:${options.port}`;
  console.log(`ModelDock on ${url} — loopback only, Ctrl-C to stop`);
  if (options.openBrowser) await open(url);

  return await new Promise<number>((resolveExit) => {
    const shutdown = () => {
      // Agents first, and before the HTTP server: a coding run is a child
      // process working in someone's checkout, and Ctrl-C must not leave one
      // behind still editing files after ModelDock is gone.
      stopAllRuns();
      stopOpencodeServer();
      server.close();
      resolveExit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
