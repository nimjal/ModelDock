/**
 * Deciding which of two edits to the same thing wins.
 *
 * Last-writer-wins, per row *per column*. The granularity is the whole point:
 * renaming a thread on the laptop and archiving it on the desktop are not a
 * conflict, and a row-level merge would throw one of them away for no reason.
 *
 * Pure, with no I/O, for the same reason `permissions.ts` is — the rule is the
 * property worth protecting, so it has to be checkable without a database, two
 * processes and a network.
 *
 * Deletes need no special case. There are no hard deletes anywhere in this
 * codebase, so a delete is a write to `deletedAt` and merges like any other
 * column. That falls out well: a delete on one device and a title edit on
 * another both survive, which is the honest outcome.
 */

/** One column's last-known write, from this device's log. */
export interface Clock {
  at: number;
  origin: string;
}

export interface Incoming {
  at: number;
  origin: string;
}

/**
 * Whether an incoming write should replace what is here.
 *
 * The tie-break on `origin` is not arbitrary decoration. Two devices can stamp
 * the same millisecond, and without a deterministic rule each would keep its
 * own value and believe it had converged — the worst kind of failure, because
 * nothing reports it. Comparing device ids gives both sides the same answer.
 *
 * A device receiving its own change back sees equal `at` *and* equal `origin`,
 * so this is false and applying it is a no-op. That is what makes the exchange
 * safe to run twice.
 */
export function wins(incoming: Incoming, local: Clock | undefined): boolean {
  if (!local) return true;
  if (incoming.at !== local.at) return incoming.at > local.at;
  return incoming.origin > local.origin;
}

/**
 * The columns of an incoming change that should actually be written.
 *
 * `clocks` is what this device knows about each column of that row. Anything
 * the sender did not mention is left alone, which is what makes concurrent
 * edits to different fields both survive.
 */
export function columnsToApply(
  incoming: Incoming,
  cols: Record<string, unknown>,
  clocks: Map<string, Clock>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [column, value] of Object.entries(cols)) {
    if (wins(incoming, clocks.get(column))) out[column] = value;
  }

  return out;
}

/**
 * A new value for a unique column that both devices will compute identically.
 *
 * `projects.slug` is the one place two people naturally collide: create
 * "Harbor" on each machine and both want `harbor`. Renaming the loser needs the
 * loser to be the *same* row on both sides and the new name to be the *same*
 * string, or the rename itself becomes the next conflict.
 *
 * Ordering by `(createdAt, id)` gives both devices the same loser without
 * either asking the other, and deriving the suffix from that row's id makes the
 * result a pure function of data both already hold.
 */
export function renameLoser(value: string, id: string): string {
  return `${value}-${id.slice(-4).toLowerCase()}`;
}

/**
 * Which of two rows keeps the contested value.
 *
 * Older wins; the id breaks a tie. Returns true when `a` should keep it.
 */
export function keepsValue(
  a: { createdAt: number; id: string },
  b: { createdAt: number; id: string },
): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return a.id < b.id;
}
