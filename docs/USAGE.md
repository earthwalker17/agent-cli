# Usage

The complete user-facing surface. The README covers the parts you need on day one; this is the
reference for everything else. `agent help` prints an abbreviated version of the same thing without
starting a session.

**Contents**

- [Interactive sessions](#interactive-sessions)
- [Commands inside a session](#commands-inside-a-session)
- [One-shot and management commands](#one-shot-and-management-commands)
- [Flags and exit codes](#flags-and-exit-codes)
- [Providers and models](#providers-and-models)
- [Workspace trust](#workspace-trust)
- [Configuration](#configuration)
- [Durable approvals](#durable-approvals)
- [What the agent can do](#what-the-agent-can-do)
- [Verification, plans and agent teams](#verification-plans-and-agent-teams)
- [Project memory](#project-memory)
- [Git](#git)
- [Remote delivery to GitHub](#remote-delivery-to-github)
- [Documents and PDFs](#documents-and-pdfs)
- [Web research](#web-research)

---

## Interactive sessions

```sh
mkdir my-project && cd my-project
agent
```

The first time you run the agent in a folder it shows a **trust prompt** — recorded consent, not a
sandbox. Then you get a prompt: type instructions in natural language, watch tool activity live,
approve or deny anything consequential inline, and keep going. One session, one evidence log.

```
agent session 20260715-101730-5d56
  workspace: C:\demo
› create a small node utility that counts words in a file
  • write_file wordstats.mjs ✓
  • run: node --test
  ⚠ approval required  [shell command — labeled observe]  run_command
  [y] allow once  [n] deny  [q] deny & stop
```

**You mostly just talk.** When a decision is genuinely required, the harness asks — inline, one
keystroke, at that moment:

```
  plan ready: build the importer and wire it into the CLI
  6 task(s), 3 isolated executor task(s) that CANNOT run until you approve.
  [y] approve   [v] show the plan first   [n] not now   (Enter = not now)
  > y
  plan approved (content sha 4f2a91c3…) — recorded as consent evidence
```

There are four such prompts: a plan awaiting its first approval, an approval invalidated by an
amendment, an open repair escalation, and a session that would accept cleanly (asked at the turn
boundary when an approved plan completes, and at your typed `/quit` for plan-less work). Each fires
at most once per state, and answering one records exactly the same evidence as typing the
equivalent command.

**They need a real terminal.** On piped stdin a prompt would consume the next scripted line, so
`--no-input` and expect-style drivers keep using the commands below.

**On a terminal, every prompt is also a menu.** Arrow keys move a highlight, Enter confirms it, and
the highlight always starts on the decline/deny row — Enter never grants anything. Typing still
works exactly as before (letters, words, `cancel`) and goes through the same parser it always did.
Approval prompts, the consent prompts above, and the `/` command menu all share the one widget;
piped runs never see a menu and keep the line grammar byte-for-byte.

### Keys

- **Ctrl+C** interrupts the running turn (pending tool calls are skipped and recorded as
  interrupted); at the idle prompt, press it twice to quit. **Ctrl+D** on an empty line quits. Both
  need a terminal — under `--interactive` over pipes there is no SIGINT channel.
- **`/` alone opens the command menu; Tab completes a typed `/name`.**
- **Ctrl+E** on an empty idle prompt reprints the last folded command output in full. Long command
  output shows its head live, then an honest fold marker and the run's final lines, with the full
  bytes kept in the session record.
- A running `run_command` **is** interruptible: Ctrl+C tree-kills it (best effort, verified) and the
  kill is recorded as evidence — a killed command never reads as a passing check.

### `@` invokes a specialist

| Sigil | What it does |
| --- | --- |
| `@plan <request>` | Investigates read-only, writes a persistent plan document, and waits. Executor tasks stay blocked until you approve. |
| `@review [focus]` | Runs the Review Agent over the current codebase (see below). |
| `@search <question>` | Forces one bounded web lookup. |
| `@research <question>` | Delegates a read-only research subagent that reads pages in its own context and returns sourced claims. |

An unknown `@word` is refused by name rather than silently sent as prose.

### The Review Agent (`@review`)

`@review [focus]` delegates an `inspector` subagent: read-only, pointed at the **current codebase**
rather than a diff, looking for bugs, regression risks, architectural problems, fragile spots and
concrete debug leads. It records typed observations — kind, severity, affected paths, the evidence
it actually inspected, the concrete failure scenario, and what to do about it — and the main agent
then drives the fixes.

It is deliberately **not** the end-of-session adversarial review gate, and the separation is
structural rather than a convention. A `reviewer` finding blocks `/accept` whether or not a review
was ever required, never expires, and every round spends one of only two. So `@review` gets its own
role writing to its own advisory channel: its observations **block nothing and consume no review
round**, which is what makes it safe to reach for at any point. They appear in
`/report inspections` under a heading that says so.

---

## Commands inside a session

**Everyday**

| Command | What it does |
| --- | --- |
| `/diff` | What this session changed, with each file's CHECKED verdict |
| `/undo [all]` | In-session undo; the model is told via a delimited harness note |
| `/report [section]` | The evidence record, sliceable: `checks`, `review`, `inspections`, `research`, `remote`, `repairs`, `previews`, `tasks`, `plan`, `completion`, … |
| `/status` | Session state, token and cache accounting, acceptance state |
| `/commit [-m "msg"] [--all] [--no-trailer]` | Commit session-attributed changes (preview + confirmation) |
| `/checkpoint [label \| list \| restore <n>]` | Recovery points in hidden git refs |
| `/expand [last \| <n> \| <call-id>]` | Reprint a folded command output in full, from the record |
| `/help` | The command surface |
| `/quit` | Or `/exit`, or Ctrl+D |

**Driving it yourself**

| Command | What it does |
| --- | --- |
| `/plan [show \| approve \| discard]` | The plan document and its approval state |
| `/accept [confirm]` | The delivery boundary |
| `/repair [dismiss <n> <reason>]` | The repair ledger. A dismissal is YOUR recorded decision — it stops blocking `/accept` but stays on the record as a caveat |
| `/provider [name [model]]`, `/model [id]` | Switch identity mid-session, with recorded evidence |
| `/grants [revoke <id>]` | Durable machine grants |
| `/init` | Interactive onboarding |

**Inspection views**

`/checks`, `/review`, `/research`, `/remote`, `/preview [stop <id>]`, `/tasks`, `/map`, and
`/cancel <ref>` — mid-turn on a TTY — to stop ONE delegated task while the rest of the turn
continues.

---

## One-shot and management commands

```sh
agent "<task>"                 # run a one-shot task in the current directory
agent run "<task>"             # the same, said explicitly — use it when the task is a single
                               #   word or looks like a command (a bare `agent status` is REFUSED
                               #   with a did-you-mean rather than becoming a billed session)
agent --continue "<task>"      # resume the latest session with a follow-up
agent resume <id> "<task>"     # resume a specific session
agent undo [--all]             # undo the last file change (or all) of a session
agent diff [<id>]              # what a session changed, as a unified diff (default: latest)
agent commit [-m "msg"]        # commit session-attributed changes (preview + confirmation;
                               #   --all = everything in the workspace; --yes for non-TTY;
                               #   --no-trailer omits the Co-authored-by trailer)
agent checkpoint [label]       # capture the workspace to a hidden git ref (recovery point)
agent checkpoint list|prune    # list checkpoints / delete refs so git gc can collect them
                               #   (prune takes --all / --yes; delivery anchors are KEPT
                               #   unless --include-delivery)
agent checkpoint restore <n>   # return to a checkpoint — snapshot-first, undoable via agent undo
agent report [<id>] [--json]   # print the evidence report (default: latest session)
agent sessions                 # list this workspace's sessions (subagent children labeled)
agent plan [<id>]              # print a session's plan document and approval state
agent memory                   # show the project-memory documents and their paths
agent init                     # points at /init (the interactive onboarding lives in the REPL)
agent grants [revoke <id>]     # list or revoke durable machine grants ("always allow" records)
agent map [--budget <n>]       # print the workspace map the model would receive
agent trust [--revoke|--list]  # manage recorded workspace trust
agent providers [--json]       # providers, models, key env vars (presence only), key sources
```

`agent --continue` with no task resumes the latest session interactively; `agent resume <id>` a
specific one.

Trust note: `agent map` and `agent diff` read workspace bytes without the trust gate (they send
nothing to a model and start no session); `agent undo` is trust-gated because it *writes*.

---

## Flags and exit codes

| Flag | Meaning |
| --- | --- |
| `-C <dir>` | Workspace root |
| `--provider <name>` | `anthropic\|openai\|deepseek\|kimi\|glm\|mock`, case-insensitive. `moonshot`→kimi and `zhipu`/`zai`/`z.ai`→glm are accepted aliases |
| `--model <id>` | Model id |
| `--script <file>` | Scripted turns, required with `--provider mock` |
| `--no-input` | Non-interactive: tool approvals auto-deny AND the command-level prompts are withheld. Auto-detected off a TTY |
| `--interactive` | Force interactive mode over piped stdio (expect-style drivers). Does **not** enable the trust prompt, which requires a real TTY |
| `--max-steps <n>` | Model steps per turn (default 60). `--max-turns` is the legacy alias; giving both conflicting values is a hard refusal |
| `--session <id>` | Targets `report`, `diff`, `plan`, `commit`, `checkpoint` and `undo` |
| `--yes` | Non-interactive confirmation for `commit`, `checkpoint prune`, `checkpoint restore`, and the large-untracked sweep |
| `--trust-this-workspace` | One invocation only, never recorded |
| `--dangerously-allow-all` | Bypasses TOOL approvals only — it never auto-approves a plan or accepts a session |
| `--version` | Print the version and exit |

`agent version`, `agent help` and `agent providers` print and exit — they never start a session.

**Exit codes:** `0` ok · `1` error · `2` a one-shot that completed with denials or hit the step
budget, and also `agent commit` when nothing was committed, `agent checkpoint prune` when cancelled
or run non-interactively without `--yes`, and `agent checkpoint restore` when the restore was not
performed (the REPL reports denials inline and exits 0 on a clean quit) · `3` workspace not
trusted · `130` a second Ctrl+C during a one-shot turn (force-quit).

**Streams:** stdout carries only model text and requested artifacts; all status chrome goes to
stderr, so `agent --interactive < script > transcript.txt` captures a clean transcript.

---

## Providers and models

One runtime, five providers, two protocols. Every adapter streams, passes cancellation through,
maps its own usage and error shapes into the harness's, and detects system proxies via the shared
transport. The `mock` provider replays a scripted-turns JSON file and needs no network — it is how
the whole loop is tested deterministically.

| Provider | Env var (first present wins) | Protocol | Default model | Where to get a key |
| --- | --- | --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | Messages API | `claude-opus-5` | platform.claude.com/settings/keys |
| `openai` | `OPENAI_API_KEY` | Responses API | `gpt-5.6-sol` | platform.openai.com/settings/organization/api-keys |
| `deepseek` | `DEEPSEEK_API_KEY` | Chat Completions | `deepseek-v4-pro` | platform.deepseek.com/api_keys (prepaid) |
| `kimi` | `MOONSHOT_API_KEY`, `KIMI_API_KEY` | Chat Completions | `kimi-k3` | platform.kimi.ai/console/api-keys |
| `glm` | `ZAI_API_KEY`, `ZHIPU_API_KEY` | Chat Completions | `glm-5.2` | z.ai (international) / open.bigmodel.cn (China) |

Base URLs default to the **international** endpoints and can be redirected per provider with
`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `DEEPSEEK_BASE_URL`, `MOONSHOT_BASE_URL` (China:
`https://api.moonshot.cn/v1`) and `ZAI_BASE_URL` (China: `https://open.bigmodel.cn/api/paas/v4`).
An active override redirects your credential to that host, so it is announced as a startup note
naming the env var, and recorded (host only) on any `/provider` switch.

**Capabilities are data, and differences are stated, not hidden.** A shipped catalog carries each
model's context and output limits, vision support, reasoning mode and replay requirement, caching
style, and lifecycle; `agent providers` and `/model` render it with the date it was last verified
against first-party documentation. Consequences you will actually see:

- **Reasoning is round-tripped opaquely.** Models whose tool loops require their own reasoning
  echoed back get it back byte-verbatim, scoped to the same provider *and* model. Reasoning from a
  different model is dropped, never forwarded.
- **No image input means honest pointers.** On a text-only model a screenshot is still captured,
  stored and recorded — the model receives `[screenshot: stored as evidence at objects/<sha> —
  model has no image input]`, and `view_image` refuses with the same explanation. Deterministic
  browser assertions, DOM checks, planning, coding, checks and recovery are untouched: only the
  visual-judgment step degrades.
- **Credentials are env-only.** `/provider` refuses key-shaped arguments; events record the env var
  *name*, the API *host*, and how the key was checked — never a value.
- **Switching is evidence.** `/provider <name> [model]` and `/model <id>` validate the key with a
  bounded model-list probe where the provider has one (a definitive 401/403 refuses the switch; a
  network failure proceeds and is recorded as unverified; GLM has no list endpoint, so it is
  presence-only and says so), then record `provider.changed`. The report names the final identity
  and lists every model that served the session.
- **Honest limits.** All five providers have been exercised live through the real tool loop, but
  only on their default models — the other catalog entries are documented, not individually
  live-tested. DeepSeek V4 models are vendor-labeled *preview*. GLM has no model-list endpoint on
  either platform, so its key check is presence-only. Retired ids are deliberately absent from the
  catalog, and invitation-only models are never advertised.

**Prompt caching** is used wherever the provider offers it (Anthropic explicit breakpoints;
automatic prefix caching on the others). `/status` and the report show cache read and write tokens;
a provider switch resets the cache and says so. When history grows very large, the oldest tool
outputs are deterministically elided from the wire and replaced by a hash-stamped marker; the full
output always remains in the evidence log, and a `context.compacted` event records exactly what the
model can no longer see. The elision budget derives from the selected model's catalog entry, so a
small-window model is never fed a large-window history.

---

## Workspace trust

Before the harness reads a single byte of a folder — its config, its `.gitignore`, the file map —
or sends anything to a model, the folder must be **trusted**: an interactive consent prompt, a
recorded grant (`agent trust`), or an explicit per-invocation flag. Trust lives in
`<state>/trust.json` with an append-only `trust.log` audit trail, outside every workspace, so
folder contents can never influence it.

**Trust is recorded consent, NOT a sandbox.** It changes what the agent is *allowed* to do, not
what a process *can technically* do. Untrusted plus non-interactive runs refuse with exit 3.

State (event logs, snapshots, trust) lives **outside** the workspace at `%USERPROFILE%\.agent-cli\`
(override with `AGENT_CLI_STATE_DIR`). The startup check refuses to run if the state directory
resolves inside the workspace.

---

## Configuration

Narrowing-only, in two layers:

- `<state>/config.json` (user): `provider`, `model`, `maxSteps`, `memoryUpdates`, plus the
  narrowing knobs.
- `<workspace>/.agent-cli/config.json` (workspace): **narrowing knobs only** — a workspace cannot
  choose your provider, model or budgets, and the agent's file tools cannot write to `.agent-cli/`.

| Knob | Effect |
| --- | --- |
| `protectedPaths` | Extra write-deny roots |
| `secretPatterns` | Literal lowercase basename substrings treated as secret-like |
| `envExcludePatterns` | Extra name substrings dropped from command-child environments |
| `remoteBlockedHosts` | Hosts remote delivery may never reach |
| `researchBlockedDomains` | Domains web research may never reach |

There is deliberately no allowed-list counterpart to the last two, because a permit list would be
widening. Config can only *restrict* the agent — there is no allowlist field, no auto-approval
field, and no way to relax the command gate or widen the sandbox. Unknown keys or invalid JSON are
hard errors. Precedence is CLI flags > user config > defaults; narrowing merges as a union across
layers.

---

## Durable approvals

Some approval prompts offer a third answer beyond "once" and "this session": `[a]` records the
decision durably, so it survives across sessions — and, for the eligible read-only capabilities,
across projects. The design is deliberately narrow:

- **Exact identity, never a pattern.** A check's `[a]` binds the exact resolved command AND the sha
  of the script body it invokes, scoped to this workspace — edit the script and it asks again. The
  other three eligible surfaces are single `(tool, class)` rules from a closed list: bounded web
  searches, research-subagent spawns, and remote READS — all read-only, all still bounded by their
  per-session budgets. The prompt prints the literal rule and its scope before anything is written.
- **Most things are not eligible, on purpose:** a push, tag or release still asks every single time;
  migrations and seeds still ask every time; executor spawns still ask every time; raw shell
  commands and secret or out-of-workspace reads can never be granted durably.
- **Inspectable, auditable, revocable.** `agent grants` lists every record with its id and scope;
  `agent grants revoke <id>` removes one; `<state>/grants.log` is the append-only audit. Every
  session that loads a durable grant says so in its evidence, so standing authority is never
  invisible. A corrupt store is a hard error, never silently rebuilt.
- **Honest edges.** A durable grant converts that ask into an allow — including in `--no-input`
  runs, which is the point: a scripted session can finally do research without a human at the
  keyboard, under the budgets. A revoke applies from the next session; `--dangerously-allow-all`
  can never create a durable grant, because it answers prompts that are never shown.

---

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
| `project_setup` | Dependency install / migrate / seed — the model names an intent, the harness resolves the command from the lockfile or the project's own script |
| `preview` | A managed dev-server process with recorded readiness, logs and teardown |
| `web_search` | Bounded web search returning source snippets with URLs — the ONE research tool the main agent holds |
| `git_status` | Read the LOCAL repository: branch/HEAD/dirtiness, what this session changed and whether a commit would be blocked, recent commits, this session's recovery points |
| `git_checkpoint` | Capture a recovery point to a hidden ref before risky work — create-only, bounded, and refuses to store secret-named files |
| `remote_status` | Read a git remote and its GitHub repo: identity, permission, ONE ref (producing the observation a publish must cite), pulls, issues, CI runs |
| `remote_push` | Publish one named branch or tag to one named remote — observation-bound, dry-run compared, verified afterwards |
| `remote_release` | A GitHub Release for a tag ALREADY on the remote (never creates the tag) |
| `browser_flow` | Typed browser steps against a running preview; screenshots and traces |
| `view_image` | Re-read an image this session recorded (browser screenshot or inspected page) |
| `read_document` | DOCX / PPTX / PDF structure, text and metadata, with an honest coverage verdict |
| `render_document` | A document spec → DOCX and/or PDF artifacts, with parse-back validation |
| `inspect_pages` | Rasterize PDF pages so the model SEES them |
| `recover` | The bounded repair ledger (classify → attempt → prove, or escalate) |
| `review` | Parent triage over findings reviewers recorded |
| `report_finding` | The reviewer child's ONLY findings channel (child-only) |

### Multi-project workspaces

**A workspace may hold several projects — across ecosystems.** Agent CLI discovers each one
(declared npm/pnpm workspaces, root `Cargo.toml` `[workspace] members`, `go.work` `use` directives,
any depth-1 directory with a manifest — `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`,
`CMakeLists.txt` — and the children of `apps`/`packages`/`services`), and `run_check`, `preview`
and `project_setup` each take a `project`. Commands run in that project's own directory and the
evidence records which project it was, so a green test in `web/` is never mistaken for evidence
about `api/` — including in plan gates, which can require a kind to pass in *each* named project.
When several projects exist and a call names none, the harness **refuses rather than guessing**.

### Toolchains

**Toolchain availability is a fact, not an assumption.** Detection probes cargo, rustc and go on
PATH and rustup components and targets on disk (stat-only, never spawning); a missing toolchain
resolves the check to an explicit `toolchain-unavailable` with the exact cure (`install via
rustup`, `rustup target add thumbv7em-none-eabihf`) *before anything is put in front of you for
approval*, and installing a toolchain mid-session is noticed by the same drift guard that notices
an edited manifest. A declared gate waived this way appears in the acceptance as a LOUD caveat
naming the missing toolchain — never a quiet "unsupported". Cargo and Go have no separate install
step, and `project_setup` says so instead of pretending otherwise.

Node/TS, Python, **Rust/Cargo and Go modules** are first-class: unit discovery, symbols and import
graphs, typed check recipes (`cargo build/test/check/clippy/fmt`, `go build/test/vet` with
path-scoped targeted tests), and compiler-aware failure classification. C/C++ (CMake) is detected
and indexed with checks honestly unsupported.

### Dependencies, migrations and seeds

These go through `project_setup`, never a raw shell command. You name an intent; the harness
resolves the command from the lockfile (`npm ci`, `pnpm install --frozen-lockfile`, yarn v1 vs
Berry — and it refuses to guess when the project declares neither) or from the project's own
declared script. An install asks for approval showing the exact command, the directory, and the
lockfile it is pinned to, and states plainly that it downloads and **executes** third-party package
code with network access. A session-scope answer covers re-runs only while the lockfile,
`package.json` and every install-affecting config file (`.npmrc`, `.yarnrc.yml`, `.pnpmfile.cjs`)
are unchanged. Migrations and seeds are classified destructive and ask **every** time, because a
migration is not idempotent and the harness cannot undo it. A setup is never verification: it can
never satisfy a plan gate.

### The command gate

Shell commands go through **automatic review** — the single default; there is no permission "mode"
to pick. A deterministic analyzer decides over the command text alone (never the model's opinion):
a *demonstrably* read-only command — a single simple command with no shell metacharacters or
encoding, whose program is on a small read-only allowlist (`git status/log/diff`, `--version`
probes, `ls`, …) with non-escaping args — may **auto-run**, but only *inside* the OS sandbox so a
misjudgment cannot do damage. Everything else — writes, installs, network, anything with pipes,
redirection, encoding or chaining, an unrecognized program, or a path that escapes the workspace —
**requires approval**. A few catastrophic forms are hard-denied outright. Where no enforced sandbox
is available, auto-run is **disabled** and every command asks.

Reads and searches inside the workspace run automatically; in-workspace writes run automatically
**and are snapshotted so they can be undone**; reads outside the workspace or of secret-looking
files require approval — and secret classification runs on the RESOLVED path, so a symlink or 8.3
alias cannot evade it.

---

## Verification, plans and agent teams

- **Plan mode** (`@plan …`, `/plan`, and the approval prompt): the plan is a structured JSON
  document — one per session, in the harness state directory — with a generated markdown view
  beside it, not disposable narration. The model writes it only through a policy-gated tool and can
  never change its status; only you approve or discard, and approval binds the exact **content
  sha**, so a status flip does not invalidate it but a semantic change does. The plan is injected
  each turn as labeled **context, not authority** — and if it diverges after approval, every
  surface says so, including the executor spawn prompt at the moment you approve the spawn. Edit
  the `.plan.json`; the `.md` next to it is a generated view.
- **Delegated tasks** (`delegate_task`, `/tasks`): one call spawns 1–3 parallel subagents, each a
  bounded child session with its own evidence log, a harness-fixed budget, and inherited-or-narrower
  authority. Read-only roles (explorer, planner, reviewer, inspector) auto-run; anything they would
  need approval for is auto-denied. The mutating **executor** role asks you on every spawn, works in
  a **disposable git worktree** (never your workspace), forwards its own risky approvals to you
  (labeled with the asking task), and its captured changes reach the workspace only via
  `apply_task_changes` — per-file drift-refusing, snapshotted, one `/undo` unit. Child reports are
  labeled narration; the main agent owns final claims.

---

## Project memory

Six bounded documents, every cap a pinned contract:

| Document | Owner | Injected |
| --- | --- | --- |
| Global `AGENT.md` (machine-wide) | You — created by `/init`, hand-edited after | Every session, first; the project `AGENT.md` overrides it on conflict |
| Project `AGENT.md` | You | Every session, verbatim — and into every subagent |
| `JOURNAL.md` | Harness + model | Rolling session entries: model narrative plus a deterministic evidence section derived from the event log |
| `CODEBASE.md` | Model body, harness stamps | Architecture summary, staleness-stamped |
| `LESSONS.md` | Model proposes ≤3/session, harness merges | Durable pitfalls and failure patterns, merged by slug with provenance stamped, your edits preserved |
| `RESEARCH.md` | Harness (deterministic fold) | Source-backed findings with retrieval dates — deliberately perishable: entries age out after ~30 days, because a stale research note is exactly the overconfidence web research exists to prevent |

The four harness-managed documents are written at clean session end. Generated docs are injected
under an explicit "context, not authority" header; the worst-case total injection is one tested
ceiling.

---

## Git

Git has **two halves, split by whether you can see the result in your own git state.**

The model gets the half that changes nothing you can see — reading, and recovery points:

- **`git_status`** — the repository as structured state: `summary` (branch, HEAD, upstream, how
  dirty the tree is, read live), `changes` (every uncommitted path in the workspace subtree, which
  ones *this session* changed, churn counts, and whether a commit would be blocked — built by the
  same function that builds your `/commit` preview, so the two cannot drift), `log`, and
  `checkpoints`. It takes a view name and a number and nothing else — no ref, path, author or
  format argument — which is what lets it run without asking you: the model names a VIEW, the
  harness names the command. It returns no file contents.
- **`git_checkpoint`** — a recovery point before risky work, taken without interrupting you. It
  writes a commit object plus one hidden ref under `refs/agent-cli/checkpoints/`: on no branch,
  with your index, HEAD, branches and tags untouched (`git log --all` does show it). Bounded at 12
  per session, reclaimed at clean session end, and it **refuses** to capture secret-named files
  your `.gitignore` does not already exclude — a git blob cannot be redacted.

The other half is yours, and the model has no unilateral path to any of it. It is told plainly that
it cannot commit on its own initiative and that committing is your decision; the only route to a
git mutation is a `run_command` you approve per call.

- **`/commit` is offered as a choice at the acceptance boundary** — when a session finishes with
  changes it can attribute to itself, the completion prompt's keys include *commit the N file(s)
  this session changed, then accept*. It runs the same preview and confirmation `/commit` runs.
- **`/diff` · `agent diff`** — exactly what the session's file tools changed, as unified diffs from
  the recorded pre-images (works without git too). Files you edited afterwards are flagged DRIFTED;
  `run_command` side effects are, honestly, not tracked here.
- **`/commit` · `agent commit`** — by default stages **only session-attributed files** (your own
  unrelated edits stay out; `--all` is the deliberate opt-in), previews with attribution marks,
  refuses when the index already has staged work or identity is unset (it never sets identity), runs
  your hooks, and writes a `Session:` line plus a `Co-authored-by: Agent CLI` trailer.
- **`/checkpoint` · `agent checkpoint`** — a point-in-time capture of the workspace into a hidden
  ref: your index, HEAD, branches, and log are untouched (low-pollution, not zero: loose objects and
  the hidden refs are written; `prune` releases them to gc). `restore <n>` returns the workspace
  subtree to the checkpoint — including deleting files created after it — with every current byte
  snapshotted first, so the restore itself is one `agent undo` away from being reverted.

Recovery order stays: snapshots for undo, checkpoints for bigger jumps, your own git history for
delivery.

One consent note: git operations you invoke honor the **trusted repository's own config and hooks**
(that is what makes commits real); the harness disables only the pieces that would run code from a
repo *implicitly* (fsmonitor).

---

## Remote delivery to GitHub

The model *can* reach the remote — under two separate authorities that no amount of arguing merges
into one. They are two policy facts, so a tool that could both read a remote and change one is
refused by construction rather than by convention.

**Reading** (`remote_status`) asks once and is session-grantable within a fixed allowance:

```
⚠ approval required  [remote READ — contacts the remote under your existing credential; nothing here is written]  remote_status
  command: git ls-remote --exit-code origin refs/heads/session-20
  reason: reads refs from github.com/you/repo via remote 'origin' using the credential gh/git already
          holds — Agent CLI never reads the token. …
  [y] allow once   [s] allow further remote READS this session (never a push, tag or release)   [n] deny
```

**Publishing** (`remote_push`, `remote_release`) asks **every single time**, and there is no `[s]`
to press:

```
⚠ approval required  [remote WRITE — changes state on the remote; NOT undoable from here]  remote_push
    exact target: refs/heads/session-20
    command: git push --porcelain --no-follow-tags origin 9f3c1ab…:refs/heads/session-20
    effect: CREATE origin:refs/heads/session-20 at 9f3c1ab (4 commit(s) in the branch)
    effect: commits: 9f3c1ab feat(remote): … | 7a1e0c2 test(remote): …
    observed 12s ago (id 16164a9ec49e): remote held (absent)
    local verification: checks since the last change: build pass, test pass · 3 commit(s) this session
  reason: PUBLISHES to … nothing in this harness can undo it. … Local verification state: … — stated
          for your judgement, NOT as authorization.
  [y] allow once   [n] deny   [q] deny & stop
```

What makes that prompt trustworthy:

- **A publish must cite a fresh observation** of that exact remote and ref, produced by
  `remote_status view=refs`. Absent or stale is a refusal, not a question — the harness will not
  reason about a remote from memory.
- **Looking never writes.** The only network verb is `git ls-remote`: no fetch, no remote-tracking
  refs, no `FETCH_HEAD`. The cost is stated honestly — a commit the remote holds and you have never
  fetched makes the relation `unknown`, and a force push over it is refused *even with `force`*,
  because nothing here can tell you what would be discarded.
- **What you approve is what executes.** The refspec source is the observed commit, not a branch
  name; before sending, the harness re-resolves the push URL and re-reads both sides, runs
  `git push --dry-run --porcelain` and checks it structurally (exactly one ref, the approved one,
  from the approved commit); afterwards it re-reads the remote and records `verified` separately
  from `ok`. A force push carries `--force-with-lease=<ref>:<observed-oid>` so the server enforces
  the same binding.
- **Agent CLI never holds your credential.** Authentication is gh's own store and git's credential
  helper; `GH_TOKEN`/`GITHUB_TOKEN` are deliberately not forwarded to child processes (and that is
  reported, not silently worked around). All gh and git output is scrubbed of credential shapes
  before it reaches the model, the terminal or the log.
- **Local completion is never permission to publish**, and a green gate is never a precondition
  either — it is shown in the prompt and enforces nothing. Since the model still cannot commit, it
  can only ever publish work you committed.

`/remote` is the record: the configured remotes, which account would act, live observations, every
read, and every mutation with its verification verdict — including the ones that failed.

Out of scope by decision: `gh api` passthrough, PR and issue creation, merges, repository creation
or deletion, settings, secrets, workflow dispatch, and `git fetch`/`pull`.

---

## Documents and PDFs

The same kernel produces polished documents. Nothing about it is a second agent loop: the model
authors a **document spec as an ordinary workspace JSON file** (`*.docspec.json` — headings,
paragraphs, lists, tables, images, code, quotes, page setup, header/footer with `{pageNumber}` /
`{totalPages}` / `{date}` / `{title}` tokens, bounded style themes), and the harness renders it
deterministically:

```
request → read sources → spec file → render → deterministic validation → SEE the pages → revise the SPEC → re-render
```

- **`read_document`** identifies DOCX / PPTX / PDF (and XLSX, names only) by **magic bytes, never
  the extension**, and returns outline, text, table shapes, slide order, page text, media inventory
  and metadata — always with a **coverage verdict** (`full` / `partial` / `structural`) and the
  reasons, so "we read it" can never quietly mean three different depths. A file that is not what
  it claims is refused *without echoing a byte of it*.
- **`render_document`** produces a **byte-deterministic DOCX** (hand-rolled OOXML: real named
  styles, one numbering instance per list, PAGE/NUMPAGES/DATE field codes, embedded PNG/JPEG, fixed
  timestamps — same spec in, same sha out) and a **PDF printed through the system browser**, then
  **parses each artifact back** and reports what it found: outline equality, table shapes, dangling
  relationships, header/footer fields, page count, headings findable in the printed text.
  Structural mismatches are failures; layout observations are notes and never block.
- **`inspect_pages`** rasterizes pages so a vision model can judge the real thing — page breaks,
  clipping, cramped tables, whitespace, balance — and each page image is stored as session evidence
  you can re-view.

Revision is **the spec, not the artifact**: edit the spec file (an ordinary snapshotted write, so
`/undo` and the session diff work as always) and re-render. Artifacts are **products, never
verification** — a render never marks a file CHECKED and never satisfies a plan gate.

Honest limits: **DOCX visual fidelity is Word's**, so DOCX claims here are structural and parse-back
verified while the *visual* check happens on the PDF twin rendered from the same spec. Without a
system browser the DOCX still renders and the PDF is skipped with a recorded reason; without image
input on the selected model, inspection refuses and says the deterministic validation is what
remains. PDF bytes are not claimed deterministic (Chromium embeds dates and ids); DOCX bytes are.
Editing pre-existing DOCX files, PPTX generation, footnotes, TOC fields, tracked changes, cell
merges, and RTL/complex-script fidelity are **out of scope** — not partially supported.

---

## Web research

An agent working from recall writes code against APIs that have moved, and is confident about it.
Agent CLI can go and check — as an explicit, budgeted, read-only capability.

Two shapes, matched to size:

- **`@search <question>`** — one bounded lookup. Returns ranked source snippets with URLs.
- **`@research <question>`** — delegates a **researcher subagent**: read-only in your workspace,
  external on the network, and holding *no tool that writes, runs, or delegates*. It searches, reads
  the pages that matter **in its own context**, corroborates, and hands back short claims with their
  sources. The raw pages never enter your conversation.

The agent also reaches for either on its own when a request clearly needs current information.

```
⚠ approval required  [web research — queries LEAVE THIS MACHINE; read-only, nothing here is written]  web_search
  web_search: "zod v4 json schema helper" → api.tavily.com
    query (sent verbatim): zod v4 json schema helper
    max results: 5
    provider: api.tavily.com (the only research destination; a configured proxy still carries the connection)
    bounds: ≤12000 retrieved chars · 20000 ms · ~1 credit(s)
    session budget remaining: 35 search(es), 20 extract(s), 119 credit(s)
  [y] allow once   [s] allow further research this session, within the session budget   [n] deny
```

**What bounds it.** One session allowance — 36 searches, 20 extracts, 120 provider credits, 1.2M
retrieved characters — shared by the main agent and every researcher, and **rebuilt from the event
log on resume** so restarting cannot refill it. The prompt shows the query verbatim before anything
is sent, and `[s]` is bounded by that budget rather than by the session.

**What it will not do.** Non-http(s) schemes, URLs with embedded credentials, loopback, private and
link-local hosts, and bare IP addresses are refused outright. `researchBlockedDomains` in either
config layer is absolute — a model-chosen domain list can never override it. And **research never
verifies anything**: it does not mark a file CHECKED and cannot satisfy a plan gate. A session
accepted as complete after consulting the web says so, and says which findings rested on a single
source or on sources that disagreed.

**Retrieved content is untrusted.** It is neutralized on the way in and rendered inside an explicit
UNTRUSTED fence telling the model it is data, never instructions. That is a *mitigation, not a
boundary* — a persuasive page can still influence a model. What it cannot do is act: a researcher
has nothing to act with.

`/research` shows every query this session sent, which hosts answered, the findings with their
sources and retrieval dates, and what is left of the budget.

Setup: `export TAVILY_API_KEY=tvly-…` ([get a key](https://app.tavily.com)). Env-only, like every
other credential here. Without it the research tools are simply not registered and the model is
never told about them.
