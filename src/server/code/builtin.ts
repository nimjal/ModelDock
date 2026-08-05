/**
 * Coding without an external agent.
 *
 * The other two adapters drive somebody else's program. This one runs the loop
 * here, on an ordinary ModelDock connection — which makes it the first coding
 * surface where the model answering is a column in this database rather than
 * whatever the installed binary happens to be configured with.
 *
 * It is thin because it should be. `streamText` already does the agentic loop,
 * and `toUIMessageStream` already emits exactly the chunk types the transcript
 * renders — so `normalize.ts` is not involved at all. That file exists to
 * translate two foreign event streams into the SDK's vocabulary; here the
 * vocabulary is native, and running native output back through a translator
 * would only be a way to introduce bugs.
 *
 * Three consequences worth knowing:
 *
 *   - The session is this store's transcript. Nothing is kept in a `~/.claude`
 *     that only exists on one machine, so `agentSessionId` stays null and a
 *     built-in coding thread resumes anywhere the store reaches — the exact
 *     limitation the README records for Claude Code, inverted.
 *   - `provider` on the stored message is the *connection's* kind, not
 *     "builtin", with the model it actually resolved. A coding turn is
 *     attributed the same way a chat turn is, which is what
 *     `tests/chat.test.ts` exists to protect.
 *   - The tool names are ModelDock's own — `read_file`, `write_file` — where a
 *     Claude Code transcript says `read` and `write`. That inconsistency is
 *     accepted deliberately: these *are* the chat tool stack, and matching the
 *     rest of this app matters more than matching another engine's vocabulary.
 */

import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type UIMessageStreamWriter,
} from "ai";

import { db, type Db } from "../db/index.js";
import { codingAgents, connections } from "../db/schema.js";
import { editTools } from "../files/edit.js";
import { shellTools } from "../files/shell.js";
import { fileTools } from "../files/tools.js";
import { buildSystemPrompt } from "../memory/inject.js";
import { ConnectionError, resolveModel } from "../providers/registry.js";
import { AgentError, type CodingAgentAdapter, type RunContext, type RunResult } from "./adapter.js";
import { approvalFor, approvalSecret } from "./approval.js";
import { toolsForLevel } from "./permissions.js";

/**
 * Generous, because a coding turn is a loop rather than an answer.
 *
 * Read, edit, re-read, run, fix is five steps before a sentence, and a budget
 * that stops mid-repair leaves the checkout in a state nobody asked for.
 */
const MAX_STEPS = 48;

/**
 * The environment variables this store names as holding credentials.
 *
 * Read from both tables rather than hard-coded, because the whole point of
 * `apiKeyEnv` is that someone can name their own — a deny-list of the
 * conventional names would miss exactly the person who set `WORK_ANTHROPIC_KEY`.
 */
async function secretNames(database: Db): Promise<string[]> {
  const [conns, agents] = await Promise.all([
    database.select({ env: connections.apiKeyEnv }).from(connections).all(),
    database.select({ env: codingAgents.authTokenEnv }).from(codingAgents).all(),
  ]);

  return [...conns, ...agents].map((row) => row.env).filter((env): env is string => Boolean(env));
}

export const builtinAdapter: CodingAgentAdapter = {
  kind: "builtin",

  async run(context: RunContext, writer: UIMessageStreamWriter): Promise<RunResult> {
    const { root, history, connection, permission, projectId, projectName } = context;

    if (!connection) {
      throw new AgentError("Pick a connection for the built-in engine to run on.");
    }

    let model: LanguageModel;
    try {
      model = resolveModel(connection, null);
    } catch (error) {
      // Reported as an agent failure so it renders as an error line in the
      // transcript rather than a stack trace.
      if (error instanceof ConnectionError) throw new AgentError(error.message);
      throw error;
    }

    const allowed = toolsForLevel(permission);
    const database = db();

    // Every variable this store knows to hold a credential, so the shell does
    // not inherit them. The store keeps names and never values, and a
    // subprocess should not be the one place that rule leaks.
    const secrets = allowed.shell ? await secretNames(database) : [];

    // The same system prompt an ordinary turn gets, so a coding session knows
    // the project's memories and which skills exist. The external engines
    // receive this on stdin instead; here it goes where it belongs.
    const system = await buildSystemPrompt(database, projectId, projectName, root);

    const result = streamText({
      model,
      system,
      messages: await convertToModelMessages(history),
      // A denied tool is *absent*, not refused. The model cannot call what it
      // was never handed, which is a stronger guarantee than a config string
      // asking an external engine to say no on our behalf.
      tools: {
        ...fileTools({ root }),
        ...(allowed.edit ? editTools({ root }) : {}),
        ...(allowed.shell ? shellTools({ root, signal: context.signal, secrets }) : {}),
      },
      // Empty except at `ask`, which is what makes that level exist. The step
      // ends when a decision is needed, so the pause is a request boundary and
      // survives a reload — see `approval.ts`.
      toolApproval: approvalFor(permission),
      // Binds the decision to the exact call it was given for, so a client
      // cannot send back approval for an input the model never proposed.
      experimental_toolApprovalSecret: approvalSecret(),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: context.signal,
    });

    // Read to completion rather than handing the stream to `writer.merge`, so
    // `run()` resolves when the run is actually over — which is what the route
    // relies on to persist the transcript.
    const reader = toUIMessageStream({ stream: result.stream }).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write(value);
      }
    } finally {
      reader.releaseLock();
    }

    return {
      // Nothing to resume: the transcript is the session.
      sessionId: null,
      model: connection.model,
    };
  },
};
