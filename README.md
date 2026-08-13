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
- **Polyglot repository intelligence.** Node/TS, Python, **Rust/Cargo and Go modules** are
  first-class: unit discovery (cargo workspace members, `go.work`), symbols and import graphs,
  typed check recipes (`cargo build/test/check/clippy/fmt`, `go build/test/vet` with path-scoped
  targeted tests), and compiler-aware failure classification. C/C++ (CMake) is detected and
  indexed with checks honestly unsupported. A **missing toolchain is a first-class answer**:
  stat-only probing produces explicit `toolchain-unavailable` states naming the exact install
  cure — never a runnable-looking recipe — and cross-target embedded crates split honestly into
  host-verifiable checks and a named refusal for what needs hardware.
- **A documents workflow on the same kernel.** DOCX/PPTX/PDF reading with an honest coverage
  verdict, a structured spec authored as an ordinary workspace file, byte-deterministic DOCX and
  browser-printed PDF output, **parse-back validation of every artifact**, and page rasterization
  so a vision model judges the real pages — revision means editing the spec and re-rendering, and
  an artifact is a product that never counts as verification.
- **Source-backed web research.** An explicit, budgeted, read-only path to the public web: one
  bounded lookup for a narrow fact, or a **researcher subagent** that reads pages in its own
  context and returns short claims with their sources, so raw pages never enter your conversation.
  One session allowance shared by every researcher and rebuilt from the event log on resume, the
  query shown verbatim before it is sent, retrieved content fenced as untrusted data — and research
  that **never counts as verification**.
- **Deliberate remote delivery to GitHub.** Reading a remote and changing one are **two different
  authorities**, enforced as two separate policy facts: reads ask once and are session-grantable
  within a fixed allowance, while a push, a tag or a release asks **every single time**, with the
  exact destination and a machine-computed effect on screen and no session-wide "yes" available at
  all. A publish must be bound to a fresh `ls-remote` observation of that exact ref — the harness
  refuses to reason about a remote from memory — and the object that reaches the remote is the
  object you read in the prompt, re-checked immediately before sending and verified against the
  remote afterwards. Local completion is **never** permission to publish, and because the model
  still cannot commit, it can only ever publish work a human committed.
- **Five model providers behind one runtime.** Anthropic, OpenAI, DeepSeek, Kimi (Moonshot) and
  GLM (Z.AI/Zhipu) through two genuinely different protocols, with a shipped **capability
  catalog** so differences degrade honestly instead of hiding behind a false
  lowest-common-denominator: `/provider` and `/model` switch mid-session with recorded evidence,
  credentials stay env-only, and a model without image input gets honest screenshot *pointers*
  rather than silently dropped pixels.

> **Status: v1.9.0.** 2,307 hermetic tests across 145 files (real-OS sandbox,
> real-repository git, **a local bare repo standing in as a real remote**, real browser flows, real
> PDF print + rasterization, hermetic HTTP wire pins, adversarial-review suites) plus opt-in live
> smokes. Newest live proof (S21.6, validated **29/29** from
> persisted evidence alone): the model read the repository through `git_status` three times with
> **zero approvals spent on the git tools all session**, every call recorded on its own policy
> branch rather than the observe fall-through; a recovery capture **refused by name** because a
> non-gitignored `.env` would have been hashed into the object database; the model, told
> explicitly to `git commit -am wip`, reached the approval prompt and the scripted human **denied
> it** — no commit process ever started; the named cure worked and a real recovery point landed;
> and the commit that did happen came from the user answering *commit the 1 file(s) this session
> changed, then accept* at the completion prompt. At quit the agent's ref was pruned, the delivery
> anchor survived, and the credential appeared **neither in the session log nor in any git object**
> (`agent-cli-s216-live/DEMO.md`). Before it: the **contextual consent** surface, live — an
> approval prompt firing on a real model-authored plan with `/plan approve` never typed, and
> `@review` finding a seeded defect while consuming zero adversarial rounds
> (`agent-cli-s215-live/DEMO.md`); a **fresh machine state** onboarded with `/init`, a durable
> "always allow" grant minted with one keystroke and **consumed by an unattended `--no-input`
> run**, then revoked and honestly denied (S21, 31/31); and **an empty folder to a real GitHub
> release in one continuous session** — 1,006 events, three lives across two terminal deaths,
> source-backed research, three parallel worktree executors, two real test failures found and
> fixed live, five passing browser flows, a DOCX/PDF overview whose visual defect the model saw
> and corrected in its own pages, and a publish whose first release attempt policy **denied** for
> citing a stale observation (S20.5, 62/62). Earlier proofs cover polyglot verification three
> ways, web research as a controlled experiment with and without the credential, the full
> multi-project workflow in one 84-minute session (38/38), and all five providers exercised live
> through the real bounded tool loop. No credential appears anywhere in the evidence. This is an
> open, build-in-public engineering effort — see `PROJECT.md` for the thesis, `ARCHITECTURE.md`
> for how it works, and `ROADMAP.md` for what is done, deferred, and next.

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

