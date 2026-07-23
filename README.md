# Agent CLI

A local-first, terminal-native agent harness. V0.1 proved a **bounded local agent loop**:
the agent understands a workspace, plans, acts through explicit typed tools, has every action
gated by one policy engine, records attributable evidence to an append-only log, can undo its
file changes, resumes across runs, and produces a deterministic evidence report. V0.2 added the
**interactive REPL**, a **workspace-trust consent gate**, and **narrowing-only policy
configuration**. V0.3 added a **managed execution kernel** — real mid-command cancellation, typed
termination (a killed command has no exit code), best-effort tree kill, and command-lifecycle
evidence. V0.4 added a **genuinely OS-enforced Windows sandbox** (Low integrity + Job Object) and
**automatic command review**: demonstrably read-only commands auto-run *inside* the sandbox, and
everything else asks — a single default, fail-closed, backed by enforcement rather than the
model's opinion. V0.5 makes the harness **Git-native and context-efficient**: probed repository
context, an attributable session diff (`/diff`), deliberate session-scoped commits (`/commit`),
hidden-ref recovery checkpoints with undoable restore (`/checkpoint`), prompt caching, and
deterministic long-session history compaction — the agent itself still never touches version
control unless you explicitly ask. V0.6 added **project memory** (a user-owned `AGENT.md`
constitution plus harness-generated journal/codebase docs — always labeled context, never
authority) and the first **delegated subagent tasks**. V0.7 grew that into a minimal,
bounded **agent-teams layer**: explicit role contracts (explorer/planner/reviewer read-only;
executor mutating), parallel task groups, **plan mode** with an explicit user approval gate,
and **worktree-isolated executors** whose approvals forward to you and whose changes reach
the workspace only through reviewed, drift-refusing integration. V0.8 added **repository
intelligence**: a ranked, incrementally indexed workspace map under a hard context budget
(the complete directory tree is always visible — ranking orders detail, it never hides
existence), a **`retrieve` tool** whose ranked hits explain WHY they matched and whose line
excerpts are always read live from disk, and **non-overlapping explorer briefs** with a
structured report contract — so large codebases are explored selectively instead of scanned.

> **Status:** V0.8, **proven live end-to-end twice** — the V0.7 loop (plan → approval → two
> parallel executors → forwarded approvals → reviewed integration → undo → review panel →
> session memory) and the V0.8 large-repo run (a 3,064-file monorepo where the old flat map
> showed 0 of 14 packages and the ranked map shows all 14; two disjoint-focus explorers with
> zero overlapping reads; every load-bearing claim re-verified first-hand) — with 574 tests
> incl. real-OS sandbox, real-repository git, and adversarial-review suites. This is an open,
> build-in-public engineering effort — see `PROJECT.md` for the thesis and `ROADMAP.md` for
> what is done, deferred, and next.

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
  ⚠ approval required  [shell command — labeled observe]  run_command
  [y] allow once  [n] deny  [q] deny & stop
```

- **Ctrl+C** interrupts the running turn (pending tool calls are skipped and recorded as
  interrupted); at the idle prompt press it twice to quit. **Ctrl+D** on an empty line quits.
- **Slash commands:** `/help`, `/status`, `/undo [all]` (in-session undo; the model is told via
  a delimited harness note), `/diff` (what this session changed, as a unified diff),
  `/commit [-m "msg"] [--all]` (deliver session changes — preview + confirmation),
  `/checkpoint [label | list | restore <n>]` (recovery points in hidden git refs),
  `/plan [show | approve | discard]` (the plan document and its approval gate),
  `/tasks` (delegated subagent tasks + a children-total cost line), `/report`, `/map`, `/quit`.
- **`@plan <request>`** forces plan mode: the model investigates read-only, writes a
  persistent plan document, and waits — executor tasks stay blocked until `/plan approve`.
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

Six typed core tools: `read_file` (with line paging for large files), `list_files`, `search`,
`write_file`, `edit_file` (exact-match replace, optionally `replace_all`), `run_command` —
plus three per-session tools the main agent (and only the main agent) receives:
`delegate_task` (bounded subagent groups), `update_plan` (the model's single gated write path
to the plan document), and `apply_task_changes` (reviewed integration of executor changes).
Every call passes through the policy engine before it runs. Reads and searches inside the
workspace run automatically; in-workspace writes run automatically **and are snapshotted so they
can be undone**; reads outside the workspace or of secret-looking files require approval.

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

`AGENT_LIVE_TEST=1 npm test` additionally runs one real Anthropic API call (excluded from CI).

## Documentation

- `PROJECT.md` — long-term product thesis and principles.
- `CLAUDE.md` — the project constitution and operating rules.
- `ARCHITECTURE.md` — how the current system is built.
- `ROADMAP.md` — session-by-session evolution and next steps.
- `BLUEPRINT.md` — the rolling near-term development horizon.
