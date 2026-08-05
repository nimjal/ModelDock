/**
 * Bundle the server and CLI into `dist/cli.js`.
 *
 * The published package is one JavaScript file plus the built page, so
 * `npx modeldock` starts without resolving a dependency tree at run time.
 * better-sqlite3 is native and stays external — it is installed as a real
 * dependency and loaded from node_modules.
 */

import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  external: ["better-sqlite3"],
  // better-sqlite3 is CommonJS and calls `require` at load time, which ESM
  // does not provide. Only `require` is shimmed: dependencies that want
  // `__dirname` already define their own, and declaring it here collides
  // with theirs. Our own code resolves paths from `import.meta.url`.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