To actually run the agent you need an API key for at least one provider. Credentials are read
**only** from the environment — never from a config file, a CLI flag, or a slash command, so they
cannot end up in a log, a report, or an event:

```sh
export ANTHROPIC_API_KEY=sk-ant-...    # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
```

`agent providers` lists every provider, which env var it needs, whether that var is set, and
where to get a key — without touching the network. See **Providers and models** below.

**Running the agent costs money** (it calls a model API). The test suite does not — it is
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

**You mostly just talk.** When a decision is genuinely required, the harness asks — inline, one
keystroke, at that moment:

```
  plan ready: build the importer and wire it into the CLI
  6 task(s), 3 isolated executor task(s) that CANNOT run until you approve.
  [y] approve   [v] show the plan first   [n] not now   (Enter = not now)
  > y
  plan approved (content sha 4f2a91c3…) — recorded as consent evidence
```

There are four such prompts — a plan awaiting its first approval, an approval invalidated by an
amendment, an open repair escalation, and a session that would accept cleanly. Each fires at most
once per state, and answering one records exactly the same evidence as typing the equivalent
command. **They need a real terminal**: on piped stdin a prompt would consume the next scripted
line, so `--no-input` and expect-style drivers keep using the commands below.

- **Ctrl+C** interrupts the running turn (pending tool calls are skipped and recorded as
  interrupted); at the idle prompt press it twice to quit. **Ctrl+D** on an empty line quits.
  Both need a terminal — under `--interactive` over pipes there is no SIGINT channel.
- **`@` invokes a specialist:** **`@plan <request>`** investigates read-only, writes a persistent
  plan document and waits — executor tasks stay blocked until you approve.
  **`@review [focus]`** runs the Review Agent over the current codebase (see below).
  **`@search <question>`** forces one bounded web lookup; **`@research <question>`** delegates a
  read-only research subagent that reads pages in its own context and returns sourced claims.
  An unknown `@word` is refused by name rather than silently sent as prose.
