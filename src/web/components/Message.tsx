/**
 * One message.
 *
 * Roles are distinguished by shape and typeface rather than by colour: what
 * the person typed is set in the interface sans on a washed panel, and the
 * reply is set in Newsreader at a reading measure with no container at all.
 * That keeps the accent budget free for the berth and, more importantly,
 * makes long answers read like a document instead of terminal output.
 *
 * Tool calls render as one quiet line. A `remember` call is the one people
 * will actually care about — it means something was written to memory — so it
 * says so in words rather than showing a payload.
 */

import { memo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Part {
  type: string;
  text?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  approval?: { id: string; approved?: boolean };
  [key: string]: unknown;
}

/** Answer one pending call. Absent on a thread that cannot be asked anything. */
type Approve = (approvalId: string, approved: boolean) => void;

interface MessageProps {
  role: "user" | "assistant" | "system";
  parts: Part[];
  provider?: string | null;
  model?: string | null;
  onRemember?: (text: string) => void;
  onApprove?: Approve;
}

export const Message = memo(function Message({
  role,
  parts,
  model,
  onRemember,
  onApprove,
}: MessageProps) {
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("");

  const reasoning = parts.filter((part) => part.type === "reasoning" && part.text);
  const tools = parts.filter((part) => part.type.startsWith("tool-"));

  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[42rem] whitespace-pre-wrap rounded-[var(--radius)] px-3.5 py-2.5 text-[0.9375rem]"
          style={{ background: "var(--wash)" }}
        >
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="group/message">
      {reasoning.length > 0 && <Reasoning parts={reasoning} />}
      {tools.map((part, index) => (
        // The call id where there is one; a tool part without it cannot repeat
        // within a message, so position is a stable enough fallback.
        <ToolCall
          key={typeof part.toolCallId === "string" ? part.toolCallId : `${part.type}-${index}`}
          part={part}
          onApprove={onApprove}
        />
      ))}

      {text && (
        <div className="prose-reply scroll-x">
          <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
        </div>
      )}

      {text && (
        <div className="mt-2 flex items-center gap-3 opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100">
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(text)}
            className="text-[0.6875rem] transition-colors hover:text-[var(--ink)]"
            style={{ color: "var(--ink-3)" }}
          >
            Copy
          </button>
          {onRemember && (
            <button
              type="button"
              onClick={() => onRemember(text)}
              className="text-[0.6875rem] transition-colors hover:text-[var(--ink)]"
              style={{ color: "var(--ink-3)" }}
            >
              Remember this
            </button>
          )}
          {model && (
            <span className="ml-auto font-mono text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
              {model}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

function Reasoning({ parts }: { parts: Part[] }) {
  const [open, setOpen] = useState(false);
  const text = parts.map((part) => part.text ?? "").join("");

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-[0.75rem] transition-colors hover:text-[var(--ink)]"
        style={{ color: "var(--ink-3)" }}
      >
        {open ? "Hide thinking" : "Show thinking"}
      </button>
      {open && (
        <div
          className="mt-1.5 whitespace-pre-wrap border-l-2 pl-3 text-[0.8125rem]"
          style={{ borderColor: "var(--line)", color: "var(--ink-2)" }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

/** The trailing mark that says where a call got to. */
function mark(state: string | undefined): string {
  switch (state) {
    case "output-available":
      return " ✓";
    case "output-error":
      return " — failed";
    case "output-denied":
      return " — skipped";
    case "approval-responded":
      return " …";
    default:
      return "…";
  }
}

function ToolCall({ part, onApprove }: { part: Part; onApprove?: Approve }) {
  const name = part.type.replace(/^tool-/, "");
  const done = part.state === "output-available";

  if (name === "remember") {
    const input = part.input as { title?: string } | undefined;
    return (
      <p className="mb-2 text-[0.8125rem]" style={{ color: "var(--ink-2)" }}>
        <span style={{ color: "var(--ink-3)" }}>
          {done ? "Saved to memory" : "Saving to memory"}
        </span>
        {input?.title ? ` — ${input.title}` : ""}
      </p>
    );
  }

  const line = (
    <p className="mb-2 font-mono text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
      {name}
      {subject(part) ? ` · ${subject(part)}` : ""}
      {mark(part.state)}
    </p>
  );

  if (part.state !== "approval-requested" || !onApprove) return line;

  return (
    <div className="mb-3">
      {line}
      <Approval part={part} name={name} onApprove={onApprove} />
    </div>
  );
}

/**
 * Deciding on one call, in the transcript rather than over it.
 *
 * There is no modal anywhere in this app and this is not the place to introduce
 * the first one — but the stronger argument is that the transcript is where
 * this belongs. The thing being approved is a line in the conversation, and the
 * decision becomes part of the record next to it.
 *
 * No new colour: "Run" is the filled `--ink` button the composer's Send already
 * uses, and "Skip" is the quiet text button used for `Copy`. `--danger` is
 * deliberately not used — it is for things that went wrong, and a second
 * saturated colour in the transcript would spend the accent budget the berth
 * owns.
 */
function Approval({ part, name, onApprove }: { part: Part; name: string; onApprove: Approve }) {
  const id = part.approval?.id;
  const [sent, setSent] = useState(false);
  if (!id) return null;

  const decide = (approved: boolean) => {
    setSent(true);
    onApprove(id, approved);
  };

  return (
    <div className="border-l-2 pl-3" style={{ borderColor: "var(--line)" }}>
      {/*
        The full text, never truncated the way `subject` truncates the line
        above it. You cannot approve what you cannot read.
      */}
      <pre
        className="mb-2 whitespace-pre-wrap break-all font-mono text-[0.8125rem]"
        style={{ color: "var(--ink)" }}
      >
        {detail(part) ?? name}
      </pre>

      {sent ? (
        <p className="text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
          Sending…
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => decide(true)}
            className="rounded px-2.5 py-1 text-[0.75rem] transition-opacity hover:opacity-85"
            style={{ background: "var(--ink)", color: "var(--paper)" }}
          >
            Run
          </button>
          <button
            type="button"
            onClick={() => decide(false)}
            className="text-[0.6875rem] transition-colors hover:text-[var(--ink)]"
            style={{ color: "var(--ink-3)" }}
          >
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

/** Everything about the call worth reading before allowing it. */
function detail(part: Part): string | null {
  const input = part.input as
    | { command?: string; path?: string; content?: string; old_string?: string }
    | undefined;
  if (!input) return null;

  if (typeof input.command === "string") return input.command;
  if (typeof input.path === "string") {
    const size =
      typeof input.content === "string"
        ? ` — ${input.content.length} characters`
        : typeof input.old_string === "string"
          ? " — replacing a section"
          : "";
    return `${input.path}${size}`;
  }
  return null;
}

/**
 * The one detail worth showing about a tool call: which file, which pattern,
 * which command. Enough to follow along without expanding anything — a
 * transcript of bare tool names reads as noise, and a transcript of full
 * payloads stops being a conversation.
 */
function subject(part: Part): string | null {
  const input = part.input as { path?: string; pattern?: string; command?: string } | undefined;
  const value = input?.path ?? input?.pattern ?? input?.command;
  if (typeof value !== "string" || !value) return null;
  return value.length > 48 ? `${value.slice(0, 47)}…` : value;
}
