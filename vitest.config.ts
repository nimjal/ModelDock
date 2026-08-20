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
     * Vitest's default is 5s, which is a number measured on a developer's
     * machine. This suite opens real SQLite files and starts real
     * subprocesses, and a GitHub Actions runner does both several times
     * slower than a laptop with an NVMe disk — a single `createDb` that costs
     * ~50ms here has been observed at ~850ms there. A default calibrated
     * locally means the first thing a slow runner does is fail a test that is
     * working correctly, in public, which teaches everyone to re-run red
     * builds instead of reading them.
     *
     * 15s is still far below the job's own 15-minute timeout, so a test that
     * has genuinely hung is caught either way.
     */
    testTimeout: 15_000,

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