- **Everyday commands:** `/diff` (what this session changed, with each file's CHECKED verdict),
  `/undo [all]` (in-session undo; the model is told via a delimited harness note),
  `/report [section]` (the evidence record, sliceable: `checks`, `review`, `inspections`,
  `research`, `remote`, `repairs`, `previews`, `tasks`, `plan`, `completion`, …), `/status`,
  `/commit [-m "msg"] [--all] [--no-trailer]` (preview + confirmation),
  `/checkpoint [label | list | restore <n>]` (recovery points in hidden git refs), `/help`,
  `/quit` (or `/exit`, or Ctrl+D).
- **Driving it yourself:** `/plan [show | approve | discard]`, `/accept [confirm]`,
  `/repair [dismiss <n> <reason>]` (a dismissal is YOUR recorded decision — it stops blocking
  `/accept` but stays on the record as a caveat), `/provider [name [model]]` and `/model [id]`,
  `/grants [revoke <id>]`, `/init`.
- **Inspection views:** `/checks`, `/review`, `/research`, `/remote`, `/preview [stop <id>]`,
  `/tasks`, `/map`, and `/cancel <ref>` — mid-turn on a TTY — to stop ONE delegated task while the
  rest of the turn continues.

### The Review Agent (`@review`)

`@review [focus]` delegates an `inspector` subagent: read-only, pointed at the **current
codebase** rather than a diff, looking for bugs, regression risks, architectural problems, fragile
spots and concrete debug leads. It records typed observations — kind, severity, affected paths,
the evidence it actually inspected, the concrete failure scenario, and what you should do about it
— and the main agent then drives the fixes.

It is deliberately **not** the end-of-session adversarial review gate, and the separation is
structural rather than a convention. A `reviewer` finding blocks `/accept` whether or not a review
was ever required, never expires, and every round spends one of only two. So `@review` gets its
own role writing to its own advisory channel: its observations **block nothing and consume no
review round**, which is what makes it safe to reach for at any point. They appear in
`/report inspections` under a heading that says so.
- A running `run_command` IS interruptible: Ctrl+C tree-kills it (best effort, verified) and the
  kill is recorded as evidence — a killed command never reads as a passing check.
- stdout carries only model text and requested artifacts; all status chrome goes to stderr, so
  `agent --interactive < script > transcript.txt` captures a clean transcript.
- `agent --continue` (no task) resumes the latest session interactively; `agent resume <id>`
  a specific one.

## One-shot use

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

Key flags: `-C <dir>` (workspace root), `--provider anthropic|openai|deepseek|kimi|glm|mock`
(case-insensitive; `moonshot`→kimi and `zhipu`/`zai`/`z.ai`→glm are accepted aliases),
`--script <file>` (scripted turns for `mock`), `--model <id>`, `--no-input` (non-interactive:
tool approvals auto-deny AND the command-level prompts are withheld; auto-detected off a TTY),
`--interactive` (force interactive mode over piped stdio, e.g. expect-style drivers — note this
does NOT enable the trust prompt, which requires a real TTY), `--max-steps <n>` (model steps per
turn; `--max-turns` is the legacy alias, and giving both conflicting values is a hard refusal),
`--session <id>` (targets `report`, `diff`, `plan`, `commit`, `checkpoint` and `undo`),
`--yes` (non-interactive confirmation for `commit`, `checkpoint prune`, `checkpoint restore`, and
the large-untracked sweep), `--trust-this-workspace` (one invocation, never recorded),
`--dangerously-allow-all` (bypasses TOOL approvals only — it never auto-approves a plan or accepts
a session), `--version`. `agent version`, `agent help` and `agent providers` print and exit — they
never start a session.

Exit codes: `0` ok · `1` error · `2` a one-shot that completed with denials or hit the step budget,
and also `agent commit` when nothing was committed, `agent checkpoint prune` when cancelled or run
non-interactively without `--yes`, and `agent checkpoint restore` when the restore was not
performed (the REPL reports denials inline and exits 0 on a clean quit) · `3` workspace not trusted
· `130` a second Ctrl+C during a one-shot turn (force-quit).

Trust note: `agent map` and `agent diff` read workspace bytes without the trust gate (they send
nothing to a model and start no session); `agent undo` is trust-gated because it *writes*.

## Providers and models

One runtime, five providers, two protocols. Every adapter streams, passes cancellation through,
maps its own usage/error shapes into the harness's, and detects system proxies (`HTTPS_PROXY`
etc.) via the shared transport. The `mock` provider replays a scripted-turns JSON file and needs
no network — it is how the whole loop is tested deterministically.

| provider | env var (first present wins) | protocol | default model | where to get a key |
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
model's context/output limits, vision support, reasoning mode and replay requirement, caching
style, and lifecycle; `agent providers` and `/model` render it with the date it was last verified
against first-party documentation. Consequences you will actually see:

- **Reasoning is round-tripped opaquely.** Models whose tool loops require their own reasoning
  echoed back (Kimi K3, DeepSeek thinking mode, OpenAI reasoning items under `store:false`,
  Anthropic thinking blocks) get it back byte-verbatim, scoped to the same provider *and* model.
  Reasoning from a different model is dropped, never forwarded.
- **No image input ⇒ honest pointers.** On a text-only model (DeepSeek, GLM text tiers) a
  screenshot is still captured, stored, and recorded — the model receives
  `[screenshot: stored as evidence at objects/<sha> — model has no image input]`, and `view_image`
  refuses with the same explanation. Deterministic browser assertions, DOM checks, planning,
  coding, checks and recovery are untouched: only the visual-judgment step degrades.
- **Credentials are env-only.** `/provider` refuses key-shaped arguments; events record the env
  var *name*, the API *host*, and how the key was checked — never a value.
- **Switching is evidence.** `/provider <name> [model]` and `/model <id>` validate the key with a
  bounded model-list probe where the provider has one (a definitive 401/403 refuses the switch; a
  network failure proceeds and is recorded as unverified; GLM has no list endpoint, so it is
  presence-only and says so), then record `provider.changed`. The report names the final identity
  and lists every model that served the session.
- **Honest limits.** All five providers have been exercised live through the real tool loop, but
  only on their default models — the other catalog entries are documented, not individually
  live-tested. DeepSeek V4 models are vendor-labeled *preview* by DeepSeek. GLM has no model-list
  endpoint on either platform, so its key check is presence-only and says so. Retired ids
  (`deepseek-chat`, `deepseek-reasoner`, `kimi-k2-*` previews, `kimi-latest`, `glm-4.5-flash`) are
  deliberately absent from the catalog, and invitation-only models are never advertised.

