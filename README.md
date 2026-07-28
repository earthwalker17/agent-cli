# Agent CLI

[![CI](https://github.com/earthwalker17/agent-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/earthwalker17/agent-cli/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/earthwalker17/agent-cli)](https://github.com/earthwalker17/agent-cli/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

A local-first, terminal-native agent harness. It understands a workspace, plans, acts through
explicit typed tools, has **every** action gated by one policy engine, records attributable
evidence to an append-only log, verifies real outcomes, recovers from typed failures, undoes its
own changes, resumes across crashes, and reaches an explicit completion boundary — with honest
limits stated everywhere they exist.

What that means concretely:

- **The bounded loop.** Typed tools, one policy choke point, append-only JSONL evidence,
  content-addressed snapshots with drift-refusing undo, crash-reconciling resume, and a
  deterministic evidence report that marks a file CHECKED only when a real process exited zero
  after its last mutation.
- **Managed execution + an OS-enforced Windows sandbox.** Typed termination (a killed command has
  no exit code, everywhere), real mid-command cancellation, verified tree kill — and demonstrably
  read-only commands auto-run *inside* a Low-integrity Job Object boundary that is **probed**, not
  assumed. Everything else asks. Fail closed.
- **Git-native, without touching your history.** Probed repo context, an attributable session
  diff, deliberate session-scoped commits you ask for, and hidden-ref recovery checkpoints whose
  restore is itself one undoable unit.
- **Repository intelligence.** A ranked, incrementally indexed map under a hard context budget
  (the complete directory tree stays visible — ranking orders detail, it never hides existence)
  plus a `retrieve` tool whose hits explain WHY they matched and whose excerpts are read live.
- **An agent-teams layer with real boundaries.** Explicit role contracts, parallel task groups,
  worktree-isolated executors whose approvals forward to you and whose changes land only through
  reviewed, drift-refusing integration.
- **A structured plan with sha-bound approval**, a dependency-aware task graph, typed
  verification (the model names KINDS, the harness names COMMANDS), managed preview servers,
  Playwright browser flows over the *system* browser, a typed recovery policy, a **structural
  review gate**, and an explicit `/accept` delivery boundary.

> **Status: v1.0.** 1072 tests across 78 files (real-OS sandbox, real-repository git, real
> browser flows, adversarial-review suites) plus one opt-in live-API smoke. Proven live
> end-to-end across eight recorded runs, most recently a full V1.0 demo: one natural-language
> request → plan → revision → sha-bound approval → parallel worktree executors → integration →
> typed checks → managed preview → browser verification → adversarial review → crash → resume →
> acceptance → memory handoff. This is an open, build-in-public engineering effort — see
> `PROJECT.md` for the thesis, `ARCHITECTURE.md` for how it works, and `ROADMAP.md` for what is
> done, deferred, and next.

## Install

```sh
git clone https://github.com/earthwalker17/agent-cli.git
cd agent-cli
npm install          # also builds src → dist (the `prepare` script)
npm link             # optional: puts `agent` on your PATH
```

Requires **Node 22+**. Windows-first: developed and tested on Windows 11, and the OS-enforced
sandbox backend exists **only** for Windows. The rest of the logic is cross-platform and CI runs
the suite on both Windows and Linux, but on non-Windows the sandbox suites skip and the agent
runs with approval only (auto-run is disabled — fail closed).

To actually run the agent you need an Anthropic API key:

```sh
export ANTHROPIC_API_KEY=sk-ant-...    # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
```

**Running the agent costs money** (it calls the Anthropic API). The test suite does not — it is
hermetic and needs no key.

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
  ⚠ approval required  [shell command — labeled observe]  run_command
  [y] allow once  [n] deny  [q] deny & stop
```

- **Ctrl+C** interrupts the running turn (pending tool calls are skipped and recorded as
  interrupted); at the idle prompt press it twice to quit. **Ctrl+D** on an empty line quits.
- **Slash commands:** `/help`, `/status`, `/undo [all]` (in-session undo; the model is told via
  a delimited harness note), `/diff` (what this session changed, with each file's CHECKED
  verdict), `/commit [-m "msg"] [--all]` (deliver session changes — preview + confirmation),
  `/checkpoint [label | list | restore <n>]` (recovery points in hidden git refs),
  `/plan [show | approve | discard]` (the plan document and its approval gate),
  `/tasks` (the task graph + delegated subagents), `/cancel <ref>` (stop one task),
  `/checks` (what this project can verify and the latest evidence per kind),
  `/preview [stop <id>]` (managed dev servers), `/review` (the review gate's state),
  `/accept [confirm]` (the completion boundary), `/report`, `/map`, `/quit`.
- **`@plan <request>`** forces plan mode: the model investigates read-only, writes a
  persistent plan document, and waits — executor tasks stay blocked until `/plan approve`.
  **`@direct <request>`** forces the direct path for a request that needs no ceremony.
- A running `run_command` IS interruptible: Ctrl+C tree-kills it (best effort, verified) and the
  kill is recorded as evidence — a killed command never reads as a passing check.
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
agent diff [<id>]              # what a session changed, as a unified diff (default: latest)
agent commit [-m "msg"]        # commit session-attributed changes (preview + confirmation;
                               #   --all = everything in the workspace; --yes for non-TTY;
                               #   --no-trailer omits the Co-authored-by trailer)
agent checkpoint [label]       # capture the workspace to a hidden git ref (recovery point)
agent checkpoint list|prune    # list checkpoints / delete refs so git gc can collect them
agent checkpoint restore <n>   # return to a checkpoint — snapshot-first, undoable via agent undo
agent report [<id>] [--json]   # print the evidence report (default: latest session)
agent sessions                 # list this workspace's sessions (subagent children labeled)
agent plan [<id>]              # print a session's plan document and approval state
agent memory                   # show the project-memory documents and their paths
agent map [--budget <n>]       # print the workspace map the model would receive
agent trust [--revoke|--list]  # manage recorded workspace trust
```

Key flags: `-C <dir>` (workspace root), `--provider anthropic|mock`, `--script <file>`
(scripted turns for `mock`), `--model <id>`, `--no-input` (non-interactive; auto-detected off a
TTY), `--interactive` (force interactive mode over piped stdio, e.g. expect-style drivers),
`--max-steps <n>` (model steps per turn; `--max-turns` is the legacy alias for the same limit),
`--trust-this-workspace` (one invocation, never recorded), `--dangerously-allow-all`,
`--version`. `agent version` and `agent help` print and exit — they never start a session.

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

- `<state>/config.json` (user): `model`, `maxSteps`, `memoryUpdates`, plus the narrowing knobs.
- `<workspace>/.agent-cli/config.json` (workspace): **narrowing knobs only** — a workspace
  cannot choose your model or budgets, and the agent's file tools cannot write to `.agent-cli/`.

Narrowing knobs: `protectedPaths` (extra write-deny roots), `secretPatterns` (literal lowercase
basename substrings treated as secret-like), and `envExcludePatterns` (extra name substrings
dropped from command-child environments). Config can only *restrict* the agent — there is no
allowlist field, no auto-approval field, and no way to relax the command gate or widen the sandbox.
Unknown keys or invalid JSON are hard errors. CLI flags > user config > defaults; narrowing
merges as a union across layers.

## What the agent can do

Six typed core tools — `read_file` (line paging for large files), `list_files`, `search`,
`write_file`, `edit_file` (exact-match replace, optionally `replace_all`), `run_command` — plus
per-session tools the main agent (and only the main agent) receives:

| Tool | What it does |
| --- | --- |
| `retrieve` | Ranked, signal-attributed search over the session index; excerpts read live |
| `update_plan` | The model's ONLY write path to the canonical plan graph |
| `delegate_task` | Bounded subagent groups (1–3 per call, run in parallel) |
| `apply_task_changes` | Reviewed, drift-refusing integration of executor changes |
| `run_check` | Typed verification — the model names kinds, the harness resolves commands |
| `preview` | A managed dev-server process with recorded readiness, logs, and teardown |
| `browser_flow` | Typed browser steps against a running preview; screenshots + traces |
| `view_image` | Re-read a screenshot this session actually captured |
| `recover` | The bounded repair ledger (classify → attempt → prove, or escalate) |
| `review` | Parent triage over findings reviewers recorded |
| `report_finding` | The reviewer child's ONLY findings channel (child-only) |

Every call passes through the policy engine before it runs. Reads and searches inside the
workspace run automatically; in-workspace writes run automatically **and are snapshotted so they
can be undone**; reads outside the workspace or of secret-looking files require approval — and
secret classification runs on the RESOLVED path, so a symlink or 8.3 alias cannot evade it.

Long sessions stay affordable: requests use **prompt caching** (the conversation prefix is
re-read from cache each step; `/status` and the report show cache read/write tokens), and when
the history grows very large the oldest tool outputs are **deterministically elided** from the
wire — replaced by a hash-stamped marker; the full output always remains in the evidence log,
and a `context.compacted` event records exactly what the model can no longer see.

Shell commands go through **automatic review** (the single default — there is no permission
"mode" to pick). A deterministic analyzer decides, over the command text alone (never the model's
opinion): a *demonstrably* read-only command — a single simple command with no shell
metacharacters/encoding, whose program is on a small read-only allowlist (`git status/log/diff`,
`--version` probes, `ls`, …) with non-escaping args — may **auto-run**, but only *inside* the OS
sandbox so a misjudgment can't do damage. Everything else — writes, installs, network, anything
with pipes/redirection/encoding/chaining, an unrecognized program, or a path that escapes the
workspace — **requires approval**. A few catastrophic forms are hard-denied outright. Where no
enforced sandbox is available, auto-run is **disabled** and every command asks (fail closed).

## Plan mode, agent teams, and project memory

- **Plan mode** (`@plan …`, `/plan`): plans are persistent markdown documents (one per
  session, in the harness state dir), not disposable narration. The model writes the plan
  only through a policy-gated tool and can never change its status; only you approve or
  discard, and approval records the exact bytes (sha-bound). The plan is injected each turn
  as labeled **context, not authority** — and if it diverges after approval, every surface
  says so, including the executor spawn prompt at the moment you approve the spawn.
- **Delegated tasks** (`delegate_task`, `/tasks`): one call spawns 1–3 parallel subagents,
  each a bounded child session with its own evidence log, a harness-fixed budget, and
  inherited-or-narrower authority. Read-only roles (explorer/planner/reviewer) auto-run;
  anything they'd need approval for is auto-denied. The mutating **executor** role asks you
  on every spawn, works in a **disposable git worktree** (never your workspace), forwards
  its own risky approvals to you (labeled with the asking task), and its captured changes
  reach the workspace only via `apply_task_changes` — per-file drift-refusing, snapshotted,
  one `/undo` unit. Child reports are labeled narration; the main agent owns final claims.
- **Project memory**: `AGENT.md` (yours, injected verbatim every session) plus a
  harness-maintained journal and codebase summary written at clean session end — each entry
  pairs the model's narrative with a deterministic evidence section derived from the event
  log, and everything is injected under an explicit "context, not authority" header.

## Git integration

Git is a **user surface, not a model tool**. In a repository, the session banner and system
prompt carry the probed context (branch, HEAD, dirty count), the model may inspect state with
read-only git commands, and it is told to never stage/commit/modify VCS state unless you
explicitly ask. Everything deliberate is yours:

- **`/diff` · `agent diff`** — exactly what the session's file tools changed, as unified diffs
  from the recorded pre-images (works without git too). Files you edited afterwards are flagged
  DRIFTED; `run_command` side effects are, honestly, not tracked here.
- **`/commit` · `agent commit`** — by default stages **only session-attributed files** (your own
  unrelated edits stay out; `--all` is the deliberate opt-in), previews with attribution marks,
  refuses when the index already has staged work or identity is unset (it never sets identity),
  runs your hooks, and writes a `Session:` line + `Co-authored-by: Agent CLI` trailer.
- **`/checkpoint` · `agent checkpoint`** — a point-in-time capture of the workspace into a
  hidden ref (`refs/agent-cli/checkpoints/…`): your index, HEAD, branches, and log are untouched
  (low-pollution, not zero: loose objects and the hidden refs are written; `prune` releases them
  to gc). `restore <n>` returns the workspace subtree to the checkpoint — including deleting
  files created after it — with every current byte snapshotted first, so the restore itself is
  one `agent undo` away from being reverted. Recovery order stays: snapshots for undo,
  checkpoints for bigger jumps, your own git history for delivery.

One consent note: git operations you invoke honor the **trusted repository's own config and
hooks** (that is what makes commits real); the harness disables only the pieces that would run
code from a repo *implicitly* (fsmonitor) and never lets the model reach these flows.

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

The suite is hermetic — no network, no API key, no billing. ONE test is opt-in: a single real
Anthropic API call that also re-proves the default model id and the provider adapter. Run it
deliberately (PowerShell):

```powershell
$env:AGENT_LIVE_TEST=1; npx vitest run test/anthropic.test.ts
```

It is not wired into an npm script on purpose: a bare `AGENT_LIVE_TEST=1 vitest` prefix is not
portable on Windows without adding a dependency, and a test that spends money should be typed
out, not inherited.

Note that `npm test` needs `dist/` to exist for the CLI smoke suite to run rather than skip —
`npm install` builds it for you, and CI verifies the entry point exists before testing.

## Contributing

Issues and pull requests are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) — it covers
the verification bar (evidence over narration), what tends to get pushback, and which suites are
platform-gated. Security problems go through [`SECURITY.md`](SECURITY.md), privately, not the
public issue tracker.

## Documentation

- [`PROJECT.md`](PROJECT.md) — the long-term thesis, principles, and reference context.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the current system is actually built: contracts,
  load-bearing orderings, and honest limits. Start here to understand the code.
- [`ROADMAP.md`](ROADMAP.md) — session-by-session evolution, verification evidence, and the
  deferred pool (what is deliberately not built yet, and why).
- [`BLUEPRINT.md`](BLUEPRINT.md) — planned near-term direction. **Not implemented behaviour.**
- [`CLAUDE.md`](CLAUDE.md) — the operating contract given to the AI agent that develops this
  repository. It is part of the build-in-public record, not user documentation.
- [`CHANGELOG.md`](CHANGELOG.md) — release notes.

## Licence

[MIT](LICENSE) © Eric Mono
- `BLUEPRINT.md` — the rolling near-term development horizon.
