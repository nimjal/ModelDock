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

import { setServingPort } from "./config.js";
import { errorResponse } from "./errors.js";
import { gatewayRoutes } from "./gateway/routes.js";
import { chatRoutes } from "./routes/chat.js";
import { codeRoutes } from "./routes/code.js";
import { connectionRoutes } from "./routes/connections.js";
import { healthRoutes } from "./routes/health.js";
import { keyRoutes } from "./routes/keys.js";
import { handoffRoutes } from "./routes/handoff.js";
import { memoryRoutes } from "./routes/memory.js";
import { skillRoutes } from "./routes/skills.js";
import { syncRoutes } from "./routes/sync.js";
import { projectRoutes } from "./routes/projects.js";
import { scriptRoutes } from "./routes/scripts.js";
import { threadRoutes } from "./routes/threads.js";
import { workspaceRoutes } from "./routes/workspace.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AppOptions {
  port: number;
  /** Origins Vite serves the page from in development. */
  devOrigins?: string[];
}

export function createApp({ port, devOrigins = [] }: AppOptions): Hono {
  const app = new Hono();

  // The handoff writes an absolute URL into another program's config, and this
  // is the only place that knows the real port — `--port` never reaches the
  // environment. See `servingPort()`.
  setServingPort(port);

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
  // Runs the script it is sent, which is safe for the same two reasons as
  // everything else here: loopback only, and never from another site's page.
  app.route("/api", scriptRoutes);
  // Loopback-only and Origin-checked like everything else here, which is what
  // lets this one be the single route allowed to accept a credential.
  app.route("/api", keyRoutes);
  app.route("/api", workspaceRoutes);
  // Writes into another program's config file, so it is Origin-checked and
  // loopback-only like everything else here — and shows a diff before it does.
  app.route("/api", handoffRoutes);
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

  /**
   * The gateway, deliberately outside `/api`.
   *
   * `/api` is ModelDock's own surface, spoken by its own page. `/v1` is two
   * other vendors' surfaces, spoken by whatever someone already has installed —
   * and both of those vendors fix the path, so there is no choice about it
   * anyway: Claude Code appends `/v1/messages` to whatever base URL it is given.
   *
   * It sits *after* the middleware above and keeps the Host check, which still
   * does useful work: a page on the open internet cannot reach it. What that
   * check cannot do is distinguish one local process from another, which is why
   * this is the one surface that also asks for a token. See `gateway/token.ts`.
   */
  app.route("/v1", gatewayRoutes);

  return app;
}
