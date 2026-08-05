<!--
  Why this file exists: a stranger's first PR to a project with an
  unwritten write-path rule and an unwritten schema rule is a stranger
  who breaks both by accident. Everything below is either "how to run
  the thing" or a rule that isn't visible from reading one file — it's
  visible from reading the two files that have to agree and don't say
  so.
-->

# Contributing to ModelDock

Thanks for looking. ModelDock is alpha software with one maintainer, so the
bar for a PR is not "impressive" — it's "small, correct, and explained."

## Prerequisites

- Node 20 or later.
- No coding agent needs to be installed to develop ModelDock. The tests that
  exercise OpenCode and Claude Code drive a fake CLI fixture over the real
  subprocess path, so they pass on a machine with neither installed.

## Getting set up

```bash
npm install
npm run dev        # API on 8765, page on 5173
```

```bash
npm test
npm run typecheck   # covers tests/ and config files too, not just src/
npm run lint         # Biome
npm run format       # Biome
```

```bash
npm run build        # bundles to dist/
node dist/cli.js      # run what you just built
```

## The source map

```
src/server/         Hono API, SQLite via Drizzle, MCP server
  db/               schema, migrations, and the one place that writes
  providers/        connection kinds → an AI SDK model
  code/             coding agent kinds → a running session
    adapter.ts        the interface every engine implements
    catalog.ts         pure metadata about each kind
    registry.ts         detects installed agents (PATH + known install locations, cached) and checks whether a row is currently runnable
    builtin.ts           the built-in engine: runs the agentic loop on a ModelDock connection
    opencode.ts           drives OpenCode via @opencode-ai/sdk
    claude-code.ts          drives Claude Code over its headless CLI protocol
    normalize.ts             translates the two external engines' events into the AI SDK's vocabulary
    permissions.ts            what a permission level actually grants, per engine — see below
    approval.ts                per-call "ask each time" approval for the built-in engine
    spawn.ts                    the one place a child process is started
  files/            the directory boundary, and the tools built on it
    boundary.ts        inside() — the only thing between a model's suggestion and the rest of someone's disk
    tools.ts             read, list, search — read-only
    edit.ts                write — the only tool that changes a file
    shell.ts                run_command — the only tool that starts a process
  sync/             device-to-device sync
    changelog.ts        the shape of a logged change, and the other permitted writer
    merge.ts              last-writer-wins, column by column
    transport.ts            the interface push/pull is driven through
    peer-http.ts              the second listener that answers a paired device
    peers.ts                    who this device is paired with, and its own id
    tables.ts                    which tables sync and which don't, and why
    run.ts                        `modeldock sync`, driving transport against every peer
  skills/           SKILL.md discovery, indexing and loading
  memory/           what every turn is told, and the tool that writes to it
src/web/            React 19 + Vite + Tailwind
tests/              vitest — each file gets its own disposable store
```

`providers/` and `code/` are deliberately the same shape: a `catalog.ts` of
pure metadata and a `registry.ts` that turns a database row into something
runnable. Adding a provider or an agent means adding to a catalog and a
switch, and the exhaustiveness checks make the compiler tell you what else
to touch.

## The one rule that will trip people up

**Every insert and update goes through `src/server/db/write.ts`. Never
`db.insert(...)` or `db.update(...)` directly, anywhere else.**

A row change and its changelog entry have to land in the same transaction or
not at all — that's what makes device-to-device sync possible, and a write
that silently skips the changelog is not a failure anyone notices until two
devices disagree weeks later. `tests/write.test.ts` enforces this by
scanning the entire `src/server` tree for `.insert(` and `.update(` calls
and failing if either appears outside the two files allowed to contain them.

The *only* other permitted writer is `src/server/sync/changelog.ts`. It
exists because applying a change that arrived from another device is a
different operation from making one here: it has to keep that row's
original timestamp and origin device rather than minting new ones, which is
exactly what `write.ts`'s normal path is built to prevent. If you think you
need a third place that writes, that should feel like a deliberate decision
— the test that counts the allowed writers will make you register it
explicitly.

## Schema changes

Two files have to move together:

1. `src/server/db/schema.ts` — the Drizzle table definitions the app
   compiles against.
2. `src/server/db/migrate.ts` — add a **new, numbered** entry to the
   `MIGRATIONS` array. Never edit an earlier entry; a database that already
   ran it will not run it again.

