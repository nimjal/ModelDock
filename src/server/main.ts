/**
 * Development entry: the API only.
 *
 * Vite serves the page on 5173 and proxies `/api` here, so the browser still
 * talks to one origin. In production `cli.ts` serves both from this port.
 */

import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { HOST, resolvePort } from "./config.js";
import { db } from "./db/index.js";
import { seedIfEmpty } from "./seed.js";

const port = resolvePort();

await seedIfEmpty(db());

serve({
  fetch: createApp({ port, devOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"] }).fetch,
  hostname: HOST,
  port,
});

console.log(`ModelDock API on http://${HOST}:${port} — page on http://localhost:5173`);
