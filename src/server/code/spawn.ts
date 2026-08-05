/**
 * Spawning an agent binary, including the Windows shim case.
 *
 * npm installs its executables on Windows as a `.cmd` shim, which cannot be
 * executed directly — it has to go through `cmd.exe`. That re-parses the
 * command line, which is the classic argument-injection footgun
 * (CVE-2024-27980), so `windowsVerbatimArguments` is set and nothing
 * user-supplied is ever passed on argv: prompts travel on stdin.
 *
 * Shared by the version probe and the adapter so the two cannot disagree
 * about how a command is launched — a probe that succeeds against a binary
 * the adapter then fails to run is worse than no probe at all.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** True for a Windows shim that needs an interpreter. */
export function needsShell(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

/**
 * Quote one argument for `cmd.exe`.
 *
 * `windowsVerbatimArguments` means Node hands the command line over untouched,
 * so the quoting is ours to do — and it has to be done, because the common
 * install path (`C:\Users\Firstname Lastname\AppData\...`) contains a space.
 * Without this `cmd` takes everything up to the first space as the command.
 */
export function quoteForCmd(value: string): string {
  if (value === "") return '""';
  if (!/[\s"^&|<>()]/.test(value)) return value;
  // `""` is how a literal quote is escaped inside a quoted cmd token.
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Build the `cmd /d /s /c "<line>"` argument list for a shim.
 *
 * With `/s` and a fully-quoted remainder, `cmd` strips the outer quotes and
 * runs the rest verbatim, which is the documented and predictable form.
 *
 * Exported so it can be tested without spawning anything: this is the part
 * that has to be right, and CVE-2024-27980 is what happens when it is not.
 */
export function cmdLineFor(command: string, args: string[]): string[] {
  const line = [command, ...args].map(quoteForCmd).join(" ");
  return ["/d", "/s", "/c", `"${line}"`];
}

export function spawnCommand(command: string, args: string[], options: SpawnOptions): ChildProcess {
  if (needsShell(command)) {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    return spawn(comspec, cmdLineFor(command, args), {
      ...options,
      shell: false,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(command, args, { ...options, shell: false });
}

/**
 * Stop a child and anything it started.
 *
 * The tree matters: a coding agent — or a `run_command` that kicked off a
 * build — leaves grandchildren that outlive a signal sent only to the process
 * we spawned. On Windows `SIGTERM` is not real at all, so `taskkill /t` is the
 * mechanism rather than an optimisation.
 *
 * One implementation, because two would drift and the second one would be the
 * one nobody tested.
 */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }

  // If it has not gone in two seconds, stop asking politely.
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2000).unref?.();
}
