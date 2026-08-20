/**
 * How much a coding agent is allowed to do this run.
 *
 * A level is chosen in the composer before sending. Three of the four are a
 * ladder — read, then edit, then a shell — and the fourth, `ask`, is not a rung
 * on it: it is "edit and run, but you see each call first".
 *
 * `ask` is only offered by the built-in engine, and the reason is structural
 * rather than a missing feature. Approving one call at a time means pausing
 * between the model choosing a tool and that tool running, and for OpenCode and
 * Claude Code that moment is inside someone else's process. The built-in engine
 * runs its loop here, so the AI SDK's own approval machinery applies directly.
 * Which levels an agent can honour is stated in `catalog.ts` and travels to the
 * composer as data.
 *
 * The one thing that is *not* a level is the directory boundary. It is denied
 * at every level, by a mechanism specific to each engine, and never derived
 * from the level argument — see the tests, which assert exactly that.
 *
 * These are pure functions with no I/O for the same reason: the mapping is the
 * security property, so it has to be checkable without spawning anything.
 */

export type PermissionLevel = "read" | "edit" | "full" | "ask";

/** What the two external engines can be given. `ask` is not one of them. */
export type ExternalLevel = Exclude<PermissionLevel, "ask">;

export const LEVELS: { value: PermissionLevel; label: string; hint: string }[] = [
  { value: "read", label: "Read only", hint: "Reads files in this project. Changes nothing." },
  { value: "edit", label: "Edit files", hint: "Writes files in this project. No shell." },
  {
    value: "full",
    label: "Edit and run",
    // Stated, not softened: a shell can start a process that reaches anywhere
    // the user account can, whatever the agent's own file rules say.
    hint: "Writes files and runs commands. A shell can reach outside the project.",
  },
  {
    // Last, because it is not further along the ladder — it is `full` with a
    // stop before each call.
    value: "ask",
    label: "Ask each time",
    hint: "Writes files and runs commands here, and asks before each one.",
  },
];

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === "read" || value === "edit" || value === "full" || value === "ask";
}

/**
 * Which tool families a level turns on.
 *
 * The built-in engine composes its tool set from this, which makes a denied
 * tool *absent* rather than refused — the model cannot call what it was never
 * handed. That is a stronger guarantee than either external engine gets from a
 * config string, and it is why this returns capabilities rather than names.
 */
export function toolsForLevel(level: PermissionLevel): {
  read: boolean;
  edit: boolean;
  shell: boolean;
} {
  return {
    read: true,
    edit: level !== "read",
    shell: level === "full" || level === "ask",
  };
}

/**
 * OpenCode's `permission` config block.
 *
 * `external_directory: "deny"` is set unconditionally and is never read from
 * `level` — that is what keeps the agent inside the project at every setting.
 *
 * Typed to `ExternalLevel`, so handing this `ask` is a compile error rather
 * than a level that quietly degrades to something more permissive.
 */
export function permissionForOpenCode(level: ExternalLevel): Record<string, string> {
  const base: Record<string, string> = {
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    lsp: "allow",
    todowrite: "allow",
    skill: "allow",
    // Never derived from `level`.
    external_directory: "deny",
  };

  if (level === "read") {
    return {
      ...base,
      edit: "deny",
      write: "deny",
      bash: "deny",
      task: "deny",
      webfetch: "deny",
      websearch: "deny",
    };
  }

  if (level === "edit") {
    return {
      ...base,
      edit: "allow",
      write: "allow",
      task: "allow",
      bash: "deny",
      webfetch: "deny",
      websearch: "deny",
    };
  }

  return {
    ...base,
    edit: "allow",
    write: "allow",
    task: "allow",
    bash: "allow",
    webfetch: "allow",
    websearch: "allow",
  };
}

/**
 * A project root as a Claude Code permission-rule path.
 *
 * `//` means "absolute from the filesystem root" — a single leading slash
 * anchors at whichever settings source defined the rule, which is not what we
 * want. Windows paths are normalised to POSIX before matching, so
 * `C:\work\harbor` has to be written `//c/work/harbor`.
 */
export function toRulePath(root: string): string {
  const posix = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const drive = /^([A-Za-z]):(\/.*)$/.exec(posix);
  const absolute = drive ? `/${drive[1]!.toLowerCase()}${drive[2]!}` : posix;
  return `/${absolute}`;
}

/**
 * Claude Code's CLI flags.
 *
 * Every rule is anchored to the project root. Passing a bare tool name here —
 * `--allowedTools "Read"` — pre-approves that tool for *any* path, including
 * absolute paths outside the project, which is exactly the hole this scoping
 * closes. Read rules also govern Grep and Glob, so one anchored Read rule
 * covers all three ways of looking at a file.
 *
 * `--add-dir` is never emitted, so the working directory stays the only one in
 * scope, and nothing here ever produces a flag that skips permission checks.
 *
 * The limit worth being honest about: these are Claude Code's own checks on
 * its own file tools. They do not constrain a subprocess the shell starts, so
 * at `full` the boundary is advisory — see `boundaryHolds` below, which is
 * what the UI and the docs are written against.
 */
export function permissionArgsForClaude(level: ExternalLevel, root: string): string[] {
  const scope = `${toRulePath(root)}/**`;

  if (level === "read") {
    return [
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      `Read(${scope})`,
      "--disallowedTools",
      ["Edit", "Write", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "Task"].join(","),
    ];
  }

  if (level === "edit") {
    return [
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      [`Read(${scope})`, `Edit(${scope})`].join(","),
      "--disallowedTools",
      ["Bash", "WebFetch", "WebSearch"].join(","),
    ];
  }

  return [
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    [`Read(${scope})`, `Edit(${scope})`, "Bash"].join(","),
  ];
}

/**
 * Whether the directory boundary is actually enforced at this level.
 *
 * False once a shell is available, and that is not a ModelDock limitation:
 * an agent's file-tool permissions govern its own tools, but a shell can start
 * a process that opens whatever the user account can open. Both engines say so
 * in their own docs. Containing that needs an OS sandbox, not a config flag —
 * so ModelDock states the limit plainly rather than implying a guarantee it
 * cannot keep.
 *
 * `ask` is false for the same reason: a shell is a shell. What `ask` changes is
 * not the boundary but who decides — the command is on screen, in full, before
 * it runs. That is a different kind of assurance, and it should not be
 * described as this one.
 */
export function boundaryHolds(level: PermissionLevel): boolean {
  return level === "read" || level === "edit";
}
