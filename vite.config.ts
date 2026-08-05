import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Kept in step with DEFAULT_PORT in src/server/config.ts. */
const API_PORT = process.env.MODELDOCK_PORT ?? "8765";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@web": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
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
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