## Durable approvals ("always allow on this machine")

Some approval prompts offer a third answer beyond "once" and "this session": `[a]` records the
decision durably, so it survives across sessions — and, for the eligible read-only capabilities,
across projects. The design is deliberately narrow:

- **Exact identity, never a pattern.** A check's `[a]` binds the exact resolved command AND the
  sha of the script body it invokes, scoped to this workspace — edit the script and it asks
  again. The other three eligible surfaces are single `(tool, class)` rules from a closed list:
  bounded web searches, research-subagent spawns, and remote READS — all read-only, all still
  bounded by their per-session budgets. The prompt prints the literal rule and its scope before
  anything is written.
- **Most things are not eligible, on purpose**: a push/tag/release still asks every single time,
  migrations and seeds still ask every time, executor spawns still ask every time, raw shell
  commands and secret/out-of-workspace reads can never be granted durably.
- **Inspectable, auditable, revocable**: `agent grants` lists every record with its id and scope;
  `agent grants revoke <id>` removes one; `<state>/grants.log` is the append-only audit. Every
  session that loads a durable grant says so in its evidence (`grants.loaded`), so standing
  authority is never invisible. A corrupt store is a hard error, never silently rebuilt.
- **Honest edges**: a durable grant converts that ask into an allow — including in `--no-input`
  runs, which is the point (a scripted session can finally do research without a human at the
  keyboard, under the budgets). A revoke applies from the next session; `--dangerously-allow-all`
  can never create a durable grant (it answers prompts that are never shown).

## Workspace trust

Before the harness reads a single byte of a folder (its config, its `.gitignore`, the file map)
or sends anything to a model, the folder must be **trusted**: an interactive consent prompt, a
recorded grant (`agent trust`), or an explicit per-invocation flag. Trust lives in
`<state>/trust.json` with an append-only `trust.log` audit trail, outside every workspace, so
folder contents can never influence it.

**Trust is recorded consent, NOT a sandbox.** It changes what the agent is *allowed* to do,
not what a process *can technically* do. Untrusted + non-interactive runs refuse with exit 3.

## Configuration (narrowing-only)

- `<state>/config.json` (user): `provider`, `model`, `maxSteps`, `memoryUpdates`, plus the
  narrowing knobs.
- `<workspace>/.agent-cli/config.json` (workspace): **narrowing knobs only** — a workspace
  cannot choose your provider, model or budgets, and the agent's file tools cannot write to
  `.agent-cli/`.

Narrowing knobs: `protectedPaths` (extra write-deny roots), `secretPatterns` (literal lowercase
basename substrings treated as secret-like), `envExcludePatterns` (extra name substrings dropped
from command-child environments), and `remoteBlockedHosts` / `researchBlockedDomains` (hosts remote delivery and domains web research may never
reach — with no allowed-domains counterpart, because a permit list would be widening). Config can only *restrict* the agent — there is no
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
| `project_setup` | Dependency install / migrate / seed — the model names an intent, the harness resolves the command from the lockfile or the project's own script |
| `preview` | A managed dev-server process with recorded readiness, logs, and teardown |
| `web_search` | Bounded web search returning source snippets with URLs — the ONE research tool the main agent holds |
| `git_status` | Read the LOCAL repository: branch/HEAD/dirtiness, what this session changed and whether a commit would be blocked, recent commits, this session's recovery points |
| `git_checkpoint` | Capture a recovery point to a hidden ref before risky work — create-only, bounded, and refuses to store secret-named files |
| `remote_status` | Read a git remote / its GitHub repo: identity, permission, ONE ref (producing the observation a publish must cite), pulls, issues, CI runs |
| `remote_push` | Publish one named branch or tag to one named remote — observation-bound, dry-run compared, verified afterwards |
| `remote_release` | A GitHub Release for a tag ALREADY on the remote (never creates the tag) |
| `browser_flow` | Typed browser steps against a running preview; screenshots + traces |
| `view_image` | Re-read an image this session recorded (browser screenshot or inspected page) |
| `read_document` | DOCX / PPTX / PDF structure, text and metadata, with an honest coverage verdict |
| `render_document` | A document spec → DOCX and/or PDF artifacts, with parse-back validation |
| `inspect_pages` | Rasterize PDF pages so the model SEES them |
| `recover` | The bounded repair ledger (classify → attempt → prove, or escalate) |
| `review` | Parent triage over findings reviewers recorded |
| `report_finding` | The reviewer child's ONLY findings channel (child-only) |

