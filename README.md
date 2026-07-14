# Agent CLI

A local-first, terminal-native agent harness. V0.1 proves a **bounded local agent loop**:
the agent understands a workspace, plans, acts through explicit typed tools, has every action
gated by one policy engine, records attributable evidence to an append-only log, can undo its
file changes, resumes across runs, and produces a deterministic evidence report.

> **V0.1 status:** the core loop is complete and tested (122 tests). This is an open,
> build-in-public engineering effort — see `PROJECT.md` for the thesis and `ROADMAP.md` for
> what is done, what is deferred, and what comes next.

## Install

```sh
npm install
npm run build        # compiles src → dist
npm test             # 121 tests + 1 opt-in live test
```

Requires Node 22+. Windows-first (developed and tested on Windows 11); the logic is
cross-platform but only the Windows path rules are exercised in CI.

## Usage

```sh
agent "<task>"                 # run a one-shot task in the current directory
agent --continue "<task>"      # resume the latest session with a follow-up
agent resume <id> "<task>"     # resume a specific session
agent undo [--all]             # undo the last file change (or all) of a session
agent report [<id>] [--json]   # print the evidence report (default: latest session)
agent sessions                 # list this workspace's sessions
agent map [--budget <n>]       # print the workspace map the model would receive
```

Key flags: `-C <dir>` (workspace root), `--provider anthropic|mock`, `--script <file>`
(scripted turns for `mock`), `--model <id>`, `--no-input` (non-interactive; auto-detected off a
TTY), `--max-turns <n>`, `--dangerously-allow-all`.

Exit codes: `0` completed · `2` completed with auto-denied approvals or hit the step budget ·
`1` error · `3` session locked · `130` aborted.

The Anthropic provider reads `ANTHROPIC_API_KEY` from the environment and streams responses.
The `mock` provider replays a scripted-turns JSON file and needs no network — it is how the
whole loop is tested deterministically.

## What the agent can do

Six typed tools: `read_file`, `list_files`, `search`, `write_file`, `edit_file`, `run_command`.
Every call passes through the policy engine before it runs. Reads and searches inside the
workspace run automatically; in-workspace writes run automatically **and are snapshotted so they
can be undone**; reads outside the workspace or of secret-looking files require approval; and
**every shell command requires approval** (there is no command allowlist).

## Security model & honest limitations

Read this before trusting the harness with anything sensitive.

- **There is NO OS sandbox in V0.1.** The only control is the approval prompt (a *logical*
  policy, not OS isolation). There is no restricted token, AppContainer, Job Object, firewall
  rule, or seccomp/Seatbelt analog. An approved `run_command` runs with **your full
  privileges** — it can touch any file, reach any network endpoint, and its effects are **not
  snapshotted and not undoable**.
- **Approval and sandbox are different controls, and only approval exists here.** V0.1 ships the
  "when to ask a human" control; the "what a process can technically touch" control is future
  work. The docs never imply isolation that does not exist.
- **Undo is file-only.** It reverts `write_file` / `edit_file` changes via content-addressed
  snapshots, and refuses to overwrite a file that drifted (external edit) rather than clobber it.
  It does **not** cover `run_command` side effects, out-of-workspace edits, or external changes.
- **Command output is not scrubbed.** Secret-looking *file reads* (`.env`, `*.pem`, …) are
  redacted in the event log, but `run_command` stdout is captured verbatim — a command that
  echoes a credential will record it in the log, and `agent report --json` may surface it.
- **Path checks are TOCTOU-racy.** The workspace-boundary check validates a path at decision
  time; a junction created between check and use is not caught. It is logical policy, not
  enforcement.
- **The path to real isolation** (WSL2, containers, or OS primitives) is future work — see
  `ROADMAP.md`.

State (event logs, snapshots) lives **outside** the workspace at
`%USERPROFILE%\.agent-cli\projects\<slug>\` (override with `AGENT_CLI_STATE_DIR`). The startup
check refuses to run if the state dir resolves inside the workspace. Note the honest caveat: an
approved shell command can still reach that state dir — the protection holds only against the
file tools.

## Development

```sh
npm run typecheck    # tsc --noEmit, strict + noUncheckedIndexedAccess
npm test             # vitest
npm run build        # emit dist/
```

`AGENT_LIVE_TEST=1 npm test` additionally runs one real Anthropic API call (excluded from CI).

## Documentation

- `PROJECT.md` — long-term product thesis and principles.
- `CLAUDE.md` — the project constitution and operating rules.
- `ARCHITECTURE.md` — how the current system is built.
- `ROADMAP.md` — session-by-session evolution and next steps.
