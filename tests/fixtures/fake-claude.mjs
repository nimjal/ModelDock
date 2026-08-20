#!/usr/bin/env node
/**
 * A stand-in for the Claude Code CLI.
 *
 * The agent tests must not require anyone to have Claude Code installed, so
 * the `coding_agents` row in those tests points `command` at this script via
 * `process.execPath` plus `args`. That is exactly why the table has an `args`
 * column — the same mechanism lets a real person point ModelDock at a wrapper
 * script, a version manager shim, or `claude` with extra flags.
 *
 * It speaks the documented headless protocol: newline-delimited JSON on
 * stdout, prompt on stdin. The final `result` line echoes the argv it was
 * given, which is how the tests assert that `--resume` and the permission
 * flags actually reach the process.
 */

const argv = process.argv.slice(2);
const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 0);

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

// Drain stdin: the prompt travels there, never on argv.
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});

process.stdin.on("end", async () => {
  const sessionId = "sess-fake-1";

  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "claude-sonnet-4-5",
    tools: ["Read", "Edit", "Bash"],
  });

  emit({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
  });
  emit({
    type: "stream_event",
    session_id: sessionId,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Looking" },
    },
  });
  emit({
    type: "stream_event",
    session_id: sessionId,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " at it." },
    },
  });
  emit({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_stop", index: 0 },
  });

  // A long run, so the abort test has something to interrupt.
  if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));

  emit({
    type: "assistant",
    session_id: sessionId,
    message: {
      model: "claude-sonnet-4-5",
      content: [
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Read",
          input: { file_path: "src/app.ts" },
        },
      ],
    },
  });

  emit({
    type: "user",
    session_id: sessionId,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "export const port = 8765;",
        },
      ],
    },
  });

  emit({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    // Echoed so the tests can assert which flags were passed.
    result: `argv:${argv.join(" ")}|prompt:${prompt.trim()}`,
    total_cost_usd: 0.01,
    num_turns: 1,
  });

  process.exit(0);
});