**A workspace may hold several projects — across ecosystems.** Agent CLI discovers each one
(declared npm/pnpm workspaces, root `Cargo.toml` `[workspace] members`, `go.work` `use`
directives, any depth-1 directory with a manifest — `package.json`, `pyproject.toml`,
`Cargo.toml`, `go.mod`, `CMakeLists.txt` — and the children of `apps`/`packages`/`services`),
and `run_check`, `preview` and `project_setup` each take a `project`. Commands run in that
project's own directory and the evidence records which project it was, so a green test in `web/`
is never mistaken for evidence about `api/` — including in plan gates, which can require a kind to
pass in *each* named project. When several projects exist and a call names none, the harness
**refuses rather than guessing**.

**Toolchain availability is a fact, not an assumption.** Detection probes cargo/rustc/go on
PATH and rustup components/targets on disk (stat-only, never spawning); a missing toolchain
resolves the check to an explicit `toolchain-unavailable` with the exact cure (`install via
rustup`, `rustup target add thumbv7em-none-eabihf`) *before anything is put in front of you for
approval*, and installing a toolchain mid-session is noticed by the same drift guard that
notices an edited manifest. A declared gate waived this way appears in the acceptance as a LOUD
caveat naming the missing toolchain — never a quiet "unsupported". Cargo and Go have no
separate install step, and `project_setup` says so instead of pretending otherwise.

**Dependencies, migrations and seed data go through `project_setup`, never a raw shell command.**
You name an intent; the harness resolves the command from the lockfile (`npm ci`,
`pnpm install --frozen-lockfile`, yarn v1 vs Berry — and it refuses to guess when the project
declares neither) or from the project's own declared script. An install asks for approval showing
the exact command, the directory, and the lockfile it is pinned to, and states plainly that it
downloads and **executes** third-party package code with network access; a session-scope answer
covers re-runs only while the lockfile, `package.json` and every install-affecting config file
(`.npmrc`, `.yarnrc.yml`, `.pnpmfile.cjs`) are unchanged. Migrations
and seeds are classified destructive and ask **every** time, because a migration is not idempotent
and the harness cannot undo it. A setup is never verification: it can never satisfy a plan gate.

Every call passes through the policy engine before it runs. Reads and searches inside the
workspace run automatically; in-workspace writes run automatically **and are snapshotted so they
can be undone**; reads outside the workspace or of secret-looking files require approval — and
secret classification runs on the RESOLVED path, so a symlink or 8.3 alias cannot evade it.

Long sessions stay affordable: requests use **prompt caching wherever the provider offers it**
(Anthropic explicit breakpoints; automatic prefix caching on the others; `/status` and the report
show cache read/write tokens — a switch resets the cache and says so), and when the history grows
very large the oldest tool outputs are **deterministically elided** from the wire — replaced by a
hash-stamped marker; the full output always remains in the evidence log, and a
`context.compacted` event records exactly what the model can no longer see. The elision budget is
derived from the selected model's catalog entry, so a small-window model is not fed a
large-window history.

Shell commands go through **automatic review** (the single default — there is no permission
"mode" to pick). A deterministic analyzer decides, over the command text alone (never the model's
opinion): a *demonstrably* read-only command — a single simple command with no shell
metacharacters/encoding, whose program is on a small read-only allowlist (`git status/log/diff`,
`--version` probes, `ls`, …) with non-escaping args — may **auto-run**, but only *inside* the OS
sandbox so a misjudgment can't do damage. Everything else — writes, installs, network, anything
with pipes/redirection/encoding/chaining, an unrecognized program, or a path that escapes the
workspace — **requires approval**. A few catastrophic forms are hard-denied outright. Where no
enforced sandbox is available, auto-run is **disabled** and every command asks (fail closed).

## Documents and PDFs (the first non-coding workflow pack)

The same kernel produces polished documents. Nothing about it is a second agent loop: the model
authors a **document spec as an ordinary workspace JSON file** (`*.docspec.json` — headings,
paragraphs, lists, tables, images, code, quotes, page setup, header/footer with `{pageNumber}` /
`{totalPages}` / `{date}` / `{title}` tokens, bounded style themes), and the harness renders it
deterministically:

```
request → read sources → spec file → render → deterministic validation → SEE the pages → revise the SPEC → re-render
```

