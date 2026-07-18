# Agent CLI

A local-first, terminal-native agent harness. V0.1 proved a **bounded local agent loop**:
the agent understands a workspace, plans, acts through explicit typed tools, has every action
gated by one policy engine, records attributable evidence to an append-only log, can undo its
file changes, resumes across runs, and produces a deterministic evidence report. V0.2 added the
**interactive REPL**, a **workspace-trust consent gate**, and **narrowing-only policy
configuration**. V0.3 added a **managed execution kernel** — real mid-command cancellation, typed
termination (a killed command has no exit code), best-effort tree kill, and command-lifecycle
evidence. V0.4 adds a **genuinely OS-enforced Windows sandbox** (Low integrity + Job Object) and
**automatic command review**: demonstrably read-only commands auto-run *inside* the sandbox, and
everything else asks — a single default, fail-closed, backed by enforcement rather than the
model's opinion.

> **Status:** core loop + interactive experience + execution kernel + enforced Windows isolation,
> complete and tested (322 tests incl. real-OS sandbox and adversarial-review suites, plus live
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

Narrowing knobs: `protectedPaths` (extra write-deny roots), `secretPatterns` (literal lowercase
basename substrings treated as secret-like), and `envExcludePatterns` (extra name substrings
dropped from command-child environments). Config can only *restrict* the agent — there is no
allowlist field, no auto-approval field, and no way to relax the command gate or widen the sandbox.
Unknown keys or invalid JSON are hard errors. CLI flags > user config > defaults; narrowing
merges as a union across layers.

## What the agent can do

Six typed tools: `read_file`, `list_files`, `search`, `write_file`, `edit_file`, `run_command`.
Every call passes through the policy engine before it runs. Reads and searches inside the
workspace run automatically; in-workspace writes run automatically **and are snapshotted so they
can be undone**; reads outside the workspace or of secret-looking files require approval.

Shell commands go through **automatic review** (the single default — there is no permission
"mode" to pick). A deterministic analyzer decides, over the command text alone (never the model's
opinion): a *demonstrably* read-only command — a single simple command with no shell
metacharacters/encoding, whose program is on a small read-only allowlist (`git status/log/diff`,
`--version` probes, `ls`, …) with non-escaping args — may **auto-run**, but only *inside* the OS
sandbox so a misjudgment can't do damage. Everything else — writes, installs, network, anything
with pipes/redirection/encoding/chaining, an unrecognized program, or a path that escapes the
workspace — **requires approval**. A few catastrophic forms are hard-denied outright. Where no
enforced sandbox is available, auto-run is **disabled** and every command asks (fail closed).

## Security model & honest limitations

Read this before trusting the harness with anything sensitive.

- **Trust, approval, and sandbox are three different controls — and now all three exist, but the
  sandbox is narrow and Windows-only.** Trust records that you consented to the agent operating in
  a folder; approval asks before consequential actions; the sandbox is the OS *technically*
  confining a process.
- **The Windows sandbox (`windows-lowil`) is a real, OS-enforced boundary — with honest limits.**
  When Agent CLI runs on Windows and its startup probe passes, an **auto-run** command executes at
  **Low integrity** inside a **Job Object**. What that *does* enforce (verified by tests against
  the live OS): the command **cannot write** to the workspace, your profile, system directories,
  or the harness state — Mandatory Integrity Control denies the write at the kernel; and its whole
  process tree (including a detached grandchild that `taskkill /T` would miss) is **reaped on
  kill** via the Job Object's kill-on-close. What it does **NOT** enforce: it does **not stop
  reads** (a sandboxed command can still read files, including secrets — so read approval and log
  redaction still matter), it does **not gate the network** (Low integrity does not restrict
  sockets or DNS), it lets the child write **Low-labeled** locations (its scratch `TEMP`,
  `%USERPROFILE%\AppData\LocalLow`), and **service-reparented** work (schtasks/sc/wmic/BITS) can
  leave the Job. It needs **no admin** and no special privilege.
- **Approved commands run UNSANDBOXED.** When you approve a command, you accepted the risk: it
  runs with **your full privileges** and its effects are **not snapshotted and not undoable**. The
  sandbox backs the *auto-run* decision (defense in depth for a misjudged read-only command); it
  is not applied to commands you explicitly allow.
- **Fail closed, never fake.** The mode is established by a runtime probe and reported truthfully
  in the banner, the report, and the system prompt. On any non-Windows platform, or if the probe
  fails, the mode is `none` (no enforcement) and **auto-run is disabled — every command asks**.
  Agent CLI never auto-runs a command with nothing enforcing the boundary, and never claims
  cross-platform parity it doesn't have.
- **Undo is file-only.** It reverts `write_file` / `edit_file` changes via content-addressed
  snapshots, and refuses to overwrite a file that drifted (external edit) rather than clobber it.
  It does **not** cover `run_command` side effects, out-of-workspace edits, or external changes.
- **Command output is not scrubbed.** Secret-looking *file reads* (`.env`, `*.pem`, …) are
  redacted in the event log, but `run_command` stdout is captured verbatim — a command that
  echoes a credential will record it in the log, and `agent report --json` may surface it.
- **Path checks (file tools) are TOCTOU-racy.** The workspace-boundary check validates a path at
  decision time; a junction created between check and use is not caught. It is logical policy, not
  enforcement — and it guards the typed file tools, not arbitrary shell text (which the sandbox,
  not a path model, is what confines for an auto-run command).
- **The automatic reviewer is a prompt-skip gate, not a boundary.** It is a *positive* proof of
  safety over the command string, so obfuscation (encoding, `%VAR:~%` reconstruction, glob
  invocation, alternate interpreters) lands in "ask", not "auto-run". But a string reviewer can
  never be a security boundary; the sandbox is what actually contains an auto-run command.
- **Legacy console note:** on Windows PowerShell 5.1, piping or redirecting the CLI's output (or a
  command's own output) can re-encode it through the OEM code page and mangle non-ASCII text;
  PowerShell 7+ and Windows Terminal handle UTF-8 correctly. Piped/non-TTY output uses ASCII
  status glyphs for this reason.
- **Stronger isolation** (network egress control, a read/confidentiality boundary, containers/VM,
  macOS/Linux enforcement) is future work — see `ROADMAP.md`.

State (event logs, snapshots, trust) lives **outside** the workspace at
`%USERPROFILE%\.agent-cli\` (override with `AGENT_CLI_STATE_DIR`). The startup check refuses to
run if the state dir resolves inside the workspace. An *approved* (unsandboxed) shell command can
still reach that state dir — but an *auto-run* (sandboxed) command **cannot** write it (the state
dir is Medium integrity; the Low-IL child is OS-denied).

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
