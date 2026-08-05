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
 * the adapter then fails to run is worse than no probe at all. Sharing also
 * means every child is launched into its own process group, which is what
 * makes `killTree` able to keep its name.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** POSIX needs a process group per child; on Windows `taskkill /t` walks the tree. */
const POSIX = process.platform !== "win32";

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

/**
 * Start a child that `killTree` can actually finish.
 *
 * On POSIX the child is `detached`, which is not about surviving this process —
 * it is never `unref`d — but about `setsid`: it makes the child the leader of a
 * new process group, and a group id is the only handle POSIX gives you on
 * "that command and everything it went on to start". Without it the only
 * reachable target is the direct child, which for a shell script is the shell
 * rather than the work.
 *
 * The cost is that the child no longer shares this process's group, so a Ctrl-C
 * in the terminal running ModelDock no longer reaches it on its own. `track`
 * hands that back deliberately.
 */
export function spawnCommand(command: string, args: string[], options: SpawnOptions): ChildProcess {
  if (needsShell(command)) {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    // Windows only, so never detached: there `detached` means a new console
    // window, and the tree is `taskkill`'s job anyway.
    return track(
      spawn(comspec, cmdLineFor(command, args), {
        ...options,
        shell: false,
        windowsVerbatimArguments: true,
      }),
    );
  }

  return track(spawn(command, args, { ...options, shell: false, detached: POSIX }));
}

/** Children still believed to be running, so a signal can be passed on to them. */
const live = new Set<ChildProcess>();
let forwarding = false;

/**
 * Remember a child, and make sure this process dying takes it along.
 *
 * `detached` costs the children their place in this process's group, and with
 * it the Ctrl-C that used to reach a running build for free. These handlers put
 * that back and slightly improve on it: the signal now reaches the whole tree
 * rather than only whatever happened to share the terminal's group.
 */
function track(child: ChildProcess): ChildProcess {
  live.add(child);
  const forget = () => live.delete(child);
  child.once("close", forget);
  child.once("error", forget);

  if (!forwarding) {
    forwarding = true;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      // `once`, so the re-raise below finds no listener and gets the default
      // disposition — this process still dies of the signal it was sent, with
      // the exit status the shell expects.
      process.once(signal, () => {
        for (const running of live) killTree(running);
        process.kill(process.pid, signal);
      });
    }
  }

  return child;
}

/**
 * Signal a whole process group, reporting whether anything was there.
 *
 * The negative pid is the group `detached` made this child the leader of.
 * `ESRCH` means the group is already gone, which is the good outcome and not
 * worth raising.
 */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a child and anything it started.
 *
 * The tree matters, and it is the whole point rather than a refinement. A
 * coding agent — or a `run_command` that kicked off a build — leaves
 * grandchildren, and those grandchildren hold the same stdout and stderr pipes
 * the parent handed down. So a signal sent only to the process we spawned does
 * not merely leak: `close` waits on the pipes, not the pid, and never fires
 * while a grandchild is alive. A timeout that kills the shell and leaves `node`
 * running hangs for as long as the command would have taken anyway.
 *
 * Hence `-pid` on POSIX and `/t` on Windows, where `SIGTERM` is not real at all
 * and `taskkill` is the mechanism rather than an optimisation.
 *
 * Deliberately not conditioned on the direct child still running. A shell that
 * has exited is exactly the case where the tree is still there — `cmd &` leaves
 * the shell reporting success while the work continues — so the group is asked
 * either way. Callers stop calling this once `close` has fired, which is what
 * keeps a recycled group id out of range.
 *
 * One implementation, because two would drift and the second one would be the
 * one nobody tested.
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (!POSIX) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    // If it has not gone in two seconds, stop asking politely.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2000).unref?.();
    return;
  }

  signalGroup(pid, "SIGTERM");

  // Asked of the group rather than the child, for the same reason as above: the
  // one still ignoring SIGTERM two seconds on may not be the process we started.
  setTimeout(() => {
    if (signalGroup(pid, 0)) signalGroup(pid, "SIGKILL");
  }, 2000).unref?.();
}