- **`read_document`** identifies DOCX / PPTX / PDF (and XLSX, names only) by **magic bytes, never
  the extension**, and returns outline, text, table shapes, slide order, page text, media
  inventory and metadata — always with a **coverage verdict** (`full` / `partial` / `structural`)
  and the reasons, so "we read it" can never quietly mean three different depths. A file that is
  not what it claims is refused *without echoing a byte of it*.
- **`render_document`** produces a **byte-deterministic DOCX** (hand-rolled OOXML: real named
  styles, one numbering instance per list, PAGE/NUMPAGES/DATE field codes, embedded PNG/JPEG,
  fixed timestamps — same spec in, same sha out) and a **PDF printed through the system browser**,
  then **parses each artifact back** and reports what it found: outline equality, table shapes,
  dangling relationships, header/footer fields, page count, headings findable in the printed
  text. Structural mismatches are failures; layout observations are notes and never block.
- **`inspect_pages`** rasterizes pages so a vision model can judge the real thing — page breaks,
  clipping, cramped tables, whitespace, balance — and each page image is stored as session
  evidence you can re-view.

Revision is **the spec, not the artifact**: edit the spec file (an ordinary snapshotted write,
so `/undo` and the session diff work as always) and re-render. Artifacts are **products, never
verification** — a render never marks a file CHECKED and never satisfies a plan gate, pinned by
the same asymmetry test the dependency-install path has.

Honest limits: **DOCX visual fidelity is Word's**, so DOCX claims here are structural and
parse-back verified while the *visual* check happens on the PDF twin rendered from the same spec.
Without a system browser the DOCX still renders and the PDF is skipped with a recorded reason;
without image input on the selected model, inspection refuses and says the deterministic
validation is what remains. PDF bytes are not claimed deterministic (Chromium embeds dates/ids);
DOCX bytes are. Editing pre-existing DOCX files, PPTX generation, footnotes, TOC fields, tracked
changes, cell merges, and RTL/complex-script fidelity are **out of scope** — not partially
supported.

## Source-backed web research

An agent working from recall writes code against APIs that have moved, and is confident about it.
Agent CLI can go and check — as an explicit, budgeted, read-only capability.

Two shapes, matched to size:

- **`@search <question>`** — one bounded lookup. Returns ranked source snippets with URLs.
- **`@research <question>`** — delegates a **researcher subagent**: read-only in your workspace,
  external on the network, and holding *no tool that writes, runs, or delegates*. It searches,
  reads the pages that matter **in its own context**, corroborates, and hands back short claims
  with their sources. The raw pages never enter your conversation.

The agent also reaches for either on its own when a request clearly needs current information.

```
⚠ approval required  [web research — queries LEAVE THIS MACHINE; read-only, nothing here is written]  web_search
  web_search: "zod v4 json schema helper" → api.tavily.com
    query (sent verbatim): zod v4 json schema helper
    max results: 5
    provider: api.tavily.com (the only research destination; a configured proxy still carries the connection)
    bounds: ≤12000 retrieved chars · 20000 ms · ~1 credit(s)
    session budget remaining: 23 search(es), 12 extract(s), 79 credit(s)
  [y] allow once   [s] allow further research this session, within the session budget   [n] deny
```

**What bounds it.** One session allowance — 24 searches, 12 extracts, 80 provider credits, 800k
retrieved characters — shared by the main agent and every researcher, and **rebuilt from the event
log on resume** so restarting cannot refill it. The prompt shows the query verbatim before anything
is sent, and `[s]` is bounded by that budget rather than by the session.

**What it will not do.** Non-http(s) schemes, URLs with embedded credentials, loopback/private/
link-local hosts and bare IP addresses are refused outright. `researchBlockedDomains` in either
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

## Plan mode, agent teams, and project memory

- **Plan mode** (`@plan …`, `/plan`, and the approval prompt): the plan is a structured JSON
  document (one per session, in the harness state dir) with a generated markdown view beside it,
  not disposable narration. The model writes it only through a policy-gated tool and can never
  change its status; only you approve or discard, and approval binds the exact **content sha**, so
  a status flip does not invalidate it but a semantic change does. The plan is injected each turn
  as labeled **context, not authority** — and if it diverges after approval, every surface says
  so, including the executor spawn prompt at the moment you approve the spawn. Edit the
  `.plan.json`; the `.md` next to it is a generated view.
