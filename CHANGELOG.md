<!--
  Why this file exists: "what changed" and "why" live in commit
  messages and PRs, which is the wrong place to answer "is it safe to
  upgrade" or "did this alpha already have per-call approval." This is
  the record meant to answer exactly that, in order, without needing
  git log archaeology.
-->

# Changelog

All notable changes to ModelDock are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/) — with the
understanding that before `1.0.0`, `0.x` releases can include breaking changes.

## [Unreleased]

### Added

- **Custom engines, as scripts.** A connection can be a short JavaScript module
  instead of a vendor: `chat()` streams a reply, `image()` draws, `models()`
  fills the picker. It is wrapped in the AI SDK's own model interfaces, so chat,
  `generate_image`, the built-in coding engine and the `/v1` gateway run it
  unchanged. Ollama, ChatGPT, Claude, Gemini, OpenAI-compatible servers and the
  Stable Diffusion WebUI ship as templates, any existing connection can be
  copied into one, and every model picker leads to an editor that checks a
  script and runs a trial turn before it is saved. Scripts run unsandboxed with
  full Node access, and never sync between devices in either direction.
- **The image model in Settings is a picker.** It lists what the chosen
  connection can draw with, image models first, where it used to be a text
  field.
- **A default model for every new chat.** A workspace-wide default connection
  and model, stamped onto a thread when it is created rather than resolved at
  the first turn — so the berth names the right engine the moment a chat opens
  instead of reading "No connection" until something is sent. Changing the
  default does not re-point conversations already started, and a project's own
  default still wins over it.
- **Image generation, as a tool the model can call.** Point Settings at an
  OpenAI, Google or OpenAI-compatible connection and the assistant gains a
  `generate_image` tool it can use mid-conversation. Deliberately independent of
  which model is answering: Anthropic publishes no image model, so "Claude
  holding the conversation, OpenAI or a local endpoint drawing" is the ordinary
  arrangement rather than a workaround. Images are stored inline in the message,
  and `toModelOutput` keeps their bytes out of the context window on every
  subsequent turn.
- **A local model gateway on `/v1`.** Every model from every configured
  connection, exported on one loopback endpoint in *both* wire protocols —
  OpenAI's `/v1/chat/completions` and Anthropic's `/v1/messages`, plus
  `/v1/models` — with tool calls and streaming passed through. Models are named
  `<connection>/<model>`. Tools are declared but never executed here: the caller
  owns its own agentic loop, and ModelDock is the model in the middle of it.
  Guarded by a token in `~/.modeldock/gateway.token`, because unlike the rest of
  the API this surface turns every key on the machine into an endpoint any local
  process could spend.
- **A button to point Claude Code and OpenCode at ModelDock.** Settings shows
  the exact change to `~/.claude/settings.json` or
  `~/.config/opencode/opencode.json` as a diff, writes it only on confirm,
  copies the original to `<name>.modeldock.bak`, and offers a revert that
  removes exactly what was added and leaves everything else. A config that
  cannot be parsed is reported rather than rewritten. `CLAUDE_CONFIG_DIR` and
  `XDG_CONFIG_HOME` are honoured.

### Changed

- **Node 22 is the minimum.** `ai`, every `@ai-sdk/*` package and
  `concurrently` declare `node >=22` themselves, so advertising 20 claimed a
  version the dependency tree did not support. `engines`, the esbuild target
  and the CI matrix all moved together.
- **TypeScript 7.** `baseUrl` was removed in 7.x. The two aliases it existed
  for — `@server/*` and `@web/*` — turned out to be imported from nowhere, so
  they were deleted rather than migrated, along with the matching unused alias
  in `vite.config.ts`.
- **Dependencies refreshed** across the AI SDK, Hono, Vite, esbuild and tsx.

### Fixed

- **A timed-out `run_command` no longer hangs the turn on macOS and Linux.**
  The kill reached only the shell ModelDock spawned, never the command that
  shell went on to start — and because the grandchild still held the output
  pipes, the tool waited out the command's full runtime anyway. Children are
  now started in their own process group and the group is what gets signalled,
  which is what Windows had all along via `taskkill /t`. A Ctrl-C in the
  terminal running ModelDock still reaches a running build.
- **`better-sqlite3` held at 12.x.** The 13.x `linux-x64` prebuild segfaults on
  opening a database, which made the store unusable on Linux — 13.0.0 rebuilt
  the binding onto N-API, which is the likely cause. Still unfixed as of
  13.0.3, so Dependabot is now told to leave the major alone instead of
  reopening it weekly for the reason to be rediscovered each time.

## [0.1.0] - 2026-08-04

The first alpha. Chat, memory and projects live in one SQLite file; the
provider layer and the coding agents are borrowed, on purpose, so this store
stays the part that's actually yours.

### Added

- **Chat** across five connection kinds — Anthropic, OpenAI, Google, Ollama,
  and anything OpenAI-compatible — with mid-thread provider switching. A
  thread's history stays intact and each message keeps the provider and
  model that produced it, even after switching engines mid-conversation.
- **Memory** — global and per-project facts, written by hand or by the
  assistant's `remember` tool, served back over MCP so other tools
  (Claude Code, OpenCode, Cursor) read the same facts saved here.
- **Projects** — a memory scope, a default connection and a group of
  conversations, with an optional `directory` that unlocks Cowork and Code.
- **Cowork** — read-only file tools (read, list, search) in ordinary chat
  for any project with a directory. No write tool, no shell tool.
- **Skills** — `SKILL.md` discovery from `~/.modeldock/skills/` and a
  project's own `<directory>/.modeldock/skills/`, with only names and
  descriptions injected up front and a `load_skill` tool for the body.
- **Code** — agentic coding through OpenCode or Claude Code, detected on
  `PATH` and driven behind one interface, with a permission level chosen
  per run (Read only, Edit files, Edit and run).
- **A built-in coding engine** that runs the agentic loop directly on a
  ModelDock connection, rather than requiring an external agent. Its
  session is this store's transcript, so it resumes from any device that
  reaches the store.
- **Per-call tool approval** ("Ask each time") for the built-in engine —
  the model's tool call is shown before it runs, and the decision is part
  of the persisted message history rather than an in-memory prompt, so it
  survives a reload.
- **Device-to-device sync** (`modeldock pair` / `modeldock sync`) — pair
  two ModelDock installs and exchange changes over a bearer-token-secured
  local listener, with last-writer-wins merge per column.
- **`doctor`** — reports which connections and coding agents are usable in
  the current environment, and which skill files failed to parse.
