/**
 * The directory boundary.
 *
 * Every surface that touches a project's files — Cowork's read-only tools,
 * Skills' reference files, and the Code adapters — resolves paths through
 * `inside()`. It is deliberately one small module with no dependencies so it
 * can be read in full and unit-tested in isolation: it is the only thing
 * standing between a model's suggestion and the rest of someone's disk.
 *
 * The check is `relative()`-based rather than `startsWith()`, and it runs
 * after `realpath`. Both details matter and both are easy to get wrong:
 *
 *   - `abs.startsWith(root)` says `/home/me/harbor-secrets` is inside
 *     `/home/me/harbor`. Appending a separator fixes that particular case but
 *     still can't see through a symlink.
 *   - `realpath` is what closes the symlink hole, but it throws on a path that
 *     does not exist yet — which every "write a new file" call is. So the walk
 *     below resolves the deepest ancestor that *does* exist and re-joins the
 *     rest, giving a real answer for a path that isn't there.
 */

import { stat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Thrown when a candidate path resolves outside the project directory. */
export class OutsideProject extends Error {
  constructor(readonly candidate: string) {
    super(`${candidate} is outside this project's directory.`);
    this.name = "OutsideProject";
  }
}

/**
 * Resolve a project's directory to a canonical root, once, at setup.
 *
 * Callers hold the result and pass it to `inside()` for every subsequent
 * check, so the (relatively expensive) symlink resolution of the root itself
 * happens once per request rather than once per tool call.
 */
export async function projectRoot(directory: string): Promise<string> {
  return realpath(resolve(directory));
}

/**
 * Resolve `candidate` against `root`, or throw `OutsideProject`.
 *
 * `candidate` is normally relative — that is what the tools ask the model
 * for — but an absolute path is accepted and simply has to land inside the
 * root like anything else.
 */
export async function inside(root: string, candidate: string): Promise<string> {
  // The root is canonicalised too, and it has to be: `realpath` below resolves
  // the target, so comparing against an uncanonical root rejects paths that
  // are genuinely inside it. On Windows a path holding an 8.3 short name
  // (`NIMITJ~1`) expands to its long form, and on any OS a symlinked parent
  // resolves elsewhere — either way `relative()` then reports a climb-out for
  // a file sitting right there. Callers that already hold a `projectRoot()`
  // pay one idempotent syscall for this; callers that do not stay correct.
  const base = await realpath(resolve(root)).catch(() => resolve(root));

  // A relative candidate lands under the root; an absolute one keeps its own
  // anchor and is caught by the containment check below.
  const target = resolve(base, candidate);

  // Walk up to the deepest ancestor that exists so `realpath` has something to
  // resolve, then re-join the trailing segments that do not exist yet.
  let existing = target;
  const missing: string[] = [];

  for (;;) {
    try {
      await stat(existing);
      break;
    } catch {
      const parent = dirname(existing);
      // Reached a filesystem root without finding anything that exists. There
      // is nothing to canonicalise, so fall through with what we have.
      if (parent === existing) {
        existing = "";
        break;
      }
      missing.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }
  }

  const real = existing ? join(await realpath(existing), ...missing) : target;

  const rel = relative(base, real);

  // `rel === ""` is the root itself, which is inside. A leading `..` means the
  // path climbed out. An *absolute* `rel` means the two paths share no common
  // anchor at all — on Windows, `relative("C:\\a", "D:\\b")` returns `D:\\b`,
  // which has no `..` to catch.
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new OutsideProject(candidate);
  }

  return real;
}
