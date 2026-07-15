# Agent CLI

A local-first, terminal-native agent harness. V0.1 proved a **bounded local agent loop**:
the agent understands a workspace, plans, acts through explicit typed tools, has every action
gated by one policy engine, records attributable evidence to an append-only log, can undo its
file changes, resumes across runs, and produces a deterministic evidence report. V0.2 adds the
**interactive REPL**, a **workspace-trust consent gate**, **narrowing-only policy
configuration**, and **turn interruption**.

> **Status:** core loop + interactive experience complete and tested (196 tests, plus a live
> end-to-end against the real API). This is an open, build-in-public engineering effort — see
> `PROJECT.md` for the thesis and `ROADMAP.md` for what is done, deferred, and next.

## Install

```sh
npm install
npm run build        # compiles src → dist
npm link             # optional: puts `agent` on your PATH
```

Requires Node 22+. Windows-first (developed and tested on Windows 11); the logic is
cross-platform but only the Windows path rules are exercised in CI.

## Interactive use

```sh
mkdir my-project && cd my-project
agent
```

The first time you run the agent in a folder it shows a **trust prompt** — recorded consent,
not a sandbox (see below). Then you get a prompt: type instructions in natural language,
watch tool activity live, approve or deny anything consequential inline, and keep going —
one session, one evidence log.

```
agent session 20260715-101730-5d56
  workspace: C:\demo
› create a small node utility that counts words in a file
  • write_file wordstats.mjs ✓
  • run: node --test
  ⚠ approval required  [observe]  run_command
  [y] allow once  [s] allow for the rest of this session  [n] deny  [q] deny & stop
```

- **Ctrl+C** interrupts the running turn (pending tool calls are skipped and recorded as
  interrupted); at the idle prompt press it twice to quit. **Ctrl+D** on an empty line quits.
- **Slash commands:** `/help`, `/status`, `/undo [all]` (in-session undo; the model is told via
  a delimited harness note), `/report`, `/map`, `/quit`.
- A running `run_command` is NOT interruptible — the abort takes effect at the next boundary.
- stdout carries only model text and requested artifacts; all status chrome goes to stderr, so
  `agent --interactive < script > transcript.txt` captures a clean transcript.
- `agent --continue` (no task) resumes the latest session interactively; `agent resume <id>`
  a specific one.

## One-shot use

```sh
agent "<task>"                 # run a one-shot task in the current directory
agent --continue "<task>"      # resume the latest session with a follow-up
agent resume <id> "<task>"     # resume a specific session
agent undo [--all]             # undo the last file change (or all) of a session
agent report [<id>] [--json]   # print the evidence report (default: latest session)
agent sessions                 # list this workspace's sessions
agent map [--budget <n>]       # print the workspace map the model would receive
agent trust [--revoke|--list]  # manage recorded workspace trust
```

Key flags: `-C <dir>` (workspace root), `--provider anthropic|mock`, `--script <file>`
(scripted turns for `mock`), `--model <id>`, `--no-input` (non-interactive; auto-detected off a
TTY), `--interactive` (force interactive mode over piped stdio, e.g. expect-style drivers),
`--max-turns <n>`, `--trust-this-workspace` (one invocation, never recorded),
`--dangerously-allow-all`.

Exit codes: `0` ok · `1` error · `2` one-shot completed with denials or hit the step budget
(the REPL reports these inline and exits 0 on a clean quit) · `3` workspace not trusted.

The Anthropic provider reads `ANTHROPIC_API_KEY` from the environment, streams responses, and
detects system proxies (`HTTPS_PROXY` etc.). The `mock` provider replays a scripted-turns JSON
file and needs no network — it is how the whole loop is tested deterministically.

## Workspace trust

Before the harness reads a single byte of a folder (its config, its `.gitignore`, the file map)
or sends anything to a model, the folder must be **trusted**: an interactive consent prompt, a
recorded grant (`agent trust`), or an explicit per-invocation flag. Trust lives in
`<state>/trust.json` with an append-only `trust.log` audit trail, outside every workspace, so
folder contents can never influence it.

**Trust is recorded consent, NOT a sandbox.** It changes what the agent is *allowed* to do,
not what a process *can technically* do. Untrusted + non-interactive runs refuse with exit 3.

## Configuration (narrowing-only)

- `<state>/config.json` (user): `model`, `maxSteps`, plus the narrowing knobs.
- `<workspace>/.agent-cli/config.json` (workspace): **narrowing knobs only** — a workspace
  cannot choose your model or budgets, and the agent's file tools cannot write to `.agent-cli/`.

Narrowing knobs: `protectedPaths` (extra write-deny roots) and `secretPatterns` (literal
lowercase basename substrings treated as secret-like). Config can only *restrict* the agent —
there is no allowlist field, no auto-approval field, and no way to relax the command gate.
Unknown keys or invalid JSON are hard errors. CLI flags > user config > defaults; narrowing
merges as a union across layers.

## What the agent can do

Six typed tools: `read_file`, `list_files`, `search`, `write_file`, `edit_file`, `run_command`.
Every call passes through the policy engine before it runs. Reads and searches inside the
workspace run automatically; in-workspace writes run automatically **and are snapshotted so they
can be undone**; reads outside the workspace or of secret-looking files require approval; and
**every shell command requires approval** (there is no command allowlist).

## Security model & honest limitations

Read this before trusting the harness with anything sensitive.

- **There is NO OS sandbox.** The only control is the approval prompt (a *logical*
  policy, not OS isolation). There is no restricted token, AppContainer, Job Object, firewall
  rule, or seccomp/Seatbelt analog. An approved `run_command` runs with **your full
  privileges** — it can touch any file, reach any network endpoint, and its effects are **not
  snapshotted and not undoable**.
- **Trust, approval, and sandbox are three different controls; only the first two exist here.**
  Trust records that you consented to the agent operating in a folder; approval asks before
  consequential actions; neither technically confines a process.
- **Undo is file-only.** It reverts `write_file` / `edit_file` changes via content-addressed
  snapshots, and refuses to overwrite a file that drifted (external edit) rather than clobber it.
  It does **not** cover `run_command` side effects, out-of-workspace edits, or external changes.
- **Command output is not scrubbed.** Secret-looking *file reads* (`.env`, `*.pem`, …) are
  redacted in the event log, but `run_command` stdout is captured verbatim — a command that
  echoes a credential will record it in the log, and `agent report --json` may surface it.
- **Path checks are TOCTOU-racy.** The workspace-boundary check validates a path at decision
  time; a junction created between check and use is not caught. It is logical policy, not
  enforcement.
- **A running shell command cannot be interrupted** by Ctrl+C in V0.2; the abort lands at the
  next tool boundary (the command's own timeout still applies).
- **Legacy console note:** on Windows PowerShell 5.1, piping or redirecting the CLI's output can
  re-encode it through the OEM code page and mangle non-ASCII text; PowerShell 7+ and Windows
  Terminal handle UTF-8 correctly. Piped/non-TTY output uses ASCII status glyphs for this reason.
- **The path to real isolation** (WSL2, containers, or OS primitives) is future work — see
  `ROADMAP.md`.

State (event logs, snapshots, trust) lives **outside** the workspace at
`%USERPROFILE%\.agent-cli\` (override with `AGENT_CLI_STATE_DIR`). The startup
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