`tests/schema.test.ts` fails if the two drift — if a column exists in one
and not the other, or if a table doesn't declare whether it participates in
sync. That last part matters beyond the schema test: a new table has to be
added to either `SYNCED` or `NOT_SYNCED` in `src/server/sync/tables.ts`, so
adding a table forces a decision about whether it syncs rather than quietly
defaulting to one answer.

## Testing

vitest, `tests/**/*.test.ts`, node environment. Each test file gets its own
worker and its own `MODELDOCK_HOME` temp directory (see `tests/setup.ts`),
so tests never share state and never touch a real install.

There is no jsdom and no React component testing in this repository. That's
a real gap, not an oversight nobody noticed — say so plainly if you're
looking for it rather than assuming it exists somewhere.

Anything that touches a model goes through a mock, not a network call.
Tests that exercise chat or a coding turn mock `providers/registry.js`:

```ts
vi.mock("../src/server/providers/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/providers/registry.js")>();
  return {
    ...actual,
    resolveModel: (connection) => new MockLanguageModelV4({
      doStream: async () => ({ stream: /* a scripted ReadableStream of parts */ }),
    }),
  };
});
```

`MockLanguageModelV4` comes from `ai/test`. Most tests want a default
"reply with some text" stream; a few queue a specific sequence of scripted
parts (see `tests/chat.test.ts`) for cases like a tool call, which takes two
round trips — one to request it, one to answer once the result comes back.

Two suites carry outsized weight and are worth reading before you touch
anything nearby:

- `tests/chat.test.ts` — start a thread on one provider, switch to another
  mid-conversation, assert the history is intact with each message still
  attributed to whoever produced it. If this ever fails, the product's
  central claim is false.
- `tests/files.test.ts` and `tests/agents.test.ts` — the directory boundary,
  and that every file rule handed to an external agent is anchored to the
  project root rather than a bare tool name. The second exists because the
  first version of Claude Code's flags wasn't anchored: `--allowedTools
  "Read"` pre-approves the Read tool for *any* path, and a live run read
  `/etc/hosts` from a read-only session before it was caught.

## Security-critical files

Changing any of these requires saying so explicitly in the PR description,
and explaining what you checked:

- `src/server/files/boundary.ts`
- `src/server/code/permissions.ts`
- `src/server/files/shell.ts`

Why these three specifically: the boundary is the only thing standing
between a model's suggestion and the rest of someone's disk, the permission
mapping decides what each engine is actually allowed to do regardless of
what the UI claims, and the shell tool is the one surface that can reach
outside the project boundary entirely. A subtle bug in any of them is not a
cosmetic bug.

## PR process

- For anything beyond a small, focused fix, open an issue first so we agree
  on the shape of the change before you write it.
- Keep diffs small — the smallest version of the fix or feature that's
  correct, per the PR template.
- New or changed behaviour needs a test.
- Add a `CHANGELOG.md` entry under `[Unreleased]`.
- Fill out the checklist in `.github/pull_request_template.md` honestly.
  It asks for `npm test` and `npm run typecheck` to pass locally, and it
  asks whether you touched one of the three security-critical files above
  — that's not decoration, it's how a reviewer knows where to look first.

## AI-assisted contributions

The PR template asks you to confirm "I can explain every line if asked."
That's policy, not a formality. Using an AI assistant to write or review
code is fine — plenty of this codebase was written that way. Submitting
output you haven't read and understood is not fine, whatever produced it.
If a reviewer asks why a line does what it does, "the model wrote it that
way" is not an answer. You're accountable for every line in your diff,
regardless of how it got there.

## Scope and non-goals

Worth reading before you start something large, so the work isn't wasted:

- ModelDock does not want to become an inference provider. The provider
  layer is the AI SDK on purpose — adding ModelDock-hosted inference would
  mean owning a business this project isn't shaped for.
- ModelDock does not bundle coding-agent binaries. It finds OpenCode and
  Claude Code if they're installed and drives them; it does not ship them,
  install them, or vendor a fork of either.
- ModelDock does not put state anywhere it doesn't own. If a change would
  mean a thread, a message, a project or a memory living somewhere other
  than this SQLite file — a vendor's server, a proprietary session format
  syncing tool state, an in-memory-only store — it's the wrong shape for
  this project, however useful it is on its own terms. When you're not
  sure whether a new surface fits, that's the question to ask.