- **Delegated tasks** (`delegate_task`, `/tasks`): one call spawns 1–3 parallel subagents,
  each a bounded child session with its own evidence log, a harness-fixed budget, and
  inherited-or-narrower authority. Read-only roles (explorer/planner/reviewer) auto-run;
  anything they'd need approval for is auto-denied. The mutating **executor** role asks you
  on every spawn, works in a **disposable git worktree** (never your workspace), forwards
  its own risky approvals to you (labeled with the asking task), and its captured changes
  reach the workspace only via `apply_task_changes` — per-file drift-refusing, snapshotted,
  one `/undo` unit. Child reports are labeled narration; the main agent owns final claims.
- **Project memory — six bounded documents, every cap a pinned contract**: your global
  `AGENT.md` (machine-wide, created by `/init`, hand-edited after — the project `AGENT.md`
  overrides it on conflict) and your project `AGENT.md` (injected verbatim every session), plus
  four harness-managed docs written at clean session end: the rolling **journal** (model
  narrative + a deterministic evidence section derived from the event log), the **codebase
  summary** (staleness-stamped), **LESSONS.md** (durable pitfalls and failure patterns — the
  model may propose up to 3 per session, merged by slug with provenance stamped, your edits
  preserved), and **RESEARCH.md** (source-backed findings with retrieval dates — deliberately
  perishable: entries age out after ~30 days, because a stale research note is exactly the
  overconfidence web research exists to prevent). Generated docs are injected under an explicit
  "context, not authority" header; the worst-case total injection is one tested ceiling.

## Git integration

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

The other half is yours, and the model has no unilateral path to any of it. It is told plainly
that it cannot commit on its own initiative and that committing is your decision; the only route
to a git mutation is a `run_command` you approve per call.

- **`/commit` is offered as a choice at the acceptance boundary** — when a session finishes with
  changes it can attribute to itself, the completion prompt's keys include *commit the N file(s)
  this session changed, then accept*. It runs the same preview and confirmation `/commit` runs.

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
code from a repo *implicitly* (fsmonitor). The model reaches the git layer only through the two
tools above, whose arguments the harness composes — never as a general git surface, and never at
a commit, restore, reset, branch, tag or push.

## Remote delivery to GitHub

The model *can* reach the remote — under two separate authorities that no amount of arguing
merges into one. They are two policy facts, so a tool that could both read a remote and change one
is refused by construction rather than by convention.

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
- **Looking never writes.** The only network verb is `git ls-remote`: no fetch, no
  remote-tracking refs, no `FETCH_HEAD`. The cost is stated honestly — a commit the remote holds
  and you have never fetched makes the relation `unknown`, and a force push over it is refused
  *even with `force`*, because nothing here can tell you what would be discarded.
- **What you approve is what executes.** The refspec source is the observed commit, not a branch
  name; before sending, the harness re-resolves the push URL and re-reads both sides, runs
  `git push --dry-run --porcelain` and checks it structurally (exactly one ref, the approved one,
  from the approved commit); afterwards it re-reads the remote and records `verified` separately
  from `ok`. A force push carries `--force-with-lease=<ref>:<observed-oid>` so the server enforces
  the same binding.
- **Agent CLI never holds your credential.** Authentication is gh's own store and git's credential
  helper; `GH_TOKEN`/`GITHUB_TOKEN` are deliberately not forwarded to child processes (and that is
  reported, not silently worked around). All gh/git output is scrubbed of credential shapes before
  it reaches the model, the terminal or the log.
- **Local completion is never permission to publish**, and a green gate is never a precondition
  either — it is shown in the prompt and enforces nothing. Since the model still cannot commit, it
  can only ever publish work you committed.

`/remote` is the record: the configured remotes, which account would act, live observations, every
read, and every mutation with its verification verdict — including the ones that failed. Out of
scope by decision: `gh api` passthrough, PR/issue creation, merges, repository creation or
deletion, settings, secrets, workflow dispatch, and `git fetch`/`pull`.

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
- **Web research SENDS text off this machine, and that is the consequence to weigh.** Nothing
  executes and nothing here changes; a query and (for a page read) a URL go out to one
  destination, and untrusted text comes back. The prompt shows the query verbatim before it is
  sent, names the destination, and states the per-call and session bounds. `[s]` is bounded by
  the session research budget rather than by the session. A configured proxy still carries the
  connection — the claim is about the destination, not the wire — and page retrieval happens on
  the provider's infrastructure, so the *research tools'* egress is one host, which is **not**
  the same as the harness's (`npm view` is on the auto-run allowlist, and the sandbox does not
  gate the network at all).
