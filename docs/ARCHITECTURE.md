# Architecture

How Agent CLI is actually built: the modules, the contracts between them, the orderings that are
load-bearing, and the limits that are real. This describes the system as implemented — not a plan.
[`ROADMAP.md`](ROADMAP.md) records how it got here and what is deliberately deferred.

**Contents**

- [The shape of the system](#the-shape-of-the-system)
- [A session, end to end](#a-session-end-to-end)
- [Authority: trust, policy, sandbox, grants](#authority-trust-policy-sandbox-grants)
- [Evidence: the event log and what is derived from it](#evidence-the-event-log-and-what-is-derived-from-it)
- [Understanding a workspace](#understanding-a-workspace)
- [Doing the work: plans, tasks, isolation](#doing-the-work-plans-tasks-isolation)
- [Proving the work: checks, previews, browsers, review](#proving-the-work-checks-previews-browsers-review)
- [Capability packs](#capability-packs)
- [Providers and networking](#providers-and-networking)
- [The terminal](#the-terminal)
- [Limits that are real](#limits-that-are-real)

---

## The shape of the system

A modular monolith in TypeScript (strict, ESM, Node 22). **One** runtime function, `runTurn`,
drives the agent loop; the one-shot CLI and the interactive REPL are both thin consumers of it,
so there is no second execution path to keep in sync. Data is plain JSON-serializable
discriminated unions; classes appear only where state genuinely lives (`EventLog`,
`SnapshotStore`).

**Nine runtime dependencies, eight of them behind a single module each** — `@anthropic-ai/sdk`
(`provider/anthropic.ts`), `undici` (`net/transport.ts`), `playwright-core` (`browser/flow.ts`),
`diff` (`shared/diff.ts`), `ignore` (`workspace/map.ts`), `fflate` (`artifacts/zip.ts`),
`@rgrove/parse-xml` (`artifacts/xml.ts`), `unpdf` (`artifacts/pdf-read.ts`). Only `zod` is
pervasive, and only as input-schema validation at the tool and config boundary. There is no web
framework, no CLI framework (argv is `node:util`'s `parseArgs`), no logger, and no daemon.

**Module boundaries are a test, not a convention** (`test/architecture.test.ts`): no `../../`
imports, `shared/` is a leaf that imports nothing outside itself, `sandbox/` is imported from
outside only through its index, and module cycles are a frozen removal-only set — exactly two,
both argued in place (`cli↔repl`, the wiring hub; `runtime↔tools`, the registry seam). Adding a
third fails the suite.

| Module | Responsibility |
| --- | --- |
| `types.ts` | Every shared contract, no logic: the action taxonomy, `Tool<I>` and its facts, policy/approval/provider wire types, `ExecSpec`, the event-log union. Modules depend on shapes, not on each other. |
| `shared/` | Leaf utilities: injectable clock and ids, hashing and redaction, path containment (`caseFold`, `isInside`), display sanitization and harness-delimiter neutralization, typed error classes, credential scrubbing, atomic document writes, the one file-registry lock. |
| `policy/` | `paths.ts` validates a path; `engine.ts` classifies and decides (the single choke point); `command-review.ts` proves a shell command read-only or does not. |
| `store/` | State outside the workspace: `layout.ts` (state-root resolution), `event-log.ts` (append-only JSONL with locking), `snapshots.ts` (content-addressed pre-images), `grants.ts` (durable machine grants). |
| `exec/` | The managed-subprocess substrate: `run.ts` (`runManaged`), `env.ts` (child env hygiene), `kill.ts` (verified tree kill), `shell.ts` (exit-code-faithful shell wrapping). Policy-free and log-free. |
| `sandbox/` | OS-level confinement backends: `windows-lowil.ts` (Low integrity + Job Object), `none.ts`, selected and probed through `index.ts`. |
| `runtime/` | The turn engine: `session.ts` (start/run/resume/end), `subagent.ts` (bounded children), `acceptance.ts`, `approvals.ts`, `elision.ts`, `undo.ts`, `worktrees.ts`, `task-changes.ts`, `roles.ts`. |
| `tools/` | The model-facing surface — one file per tool, plus the `TOOLS` registry. Tools declare facts; they contain no policy logic. |
| `checks/` | Typed verification: project detection, project-unit discovery, the declarative recipe table, toolchain probing, exit-code normalization. |
| `plan/` | The canonical plan graph: zod schema and semantic validation, the content-sha identity approval binds to, the JSON store, deterministic projections, and the pure execution fold. |
| `review/`, `recovery/` | Two pure folds with their own data tables: the adversarial review ledger, and the eleven-class bounded repair policy. |
| `git/`, `remote/` | The managed git client and the managed `gh` client, plus commits, hidden-ref checkpoints, worktrees, and observation-bound GitHub publishing. |
| `retrieval/`, `workspace/` | What the model sees of the repository: inventory → extraction → import graph → ranking → a rendered map under a hard budget; plus the flat-map fallback and the system-prompt builders. |
| `artifacts/`, `research/` | The two non-coding capability packs: documents/PDF, and source-backed web research. Neither imports the kernel. |
| `preview/`, `browser/` | Managed long-lived dev servers, and deterministic browser flows against them. |
| `memory/` | Six bounded project-memory documents, their caps, their merges, and their staleness rules. |
| `provider/`, `net/` | Five model providers over two protocols behind one contract, plus the proxy-aware transport. |
| `report/` | `buildReport`: a pure function from the event log to a structured object and a Markdown rendering. `diff.ts` renders the attributable session diff. |
| `repl/`, `cli/` | The interactive terminal and the argv dispatch. `cli/assemble.ts` is the one session-assembly path both consume. |
| `config/`, `trust/`, `setup/` | Narrowing-only layered config; recorded workspace consent; dependency install/migrate/seed by declared intent. |

---

## A session, end to end

### Startup order (load-bearing)

For every session-starting command, in this order:

1. Workspace realpath, then **refuse if the state root resolves inside the workspace** (re-checked
   in `ensureTrusted`, so a folder cannot plant a `trust.json` granting itself consent).
2. **Trust gate.** Nothing above this line has read a workspace byte.
3. Config load — the workspace config file is untrusted bytes until trust passes.
4. Per-project state creation, then `assembleSession`: **sandbox select + probe** → **git probe**
   (after trust, because it executes git against the repo) → orphaned-worktree sweep →
   orphaned-preview sweep → ranked map + retrieval index (any failure falls back to the flat map
   with the reason surfaced) → project-memory load → system prompt → start or resume.
5. Post-start records in a fixed order: `trust.verified`, `config.loaded`, `sandbox.status`,
   `git.context`, `remote.context` (always, usable remote or not — the local remote inventory is
   the premise every later remote decision rests on), then `workspace.mapped`, `memory.loaded`,
   `preview.swept` when the sweep found orphans, and `grants.loaded` when durable grants apply.
6. Per-session tool attachment: `retrieve`, `delegate_task` with the executor bundle and the
   approval-forwarding queue, `update_plan`, `run_check`, `preview`, `browser_flow`, `recover`,
   `review`, `apply_task_changes` with the captured-changes registry rebuilt from events.

Read-only commands (`report`, `sessions`, `diff`, `map`, `plan`, `memory`, `providers`, `version`,
`help`) are ungated, create no state directories, and run no git. `commit`, `checkpoint` and
`undo` **are** trust-gated: the first two execute repository hooks and write `.git`, and `undo`
restores bytes into the workspace — reverting a change is exactly as consequential as making one.
`map` reads workspace bytes but sends nothing to a model, and keeps the pure walker pre-trust.

### The core loop (`runtime/session.ts`)

`runTurn(session, userText, { signal? })` appends a `user.message`, then loops up to `maxSteps`:

1. Build a `ProviderRequest` — system prompt, the **elided view** of history, tool schemas derived
   from each tool's zod schema — and call `provider.complete`.
2. Record `assistant.message` with structured content (text plus each tool_use's id/name/input) so
   resume is faithful.
3. If tool_use blocks exist, process each sequentially through `executeCall`, collect the
   `tool_result` blocks, push them as one user message, and repeat.
4. Otherwise end — but **answer any unanswered tool_use blocks first**. Blocks and stop reason can
   diverge (a `max_tokens` cut mid-tool-call yields tool_use blocks with stop reason `max_tokens`),
   and leaving them unanswered makes every later request 400 for the life of the session.

**`executeCall` is the gate.** Record `tool.requested` (the model's verbatim, untrusted bytes) →
parse the input against the tool's zod schema → `decide(...)` → record `policy.decision`. On
`deny`, return a terminal error result *with* a `tool.completed`, so resume never mistakes a
denial for a crash. On `ask`, call the approver and record `approval.resolved`. On allow, run.

A parse failure first passes through `input-coerce.ts`: when an `invalid_type` issue expected an
object or array and a string sits at that path that itself parses as JSON, it is decoded and
re-validated **once** (some models double-encode nested arguments and cannot recover from the
schema error alone). The wire history and `tool.requested` keep the original bytes; policy and
execution both see the decoded input — the same thing the approval prompt shows.

`runExecution` captures a pre-mutation snapshot when required (a capture failure escalates to a
no-undo ask, never a silent proceed), then executes with a **per-call context**: the turn's
`AbortSignal` plus callId-bound evidence channels. The runtime binds the callId, so a tool cannot
forge another call's evidence. The **model sees real tool output**; the **persisted log redacts**
secret-classified reads. If reading a just-written file back fails (transient AV or index locks),
the mutation is still recorded with `postStateUnverified` — losing the event would leave `/undo`
blind to bytes already on disk.

`tool.completed` is also the **spill choke point**: when a tool attached transient
`ToolResult.fullOutput` and the output was truncated, the full pre-truncation bytes are stored as
`objects/<sha>` and the event marked `fullOutputSaved` — skipped under any redaction, capped, and
flagged only when the stored blob's hash verifiably matches. The report says "captured output
preserved", never "full": the exec capture cap may itself have dropped bytes.

**Abort and repair.** The tool loop has a pre-gate: once the signal is aborted or a deny-and-stop
is seen, no further call executes — including auto-allowed in-workspace writes. Skipped calls get
synthesized request/completion events and error results so the wire history stays API-valid, and
the turn records `turn.aborted {phase}`. An executing `run_command` **is** interruptible: the
signal reaches the child, which is tree-killed, verified and drained, reported as
`termination: 'aborted'` — distinct evidence from `turn.aborted` (process versus turn).
`repairDanglingToolUses` answers orphaned tool_use blocks from their recorded completions after a
mid-turn throw, so one failed turn cannot poison every later request.

### Context budget (`runtime/elision.ts`)

The full conversation is resent every step and old tool outputs are the bulk of it. `elideHistory`
is a **pure** function recomputed per request:

- **Image pass (unconditional):** image parts older than two assistant steps become
  `[screenshot <label>: viewed live…; preserved at objects/<sha>]` markers, on a deliberately
  separate window from the char pass's four steps.
- **Char pass:** when raw history crosses the trigger, the oldest tool_result *contents* are
  replaced by a marker (char count, sha256, evidence-log pointer) until the sent size meets the
  target. Both bounds derive from the selected model's catalog entry, so a small-window model is
  never fed a large-window history.
- **Monotonicity is enforced and survives resume.** Elided results stay elided; the set is
  re-seeded on resume from the log's `context.compacted` events. Without that, an aging screenshot
  could free budget the char pass then used to restore older outputs verbatim — invalidating the
  moving cache breakpoint and contradicting the record.
- **Reasoning blocks weigh their payload only.** The `text` field is a display copy that is never
  re-sent; charging both double-weighed every block on the providers that set them equal.

Only tool_result content is replaced: tool_use/result pairing, assistant text, user messages and
the last four assistant steps are untouched. `session.messages` and the log are never mutated.
The **exhausted** state — history over target even fully elided — fires one loud
`context.compacted {exhausted: true}` at the crossing and re-arms if pressure recedes.

### Resume

`reconstruct` rebuilds the provider conversation from the committed log. It is faithful for every
tool result except redacted secret reads, which by design are not persisted and cannot be replayed.
Crash recovery reconciles against `file.mutated` and post-hashes: a completed edit whose
`tool.completed` was lost to a truncated tail is recognized as **applied** (the post-hash matches
disk); a snapshot with no matching mutation is flagged **unknown post-state**; a bare
`tool.requested` is a true **orphan** — unless `command.started` shows the command had spawned
(the replay says its effects are unknown), `task.started` shows delegated tasks were running (the
replay points at every surviving child log), or a recorded completion verdict exists
(`command.ended` / `check.completed` / `setup.completed` / `remote.mutated`), in which case the
verdict is replayed rather than inviting a re-run.

Grants and the system prompt/map are regenerated fresh — current state outranks stale context.
Rebuilt from events at assembly: the captured-changes registry, delegate/check/preview caps, the
research spend, and the owed harness-ref list, so a crashed life's cleanup debts survive.

### The acceptance boundary (`runtime/acceptance.ts`, `/accept`)

Completion is an explicit recorded boundary, never a side effect of quitting. `computeAcceptance`
is a pure fold over (plan state, graph fold, events). **COMPLETE** requires the plan fully executed
(every task completed or parent-owned; a draft plan is deliberately not silently complete) *and*
every applicable executor capture applied, registry-wide. Three further axes make a session
**unfinished**: a completed task whose declared check gate is still pending; a declared
`gates.completion` kind that has not passed since the last change; an open escalation or unproven
repair.

It also carries non-blocking **caveats** — above all gates waived because the project or the
machine cannot run them, each naming the scope it means ("NEVER RAN in `web`; it passed in `api`").
One derivation feeds `/accept`, `/status`, the quit summary, the report, and the journal handoff.

`/accept` is user-typed consent. On COMPLETE it appends `session.accepted` and runs bounded
cleanup: prune this session's owed harness refs, and retire a fully-executed approved plan through
the existing discard flow (the file stays on disk as audit). With unfinished work it refuses with
the honest list; `/accept confirm` records a partial acceptance and retires nothing. Re-accepting
with no work since is a no-op that also finishes an interrupted cleanup. Work-shaped events after
an acceptance mark it **stale**, and every surface says so. Cleanup never erases rollback, audit
or resume material.

---

## Authority: trust, policy, sandbox, grants

Three separate controls, deliberately not conflated: **trust** records that you consented to the
agent operating in a folder; **approval** asks before a consequential action; the **sandbox** is
the OS technically confining a process.

### Trust (`trust/`)

Recorded consent, explicitly not a sandbox. `trust.json` (keyed by case-folded real path) and an
append-only `trust.log` live at the state root, outside every workspace, so folder contents can
never influence trust. A corrupt store is a hard error — never read as "trusted", never silently
rewritten. The consent prompt is offered only on a real TTY (a piped answer nobody read is not
consent); non-interactive untrusted runs refuse with exit 3; `--trust-this-workspace` consents for
one invocation and is never persisted.

### Configuration (`config/config.ts`)

Two strict-schema layers merged **narrowing-only**: the user layer (`<state>/config.json`) carries
preferences (`provider`, `model`, `maxSteps`, `memoryUpdates`) plus narrowing knobs; the workspace
layer (`<ws>/.agent-cli/config.json`) carries **narrowing only**, because a workspace is
attacker-influenceable. The knobs are `protectedPaths`, `secretPatterns`, `envExcludePatterns`,
`remoteBlockedHosts` and `researchBlockedDomains` — all deny lists, with no allowed-list
counterpart, because a permit list would be widening. The schemas structurally cannot express
widening; unknown keys and bad JSON are hard errors. Provenance is recorded as
`config.loaded {sources: [{path, sha256}]}`, and `.agent-cli/` is write-protected from the agent's
own file tools.

### The policy engine (`policy/`)

Two independent ideas, honestly separated: **path validation** and **action classification**.

`validatePath` (Windows-first) hard-rejects NUL, `\\?\` / `\\.\` device prefixes, UNC paths,
reserved device names, NTFS alternate data streams, and trailing dot or space; resolves through
`realpathSync.native` of the deepest existing ancestor plus the tail; and containment-checks
against `realpath(workspace) + separator`, so a sibling prefix (`C:\ws` versus `C:\ws-evil`) cannot
escape. It returns facts; the engine decides.

`decide(tool, input, ctx, grants)` is **deny-first, first match wins**, over the facts a tool
declares:

| Branch | Verdict |
| --- | --- |
| **Delegation** (`delegates`) | Step 0, deliberately first: a delegating tool must never reach the command path or the observe fall-through. Any unknown role denies the whole group; any mutating role asks (class `reversible`, deliberately not session-grantable, so every executor spawn is a human decision). |
| **Plan-document write** (`planDoc`) | `reversible`/allow — the store archives prior bytes and the write cannot touch workspace files. `planDoc` + `command` denies. |
| **Typed check** (`check`) | Before the command branch, because a check spawns a process. `reversible` + `noUndo` + `execBoundary: 'unsandboxed'`, and asks unless every resolved command already carries replay consent. The fact must be pure — resolved from a captured project snapshot, never the filesystem. |
| **Browser flow** (`browser`) | Bound to a running managed preview allows; anything else **denies**. There is no ask path for arbitrary origins. |
| **Session-evidence read** (`evidenceRead`) | Allows only for a sha this session's own artifacts recorded; an un-admitted sha denies. |
| **Remote read / remote write** (`remoteRead`, `remoteWrite`) | Two separate facts, each fail-closed. A read asks as `external` and is session-grantable within a real counter; a write asks **every time**, is never passed through `applyGrant`, and offers no `[s]` anywhere. |
| **Local git read / checkpoint** (`gitRead`, `gitCheckpoint`) | Same two-fact shape. A read allows as `observe` with a rule naming the argv; a checkpoint allows as `reversible` + `noUndo` and is the one model-reachable write inside `.git`. |
| **Research** (`research`) | Command-less and mutation-less, so it would otherwise auto-allow as "read-only workspace access" — false in the one direction that matters. Reading is not the consequence; **sending** is. |
| **Artifact render / inspect** (`artifact`) | Render cross-checks the fact's declared outputs against the resolved mutation plan (divergence denies); inspect splits on provenance and denies secret-named paths outright, because pixels cannot be redacted. |
| **Shell command** (`command`) | Automatic review — see below. A declared `cwd` is validated with the write-target containment rule and refused for protected paths: `.git` and the state dir are protected as *places*, not only as write destinations. A hardcoded circuit-breaker denies workspace and drive wipes. |
| **Declared write** | Out-of-workspace or protected (`.git`, the state dir, any `.agent-cli` segment, configured `protectedPaths`) denies; otherwise `reversible`/allow with `requiresSnapshot`. |
| **Reads** | Out-of-workspace or secret-named ask as `sensitive`, with log redaction. Secret classification runs on **both** the raw request and the resolved path, so a symlink or an 8.3 alias of `.env` cannot evade it. |

A throwing fact denies. A tool declaring conflicting facts denies. That last rule is what makes
"the read tool cannot publish" verifiable by grepping for a second fact and finding none.

**`analyzeCommand` is a positive proof of safety**, deterministic over the command string alone —
the model's opinion is never consulted. Auto-run requires *all* of: a single simple command with no
shell metacharacters, encoding or control characters (chaining, redirection, substitution,
expansion sigils, quotes and the `--%` stop-parse token all disqualify); an executable on a small
curated read-only allowlist (basename, extensions stripped, NFKC-normalized, casefolded); and
per-executable argument checks with nothing escaping the workspace. Everything else asks.
Obfuscation defeats any string reviewer, which is why safety here is *proven* rather than
pattern-matched — and why the reviewer is a prompt-skip gate, never the boundary.

**Session grants** are in-memory, keyed `(tool, class)`, and store only grantable classes
(`sensitive`, `external`) — never `destructive`, never `reversible`, and **never** any
command-bearing tool: a command's classification is a best-effort label over untrusted model text,
so a grant keyed on it would be standing shell permission won by a label. Grants are not persisted
and not restored on resume. The prompt hides `[s]` whenever no grant would actually be stored.

### Durable machine grants (`store/grants.ts`)

The one explicit, user-recorded exception to "authority is not durable", designed narrowly against
the known failure mode of vague "don't ask again" answers that mint machine-wide permissions.

- **Exact identity only.** An `[a]` answer persists either the approved check batch's exact replay
  keys (body-sha-bound, so any script or command drift re-asks structurally; scoped to the
  workspace by the same derivation trust uses) or one `(tool, external)` pair from a closed
  eligible set: `web_search`, the researcher spawn, and `remote_status` reads — three read-only
  external consents whose blast radius per-session budgets already bound. No prefixes, no patterns.
- **Everything else is ineligible, with the reason written on the set itself**: remote writes,
  migrate and seed, executor spawns, `run_command`, out-of-workspace and secret reads, artifact
  inspection, preview replay, install replay.
- **The offer is structural.** `[a]` renders only from an interactive approver — never
  non-interactive, never under `--dangerously-allow-all` (which answers before any prompt exists),
  never on a forwarded child ask, and only for eligible requests. An unoffered `a` parses as a
  **deny**, so scope cannot be upgraded by a typo.
- **The record never lies.** Persistence runs *before* `approval.resolved` is appended; a failed
  persist downgrades the recorded scope to `session` with the reason in the event's detail.
- **Visible and revocable.** `<stateRoot>/grants.json` (strict schema, corrupt is a hard error,
  never rewritten) with registry-locked atomic writes and an append-only `grants.log`. Assembly
  loads matching entries at every start and resume, validates class entries against the eligibility
  set, seeds the in-memory grants, and appends `grants.loaded` — standing authority is visible in
  the evidence of every session it touches. `agent grants revoke <id>` (or `/grants revoke`)
  applies from the next assembly; a running session keeps its in-memory copy, and says so.

### The sandbox (`sandbox/`)

A backend is selected once per session, **probed**, and reported truthfully. The runtime never
assumes enforcement from a platform name.

`windows-lowil` is a genuinely OS-enforced boundary. `wrapSpec` is a transform at spawn time: it
rewrites the spec so `runManaged` spawns a versioned PowerShell + inline-C# host instead of the
shell. The host duplicates the caller's own token, lowers it to **Low integrity** (no admin needed
for a lowered copy of your own token), creates a **Job Object** (kill-on-close, active-process cap,
UI restrictions), and launches the real command forwarding its inherited standard handles — so
output capture and the kill/drain machinery are unchanged. The child's `TEMP` points at a
Low-labeled scratch directory under the state root.

**What it enforces**, verified against the live OS: Mandatory Integrity Control denies the child's
writes to Medium-and-above objects — the workspace, the user profile, system directories, and the
harness state directory — at the kernel; and the Job Object reaps the whole process tree on kill,
including a detached grandchild `taskkill /T` cannot reach. **What it does not enforce**, stated
verbatim in `EnforcementFacts.doesNotConfine`: reads, network, writes to Low-labeled locations, and
service-reparented work.

**Fail closed.** `ensureAvailable()` spawns a Low-IL child and confirms *both* Low integrity *and*
an actual write-deny before `enforced: true`. On any non-Windows platform, or on probe failure, the
backend degrades to `none` semantics and the engine **disables auto-run entirely** — every command
asks. The host never falls back to unsandboxed. `PolicyDecision.execBoundary` decides which wrap
the runtime hands a tool, and `command.started.sandbox` records the boundary actually used.

### Managed execution (`exec/`)

`runManaged(spec) → ExecOutcome` is the substrate every shell execution goes through. It is
policy-free and log-free: policy stays in the engine, evidence stays in the runtime.

- **Termination is typed**: `exited | timeout | aborted | spawn-error`. Only `exited` carries an
  exit code — a killed command has `exitCode: null` by contract and can never read as a passing
  check anywhere downstream.
- **Kill and drain.** Timeout or abort triggers `killTree` (exit 0 and 128 both mean "gone";
  bounded liveness probes; the result recorded honestly, including when unverified), then settles
  on `'exit'` with a bounded wait and races `'close'` against a drain timeout. It never awaits
  `'close'` unconditionally, so a detached grandchild holding inherited pipe handles cannot hang
  the outcome. Tree kill is best-effort and says so.
- **Capture.** stdin is `'ignore'`, so interactive children fail fast rather than hanging a turn;
  stdout and stderr are captured separately and interleaved, head-plus-tail under byte caps
  (stderr-prioritized), decoded once.
- **Env hygiene.** Children get the parent environment minus names containing
  `key`/`secret`/`token`/`password`/`credential` (case-insensitive; config may add more), deduped
  case-insensitively, with a non-excludable floor and proxy variables passed through. Embedded
  proxy credentials remain visible — an honest documented limit, not a boundary.

---

## Evidence: the event log and what is derived from it

### The event log (`store/event-log.ts`)

One JSON object per line at `<state>/projects/<slug>/sessions/<id>.jsonl`, written synchronously.
`EventLog.open` acquires an atomic exclusive lock (refusing a live foreign holder, reclaiming a
stale one, and re-reading a present-but-unparseable lock before any steal, because the exclusive
create is visible before the JSON bytes land), repairs a partial trailing line **before** the first
append, and refuses mid-file corruption and newer schema versions. `events` is **live** — appends
through the instance appear immediately, which is what `/undo`, `/report` and `/status` depend on —
and observable via `onAppend`. `readLenient` is a lock-free, never-throwing reader for the report
and session listing.

The schema stays **v1**, and every extension has been additive — new event types or optional
fields. Bumping `v` would lock old binaries out of new logs. The accumulated surface covers
session and turn lifecycle; trust, config, policy decisions and approvals; provider identity
changes (env var *names* and hosts only, never credentials); tool requests and completions, file
mutations, snapshots and undos; command start/end with typed termination and the sandbox boundary;
git context, commits, checkpoints, restores and hidden-ref lineage; context compaction; memory
loads and updates; workspace mapping; task lifecycle, changes, applies and supervision; plan
routing, updates, approval and discard; check start/completion with named signals and project
scope; setup start/completion; repair attempts, escalations and dismissals; preview and browser
events; artifact renders and inspections; review findings and triage; and acceptance.

### Snapshots and undo (`store/snapshots.ts`, `runtime/undo.ts`)

Pre-mutation file bytes are stored content-addressed at `<state>/…/objects/<sha256>` — no git
dependency, so undo works with no repository present. `SnapshotStore.restore` verifies the file
still holds the recorded post-mutation hash and **refuses drifted files** rather than clobbering
them. `applyUndo` reverts the last mutating action or all of them in reverse order, chaining a
multiply-edited file back to its original bytes and removing directories the mutation created if
now empty. Every undo appends `undo.applied`; the log is never rewritten.

Git checkpoints **layer on top**: a checkpoint restore snapshots current bytes first and records
ordinary `file.mutated` events under one synthetic callId, so the restore is itself one undoable
unit of this same machinery. Git never becomes the undo mechanism.

### The report (`report/report.ts`)

`buildReport` is a pure function `(Event[], approvedGraph?) → { json, md }`.

**A changed file is labeled CHECKED only if a `run_command` — or a typed check — genuinely exited
zero after that file's last mutation.** The two sources are merged and sorted by seq before the
lookup, and a check's `pass` is derived from the identical `exited && exitCode === 0` rule. Each
piece of passing evidence carries the **scope** it covers — a check's project unit, a command's
declared cwd — and the correlation requires the file to be inside it, so a green build in `web/`
never marks a changed file in `api/`. A `command.ended` recording a kill vetoes CHECKED even
against a stray exit-0 completion. Everything else is UNCHECKED, and the report prints *which*
command with the exact wording "check ran, exit 0" and no correctness claim.

Commands that never executed stay visible under Actions/Approvals rather than "Commands run";
killed commands render as `killed: … no exit code`; a start with no completion renders `STARTED but
never completed … effects unknown`. Every command carries its actual boundary marker, and a header
block renders the session's `sandbox.status` — mode, whether it was enforced, and the verbatim
confines/does-not-confine scope. The session's end is read from the newest lifecycle event, so a
resumed-then-crashed log never reports the earlier clean end.

Sections, all derived purely from events: per-file churn; commits, checkpoints and restores;
captured-output pointers; delegated tasks (with the footer that child usage is not in the parent
totals and subagent reports are narration); plan; task changes and integration; typed checks;
recovery; preview processes; browser verification; adversarial review; git recovery and audit
state; and completion. The reviewable *content* lives in `report/diff.ts`: the attributable session
diff, built from the first pre-image blob against current disk bytes, undo folded in, external
edits flagged DRIFTED.

---

## Understanding a workspace

### Repository intelligence (`retrieval/`, `tools/retrieve.ts`)

Large-repo understanding is selective and ranked, not a broad file dump. One in-memory handle is
built per session at assembly and read everywhere else.

- **Inventory:** `git ls-files` plus per-file size/mtime plus dirty paths, capped at 20k files.
  The digest covers the sorted path *set*, deliberately independent of rendering, so map-format
  changes cannot flap staleness.
- **Extraction:** line-anchored regex symbols and imports for the TS/JS family, Python, Rust, Go
  and C/C++, from per-language pattern tables, all column-0 anchored — module-level items only, so
  Rust `impl` methods and Python nested definitions stay invisible by design. Injection defence is
  structural: symbol captures are bounded identifier classes and import specifiers are
  charset-filtered, so repository prose cannot enter the system prompt through extraction.
  Secret-named, binary and oversized files are never read.
- **Index:** a derived, idempotent cache written **only** at assembly (a command-less observe tool
  must never mutate durable state). Warm loads stat-diff and re-extract only changes; corrupt,
  missing or version-mismatched indexes rebuild cold; a wall budget yields an honest `partial` that
  converges across sessions. Deliberately lock-less — any consistent snapshot is valid, atomic
  tmp+rename prevents torn reads, and rebuild is the recovery.
- **Ranking:** a task-agnostic structural prior (bounded PageRank over resolved relative imports,
  entry-point and manifest heuristics, an uncommitted-change boost, depth and test/vendor
  penalties) plus per-query path/symbol matching and graph-neighbour boost. Deterministic, and
  every hit carries human-readable `signals` — traceable selection is a contract, not a debug
  feature.
- **The rendered map** is tiered under a hard 16k-character budget: a coverage-honesty header,
  uncommitted files, **the complete directory tree with per-directory counts** (the recall
  backstop — ranking orders detail but never hides that a directory exists), ranked key files with
  their top exported symbols and **no line numbers** (line numbers only ever come from live reads),
  and a footer pointing at the tools. `WorkspaceMap.sha256` is the sha of exactly what the model
  saw.
- **`retrieve`** returns ranked hits with signals, symbols, and excerpt lines read **live** at
  query time. Executor children and pre-trust `agent map` deliberately stay on the flat map.

### Project units (`checks/workspace.ts`)

A workspace holds one or more project **units**, not one project at its root.

- **Discovery** is bounded, stat-first and never-throwing: the root when it has a manifest;
  whatever the root declares (npm/pnpm `workspaces`, Cargo `[workspace] members`, `go.work` `use`);
  every depth-1 directory holding a manifest; and the children of conventional containers
  (`apps`, `packages`, `services`, `libs`, `modules`). Recognized manifests are `package.json`,
  `pyproject.toml`, `setup.cfg`, `Cargo.toml`, `go.mod` and `CMakeLists.txt` — a CMake unit is
  *named* without recipe rows, so refusals can say what the project is.
- **Two rules are load-bearing.** A unit exists only where a **manifest** exists (directory names
  are candidates, never units). And everything not interpreted is **recorded as a note**: the glob
  vocabulary is "a literal directory" or "a single trailing `/*`", and anything richer is refused
  with a reason, because half-interpreting a glob silently yields a different unit set than the
  package manager itself uses.
- **Ordering is deterministic** (root first, then lexicographic; filtered, sorted, then capped)
  because unit ids qualify recipe ids, and recipe ids are what consent binds to. Ids fold case on
  case-insensitive filesystems only; a unit whose real path escapes the workspace is dropped.
- **`selectUnit` refuses ambiguity; it never picks.** With more than one unit a call must name its
  `project`. A workspace with no project resolves to its root, so "this project cannot run a build"
  stays a capability answer rather than a call refusal that could never be waived.
- **Toolchain facts are stat-only and never spawn**: cargo, rustc and go probed on PATH, rustup
  components and installed targets probed under the toolchain directories. Present toolchains
  become pseudo-stamps on the existing drift seam, so installing Go mid-session flips staleness and
  the shared holder re-detects; absence is never cached across a session. A presence probe is not a
  health check, and the module says so.
- **One detection per session, one live holder.** Assembly detects once, before the system prompt,
  and publishes that snapshot to `run_check`, `preview` and `project_setup` through a single shared
  object. The system-prompt block is a *photograph*, labelled as observed at session start.

### Project memory (`memory/`) — six documents, context not authority

Cross-session continuity with hard caps and honest degrades: a broken or oversize document can
never block a session — it loads truncated, or is skipped with a status recorded in
`memory.loaded`. Every bound is pinned in `test/limits.test.ts`, including the worst-case **total**
injection as one ceiling a new document must deliberately trip.

| Document | Home | Owner | Inject cap | Lifecycle |
| --- | --- | --- | --- | --- |
| global `AGENT.md` | state root | user (created by `/init`, hand-edited after) | 16 KiB | machine-wide constitution, injected first; the project file overrides on conflict; deliberately **not** given to subagents |
| `AGENT.md` | workspace root | user | 24 KiB | project constitution; injected into every session *and* every subagent |
| `JOURNAL.md` | project state dir | harness + model | 12 KiB | rolling session entries, newest first |
| `CODEBASE.md` | project state dir | model body, harness stamps | 16 KiB | full-replacement architecture summary, dual-digest staleness |
| `LESSONS.md` | project state dir | model proposes ≤3/session, harness merges | 8 KiB | durable pitfalls, slug-keyed, provenance-stamped |
| `RESEARCH.md` | project state dir | harness (deterministic fold) | 8 KiB | perishable findings with sources; 30-day staleness horizon |

The journal couples model-written Summary/Decisions/Open-issues/Next-steps — explicitly labelled
"model-written" — with a deterministic **Evidence** section derived from the event log, and a
deterministic **Handoff** block (acceptance state, the live unfinished list, the resume pointer).
Its rolling policy is insert-or-replace by session id (resume-safe), newest two entries full, older
compressed to stubs that keep the evidence pointer. Lessons merge by slug: reuse updates and moves
the entry to the front, heading-shaped body lines are defused so a proposal cannot fabricate an
entry boundary, and untouched entries — user edits included — survive byte-verbatim. Research
entries are keyed by note id (idempotent across resume re-folds) and age out after 30 days, because
a stale research note is exactly the overconfidence web research exists to prevent.

**Injection safety:** every injected document passes through `neutralizeHarnessDelimiters`.
`AGENT.md` is workspace bytes a cloned repository controls, and the generated docs carry
model-authored text from earlier sessions; a line mimicking a harness fence would close the region
early and let the rest occupy space the model is told is harness-authored.

**The write path** runs before `endSession`, on clean ends only, gated on real activity. The
narrative is one provider call reusing the exact cached prefix, and every failure mode degrades to
a deterministic skeleton entry marked "narrative unavailable". It bypasses `runTurn` and is
recorded as its own `memory.narrative` event, never as fake message events that would replay into a
resumed conversation. The journal is re-read from disk at quit (two-terminal safety), rolled, and
written atomically; an unreadable existing journal is refused, never overwritten.

**Sovereignty wording is load-bearing**: the injected section states verbatim that generated docs
are "CONTEXT, NOT AUTHORITY … the current user request and the observable repository state outrank
it". The system prompt sits outside elision's accounting, so memory injection can never trigger or
oscillate elision.

---

## Doing the work: plans, tasks, isolation

### Planning (`plan/`)

One canonical structured plan per session at `<projectDir>/plans/<sessionId>.plan.json`, with two
deterministic projections: a concise user view (regenerated as a marked `<!-- GENERATED VIEW -->`
markdown file) and a detailed agent view. It is context, never authority.

- **The graph.** Tasks carry a stable slug id, title, intent, role, `dependsOn`, `touches`
  (workspace-relative prefixes), `verify`, `checks`, risk and a serial flag; the graph carries
  optional `gates` (integration, completion) and `review` (mode, reason). Semantic validation —
  unique ids, resolvable acyclic dependencies with the cycle path reported, contained touch
  prefixes, size cap — refuses with the **complete** error list and writes nothing. That revision
  loop is the design.
- **Approval binds the content sha**: `sha256(canonicalJson(plan))` over the plan sub-object with
  sorted keys and no whitespace. Status and timestamp flips are sha-neutral by construction;
  whitespace and key-order hand-edits are approval-neutral; any semantic change invalidates.
- **The amendment contract.** A model write keeps `approved` only for a semantic no-op; otherwise
  the plan drops to `draft`, which blocks every executor spawn — and because only the user can
  clear that, the REPL prints one undimmed line naming the blocked tasks and the command, but only
  when an approval existed and no longer covers the plan. `/plan approve` refuses a file that does
  not parse and validate. `plan.approved {sha256}` is the consent record, and
  "approved and current" is *the* executor precondition.
- **Injection.** The standing per-turn note carries the agent view when the content sha is new to
  the model and a pointer otherwise — and the pointer always carries the live execution summary,
  because task states change without changing the content sha. It is wrapped in a harness-note
  fence whose closing sequence is broken inside the note text, so plan strings cannot close the
  wrapper and forge user-attributed words.

### The task DAG and the scheduler gate

Execution state is a **pure fold** over (approved graph, events) — no new store. Per-task states:
queued, blocked, running, awaiting-approval, integrating, completed, failed, cancelled,
parent-owned, interrupted. A completed executor with **no** capture event folds to `failed`,
because capture loss must stay re-runnable.

**Definition identity: `completed` belongs to the definition that ran, not to the id.** Every bound
spawn records the sha of the task's canonical form, and the fold re-opens a completed task whose
current definition no longer matches the binding that completed it.

The gate runs **before** the base checkpoint and is group-atomic — a refusal spawns nothing:

- **Status gate (strict):** while any plan document exists, executor groups require an
  approved-and-current plan. Draft, unknown, superseded, diverged, and approved-without-recorded-
  consent all refuse. *No plan at all does not block* — the per-spawn human ask stays the consent
  floor.
- **DAG rules**, active only when an approved-and-current graph exists: unbound executors refuse
  (naming the ready ids and the escape hatches); unknown id; role mismatch; then **group
  composition before per-task state**, so "sequence them across calls" is never shadowed —
  duplicate binding, intra-group dependency, serial/high-risk must run alone, overlapping declared
  touches between executors; then per-task state — completed re-runs refuse (failed, cancelled and
  interrupted stay re-spawnable), integrating refuses until applied, an attempt ceiling refuses a
  task with three genuine failures under its *current* definition, then unmet dependencies refuse
  naming the dependency's state. Two further rules add the recovery gates below.
- **Waves are parent-serialized by construction:** one delegate call is one parallel group, and the
  parent integrates between calls, so the next group's base checkpoint includes applied
  dependencies. The scheduler is the gate plus the fold plus guidance notes — deliberately not an
  in-tool wave engine.

### Tasks and roles (`runtime/subagent.ts`, `runtime/roles.ts`, `tools/delegate.ts`)

The main agent keeps user interaction, authority, coordination, integration and final claims; a
delegated task is a bounded, attributable unit beneath it.

- **Roles are split by layer.** `types.ts` holds the **policy** fact table — explorer, planner,
  reviewer and inspector are read-only, researcher is read-only-external, executor is
  mutating-worktree — and `decide()` consults only this, failing closed on anything else.
  `runtime/roles.ts` holds the **runtime** contract per role: a tool registry that is a subset of
  `TOOLS` and never includes the delegate, plan-write or apply tools (so depth stays 1 and no child
  can self-integrate), a role prompt builder, a harness-fixed budget, and an approval mode. A
  load-time check pins the two tables consistent.
- **The `inspector` role** backs `@review` and exists separately from `reviewer` for structural
  reasons: a reviewer's recorded critical or high findings block `/accept` regardless of
  requirement or waiver, findings never expire, and every round spends one of only two. A casual
  mid-session "have a look at this" must not be able to do any of that, so the inspector writes to
  its own advisory channel, which blocks nothing and consumes no round.
- **Named admission seams.** `retrieve`, `report_finding` and `report_observation` exist only as
  per-session instances and reach children only through named fields; a child gets one iff its role
  contract names it *and* the instance is structurally free of command, delegates and plan-document
  facts. Deliberately not a generic extra-tools list, so depth-1 stays a property of construction.
- **One runtime, parallelism in the tool.** A child task is another `Session` driven by the same
  `runTurn`, in-process, and a task is exactly one turn. `delegate_task` takes one to three tasks
  that run concurrently — the schema maximum *is* the concurrency cap. One call is one parallel
  group, one evidence unit, and one approval for a group containing a mutating role (the strictest
  member governs).
- **Inherited-or-narrower authority, structurally:** the role registry is a subset of `TOOLS`, the
  parent's narrowing rules apply, the probed sandbox instance is shared, grants start empty, and
  `AGENT.md` is injected while generated memory docs deliberately are not. Read-only roles get an
  auto-denying approver; the executor's asks **forward** to the parent's approver.
- **Approval forwarding** is a serialized FIFO queue wrapping the parent *session* approver — never
  io directly — so non-interactive parents fail closed structurally and `--dangerously-allow-all`
  keeps its meaning. Every forwarded request carries task context; entries are signal-linked, so a
  task that dies while its ask is queued resolves deny without ever displaying, and one that dies
  while displayed unblocks immediately with the stale answer discarded and an honest line printed.
- **Supervision** runs on the child's append chain plus a scaled ticker (production: 60s stall,
  30s cadence): loop detection over identical consecutive calls annotates at three and auto-cancels
  at five; one budget-pressure observation at 80% of tokens or wall clock; one stall observation,
  suppressed while a command is genuinely in flight. All observations are bounded, never-throwing,
  and dual-surfaced — persisted events *and* notes at the **head** of the group digest, so
  head-biased truncation cannot hide a failed status behind a long child report.
- **Boundaries, deliberately:** depth 1; no inter-child messaging (siblings are blind, the parent
  integrates); no task resume; no automatic retries.

### Executor isolation and integration

The mutating role never touches the user's workspace. The chain is base → worktree → capture →
review → apply, every link evidenced.

- **Base is one hidden-ref checkpoint per group**, created sequentially before fan-out, so the
  parent's current working tree — dirty state included — is the base and every member starts from
  the same attributable oid.
- **EOL pin.** Before creating the worktree the harness probes whether checkout normalization would
  differ from the parent's on-disk bytes (`core.autocrlf=true` over a uniformly-LF tree) and, if
  so, forces both the worktree add and the capture staging to preserve them. Without it every
  captured file refused at apply as base drift. Deliberately the uniform case only: a mixed tree
  keeps the refusal, with a diagnosis that names EOL normalization rather than generic drift.
- **Worktree per task**: `git worktree add --detach` at the base oid, under an OS-temp home whose
  placement is dictated by `validatePath`. A version gate refuses old git; non-repo workspaces
  refuse honestly. Children never pass the CLI trust gate — a harness-created worktree of a trusted
  workspace is trusted **by derivation** and never written to `trust.json`. The worktree
  materializes *without* gitignored files, which the executor prompt states plainly.
- **Capture** happens at task end for **any** status, because partial work is evidence: the
  worktree's porcelain status, workspace-prefix filtered, base bytes materialized binary-safely,
  after and base bytes stored as content-addressed blobs, bounded with every omission counted.
  Rename pairs survive the cap atomically. The recorded diff outlives the worktree.
- **Cleanup is deterministic**: the worktree is always removed in a `finally`, and failure is
  honest `worktree.removed {ok: false}` evidence. The registry is owner-stamped and the sweep
  **always skips live-pid entries** — there is deliberately no age hatch, because approval wait is
  excluded from the executor clock, so a live task's age is unbounded and nothing file-based
  distinguishes a live owner from a crashed one whose pid was recycled.
- **Integration** (`apply_task_changes`, parent-only) declares the concrete apply-eligible paths
  from the captured evidence, and the existing snapshot-first / `file.mutated` / undo / commit
  attribution machinery does all the writing. The per-file rule: the workspace file must still hold
  the task's base bytes (or already hold the target, or be absent for a create); anything else
  refuses **that file**. Partial applies are reported per file and land as one undoable unit.

### Typed recovery (`recovery/`)

Recovery is a **policy**, not "try again": classification happens before any repair is planned, and
every automatic repair needs a supported class, sufficient evidence, a recovery point, a materially
different hypothesis, and budget it has not spent.

- **Eleven classes** — dependency-setup, compile-type, test-assertion, lint-format,
  runtime-process, integration-conflict, policy-approval, timeout-resource, preview-startup,
  browser-verification, and **unknown**, which is a real answer with real consequences (stop and
  escalate), never a shrug.
- **The catalogue is data**: one entry per class carrying likely signals, required evidence,
  diagnostics, eligible actions, regression checks, auto-eligibility, and stop conditions. It is
  rendered into failing check results and gate refusals, so guidance arrives where it is needed.
- **Classification is deterministic and derivable from events alone.** Ordering is load-bearing:
  non-verdict terminations win first (a user interruption produced no verdict and must not become
  a repairable defect), then a missing toolchain outranks every downstream diagnostic. A delegated
  task that merely ended in error stays **unknown** and points at the child log — "a task failed"
  is not a diagnosis.
- **The ledger derives outcomes; it never records them.** There is no `repair.ended` to lose in a
  crash: an attempt is `succeeded` only when every regression check it declared actually passed
  afterwards, `superseded` by a newer attempt for the same signature, else `open`. The proof must
  include the kind that actually failed, and for scope-bearing kinds the passing run's scope must
  cover the attempt's.
- **Acceptance closure.** An open escalation or unproven repair is honest unfinished work. It
  resolves by evidence when its plan task completes with a satisfied gate — or by the user's
  recorded dismissal (`/repair dismiss <n> <reason>`), which closes the blocker while **always**
  remaining an acceptance caveat. Dismissed is not resolved.

### Harness checkpoint lineage

Recovery points at the transitions the coding flow actually has, all as hidden refs under
`refs/agent-cli/checkpoints/` — never the user's branch history, and never a commit as a side
effect of running Agent CLI.

- **Event before ref.** `createCheckpoint` invokes a seam between `commit-tree` and `update-ref`,
  and every harness call site appends its creation event there. A crash between the two leaves an
  *owed* ref that does not exist, and deletion counts a missing ref as deleted — so the
  creation-instant leak is structurally closed. The inverse is handled honestly: an `update-ref`
  that fails after the append leaves a **phantom** creation, so every reader treats the live ref
  listing as truth.
- **Four kinds, one lifecycle rule.** `task-base`, `pre-integration` and `agent` (a recovery point
  the model asked for) are session-scoped and pruned at clean end; `delivery` survives as the
  durable audit anchor, keyed on the ref the latest acceptance actually *consumed* rather than the
  newest creation event, which a phantom could hold.
- **Pre-integration** fires only under the covered-change rule: an un-snapshot-covered writer must
  have *spawned* since the last harness checkpoint. Snapshot-backed mutations are deliberately
  excluded, because counting them made every apply after the first pay a whole-tree capture. A
  decline or failure skips with a recorded note and never refuses the apply.

---

## Proving the work: checks, previews, browsers, review

### Typed verification (`checks/`, `tools/run-check.ts`)

**The model names KINDS; the harness names COMMANDS.** That inversion is the whole trust argument,
and everything else follows from it.

- **Kinds:** `build`, `test`, `test-targeted`, `typecheck`, `lint`, `format`, `static-analysis`,
  plus `browser`, which only flows produce. There is deliberately **no** dependency-install kind:
  installing runs third-party code with network access, which is not "verify what we just built".
- **Recipes are declarative rows** with `applies`, `unmetPrecondition`, argv or a body script, a
  timeout, and effects. A project's own script always beats a guessed tool invocation, and the
  first applicable row wins — resolution is deterministic, which is what consent can bind to. One
  composer builds the command line: bare-safe tokens pass through, everything else is quoted, and
  an unrepresentable argument throws rather than being hand-escaped. Node/TS is first-class, Python
  minimal, Rust/Cargo and Go modules first-class, CMake detected-but-unsupported, everything else
  `unsupported` **with the reason**. Holes are decisions with stated reasons — no Rust
  test-targeted (cargo selects tests by name), no Go format (`gofmt -l` exits 0 either way, and an
  output-parsed verdict would break the contract below). Preconditions are **row-owned**: whether a
  blocker is an uninstalled project (curable), a missing machine toolchain (waives loudly), or a
  host incapability (waives quietly) is a fact only the row can state.
- **Normalization: the exit code is the verdict.** `exited` + 0 is a pass, `exited` + non-zero is a
  fail, and every non-exit termination is an `error` — never a pass. Parsers only enrich the
  summary, findings and named **signals**, and the signals are the durable half: full output is
  truncated and only spilled to a blob, so later failure classification reads persisted signal ids
  rather than text that has left the context.
- **Three refusals that spawn nothing:** the resolved command (or the script body it invokes)
  changed since the gate; a malformed request, refused as a *call* with no event so a caller
  mistake can never become gate evidence; and the session check budget.
- **Evidence.** `check.started` is emitted from the spawn callback only, so it means exactly what
  `command.started` means. An `unsupported` kind records a completed event alone carrying a typed
  reason — `no-recipe`, `precondition`, `precondition-curable`, `bad-request`, or
  `toolchain-unavailable` — which lets a gate distinguish "this project cannot" from "you asked
  wrong" from "this project is not installed yet".
- **Consent is replay, bound to what actually runs.** A check runs project code at full user
  privilege, so it is `reversible` + `noUndo`, always unsandboxed (the Low-IL boundary denies
  workspace writes, so a build could not run inside it), and it asks. A session-scope answer stores
  replay consent keyed by `sha256(recipeId + command + bodySha)` in a separate store with no action
  class. The **body** is load-bearing: `npm run test` is a stable string whose behaviour lives in
  `package.json`, which the agent can rewrite through an ordinary auto-allowed write — and the sha
  covers the *untruncated* script value, because hashing the display-capped text let an append past
  the cap ride the earlier approval.

### Project setup (`setup/`, `tools/project-setup.ts`)

The check inversion applied to dependency installs, migrations and seeds — with its own tool, its
own consent, its own events, and **no path to satisfying a verification gate**. A check means "we
verified"; it never means "we fetched".

The model names an intent and a unit; the harness resolves the command. `install` resolves from the
**lockfile**, and refuses rather than guessing when a project declares neither a lockfile nor a
package manager. `migrate` and `seed` resolve the project's own script from a fixed per-intent
allowlist, so neither can become "run any script". Consent splits by consequence: an install is
`external` and may replay under `[s]`, bound to the sha of the lockfile *plus* `package.json`
*plus* every install-affecting config file — because every package manager executes lifecycle
scripts during an install, and those config files each choose what code runs and where it comes
from. Migrations and seeds are `destructive` and ask **every** time: a migration is not idempotent,
so "you approved this once" cannot honestly mean "you approved it again". Installs deliberately
*do* run lifecycle scripts, because `--ignore-scripts` would break real toolchains and make the
capability a lie — so the prompt states the risk instead. It is parent-only, for a sharper reason
than checks: an executor worktree is disposable, so an install there populates a directory about to
be deleted, and a migration there writes the *real* local database from what the user believes is
isolation.

### Managed previews (`preview/`)

The one process class whose lifetime is not bounded by a tool call: an explicit **session
resource** with recorded start, readiness, health, logs, and a deterministic end.

`startSupervised` is `runManaged`'s deliberate inverse — it returns a live handle instead of
awaiting an outcome. Output goes to a per-preview **log file** through an inherited fd, so an
orphan surviving harness death can never wedge on a full pipe buffer half-serving requests.
Lifetime bounds are typed stop reasons: TTL, log cap, explicit stop, session end. Consent reuses
the check inversion — the model names a script from a fixed allowlist, the harness composes the
command, and the persisted decision says "KEEPS RUNNING, binds a local port".

**Readiness is honest.** The harness probes HTTP only on a port the server's own output announced,
strips ANSI before parsing, honours the deadline and the turn abort, re-checks liveness after a
successful probe, and records "socket ownership not verified". Each candidate is probed on **both**
loopback literals and **the address that answered is what gets recorded** — that recorded URL is
also the origin a browser flow is locked to, so it must be an address proven to answer. An HTTP
answer means *a* server is up; application state is judged only by browser flows.

The crash sweep kills only on **positive identity** — dead pid drops, a live sibling owner is
skipped, and a live orphan must match both the re-derived command token and a creation time within
tolerance, or the kill is skipped and reported. There is deliberately no age hatch on kills:
delayed removal is safe, killing a recycled pid is not.

### Browser verification (`browser/`)

The check inversion applied to UI: the model declares a **typed flow**; the harness owns execution,
waits, and the failure taxonomy. `playwright-core` drives the **system** browser (Edge, then
Chrome, then a Playwright-cache Chromium), and the probe is cached **success-only** — a cached
transient failure would turn every later flow into a gate-waiving `unsupported`, and acceptance
could reach COMPLETE without the UI ever being driven.

The spec is strict zod: `goto` requires a **declared** ready condition (a load event, network idle
or a quiet spinner never count), assertions are typed, and steps run strictly in order stopping at
the first failure. The failure taxonomy is typed — timeout, assertion (with the last observed
state), navigation (a real URL-origin comparison; any off-origin top-level navigation aborts the
flow), runtime, protocol (the browser died, so the app was never judged). Console errors are
findings, not verdicts, unless the flow asks otherwise.

Evidence rides the check channel with `exitCode: null` and no termination **always**, which is
exactly what keeps a browser pass out of the report's file-CHECKED correlation while gates,
waivers, caveats, classification and the repair ledger all work unchanged. **Visual judgment is
judgment**: `view_image` returns real pixels only for a sha this session's own artifacts recorded —
enforced at the gate and re-checked at execute, because the shared blob store also holds spilled
output and snapshot pre-images. Visual impressions can add findings but never discharge a gate or
override a failed deterministic assertion.

### The verification gate

A plan task declares the typed checks that gate it, and **dependents unblock only when that gate is
green**. The mechanism is one predicate, not a new state:
`depSatisfied = (completed && verification.status !== 'pending') || parent-owned`. A task with no
declared checks has status `none` and behaves exactly as before, so simple tasks stay cheap.

**What a green gate proves, exactly:** the declared kinds passed on the workspace at a point *after*
this task's own work was integrated. The anchor is the maximum over all of the task's bindings,
because capture happens for failed children too and an earlier attempt's files can be applied
later. Satisfaction is harness-derived from event sequence, never attested by the model's label.
For `test-targeted` the **scope is the check**: the run's recorded scope must overlap the task's
declared touches.

**Waivers, honestly.** An `unsupported` result waives the kind — but only when the reason is a
capability one. Neither `bad-request` nor `precondition-curable` may (the latter means the project
simply has not been installed yet, and there is a named cure). `toolchain-unavailable` waives
deliberately — a machine without the compiler is the browser-unavailable case one toolchain over —
but the folds track it apart and its caveat names the missing toolchain, so "the machine lacks
cargo" can never read as "this project cannot be tested". With `gates.projects`, a kind is
satisfied only when it passed or was honestly waived in **every** named project, and the fold
records which projects passed, waived and are missing, so a blocker names the one that is missing.

### The review gate (`review/ledger.ts`)

The reviewers record **typed findings**, the harness derives what the records are worth, and the
parent's judgment annotates but never erases.

- **Findings are typed at the source.** `report_finding` is the reviewer child's only findings
  channel: a per-task accumulator constructed inside the fan-out, so parallel lenses can never
  interleave. Bounded in count and field length; paths validated with the containment rule;
  model-authored strings neutralized at ingestion because they are later rendered into
  harness-attributed lines; a path that sanitization would alter is **refused** rather than
  escaped, because an altered path names no real file.
- **Capture is unconditional** for any reviewer child that existed: an empty finding list is a
  recorded *clean lens*, while a completed reviewer with no capture means the round's evidence was
  lost.
- **The fold is pure** over (approved-and-current graph, events), with three rules. The requirement
  is **derived** — at least one executor task means review is required — and never stored; the
  plan's `review` field waives it visibly with a user-approved reason. A round **qualifies** only
  against real work: no effective apply may land inside the round's window (reviewers that observed
  mid-apply state reviewed neither before nor after), and at least one unit of real work must
  precede it. And findings **never expire**, so a weak second round cannot launder the first
  round's criticals. Post-round fixes do not de-qualify the round — they surface as a caveat,
  because punishing the harness-recommended fix path made the loop never end.
- **Triage annotates; the fold derives worth.** `verify` keeps blocking (confirmed real and unfixed
  is the strongest reason to block); `refute` clears but is recorded verbatim, labelled an
  UNVERIFIED MODEL CLAIM everywhere *and* surfaced as an acceptance caveat, because it is the
  cheapest path past the gate and the only one whose evidence is a bare claim; `accept` is
  medium/low only; `address` requires references that both exist in the log and postdate the
  finding. Every rule is enforced twice — refused at the call so the log stays clean, and
  re-derived in the fold so a hand-forged event cannot launder a blocker on replay.
- **Two rounds, and the cap knows it.** With no qualifying round left, the blocker text stops
  prescribing a call that `delegate_task` refuses and hands the exits to the user instead.

---

## Capability packs

Three packs live outside the kernel and share one shape: a pure module with no kernel imports, its
own failure vocabulary, and thin tool wrappers above it. None of them adds an orchestration layer,
a plugin system, or a second agent loop.

### Documents and PDF (`artifacts/`)

**The loop is spec-centred:** request → read sources → author a `*.docspec.json` → render →
deterministic validation → *see* the pages → revise **the spec** → re-render. The spec is an
ordinary workspace file written with the ordinary file tools, which is what makes revision
snapshot-backed, undoable, diffable and attributable for free.

- **Substrate.** OOXML containers are opened **in memory only** — nothing is ever extracted to
  disk, so zip-slip is structurally impossible rather than defended against — with every entry name
  validated and entries/bytes capped on `max(size, originalSize)`, because a *stored* entry is
  materialized by its compressed size. Writing is deterministic: sorted entries, fixed timestamps,
  fixed level. XML parsing is size- **and** depth-bounded and strict.
- **Identification is by magic bytes and the content-types part, never the extension**, and never
  throws: every failure is an `unsupported` verdict whose reason echoes no file content, so a
  `.env` renamed `report.docx` fails the sniff without leaking a byte.
- **Readers return one summary shape whose first field is a coverage verdict** — `full`, `partial`
  or `structural`, with reasons — so "we read it" can never quietly mean three different depths.
- **DOCX rendering is byte-deterministic**: fixed relationship ids, fixed document-properties
  timestamps, real field runs for `{pageNumber}`/`{totalPages}`/`{date}`, real named styles, one
  numbering instance per list block, schema-ordered run properties. Same spec plus same image bytes
  yields the same sha256, pinned by rendering twice. The PDF is printed through the same probed
  browser from one self-contained HTML page (no script, no link, no external src — images are
  data URIs). **PDF bytes are not claimed deterministic** (Chromium embeds dates and ids); DOCX
  bytes are.
- **Validation is deterministic and model-free** — the half a non-vision session still gets in
  full. Each artifact is parsed **back**: outline equality, table shapes, dangling references,
  header/footer presence, a page field whenever one was asked for, printed page count, headings
  findable in the printed text. Two severities, deliberately separate: structural mismatches are
  **failures**; layout heuristics are **notes** that can never block, because the first false
  positive would turn a guess into a gate.
- **`inspect_pages`** rasterizes pages by injecting the bundled pdf.js into a blank page of the
  probed browser, enforcing a per-image byte ceiling by re-rendering at reduced scale. Pages become
  content-addressed blobs and ride the existing wire-image channel, so the vision choke and image
  aging apply unchanged.
- **Artifacts are products, never verification.** `artifact.rendered` and `artifact.inspected` can
  never satisfy a gate, and the report's asymmetry test pins it: a render exiting clean after a
  mutation leaves the file UNCHECKED.

### Web research (`research/`)

The one capability that sends anything off this machine.

**Egress is one host.** `research/tavily.ts` is the only code here that opens a connection, and it
opens exactly one. Page retrieval happens on the provider's infrastructure, so the pack owns no
redirect policy and no SSRF guard — it never fetches a model-named URL itself. The claim is scoped:
*the research tools'* egress is one host, **not** the harness's, and a configured proxy still
carries the connection. The approval prompt says both.

**Consent is the budget.** The first call asks with the query verbatim, the per-call bounds and the
remaining allowance. One budget object — searches, extracts, provider credits and retrieved
characters — is shared by reference between the parent and every researcher child, and rebuilt from
events on resume, so a restart cannot refill it. The credit ceiling is checked against the estimate
*before* the wire, so a call that would overshoot is refused whole rather than half-spent. Every
bound is re-enforced at execute, because `decide()` is a claim about what *will* happen and a
sibling can drain the remainder while a human reads the prompt.

**The registry split is what makes the claim structural.** The parent holds `web_search` only;
`web_extract` (full page text) and `record_source` are researcher-only. That is what makes "the
main agent never receives raw web pages" a property of construction rather than a promise. The
admissibility table is an exhaustive `satisfies Record<FactKind, boolean>`, so the next policy fact
breaks the typecheck rather than silently passing into a child registry.

**Untrusted content, three mechanisms, honestly ranked.** Ingestion sanitization; harness-delimiter
neutralization; and the UNTRUSTED fence plus the prompt contract — which is a **mitigation, not a
boundary**. A sufficiently persuasive page can still influence a model. What it cannot do is
*act*: a researcher holds no tool that writes, runs, or delegates. URLs are treated as identifiers,
so a value sanitization would alter is refused rather than escaped, and loopback, private,
link-local and bare-IP hosts are refused outright.

**Findings, not summaries.** `record_source` takes one falsifiable claim, its source URLs and a
corroboration verdict, and refuses `corroborated` backed by a single distinct source.
**Research never verifies anything**: research events never mark a file CHECKED and never satisfy a
gate. Acceptance carries two caveats instead — that the web was consulted at all, and that some
findings rested on a single source or on sources that disagreed.

### Git (`git/`) — two halves, split by what the user can see

- **Harness-owned** — everything that moves a ref, index, HEAD, branch, tag or remote the user
  sees: commits, checkpoint restores, prunes, the delivery anchor. The model has no path to any of
  it.
- **Model-facing** — reading repository state, and capturing a recovery point to a hidden ref.
  Both go through harness-composed argv, and neither changes anything the user's own `git status`
  would show.

Why a git tool needs a policy branch at all: `decide()` classifies a tool with no command, a null
mutation plan and no reads as `observe`/auto-allow — so a "git_commit" tool of that shape would
commit with **no** approval. That is pinned verbatim by a policy regression test plus a registry
guard, and it is why the two model-facing tools declare explicit facts rather than falling through.

- **`git_status`** takes a **view name and a bounded integer, and nothing else** — no ref, path,
  author or format parameter. That is the entire argument for allowing these reads on machines with
  no enforced sandbox: the model names a *view*, the harness names the command. Its `changes` view
  runs the same `prepareCommit` that builds the human's `/commit` preview, so the model's answer
  and the user's screen cannot drift. **Nothing it returns is file content**, which is what makes
  allowing before `readsPaths` is evaluated honest.
- **`git_checkpoint`** takes an optional label; the schema cannot express a restore, reset, commit
  or push. It auto-allows because a hidden ref built against a temporary index is the most
  reversible write in the system. Bounds replace the prompt: a per-session cap surfaced as a
  fact-level deny, and a **secret guard** that refuses to capture secret-named files `.gitignore`
  does not already exclude — `git add -A` excludes exactly what gitignore excludes and nothing
  else, and a git blob cannot be redacted.
- **Deliberate commits** stage only session-attributed paths by default, intersected with git
  status so every pathspec provably exists in git's view. Blockers where attribution would corrupt
  (missing identity — never set for the user; a pre-staged index); warnings for externally-modified
  session files and for unattributable `run_command` effects. Hooks run; failures are honest.
- **Checkpoints** run as plumbing against a temporary index, writing to hidden refs, so the
  user-visible git state is byte-identical before and after (tested). Honesty: **low-pollution, not
  zero** — loose objects and hidden refs are written, and `prune` frees them. A restore materializes
  content binary-safely and snapshots all current bytes **first** under one synthetic callId, so the
  whole restore is a single `applyUndo` unit.
- **Output discipline**: repository-authored text — commit subjects, author names, branch and tag
  names, paths — is scrubbed, neutralized and sanitized inside a labelled UNTRUSTED fence, because
  a cloned repository can carry "ignore previous instructions" in a commit message exactly as a
  stranger's pull request can.

**The consent contract, in full:** every mutating flow previews and interactively confirms
(non-interactive requires `--yes`); every operation appends a provenance event; `GitClient` is
reachable from the model only through the two tools above; and the model has **no unilateral path**
to any ref, index, HEAD, branch, tag or remote the user can see. "Never" would be an overclaim — a
human who approves `git commit` at the prompt has moved HEAD, and that is consent working, not a
hole.

**Hardening on every invocation**: git is resolved to an absolute path by scanning PATH directly,
because a bare name resolves against the child cwd on Windows and a `git.exe` planted in a
workspace must never execute (relative PATH entries are skipped, `.cmd`/`.bat` shims rejected);
`-c core.fsmonitor=false`, because a repository's own config must not start a daemon;
`GIT_OPTIONAL_LOCKS=0`; `GIT_TERMINAL_PROMPT=0` and no stdin; repo-targeting `GIT_*` variables
scrubbed; bounded timeouts. Parsed output is always `-z` porcelain.

### Remote delivery to GitHub (`remote/`)

The one capability that changes state on a machine the user does not own.

**Two facts, not one capability with a mode.** `remoteRead` and `remoteWrite` each have their own
fail-closed branch, which makes the thesis structural rather than documentary: the engine's
conflicting-contract rule then makes a tool that could both read and publish an automatic deny.
Consent follows the split — a read asks as `external` and is session-grantable within a real
counter; a write asks **every time**, is never passed through the grant path, and offers no `[s]`
in the prompt formatter. The same sentence is written in three places on purpose: a consent surface
that disagrees with itself is how standing authority gets won by accident.

**Observation binding.** A mutation must carry the live look at the remote its effect was computed
from; absent, or older than a kernel-owned maximum age, is a **deny**. Only `remote_status
view=refs` produces observations, so "understand the remote before you change it" is enforced by
the engine rather than requested in a prompt. The bound lives in `src/types.ts`, not in the pack,
so a workflow pack cannot widen its own leash. Observations and the gh identity are **in memory
only** and do not survive a resume, while the read/write spend **is** rebuilt from events —
authority is not durable, spending is.

**Looking never writes.** The only network verb is `git ls-remote`: no fetch, no remote-tracking
refs, no `FETCH_HEAD`. The cost is honest — a commit the remote holds and this repository has never
seen is genuinely outside our object database, so the relation reports `unknown` and a force push
over it is **refused even with `force`**, because the harness cannot say what would be discarded.

**What the human approved is what executes.** The refspec source is the observed oid, not a branch
name, so a local branch that moves while a human reads the prompt cannot change what is sent.
Execute re-reads both sides, runs `git push --dry-run --porcelain` and checks it structurally
(exactly one ref, the approved one, from the approved commit), pushes, then re-reads the remote to
set `verified` separately from `ok`. A force push carries `--force-with-lease` bound to the
observed oid, so the **server** enforces the same binding.

**The harness never holds a credential.** Authentication is gh's own stored credential and git's
credential helper. `GH_TOKEN`/`GITHUB_TOKEN` are dropped from child environments and *cannot* be
forwarded — recorded as a fact rather than worked around. All gh and git output is scrubbed of
credential shapes at the pack boundary and again at the event emit site. `gh` itself is managed
exactly like git: absolute-path resolution, `GH_REPO` scrubbed because it retargets every command,
debug variables scrubbed because gh's debug mode prints the Authorization header, prompts disabled,
bounded timeouts. `GH_HOST`/`GH_CONFIG_DIR` deliberately pass through — an enterprise host is
legitimate — and are recorded so an override is auditable.

**Everything is harness-composed.** Every argv is built from typed inputs in `--flag=value` form,
so model text lands only in value positions and a value beginning with `-` cannot become a flag.
There is no `gh api` passthrough and no generic escape. `gh release create` always carries
`--verify-tag`: without it gh silently creates the named tag from the default branch — a publish
nobody asked for, at a commit nobody named.

**Never a gate, in either direction.** Remote events never stale an acceptance, and a publish is an
acceptance **caveat**, never a blocker — including when it failed, and including when it succeeded
but could not be verified. Symmetrically, local verification state is *shown* in the publish prompt
and is deliberately **not** a precondition: making a green gate a requirement would make a green
gate an authorization, the exact inversion this capability exists to prevent.

**The compound invariant.** The model cannot commit, and a push transmits committed refs only.
Together: *the model cannot publish content a human did not commit.*

---

## Providers and networking

Five real providers over **two genuinely different protocols**, plus a mock, behind the same
`Provider` contract and the same `runTurn`. Everything provider-specific is either an adapter or
data; the runtime has no provider name checks (the single exception, the vision choke, reads the
catalog rather than a name).

| Module | Role |
| --- | --- |
| `catalog.ts` | The capability model **as data**: per-model context and output caps, vision support and tool-result image handling, reasoning mode and replay policy, caching style, lifecycle, quirk notes, and `budgetTokens` — *our* working-context cap, derived so the request fits the window under provider billing clamps, not the provider's raw number. Retired ids are absent; invitation-only models are never listed. An uncataloged model gets conservative defaults and a note. |
| `profiles.ts` | Per-provider wire deviations for the chat-compatible adapter: parameter names, usage-inclusion policy, strict-flag policy, reasoning-replay policy, usage extraction, extra finish reasons, error envelopes. |
| `errors.ts` | The `ProviderError` taxonomy plus a bounded **connection-phase-only** retry, `Retry-After` aware, with a deeper budget for rate limits (a throttle is expected to clear). |
| `sse.ts` | One incremental SSE parser handling chunk splits mid-UTF-8, CRLF, comment keep-alives, multi-line data and `[DONE]`. |
| `registry.ts` | The one construction and discovery seam: env-only key discovery (names and presence), base-URL overrides, and a bounded models-list validation probe. |

- **Anthropic** streams via the SDK with the abort signal passed through, and coalesces consecutive
  user messages at the wire (aborted turns and crash resumes legitimately produce them). The
  `thinking` parameter is deliberately omitted so each model's own default applies.
- **OpenAI** speaks the **Responses API**, not Chat Completions, because reasoning-item replay is
  Responses-only. `store: false` plus encrypted reasoning content keeps the harness stateless; the
  terminal payload is authoritative, and a failed or terminal-less stream throws rather than
  fabricating a turn.
- **DeepSeek, Kimi and GLM** share **one** Chat-Completions adapter parameterized by a profile.
  Load-bearing mappings: each tool result becomes its own `role: 'tool'` message before same-message
  user text; consecutive user text coalesces at the wire; and a stream that ends with neither
  `[DONE]` nor any finish reason **throws** a typed non-retryable error rather than committing a
  half-generated turn — a proxy idle half-close used to turn a truncated sentence into the model's
  final answer.
- **Mock** replays scripted turns offline and throws if exhausted. The entire loop, policy,
  snapshot, resume and report behaviour is proven through it, and its `hang` turns are the
  deterministic way to test mid-stream aborts.

**Opaque reasoning round-trip.** A content-block variant carries the provider-native artifact
verbatim, tagged with the producing provider *and* model. It is persisted additively, replayed at
the head of assistant content on resume, and **weighed but never replaced** by elision. Each
adapter replays only its own blocks for its own model, within that provider's documented scope.
Foreign or out-of-window blocks are dropped from the **wire view** only; `session.messages` is
never mutated. This is what makes always-thinking models and reasoning tool loops legal at all.

**Prompt caching.** The Anthropic request builder sets two ephemeral breakpoints — the system block
(tools plus system: the stable prefix) and a moving one on the final content block of the final
wire message, attached *after* coalescing and never on a replayed thinking block, whose bytes must
not change. The pipeline order is fixed: elide → scope reasoning → coalesce → cache-mark. The other
providers cache automatically. Cache accounting flows into events, `/status` and the report.

**Identity and honest degradation.** Selection precedence is flags, then user config, then the
catalog default; the workspace config layer structurally cannot express either. Credentials are
env-only — never a flag, never config, never a command argument — so they cannot reach argv, a user
message, or any event. `/provider` and `/model` are between-turns **user** commands (never tools:
the model cannot switch itself); they append `provider.changed` recording the env var *name*, the
API *host*, and how the key was checked. Readers fold identity newest-wins. **Vision degrades at
one choke**: when the catalog says a model has no image input, wire image parts are replaced with
an explicit stored-as-evidence pointer and `view_image` refuses with the same explanation — blobs,
metadata, DOM assertions, gates, checks and recovery are untouched.

**Networking** (`net/transport.ts`) is a reusable factory, deliberately decoupled from any
provider. `resolveProxy` is a pure function over the standard environment variables with a stated
precedence (an explicit override wins; the protocol-specific variable beats `ALL_PROXY`; `NO_PROXY`
overrides an environment-derived proxy but not an explicit override). **Every** network path goes
through it — including the registry's key-validation probe, because a bare global fetch ignores
system proxy settings and on a proxied machine produced a 401 for a valid key. A proxy dispatcher
is attached **per request**; `setGlobalDispatcher` is never called. Proxy URLs and any embedded
credentials are never written to the event log, the report, or any persisted state.

---

## The terminal

The REPL is a consumer of the same runtime: one session, `runTurn` per user line. `io.ts` owns the
**one** persistent readline — the idle prompt and approval questions share it, echo is muted during
turns (Ctrl+C still arrives), typed-ahead lines are buffered, and EOF at a pending approval
resolves to deny-and-stop. The pending resolver installs **before** the prompt bytes go out, so a
zero-delay driver answering the instant a prompt appears cannot land its answer where the question
never looks.

`render.ts` subscribes to `EventLog.onAppend`, so the screen is a live view of the persisted
evidence. Three render-only channels sit alongside it: streamed model text, the live command-output
preview, and the structured child-status channel. For all three, the persisted truth remains the
events. Long command output shows its head live, then an honest fold marker and the run's final
lines; `/expand` reprints it **from the record** — the spill blob when one was saved, the recorded
head and tail otherwise, provenance named either way — so it survives resume by construction.

**Stream split: stdout carries model text and requested artifacts only; stderr carries all chrome.**
Piped transcripts stay clean, and non-TTY chrome uses ASCII glyphs.

**The select surface.** Prompts on a TTY are arrow-key menus layered **over** the line grammar,
never replacing it. The widget owns no cursor code (the status area's overlay channel draws the
menu) and no answer grammar (menu picks submit their key; typed text opens a visible buffer
submitted through the *caller's* parser, so every scope rule holds). `captureKeys` detaches
readline's own keypress listener for the capture's lifetime — coexisting was the trap, since
arrow-up is history recall and Enter emits a line into type-ahead. **The initial highlight is
always the decline row — Enter never affirms.** Approval menus derive from the same label helpers
the frozen prompt strings use, cross-pinned by test so menu and text cannot drift. Everything is
TTY-gated, and every non-TTY path keeps the line grammar byte-for-byte.

**Contextual consent.** Four decisions are *asked* instead of requiring a remembered command: a
plan awaiting first approval, an approval invalidated by an amendment, an open repair escalation,
and a session that would accept cleanly. All four are pure folds over (plan bytes, event log), at
most one prompt per boundary. The boundaries split by session shape: an approved plan completing is
a delivery boundary, so plan-carrying sessions keep the turn-boundary offer, while plan-less work is
asked once at the typed `/quit` — never at EOF, never at a double Ctrl+C, because walking away is
not a consent moment. Three properties are load-bearing: they are **TTY-gated** (off a TTY the
question would consume a driver's next queued line); they fire **after** the turn's `finally`, not
at the end of the `try`; and they make **zero appends of their own** — every affirmative answer
calls the same body the slash command calls, pinned by running one fixture twice and comparing
event arrays.

**The status area** (`status.ts`) is the only cursor-moving code, strictly TTY- and stderr-confined.
All chrome routes through its status-aware writer, approval prompts suspend it, every turn's
`finally` clears it, and content is sanitized and clipped by **display column** per redraw. Off a
TTY it is a pure pass-through emitting **zero** escape bytes. Its safety rests on one structural
fact: the area is populated only during delegate flight, when the parent is blocked on the tool
call — so stderr cursor movement can never interleave with stdout model text.

**Sigils** are one table, not four inlined branches: `@plan`, `@review`, `@search`, `@research`.
The head guard is anchored, and an unknown `@word` is refused by name instead of falling through as
prose.

The slash-command surface is mirrored **as data** in `command-table.ts`, drift-pinned against the
dispatch switch in both directions, and used for both Tab completion and the `/` menu.
`/report [section]` slices the one rendered report; the inspection views keep their own rendering
because each carries live state the report structurally cannot (a re-probed project, re-probed
process liveness, memory-only remote identities, live research spend) or an action affordance.

---

## Limits that are real

Stated here because they are stated in the product too — in the banner, the report, the approval
prompts and the system prompt.

- **Trust is recorded consent, not isolation.** It changes what the agent is allowed to do, not
  what a process can technically do.
- **The sandbox is Windows-only and narrow.** It denies writes and reaps process trees. It does
  **not** stop reads, does **not** gate the network, permits writes to Low-labeled locations, and
  cannot hold service-reparented work. On any other platform, or on probe failure, there is no
  enforcement — and auto-run is disabled entirely.
- **Approved commands run unsandboxed**, at full user privilege, and their effects are not
  snapshotted and not undoable. The sandbox backs the *auto-run* decision, not an approval.
- **Undo is file-only.** It reverts the typed file tools' changes through content-addressed
  snapshots and refuses drifted files. It does not cover `run_command` side effects,
  out-of-workspace edits, or external changes.
- **Command output is not scrubbed for secrets.** Secret-classified *file reads* are redacted in
  the log; `run_command` stdout is captured verbatim. The narrow exception is remote delivery,
  whose gh/git output passes a credential scrubber that matches documented token shapes and URL
  userinfo — it is not a general secret detector.
- **Path checks are TOCTOU-racy**, as all path checks are. They are logical policy, not
  enforcement, and they guard the typed file tools rather than arbitrary shell text.
- **The command reviewer is a prompt-skip gate, not a boundary.** It is a positive proof of safety
  over the command string, so obfuscation lands in "ask" — but a string reviewer can never be a
  security boundary. The sandbox is what actually contains an auto-run command.
- **The untrusted-content fence is a mitigation, not a boundary.** A persuasive page or commit
  message can still influence a model; what it cannot do is act.
- **Symbol and import extraction is heuristic** (column-0 regex, no tree-sitter), so Rust `impl`
  methods, C++ templates and generated Go are invisible to the *map*. Live reads always see them.
  The Go import graph resolves by directory suffix, wrong only toward missing edges.
- **Ecosystem coverage is a bounded surface.** Node/TS, Rust/Cargo and Go are first-class; Python
  is minimal; C/C++ is detection and indexing only, with no build recipes; external database
  servers, Docker and containers are out of scope. `yarn` is implemented from documentation rather
  than live-proven.
- **DOCX visual fidelity belongs to Word.** DOCX claims are structural and parse-back verified;
  visual judgment happens on the PDF twin rendered from the same spec. PDF bytes are not
  deterministic. Editing pre-existing DOCX files, PPTX generation, footnotes, TOC fields, tracked
  changes, cell merges and RTL fidelity are out of scope rather than partially supported.
- **`--dangerously-allow-all` covers remote mutations too.** The policy engine returns `ask` for
  every publish and never consults a session grant, but that flag replaces the human at the prompt.
  "Asks every time" is a statement about the policy decision, not about that flag.
- **Legacy console note:** on Windows PowerShell 5.1, piping or redirecting output can re-encode it
  through the OEM code page and mangle non-ASCII text. Piped output uses ASCII status glyphs for
  this reason.
