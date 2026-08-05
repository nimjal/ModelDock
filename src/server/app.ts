/**
 * The HTTP surface.
 *
 * ModelDock binds to loopback and has no authentication, so the only thing
 * standing between a page on the open internet and someone's local API is the
 * browser's own rules. Two exact-match checks make that reliable rather than
 * hopeful: a request must claim a Host this server could have produced, and a
 * mutating request must not carry another site's Origin. A domain that
 * resolves to 127.0.0.1 cannot forge the first, and a cross-site fetch always
 * carries the second.
 */

import { Hono } from "hono";

import { errorResponse } from "./errors.js";
import { chatRoutes } from "./routes/chat.js";
import { codeRoutes } from "./routes/code.js";
import { connectionRoutes } from "./routes/connections.js";
import { healthRoutes } from "./routes/health.js";
import { memoryRoutes } from "./routes/memory.js";
import { skillRoutes } from "./routes/skills.js";
import { syncRoutes } from "./routes/sync.js";
import { projectRoutes } from "./routes/projects.js";
import { threadRoutes } from "./routes/threads.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AppOptions {
  port: number;
  /** Origins Vite serves the page from in development. */
  devOrigins?: string[];
}

export function createApp({ port, devOrigins = [] }: AppOptions): Hono {
  const app = new Hono();

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...devOrigins,
  ]);

  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!allowedHosts.has(host)) {
      return c.json({ error: `Unexpected Host header "${host}"` }, 403);
    }

    if (MUTATING.has(c.req.method)) {
      const origin = c.req.header("origin");
      // Absent Origin means the request did not come from another site's
      // page, which is the only thing this check is defending against.
      if (origin && !allowedOrigins.has(origin)) {
        return c.json({ error: `Cross-origin request from "${origin}"` }, 403);
      }
    }

    await next();
  });

  app.onError(errorResponse);

  app.route("/api", healthRoutes);
  app.route("/api", connectionRoutes);
  app.route("/api", projectRoutes);
  app.route("/api", threadRoutes);
  app.route("/api", memoryRoutes);
  app.route("/api", skillRoutes);
  app.route("/api", codeRoutes);
  app.route("/api", chatRoutes);
  // Outbound only. The inbound half is a separate listener on its own port —
  // mounting it here would put every route above on the network.
  app.route("/api", syncRoutes);

  app.all("/api/*", (c) => c.json({ error: `No route ${c.req.path}` }, 404));

  return app;
}