- **Retrieved web content is untrusted, and the fence is a mitigation, not a boundary.** Every
  retrieved string is neutralized at ingestion (control, bidi and zero-width characters escaped;
  harness-fence mimicry broken) and rendered inside an explicit UNTRUSTED region that tells the
  model it is data, never instructions. A sufficiently persuasive page can still influence a
  model — no prompt can promise otherwise. What it **cannot** do is act: a researcher subagent
  holds no tool that writes, runs, or delegates, so the worst case is a bad claim, which is why
  claims carry their sources and why research can never mark anything verified.
- **Research never counts as verification.** No research event marks a file CHECKED or satisfies
  a plan gate. A session accepted as complete after consulting the web says so in its caveats,
  and names any finding that rested on a single source or on sources that disagreed.
- **An install executes third-party code, and a migration cannot be undone.** `project_setup`
  never runs without an explicit approval showing the exact command and directory, and installs
  deliberately DO run package lifecycle scripts (`--ignore-scripts` would break esbuild,
  playwright and every prebuild download, so the prompt states the risk instead of pretending it
  away). A session-scope answer covers re-runs only while the lockfile, `package.json` and every
  install-affecting config file (`.npmrc`, `.yarnrc.yml`, `.pnpmfile.cjs`) are unchanged;
  migrations and seeds ask every single time.
- **The multi-project workflow is live-proven end to end, in one session.** Against a real
  two-package project (Express + `node:sqlite`, Vite + React, real lockfiles, no `node_modules`,
  no `.env`, no database): one natural-language request drove detection, `project_setup`
  installing BOTH projects, `.env`, migrate, seed, per-project typed checks (including a lint
  script only one project declares), a parallel executor wave in isolated worktrees, integration,
  two managed dev servers at once (one answering only on IPv6 loopback), three passing
  project-attributed browser flows, a three-lens adversarial review that recorded the seeded
  XSS, a deliberate mid-session kill and resume, and `/accept` COMPLETE with no override —
  38/38 post-hoc checks over persisted evidence alone (see `CHANGELOG.md` 1.2.1 for the honest
  limits of that run, including two review lenses that hit their budget wall after capturing).
- **yarn is implemented from documentation, not live-proven.** npm is exercised; pnpm is
  implemented and unit-tested; yarn is not installed on the development machine.
- **Polyglot support is a defined, bounded surface.** Rust and Go recipes are live-proven with
  the toolchains this machine has (rustup **gnu** host, stable; Go from go.dev); MSVC-hosted
  Rust, cgo, build tags, cargo features, and `rust-toolchain` version pinning are untouched
  facts the harness records but never manipulates. Symbol/import extraction is declared
  heuristic (column-0 regex, no tree-sitter): Rust `impl` methods, C++ templates and Go
  generated code are invisible to the map (live reads always see them). The Go import graph is
  resolved by directory-suffix matching, wrong only toward missing edges. C/C++ is
  detection+indexing only — no configure/build recipes — and a gcc/clang `fatal error:
  foo.h: No such file or directory` would today false-fire the `command-not-found` signal if
  such output ever entered check normalization (it cannot yet: no C/C++ recipe exists to emit
  it). Embedded validation splits at the host boundary: cross builds are verifiable, anything
  needing a board, emulator or runner refuses with the reason — the harness manages no hardware.
- **External database servers, Docker and containers are out of scope.** What is supported is
  file-backed local databases and the project's own declared migrate/seed scripts.
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

The suite is hermetic — no network, no API key, no billing. The live tests are opt-in and gated
**twice**: they need `AGENT_LIVE_TEST=1` *and* the relevant provider's key env var, so a missing
key skips cleanly instead of failing. Run them deliberately (PowerShell):

```powershell
$env:AGENT_LIVE_TEST=1; npx vitest run test/anthropic.test.ts       # Anthropic adapter + default model id
$env:AGENT_LIVE_TEST=1; npx vitest run test/live-providers.test.ts  # every provider whose key is set
```

`test/live-providers.test.ts` proves two things per provider through the real adapter: a streamed
completion, and one tool round-trip whose second request replays the first turn's blocks —
including reasoning — which is exactly the echo Kimi and DeepSeek require and Anthropic validates
byte-verbatim. They are not wired into an npm script on purpose: a bare `AGENT_LIVE_TEST=1 vitest`
prefix is not portable on Windows without adding a dependency, and a test that spends money
should be typed out, not inherited.

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
