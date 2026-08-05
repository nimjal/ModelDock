<div align="center">

# ModelDock

**A unified AI workspace you own.**

Chat, memory and projects that outlive whichever model is behind them.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20%2B-blue.svg)](https://nodejs.org)
[![Status: Alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#status)

</div>

---

## The idea

Every AI tool wants to be the place your work lives. That is the trap: the moment your
conversations, your context and your saved knowledge belong to a vendor, switching costs
you everything you have built up, and you stop switching.

ModelDock inverts it. **The substrate is yours; the engine is a detail.**

- Your conversations, projects and memory live in one SQLite file on your machine.
- Which model answers is a column in that database. Change it mid-conversation — the
  thread doesn't move.
- That memory is served back out over MCP, so Claude Code, OpenCode and Cursor read the
  *same* facts you saved here.
- Two machines sync that file directly to each other, with no account and nothing in
  between.

Thin where it's about inference — the provider layer is the AI SDK, and a coding session can
run on any agent you already have installed. Thick where it's about state, because state is
the part you can't afford to rent.

---

## Getting started

```bash
npx modeldock
```

That's the whole install. It creates `~/.modeldock/`, migrates the database, opens the
workspace on `127.0.0.1:8765`, and ships with Anthropic, OpenAI, Google and Ollama
already described.

Then export a key for whichever one you want and restart:

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # or OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY
```

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."    # PowerShell
```

Ollama needs no key at all. Not sure what's wired up?

```bash
npx modeldock doctor
```

```
ModelDock — /home/you/.modeldock

  ok    Store          /home/you/.modeldock/modeldock.db
  ok    Anthropic      anthropic · claude-sonnet-4-5
  warn  OpenAI         OPENAI_API_KEY is not set in this environment, so "OpenAI" cannot be used yet.
  ok    Ollama         ollama · llama3.2
  ok    OpenCode       1.18.12 · /home/you/.opencode/bin/opencode
  warn  Claude Code    not found. Install with: npm install -g @anthropic-ai/claude-code
```

`doctor` also reports any coding agent it can find and any skill whose `SKILL.md` it
could not read — the two things that otherwise fail silently.

### Your key is never stored

ModelDock saves the **name** of an environment variable, never its value. Keys are read
from the environment at the moment a request is made. So the database can be backed up,
copied between machines or (later) synced without ever becoming a credential leak — and
`doctor` can tell you a variable is missing instead of a request failing mysteriously.

---

## What's in it

**Chat** — against any provider, with no project and no directory required. Streaming,
tool calls and reasoning all render, and are stored structurally so an old thread still
reads correctly long after the model that produced it is gone.

**Memory** — durable facts that reach every conversation. Global memories always apply;
project memories apply in their project. You can write them by hand, the assistant can
save one mid-conversation with its `remember` tool, and you can always read the exact
block being sent to the model. Memory you can't inspect is memory you stop trusting.

**Projects** — a context, not a folder: a memory scope, a default connection and a group
of conversations. Give one a `directory` and it also gains the two file-backed surfaces
below; most projects are not a checkout, so the field stays optional.

**Cowork** — a project with a directory gains read-only file tools in ordinary chat: read,
list and search, shown as quiet tool-call lines in the transcript. It is not a mode you
switch into and there is no second screen — the conversation is the same one. Cowork has no
write tool and no shell tool, and that absence *is* its safety story: an ordinary chat
cannot damage anything, so it needs no permission level and nothing to approve. Writing and
running live in the Code surface, which has both.

**Skills** — folders holding a `SKILL.md`, in the standard Agent Skills shape, so one you
already wrote for another tool works here unchanged. Personal ones live in
`~/.modeldock/skills/`; a project's own live in `<directory>/.modeldock/skills/` and commit
with the repository, where they beat a personal skill of the same name. Only names and
descriptions are injected — a `load_skill` tool fetches the body when one is relevant —
and the Skills screen shows you the exact block, the way Memory does.

**Code** — agentic coding, either on a model you have configured here or through an agent
you already have installed.

The built-in engine runs the loop on an ordinary ModelDock connection, which makes it the
one coding surface where the model answering is a column in your database like anywhere
else — switch the connection and the next turn is answered by something else, with the
transcript untouched. Its sessions are portable, too: they are this store's own messages
rather than state in some other program's home directory.

ModelDock also finds OpenCode and Claude Code and drives them behind the same interface. It
never bundles a binary, and an agent that isn't installed simply doesn't appear rather than
sitting there disabled. Either way a coding session is an ordinary thread, so it renders,
reloads and reads back like any other.

How much may happen in a run is a level you pick in the composer:

| Level | What may happen | Directory boundary |
|---|---|---|
| **Read only** | read, search and list inside the project | enforced |
| **Edit files** | also write files inside the project | enforced |
| **Edit and run** | also run shell commands | **advisory** — see below |
| **Ask each time** | the same, but each write and each command is shown to you first | **advisory**, but nothing runs unseen |

Every file rule ModelDock passes is anchored to the project directory, so at the first two
levels a path outside it is refused rather than merely discouraged. With the built-in engine
it is stronger still: a tool the level does not permit is not in the tool set at all, so
there is nothing to refuse.

Once a shell is available the boundary stops being a guarantee, and it is worth saying
plainly why. File permissions govern an agent's *own* tools, but a shell can start a process
that opens anything your user account can. That is true of every coding agent, and no
configuration flag closes it — only an OS-level sandbox does.

**Ask each time** does not change that, and it would be dishonest to imply it did. What it
changes is who decides: the command appears in the transcript, in full and untruncated, and
nothing happens until you say so. The decision is recorded next to it. It is available on
the built-in engine, because pausing between a model choosing a tool and that tool running
requires the loop to be running here — inside OpenCode or Claude Code, that moment isn't
ModelDock's to interrupt.

**Connections** — Anthropic, OpenAI, Google, Ollama, and anything speaking the OpenAI API.
That last one covers OpenRouter, LiteLLM, vLLM, LM Studio, Groq, Together and your own
server — a proxy is just a base URL, so no gateway dependency is needed.

### Providers

| Kind | For | Needs |
|---|---|---|
| `anthropic` | Claude, direct | `ANTHROPIC_API_KEY` |
| `openai` | GPT, direct | `OPENAI_API_KEY` |
| `google` | Gemini, direct | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `ollama` | Local models | nothing |
| `openai_compatible` | Everything else OpenAI-shaped | a base URL, and a key if the endpoint wants one |

### Coding engines

The external two are detected on `PATH` and in the usual install locations. Nothing is
bundled or installed for you, and each runs with your own login and your own project files —
your `CLAUDE.md`, your `AGENTS.md`, your slash commands, your MCP servers.

| Engine | Runs on | Install |
|---|---|---|
| **ModelDock** | any connection above — the loop runs here | nothing |
| OpenCode | its own configuration; ModelDock starts and stops its server | `curl -fsSL https://opencode.ai/install \| bash` |
| Claude Code | its own login, over its documented headless CLI protocol | `npm install -g @anthropic-ai/claude-code` |

Only the built-in engine offers **Ask each time**, and only it keeps a session you can pick
up on another machine.

---

## Sharing memory with your other tools

The store is served over MCP, so what you save here is available wherever you work:

```bash
claude mcp add modeldock -- npx modeldock mcp
```

That exposes `search_memory`, `add_memory` and `list_projects`. Save a preference in
ModelDock and Claude Code knows it; have Claude Code record a decision and it shows up on
the Memory screen and in your next chat. One set of facts, many tools — which is the
point.

---

## Sharing the store with your other machines

Two ModelDock installs sync directly with each other. There is no account, no server, and
nothing in between — which is the only arrangement consistent with the rest of this: a
workspace you own is not one that has to phone somewhere to reach itself.

On the machine that is usually on:

```bash
modeldock pair --host
```

It prints a code. On the other machine, within ten minutes:

```bash
modeldock pair v1.eyJob3N0Ijoi…
modeldock sync
```

```
  ok    desktop              pushed 41, pulled 12

pushed 41 changes, pulled 12
```

After that, `modeldock sync` on the laptop whenever you want to catch up, or **Sync now** in
Settings. Only the joiner ever initiates, so only one machine has to be reachable — which is
what makes this work from a laptop behind NAT.

Conversations, projects and memory merge **per column**: rename a thread on one machine and
archive it on the other and both edits survive, because they were never really in conflict.
Where two devices genuinely change the same field, the later write wins and both sides agree
on which one that was.

What stays put is as deliberate as what travels. A project's `directory` and an agent's
install path describe *that* machine, so they never leave it — a synced coding agent arrives
on the other side reported as not installed, which is the truth. Skills don't sync at all:
the folder on disk is the source, and `~/.modeldock/skills/` is a directory any file-syncing
tool already handles.

Two things to know before you rely on it. The connection is **plaintext on your local
network**, authenticated with a token — put it behind WireGuard or Tailscale over anything
you don't trust. And merging by "later wins" assumes the two clocks agree; if they drift far
apart, `sync` says so rather than quietly resolving edits in the wrong order.

---

## Design

The chrome is permanently quiet, and the only saturated colour in the entire app is the
provider currently docked, shown as one chip in the header. Switching engines re-tints
exactly that chip and moves nothing else. The claim that you aren't locked in should be
something you can see, not just something the README says.

Assistant replies are set in Newsreader at a reading measure, because reading is what you
actually do here and long answers in a 15px UI sans read like log output.

---

## Development

```bash
npm install
npm run dev        # API on 8765, page on 5173
npm test
npm run lint       # biome — lint and format in one pass
npm run typecheck  # covers tests/ as well as src/
npm run build      # bundles to dist/, then: node dist/cli.js
```

```
src/server/         Hono API, SQLite via Drizzle, MCP server
  db/               the schema, the migration ladder, and write.ts
  providers/        connection kinds → an AI SDK model
  code/             coding engines → a running session, and what each may do
  files/            the directory boundary; read tools, write tools, the shell
  sync/             the change log, the merge rule, and how peers talk
  skills/           SKILL.md discovery, indexing and loading
  memory/           what every turn is told, and the tool that writes to it
src/web/            React 19 + Vite + Tailwind
tests/              vitest — each file gets its own disposable store
```

`providers/` and `code/` are deliberately the same shape: a `catalog.ts` of pure metadata
and a `registry.ts` that turns a database row into something runnable. Adding a provider
or an engine means adding to a catalog and a switch, and the exhaustiveness checks make the
compiler tell you what else to touch.

**Everything that writes goes through `src/server/db/write.ts`** — not by convention but
because a row change and its changelog entry have to land in one transaction. The only other
writer is `src/server/sync/changelog.ts`, which applies rows arriving from another device
with the stamps they were given rather than new ones. `tests/write.test.ts` enforces the rule
by scanning the source, because the previous convention was hand-copied and had already
drifted in two places.

The test that matters most is in `tests/chat.test.ts`: start a thread on one provider,
switch to another mid-conversation, and assert the history is intact with each message
still attributed to whoever produced it. If that ever fails, the product's central claim
is false.

Several others carry real weight:

- `tests/files.test.ts` — the directory boundary, the only thing between a model's
  suggestion and the rest of your disk.
- `tests/agents.test.ts` — that every file rule handed to an agent is anchored to the
  project root. It exists because the first version wasn't: `--allowedTools "Read"`
  pre-approves the Read tool for *any* path, and a live run read `/etc/hosts` from a
  read-only session before it was caught. These drive a fake CLI fixture over the real
  subprocess path, so they run on a machine with no coding agent installed.
- `tests/approval.test.ts` — that a call needing approval does not happen until it has one,
  and that an approval whose input was altered afterwards is rejected.
- `tests/shell.test.ts` — that `run_command` cannot see the environment variables your
  connections name as holding keys.
- `tests/sync.test.ts` — two live stores merging, including the case where both devices edit
  the same row and have to independently agree on the winner.
- `tests/migrate.test.ts` and `tests/schema.test.ts` — that an older database upgrades
  cleanly, and that `schema.ts` and `migrate.ts` still describe the same tables.

---

## Status

**Alpha**, and honest about it.

Working today: everything under [What's in it](#whats-in-it) — chat across all five
connection kinds, memory, projects, Cowork, Skills, Code on the built-in engine or an
external agent, per-call approval, device-to-device sync, the MCP server, `doctor` and
`npx modeldock`.

Not built yet:

1. **Per-call approval for the external engines.** OpenCode and Claude Code run their loop
   in their own process, so the moment between choosing a tool and running it isn't
   ModelDock's to pause. Doing it properly means using each engine's own hook — OpenCode's
   `ask` permission, and for Claude Code an MCP server stood up per run and correlated back
   to the stream. Until then, **Ask each time** is offered only where it actually works.
2. **Encrypted sync.** Peers talk plaintext over the local network with a bearer token.
   WireGuard or Tailscale is the answer today; a pinned-certificate mode is the obvious
   next step, and the pairing code already reserves a field for it.
3. **Clock skew.** Merging by "later wins" is only as good as the two clocks. `sync` reports
   a large drift rather than resolving edits in the wrong order silently, but it cannot fix
   it. A hybrid logical clock would, at the cost of `updatedAt` no longer meaning what the
   sidebar shows.

### Two limitations worth knowing

Claude Code sessions are machine-local: `--resume` only works where `~/.claude` holds the
session, so `threads.agentSessionId` does not travel and is deliberately excluded from sync.
ModelDock's own transcript is always complete regardless — and a **built-in** coding session
has no such problem, because its session *is* that transcript.

At **Edit and run** and **Ask each time**, a shell can reach outside the project directory.
This is a property of shells, not a gap in the configuration; see
[What's in it](#whats-in-it) for the full statement of it.

---

## Credits

ModelDock is thin on purpose where other people have already done the work well:

- **[AI SDK](https://ai-sdk.dev)** (Vercel, Apache-2.0) — the provider layer.
- **[Model Context Protocol](https://modelcontextprotocol.io)** (open spec, MIT SDKs) —
  how memory reaches everything else.
- **[OpenCode](https://opencode.ai)** (MIT) — a coding engine the Code surface can drive,
  via `@opencode-ai/sdk`. Claude Code is driven over its documented headless CLI protocol
  rather than its SDK, which ships under Anthropic's commercial terms; invoking a program
  someone installed keeps ModelDock's dependency tree MIT throughout.
- **[Hono](https://hono.dev)**, **[Drizzle](https://orm.drizzle.team)**,
  **[Geist](https://vercel.com/font)** and **[Newsreader](https://fonts.google.com/specimen/Newsreader)**.

ModelDock's own code is [MIT](./LICENSE).
