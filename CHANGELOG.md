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

### Fixed

- **A timed-out `run_command` no longer hangs the turn on macOS and Linux.**
  The kill reached only the shell ModelDock spawned, never the command that
  shell went on to start — and because the grandchild still held the output
  pipes, the tool waited out the command's full runtime anyway. Children are
  now started in their own process group and the group is what gets signalled,
  which is what Windows had all along via `taskkill /t`. A Ctrl-C in the
  terminal running ModelDock still reaches a running build.
- **`better-sqlite3` held at 12.x.** The 13.x `linux-x64` prebuild segfaults on
  opening a database, which made the store unusable on Linux.

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
