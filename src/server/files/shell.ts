/**
 * Letting the model run a command in the project.
 *
 * The most dangerous thing in this codebase, and the only honest framing is the
 * one `permissions.ts` already uses: the directory boundary governs *tools*, and
 * a shell is not a tool — it starts a process that can open anything the user
 * account can. `boundaryHolds` returns false wherever this factory is in play,
 * and the README says so in words rather than implying a guarantee that does
 * not exist. What `ask` adds is not containment but consent: the command is on
 * screen, in full, before it runs.
 *
 * Given that, the things this file *can* control, it controls tightly.
 *
 * **The command never touches argv.** `spawn.ts` promises that nothing
 * user-supplied is ever passed as an argument, because on Windows a command
 * line is re-parsed by `cmd.exe` (CVE-2024-27980) — and a shell tool's entire
 * input *is* a command line. So the command is written to a script file in a
 * fresh temp directory and only that path, which ModelDock generated, is passed
 * as an argument. The promise holds unchanged.
 *
 * Feeding the shell on stdin was the obvious alternative and it does not work
 * on Windows: `cmd.exe` reading a piped script prints its banner and echoes
 * every line into stdout before `@echo off` can take effect, and the exit
 * status of the last command is lost. A script file behaves identically on both
 * platforms, which is worth more here than saving a file write.
 *
 * **The keys are removed.** `connections.apiKeyEnv` and
 * `codingAgents.authTokenEnv` name the variables holding real credentials, and
 * a child inherits `process.env` by default — so without this, `echo
 * $ANTHROPIC_API_KEY` would work. Stripping them follows directly from the rule
 * the rest of the app already keeps: the store holds variable names, never
 * secrets, and a subprocess should not be the hole in that.
 *
 * **`cwd` is the project root, always.** Never an input, never derived from the
 * level — the same posture as `--add-dir` never being emitted.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";

import { killTree, spawnCommand } from "../code/spawn.js";

/** Enough output to be useful, not enough to blow out the context window. */
const MAX_OUTPUT = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * Variables stripped from the child regardless of what the store names.
 *
 * The store's own `apiKeyEnv` values are passed in as `secrets`; this covers
 * the conventional ones a person may have exported without ever telling
 * ModelDock about them.
 */
const ALWAYS_STRIP = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "MISTRAL_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
];

export interface ShellToolContext {
  /** Already resolved through `projectRoot`. */
  root: string;
  /** Cancels the whole run; a command outliving its turn would be a leak. */
  signal?: AbortSignal;
  /** Names of environment variables the store knows to hold credentials. */
  secrets?: string[];
}

/** `process.env` minus anything that would hand a model a credential. */
export function childEnv(secrets: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const name of [...ALWAYS_STRIP, ...secrets]) {
    delete env[name];
  }

  // So a script can tell, and behave differently if it wants to.
  env.MODELDOCK = "1";
  return env;
}

/**
 * Put the command in a script file and say how to run it.
 *
 * The returned `args` contain only the generated path, never the command text
 * — see the header. The directory is fresh per call, so two commands cannot
 * collide and there is nothing to clean up but one directory.
 */
async function scriptFor(command: string): Promise<{ dir: string; file: string; args: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "modeldock-run-"));
  const windows = process.platform === "win32";
  const path = join(dir, windows ? "run.cmd" : "run.sh");

  await writeFile(path, windows ? `@echo off\r\n${command}\r\n` : command, "utf8");

  return windows
    ? { dir, file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", path] }
    : { dir, file: "/bin/sh", args: [path] };
}

export function shellTools({ root, signal, secrets = [] }: ShellToolContext) {
  return {
    run_command: tool({
      description:
        "Run a shell command in the project directory. Use for builds, tests and git. " +
        "Output is truncated past 32KB, and the command is killed if it exceeds its timeout.",
      inputSchema: z.object({
        command: z.string().min(1).describe("The command line to run, as you would type it."),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(MAX_TIMEOUT_MS)
          .describe("How long to allow before killing it.")
          .default(DEFAULT_TIMEOUT_MS),
      }),
      execute: async ({ command, timeout_ms }) => {
        const started = Date.now();
        const { dir, file, args } = await scriptFor(command);

        // `args` holds a path this process generated, never the command. See
        // the header for why that distinction is load-bearing on Windows.
        const child = spawnCommand(file, args, {
          cwd: root,
          env: childEnv(secrets),
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let truncated = false;

        const collect = (into: "out" | "err") => (buffer: Buffer) => {
          const text = buffer.toString();
          if (into === "out") {
            if (stdout.length >= MAX_OUTPUT) truncated = true;
            else stdout += text.slice(0, MAX_OUTPUT - stdout.length);
          } else {
            if (stderr.length >= MAX_OUTPUT) truncated = true;
            else stderr += text.slice(0, MAX_OUTPUT - stderr.length);
          }
        };

        child.stdout?.on("data", collect("out"));
        child.stderr?.on("data", collect("err"));
        // Closed rather than written to: a command that reads stdin should see
        // end-of-input, not hang waiting for a person who is not there.
        child.stdin?.end();

        let timedOut = false;
        // Defended rather than assumed: the schema supplies a default, but
        // `setTimeout(fn, undefined)` fires on the next tick rather than never,
        // so anything that reached here without validation would kill every
        // command the instant it started.
        const limit = Number.isFinite(timeout_ms) ? timeout_ms : DEFAULT_TIMEOUT_MS;
        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, limit);

        const stop = () => killTree(child);
        signal?.addEventListener("abort", stop, { once: true });

        try {
          const exitCode = await new Promise<number | null>((resolve) => {
            child.on("error", () => resolve(null));
            child.on("close", (code) => resolve(code));
          });

          const durationMs = Date.now() - started;

          if (timedOut) {
            // Returned, not thrown: the model should see what it managed to
            // produce and decide what to do, the same as any other tool failure.
            return {
              error: `Timed out after ${Math.round(limit / 1000)}s and was killed.`,
              stdout,
              stderr,
              exitCode: null,
              durationMs,
            };
          }

          return { command, exitCode, stdout, stderr, truncated, durationMs };
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          await rm(dir, { recursive: true, force: true }).catch(() => {
            // A stray temp directory is not worth failing a command over.
          });
        }
      },
    }),
  };
}
