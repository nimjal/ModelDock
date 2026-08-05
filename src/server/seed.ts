/**
 * First run.
 *
 * The worst version of BYOK is an empty screen that asks you to describe a
 * provider before it will do anything. ModelDock instead offers the four
 * shapes almost everyone wants, pre-filled with the conventional environment
 * variable for each — so someone who already has `ANTHROPIC_API_KEY` exported
 * can open the app and type. Nothing here is a secret: these rows name
 * variables, and a connection whose variable is unset simply reports as not
 * ready until it is.
 */

import { count } from "drizzle-orm";

import type { Db } from "./db/index.js";
import { connections } from "./db/schema.js";
import { putMany } from "./db/write.js";
import { KINDS } from "./providers/catalog.js";

/**
 * A fixed id for a row every machine creates for itself.
 *
 * These four rows are not a person's data — they are the same four defaults on
 * every install. If each machine minted its own ULID for them, pairing two
 * fresh machines would produce eight connections, four of which would collide
 * on the UNIQUE `name`. Agreeing on the id up front means the two copies are
 * simply the same row, and merge as one.
 *
 * Shaped like a ULID and dated to the epoch, so they sort ahead of anything
 * genuinely created later.
 */
const seedId = (slot: number): string => `0000000000SEED${String(slot).padStart(12, "0")}`;

export async function seedIfEmpty(db: Db): Promise<void> {
  const [existing] = await db.select({ total: count() }).from(connections);
  if ((existing?.total ?? 0) > 0) return;

  putMany(db, connections, [
    {
      id: seedId(1),
      name: "Anthropic",
      kind: "anthropic",
      model: KINDS.anthropic.suggestedModels[0]!,
      apiKeyEnv: KINDS.anthropic.defaultApiKeyEnv,
    },
    {
      id: seedId(2),
      name: "OpenAI",
      kind: "openai",
      model: KINDS.openai.suggestedModels[0]!,
      apiKeyEnv: KINDS.openai.defaultApiKeyEnv,
    },
    {
      id: seedId(3),
      name: "Google",
      kind: "google",
      model: KINDS.google.suggestedModels[0]!,
      apiKeyEnv: KINDS.google.defaultApiKeyEnv,
    },
    {
      id: seedId(4),
      name: "Ollama",
      kind: "ollama",
      baseUrl: KINDS.ollama.defaultBaseUrl,
      model: KINDS.ollama.suggestedModels[0]!,
      apiKeyEnv: null,
    },
  ]);
}
