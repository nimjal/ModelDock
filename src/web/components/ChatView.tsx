/**
 * A conversation.
 *
 * The client sends only the newest message and a thread id; the server owns
 * the history. That is deliberate — it is what lets the provider change
 * mid-thread without the browser having to re-post a transcript, and it means
 * a reload anywhere gets the same conversation back from the database.
 *
 * `useChat` is keyed on the thread id so switching threads tears down and
 * rebuilds cleanly rather than bleeding messages between conversations.
 */

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from "ai";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  type AgentView,
  type ConnectionView,
  type PermissionLevel,
  type StoredMessage,
  type ThreadView,
} from "../lib/api";
import { Composer } from "./Composer";
import { Message } from "./Message";

interface ChatViewProps {
  thread: ThreadView;
  initialMessages: StoredMessage[];
  connection: ConnectionView | null;
  agent: AgentView | null;
  projectName: string | null;
  projectDirectory: string | null;
  onThreadChanged: () => void;
  onRemember: (text: string) => void;
}

export function ChatView({
  thread,
  initialMessages,
  connection,
  agent,
  projectName,
  projectDirectory,
  onThreadChanged,
  onRemember,
}: ChatViewProps) {
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const titled = useRef(Boolean(thread.title));

  // A coding session and a chat are the same view over two routes. The level
  // lives in a ref rather than state so changing it does not rebuild the
  // transport mid-conversation.
  const coding = Boolean(thread.agentId);
  const [permission, setPermission] = useState<PermissionLevel>(thread.permission ?? "read");
  const permissionRef = useRef(permission);
  permissionRef.current = permission;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: coding ? "/api/code" : "/api/chat",
        prepareSendMessagesRequest: ({ id, messages }) => ({
          body: {
            threadId: id,
            message: messages[messages.length - 1],
            ...(coding ? { permission: permissionRef.current } : {}),
          },
        }),
      }),
    [coding],
  );

  const { messages, sendMessage, status, error, stop, addToolApprovalResponse } = useChat({
    id: thread.id,
    transport,
    messages: initialMessages.map(
      (row) => ({ id: row.id, role: row.role, parts: row.parts }) as UIMessage,
    ),
    /**
     * Send the answer back the moment every pending call has one, so the
     * conversation resumes without a second thing to click. The message that
     * goes back is the *assistant* one carrying the decision, which is why
     * `/api/code` treats an assistant message as a continuation rather than
     * storing it as something the person said.
     */
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  const busy = status === "submitted" || status === "streaming";

  /**
   * Whether the model is waiting on a decision.
   *
   * The stream has already ended by this point — the pause is a request
   * boundary, not a held-open connection — so `busy` is false and the composer
   * would otherwise look ready for a new message. Sending one here would
   * abandon the pending call, so it is refused and says why.
   */
  const awaiting = messages.some((message) =>
    (message.parts as { state?: string }[]).some((part) => part.state === "approval-requested"),
  );

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  // The server names an untitled thread from its first message, so the
  // sidebar has to be told to re-read once that has happened.
  useEffect(() => {
    if (status === "ready" && !titled.current && messages.length > 0) {
      titled.current = true;
      onThreadChanged();
    }
  }, [status, messages.length, onThreadChanged]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void sendMessage({ text });
  };

  const modelFor = (index: number) => {
    // Stored messages carry the model that produced them; live ones came from
    // whatever is docked right now.
    const stored = initialMessages[index];
    return stored?.model ?? (index >= initialMessages.length ? connection?.model : null) ?? null;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-5 py-8">
          {messages.length === 0 && (
            <EmptyThread projectName={projectName} projectDirectory={projectDirectory} />
          )}

          {messages.map((message, index) => (
            <Message
              key={message.id}
              role={message.role as "user" | "assistant"}
              parts={message.parts as never}
              model={message.role === "assistant" ? modelFor(index) : null}
              onRemember={message.role === "assistant" ? onRemember : undefined}
              onApprove={(approvalId, approved) =>
                void addToolApprovalResponse({ id: approvalId, approved })
              }
            />
          ))}

          {status === "submitted" && (
            <p className="text-[0.8125rem]" style={{ color: "var(--ink-3)" }}>
              Thinking…
            </p>
          )}

          {error && (
            <div
              className="rounded-[var(--radius)] border px-3.5 py-3 text-[0.8125rem]"
              style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
            >
              {error.message}
            </div>
          )}

          <div ref={bottom} />
        </div>
      </div>

      <div className="border-t" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto w-full max-w-3xl px-5 py-4">
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={send}
            onStop={stop}
            busy={busy}
            // A coding session answers through its agent, not a connection,
            // so an unconfigured model provider must not disable it.
            disabled={awaiting || (coding ? false : !connection?.ready)}
            waiting={awaiting}
            levels={coding ? agent?.levels : undefined}
            permission={coding ? permission : undefined}
            onPermission={
              coding
                ? (level) => {
                    setPermission(level);
                    void api.updateThread(thread.id, { permission: level });
                  }
                : undefined
            }
            placeholder={
              coding
                ? `What should ${agent?.label ?? "the agent"} do?`
                : connection?.ready
                  ? projectName
                    ? `Message ${projectName}…`
                    : "Message…"
                  : "Set up a connection to start"
            }
          />
          {!coding && connection && !connection.ready && connection.problem && (
            <p className="mt-2 text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
              {connection.problem}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyThread({
  projectName,
  projectDirectory,
}: {
  projectName: string | null;
  projectDirectory: string | null;
}) {
  return (
    <div className="pt-12">
      <p className="text-[1.0625rem]" style={{ fontFamily: "var(--font-reading)" }}>
        {projectName ? `Working in ${projectName}.` : "What are you working on?"}
      </p>
      <p className="mt-1.5 text-[0.8125rem]" style={{ color: "var(--ink-3)" }}>
        Anything saved to memory comes with you, whichever model is docked.
      </p>
      {/* The only announcement Cowork gets. If this conversation can read
          files, say which ones — and say plainly that it cannot change them. */}
      {projectDirectory && (
        <p className="mt-1.5 text-[0.8125rem]" style={{ color: "var(--ink-3)" }}>
          Reading <span className="font-mono">{projectDirectory}</span>. Nothing here can change it.
        </p>
      )}
    </div>
  );
}

/** Load a thread and its history, then render it. Keyed by the caller. */
export function ChatViewLoader(props: {
  threadId: string;
  connection: ConnectionView | null;
  agent: AgentView | null;
  projectName: string | null;
  projectDirectory: string | null;
  onThreadChanged: () => void;
  onRemember: (text: string) => void;
}) {
  const [state, setState] = useState<{
    thread: ThreadView;
    messages: StoredMessage[];
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setState(null);
    setFailure(null);
    api
      .thread(props.threadId)
      .then((data) => {
        if (live) setState({ thread: data.thread, messages: data.messages });
      })
      .catch((error: Error) => {
        if (live) setFailure(error.message);
      });
    return () => {
      live = false;
    };
  }, [props.threadId]);

  if (failure) {
    return (
      <p className="p-6 text-[0.8125rem]" style={{ color: "var(--danger)" }}>
        {failure}
      </p>
    );
  }
  if (!state) return <div className="flex-1" />;

  return (
    <ChatView
      key={state.thread.id}
      thread={state.thread}
      initialMessages={state.messages}
      connection={props.connection}
      agent={props.agent}
      projectName={props.projectName}
      projectDirectory={props.projectDirectory}
      onThreadChanged={props.onThreadChanged}
      onRemember={props.onRemember}
    />
  );
}
