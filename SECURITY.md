<!--
  Why this file exists: ModelDock spawns subprocesses, reads and writes
  files on request, and (optionally) listens for another device on the
  network. Those are the parts of the app that can hurt someone if
  they're wrong, so this file says exactly what is and isn't a
  vulnerability report, rather than leaving that to be worked out in
  a public issue thread.
-->

# Security Policy

## Supported versions

ModelDock is pre-1.0 alpha software, currently `0.1.x`. There is no long-term
support branch: a fix lands on the latest release, not backported to an
older one. If you're running an old alpha, the first thing to try is
updating.

## Reporting a vulnerability

Please don't open a public issue for a security problem.

Preferred: use **GitHub Security Advisories** — the "Report a vulnerability"
button under this repository's Security tab. That gives us a private thread
to work the problem in before anything is public.

If you'd rather not use GitHub, email **hi@nimit.is-a.dev**.

## What to expect

This is one person maintaining alpha software, not a security team with an
SLA. What you can expect: an acknowledgement within a week, and a fix
prioritized once the report is understood. What you shouldn't expect: a
guaranteed response time shorter than that, or a CVE process — if a report
turns out to need one, we'll figure that out together at the time.

## In scope

These are the places where ModelDock draws a line between what a model can
do and what it can't, so a bug in any of them means that line moved without
anyone deciding it should:

- **The project-directory boundary** (`src/server/files/boundary.ts`) —
  any way to make `inside()` accept a path outside the project directory:
  via a symlink, a `..` segment, a non-canonical root, or a Windows 8.3
  short name.
- **The permission mapping** (`src/server/code/permissions.ts`) — any
  permission level (`read`, `edit`, `full`, `ask`) granting a coding agent
  more than its own description says it grants.
- **`run_command`** (`src/server/files/shell.ts`) — leakage of an
  environment variable that should have been stripped before a command ran,
  or argv/command-line injection, including the Windows `cmd.exe`
  re-parsing behaviour this file specifically writes around.
- **The tool-approval signature** (`src/server/code/approval.ts`) —
  any way to get a call approved whose input differs from what was actually
  shown to the person approving it.
- **The peer listener** (`src/server/sync/peer-http.ts`) — unauthenticated
  access to `/push` or `/pull`, or a way to obtain or forge a valid pairing
  token or bearer token.
- **The Host/Origin check** in `src/server/app.ts` — any request that gets
  past it without a Host this server could plausibly have produced, or with
  a mutating request that carries another site's Origin.
- **Any path by which an API key reaches the database, a response body, or
  a subprocess.** ModelDock's central promise is that it stores the *name*
  of an environment variable and never its value — a way to break that
  promise is a vulnerability regardless of which file it's found in.

## Out of scope

Stated plainly rather than left for someone to discover the hard way:

- **A shell can reach anything the user account can, at the "Edit and run"
  and "Ask each time" permission levels.** This is documented behaviour,
  not a vulnerability. File-tool permissions govern an agent's own tools;
  they were never a sandbox around a subprocess, and no config flag can
  make them one. Containing what a shell can do needs an OS-level sandbox.
  If you have a way to make ModelDock's own directory boundary hold even
  when a shell is available, that's a genuine finding — "a shell can do
  what a shell can do" is not.
- **Sync traffic is plaintext on the local network, by design.** The peer
  listener is authenticated with a bearer token but sends nothing over
  TLS. If you need that traffic protected against a network observer, run
  it over WireGuard or Tailscale. A report that sync traffic is
  interceptable on an untrusted LAN restates a documented limitation rather
  than reporting a new one.
