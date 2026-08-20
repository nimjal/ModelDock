import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file gets its own worker, and setup.ts gives that worker its
    // own MODELDOCK_HOME — so the lazily-opened database singleton is a fresh
    // one per file and no test can see another's rows.
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    environment: "node",

    /**
     * Reported, never gated.
     *
     * A threshold turns a number into a target, and the honest state of this
     * project is that the parts worth covering — the directory boundary, the
     * permission mapping, the merge rule — are covered deliberately rather
     * than incidentally. A percentage that made the suite red would push
     * people towards tests that raise it instead of tests that matter.
     *
     * `src/web` is excluded because there is no DOM environment configured, so
     * counting it would report a number nothing could ever move.
     */
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**"],
      exclude: ["src/web/**", "**/*.d.ts", "src/server/main.ts"],
    },
  },
});
