/**
 * One turn of conversation.
 *
 * The browser sends only the newest message plus a thread id; this server
 * holds the history. That is what makes the provider swap safe: the messages
 * are rows in ModelDock's database, so changing `threads.connectionId`
 * changes who answers the *next* turn and touches nothing that came before.
 * A thread started on Claude and continued on a local Llama is one thread.
 *
 * Messages are stored as the AI SDK's own `UIMessage.parts` array rather than
 * flattened text, so tool calls and reasoning survive a reload and still
 * render years after whichever model produced them is gone.
 *
 * When the thread's project has a `directory`, this same route also gains
 * read-only file tools — that is the whole of Cowork. It is not a separate
 * mode or a separate screen: attaching a directory to a project upgrades its
 * conversations in place, and everything else here is untouched.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type UIMessage,
} from "ai";

import {
  connectionForThread,
  historyFor,
  titleThreadIfNeeded,
  toUiMessages,
} from "../chat/turn.js";
import { db } from "../db/index.js";
import { messages, projects, threads } from "../db/schema.js";
import { patch, put } from "../db/write.js";
import { projectRoot } from "../files/boundary.js";
import { fileTools } from "../files/tools.js";
import { buildSystemPrompt } from "../memory/inject.js";
import { memoryTools } from "../memory/tools.js";
import { skillTools } from "../skills/tools.js";
import { ConnectionError, resolveModel } from "../providers/registry.js";
import { HttpError } from "../errors.js";

export const chatRoutes = new Hono();

chatRoutes.post("/chat", async (c) => {
  const body = await c.req.json<{ threadId?: string; message?: UIMessage }>();
  const threadId = body.threadId;
  const incoming = body.message;

  if (!threadId) throw new HttpError(400, "threadId is required");
  if (!incoming) throw new HttpError(400, "message is required");

  const database = db();
  const { thread, connection } = await connectionForThread(threadId);

  // Persisted before the model is called. If the provider is misconfigured or
  // the process dies mid-turn, what the person typed is still there.
  //
  // The id is this store's own ULID, not `incoming.id`. The assistant row below
  // has always worked that way and explains why; the same reasoning applies
  // here, and the client-supplied id was additionally a value the browser chose
  // — so half the ids in `messages` were not ULIDs and did not sort with the
  // other half.
  put(database, messages, {
    threadId,
    role: "user",
    parts: incoming.parts as unknown[],
  });

  // The thread moved the moment the person sent something. Bumping this only
  // in `onEnd` meant a turn that failed — a bad key, a dropped connection —
  // left the thread sorted in the sidebar by a time before the message it now
  // contained.
  patch(database, threads, threadId, { connectionId: connection.id });

  const history = await historyFor(threadId);

  const project = thread.projectId
    ? (
        await database
          .select({ name: projects.name, directory: projects.directory })
          .from(projects)
          .where(eq(projects.id, thread.projectId))
          .limit(1)
      )[0]
    : undefined;

  const projectName = project?.name ?? null;

  // Cowork: a project with a directory gets read-only file tools. Resolving
  // the root here (once per turn) both canonicalises it for the boundary
  // check and proves it exists — a directory that has been moved or deleted
  // silently degrades to an ordinary chat rather than failing the turn.
  const root = project?.directory ? await projectRoot(project.directory).catch(() => null) : null;

  let model: LanguageModel;
  try {
    model = resolveModel(connection, thread.model);
  } catch (error) {
    if (error instanceof ConnectionError) throw new HttpError(400, error.message);
    throw error;
  }

  const system = await buildSystemPrompt(database, thread.projectId, projectName, root);
  const modelId = thread.model || connection.model;

  const result = streamText({
    model,
    system,
    messages: await convertToModelMessages(toUiMessages(history)),
    tools: {
      ...memoryTools({ db: database, projectId: thread.projectId, threadId }),
      ...skillTools({ db: database, projectId: thread.projectId }),
      ...(root ? fileTools({ root }) : {}),
    },
    // The assistant should be able to save a memory and then keep talking,
    // rather than ending its turn on the tool call. With file tools in play a
    // list→search→read→answer loop spends four steps before any prose, so the
    // budget has to be larger when there is a directory attached.
    stopWhen: stepCountIs(root ? 12 : 6),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      onEnd: async ({ responseMessage, isAborted }) => {
        if (isAborted) return;

        put(database, messages, {
          // Deliberately not `responseMessage.id`: that id is the SDK's, is
          // only meaningful within one stream, and is not guaranteed unique
          // across turns. Rows in this store get this store's own ULID. The
          // client never cross-references the two — it renders live messages
          // from the stream and reloaded ones from here.
          threadId,
          role: "assistant",
          parts: responseMessage.parts as unknown[],
          // Recorded per message, not per thread, so a conversation that
          // spans providers can show exactly who said what.
          provider: connection.kind,
          model: modelId,
        });

        patch(database, threads, threadId, { connectionId: connection.id });

        await titleThreadIfNeeded(threadId);
      },
    }),
  });
});
