/**
 * Point every test file at a private, disposable store.
 *
 * `setupFiles` runs before the file's imports are evaluated, which matters:
 * `config.ts` reads `MODELDOCK_HOME` when the database is first opened, and
 * the database is opened lazily on first use. Setting it here means no test
 * can reach a real install.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

const home = mkdtempSync(join(tmpdir(), "modeldock-test-"));
process.env.MODELDOCK_HOME = home;

afterAll(async () => {
  // The database has to let go of the file before the directory can be
  // removed — on Windows an open SQLite handle holds a lock.
  const { closeDb } = await import("../src/server/db/index.js");
  closeDb();

  // Cleanup is a courtesy, not a result. A stray temp directory must never
  // turn a passing suite red.
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* the OS will get it */
  }
});
