import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Kept in step with DEFAULT_PORT in src/server/config.ts. */
const API_PORT = process.env.MODELDOCK_PORT ?? "8765";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In development the page is served by Vite and the API by Hono, so the
    // browser still only ever talks to one origin.
    //
    // `changeOrigin` rewrites the forwarded Host to the API's own, which the
    // server requires: it refuses any Host it could not have produced. That
    // check stays strict rather than being widened for development, and the
    // Origin the browser attaches (localhost:5173) is allowed explicitly in
    // src/server/main.ts.
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
      // The gateway. Proxied in development for the same reason /api is —
      // so the page and anything testing the endpoint see one origin.
      "/v1": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
