# ROADMAP

Rolling execution record: the latest one or two sessions in full detail, older sessions
compressed under **Earlier Milestones** (per the rolling-docs policy in `CLAUDE.md`). Newest first.

---

## Session 8 (2026-07-22) — V0.7: coordinated parallelism + the minimal agent-teams layer

### Objective

Build outward from the proven V0.6 single-task primitives into a minimal, bounded agent-teams
system — real plan mode (planner role + persistent user-editable plan document + explicit user
approval gate), parallel task groups, a mutating executor role isolated in git worktrees with
approval forwarding and reviewed integration, and a reviewer role for bounded adversarial
review — with roles as explicit contracts, no second runtime, no policy side door, and no
unbounded swarm.

### Planning provenance

3 Explore-agent recon passes (runtime/task/policy; git/trust/state layout; REPL/report/tests)
+ targeted external research (worktree-per-agent as the industry isolation primitive; plan mode
as enforced read-only + persistent plan file + approval gate) + a Plan-agent adversarial
critique, every load-bearing claim hand-verified. The critique caught one CRITICAL design flaw
before code — the draft placed worktrees under the state dir, where `validatePath` denies every
child write (`.agent-cli` segment + stateDir protection ⇒ tmpdir home + path-guarded registry
sweep instead) — plus: the same-pid lock RECLAIM would let a colliding child silently merge a
live sibling's evidence (fixed structurally, not by the TOCTOU guard); a sessionId suffix
cannot fix same-session concurrent checkpoint temp indexes (per-op randomness + one base per
group); deny-stop mapped to task status 'error' (would misrecord the new per-task user-stop);
`reconstruct` kept only the LAST task.started per callId (a crash mid-group would orphan
siblings' evidence); forwarded approvals could deadlock a dead child (signal-linked queue
entries); group approval prompts were unanswerable (delegates-aware describeCall +
taskContext); shared MockProvider cursors are nondeterministic under Promise.all (per-task
provider seam); pendingNotes clear after one turn (standing plan injection).

### What was implemented (commits `d0abbb1`, `15a1f93`, `58f06ed`, `2cfe2ca`, + docs; stage order A→B→D→C→E)

1. **Stage A `feat(store,git,ids)` concurrency foundations** — 32-bit session-id suffixes;
   `EventLog.open(expectFresh)`: atomic exclusive log creation BEFORE any lock interaction
   (collision ⇒ `FreshLogCollisionError` + regenerate — refusal is structural; the old
   existsSync check was TOCTOU and the same-pid reclaim made collisions silent); atomic
   snapshot-blob writes (temp+rename; losing the rename race to identical content is success)
   + additive `putBlob`; checkpoint/restore/commit temp names gain per-operation randomness
   (pid alone collides once ONE process runs concurrent sessions).
2. **Stage B `feat(policy,runtime,tools)` role contracts + parallel groups** — `SUBAGENT_ROLES`
   policy-fact table in types.ts (explorer/planner/reviewer read-only; executor
   mutating-worktree) + `runtime/roles.ts` RoleContract rows (registry, prompt builder, budget,
   approval mode; load-time consistency check); step-0 rewritten for batches (try/catch around
   the fact, empty/unknown/conflicting deny, strictest member governs); `delegate_task` takes
   `tasks[1..3]` run via `Promise.all` INSIDE the tool — `runTurn` byte-identical, one call =
   one group = one evidence unit; caps: 12 tasks/session group-atomic + 150k cumulative child
   output tokens; planner/reviewer prompt builders over the shared read-only scaffold;
   consumers batch-corrected (childSessionId joins, reconstruct keeps all task.started per
   callId, task chrome + turn-summary counts, delegates-aware approval descriptions).
3. **Stage D `feat(plan,policy,repl,cli)` plan mode** — plan documents at
   `<projectDir>/plans/<sessionId>.md`: lenient never-throwing reads, atomic writes,
   blob-archived priors, harness-owned frontmatter (model writes NEVER change status; smuggled
   frontmatter stripped); `update_plan` behind the new fail-closed `planDoc` policy branch
   (the S6 observe-trap pinned a third time); `plan.updated` via the callId-bound `reportPlan`
   channel; `/plan show|approve|discard` with approval binding the exact sha (consent
   evidence; later divergence surfaced, never hidden); `@plan` forced routing; standing
   per-turn injection (full content only when the sha is new to the model, pointer otherwise,
   sovereignty wording verbatim); executor gate on unapproved plans; `agent plan` CLI; report
   "## Plan" section; system-prompt Planning rule.
4. **Stage C `feat(git,runtime,tools)` executor role** — policy flip to ask/`reversible`
   (`task.mutating-role`, deliberately non-grantable — every spawn is a human decision); ONE
   base checkpoint per group (dirty parent state included) → detached worktree per task under
   `<os-tmp>/agent-cli-worktrees/<slug>/` (placement dictated by validatePath) → child scoped
   to the worktree with fresh git facts/map → bounded binary-safe capture (porcelain
   enumerate, read-tree+checkout-index base staging, content-addressed blobs, 200 files/5 MiB
   caps, overlap warnings) recorded as `task.changes` → worktree ALWAYS removed (EBUSY retries
   + rm fallback + prune; failures are `worktree.removed ok:false` evidence; crash orphans
   swept at assembly from a path-guarded registry). Approval forwarding: serialized queue
   wrapping the SESSION approver (non-interactive fail-closes structurally, EOF cascades
   deny-stop), taskContext-labeled prompts, signal-linked entries ('task-aborted' auto-deny,
   loud stale-answer discard), forwarded deny-stop ends THAT task only (`user-stopped`).
   Integration: `apply_task_changes` declares apply-eligible paths via `mutates()` (never
   null) so the existing snapshot/file.mutated/undo/attribution machinery does the writing;
   per-file drift-refuse; registry rebuilt from events on resume. Trust decision: worktrees of
   a trusted workspace are trusted BY DERIVATION, never written to trust.json.
5. **Stage E `feat/docs`** — review-stage prompt rule (ONE bounded panel of 2–3 reviewer
   lenses, parent hand-verifies findings — the CLAUDE.md cost discipline encoded in the
   product prompt); report "Task changes and integration" section + executor honesty footer;
   render-only stall chrome ("no activity for Ns"); USAGE bump; ARCHITECTURE/ROADMAP/BLUEPRINT
   updates.

### Verification evidence

- **Gate:** `npm run typecheck` + `npm run build` clean per commit; suite grew 450→**498
  passed / 1 skipped across 42 files (+48)**: expectFresh refusal leaves a live sibling's lock
  byte-identical and its log writable; startSession regenerate/exhaustion; atomic blobs;
  concurrent same-pid checkpoints (distinct refs, correct trees, clean state dir); policy
  pinning-table extensions (batch unknown/empty/throwing/conflicting; executor ask/reversible
  + reversible-grant no-op; planDoc trap pins); 3-child parallel e2e (per-child providers, one
  callId, three lineage-stamped logs, ordered labeled reports, context passthrough); abort
  mid-group ends every child `aborted` with a complete parent log; group-atomic cap refusal
  spawns nothing; plan store roundtrip/status-preservation/frontmatter-smuggle/leniency/
  user-edits-win; REPL plan e2e (update_plan → /plan approve → labeled injection → divergence
  → discard stops injection; @plan routing); forwarder units (FIFO, abort-while-queued never
  displays, loud late-answer discard, throwing base fails closed); real-git executor e2e
  (dirty base reached the child, isolation proven from both logs, capture shapes incl.
  delete, cleanup + empty registry, apply through the snapshot path with one-unit undo, drift
  refusal declares nothing and touches nothing, forwarded deny-stop → `user-stopped` with the
  parent turn surviving, draft-plan block, path-guarded sweep leaves foreign dirs untouched,
  honest no-repo refusal); report plan/integration sections.
- No live-API E2E this session (mock-driven e2e coverage is dense; a live plan→approve→
  executor→apply→review run is the recommended first act of Session 9).

### Decisions (and why)

- **Parallelism lives in the delegate tool, not runTurn** — one call = one parallel group = one
  attributable evidence unit = one approval for a mutating group; the kernel loop stays
  byte-identical (the strongest form of the one-runtime invariant); the schema max (3) IS the
  concurrency cap.
- **Roles are two-layer contracts:** the policy fact table (types.ts, data-only — decide()
  fails closed on anything outside it) and the runtime contract table (roles.ts). Adding a
  role is a deliberate two-table act, pinned by a load-time consistency check.
- **Stage order A→B→D→C** (BLUEPRINT said worktrees before parallel groups): D-before-C lands
  the plan-approval gate BEFORE the capability it gates and makes the coherent fallback
  increment (plan mode + parallel read-only teams) if C overran.
- **Worktrees live in the OS temp dir** — dictated by verified policy behavior, not taste:
  under the state root every executor write would deny (`.agent-cli` segment rule); under the
  project dir likewise (stateDir protection). The registry+sweep owns the crash story and can
  never touch a path it did not create.
- **The diff outlives the worktree:** capture-to-blobs + `task.changes` events make the
  worktree disposable (removed in finally, every time) and integration replayable across
  crashes/resume — no long-lived checkout to leak, reconcile, or trust.
- **Integration rides the existing write path** — apply declares real paths via `mutates()`,
  so snapshot/undo//diff//commit attribution came for free and the S6 observe-trap stayed
  closed. Per-file drift-refuse mirrors the snapshot-restore philosophy.
- **Plan approval binds bytes, not vibes:** `plan.approved {sha256}` is the consent record;
  the file's current bytes stay truth; divergence is surfaced at every injection and executor
  spawn rather than silently blocking (the per-spawn ask is the enforcement point).
- **Executor spawns are never grantable** (`reversible` excluded from GRANTABLE, pinned): a
  session grant would let later groups mutate with no human in the loop.

### Open issues / boundaries (deliberate, documented)

- Per-task cancellation = forwarded deny-stop + harness causes (timeout/tokens/parent-abort);
  a mid-turn task-management UI (list/cancel while running) remains deferred. Ctrl+C still
  aborts the whole turn.
- A stale forwarded prompt left displayed after its task dies consumes the user's next typed
  line as its answer; the discard is LOUD (chrome line) but the line is still consumed —
  bounded, documented, fixable only with a deeper io redesign.
- Executor worktrees lack gitignored files (no node_modules): builds/tests may need installs
  (forwarded approval) or the executor honestly reports UNVERIFIED. Sandbox scratch TEMP is
  still shared across concurrent sandboxed auto-run commands (read-only commands; collision
  risk accepted). Task-base checkpoints accumulate as hidden refs until `checkpoint prune`.
- The reviewer stage is prompt-shaped (role contract + review rule), not structurally forced;
  the parent may skip review — the report's CHECKED/diff surfaces stay the backstop.
- `--provider mock --script` still shares one script between parent and children (tests use
  the per-task provider seam); no cross-log cost roll-up view yet; task resume, inter-agent
  messaging, and deeper child-report instruction-scanning remain out (delimiters + provenance
  labels stand).

### Recommended next step

Live-API E2E of the full V0.7 loop (@plan → approve → parallel executors with a forwarded
approval → apply → review panel → /undo), then per BLUEPRINT: the first non-coding workflow
pack (documents/PDF) on the now-complete kernel, or the deferred-pool UX debts (per-task
cancel UI, cross-log cost roll-up) if live usage surfaces friction first.

---

## Session 7 (2026-07-20/21) — V0.6: main-agent control layer — project memory + subagent tasks

### Objective

Evolve the single-agent loop into an explicit main-agent control layer (the main agent keeps
user interaction, authority, coordination, integration, and final claims) by adding two
subsystems beneath it: a built-in three-document project memory (user-owned `AGENT.md` loaded
every session; harness-generated rolling `JOURNAL.md` + architecture `CODEBASE.md`,
auto-updated after productive sessions, auto-loaded at start, context-not-authority) and the
first dependable task/subagent primitives (one read-only `explorer` role with explicit
contract: isolated context, inherited-or-narrower authority, fixed budget, cancellation,
attributable parent↔child evidence lineage) — without a second execution loop, a policy side
door, or broad multi-agent scope (teams/parallelism stay Session 8).

### Planning provenance

3-Explore-agent recon (session lifecycle/context pipeline; evidence/event/state model;
policy/exec/concurrency audit — verdict: the kernel is per-session value objects, structurally
ready) + external research (Claude Code subagents/auto-memory, Codex AGENTS.md/memories) + a
Plan-agent adversarial critique that caught real flaws before code, hand-verified: the
`latestSessionId` hijack (child logs sort newest ⇒ `--continue`/undo/diff/commit/report would
silently target the newest CHILD log), the delegates-branch placement requirement (step 0 +
conflicting-contract deny), a live product bug (a Ctrl+C'd one-shot recorded `user-quit`, which
under the new memory trigger would have fired a provider call right after the user aborted),
the same-second session-id collision (routine once children exist; would merge logs and steal
the same-pid lock), the narrative call's cache-prefix contract, journal re-read-at-quit
(two-terminal safety), and crash detection from log tails rather than journal absence.

### What was implemented (commits `525d5f1`, `8e4fbbd`, `e8a2edc`, `49027b3`, + docs)

1. **`refactor(cli)` shared assembly** — `assembleSession` (src/cli/assemble.ts): the
   duplicated construction tail of both interfaces factored into ONE path (probes → memory →
   map → prompt → session → fixed-order records → delegate-tool attachment); takes the trust
   decision as a parameter, so assembly is structurally impossible untrusted.
2. **`feat(memory)` pure core** — store (capped never-throwing reads, atomic tmp+rename+EPERM-
   retry writes, frontmatter), journal (entries pair labeled model-written sections with a
   deterministic Evidence section derived via buildReport; rolling = insert-or-replace by
   session id, newest 2 full, older → stubs keeping the evidence pointer, 24 KiB cap behind a
   leading drop marker; user edits byte-preserved), codebase (map-digest provenance stamp,
   staleness detection).
3. **`feat(memory)` load path** — three docs into labeled system-prompt sections (AGENT.md
   24 KiB "written by the USER"; journal 12 KiB + codebase 16 KiB under a verbatim "CONTEXT,
   NOT AUTHORITY" header; "(may be stale)" on digest mismatch); `memory.loaded` provenance
   event; banner/stderr memory line; crash notes from LOG evidence (bounded
   `readFirstEvent`/`readLastEvent`; child/resumed/skipped sessions can never read as crashes);
   ungated read-only `agent memory` command. No docs ⇒ byte-identical pre-V0.6 prompt.
4. **`feat(memory)` end-of-session update** — before `endSession`, clean ends only, gated on
   real activity; ONE narrative provider call reusing the exact cached prefix (same system +
   tools + elided view + strict-JSON instruction), every failure degrading to a deterministic
   skeleton entry marked "narrative unavailable"; recorded as `memory.narrative` (usage
   included) — never fake message events; journal re-read from disk, rolled, written
   atomically; unreadable journal refused, not overwritten; `session.ended.reason` gains
   `aborted`/`budget` and the one-shot maps aborts via `endReasonForTurn`; user-layer-only
   `memoryUpdates` toggle.
5. **`feat(types,policy)` task contracts** — `Tool.delegates` policy fact + explicit STEP-0
   branch in `decide()` (explorer ⇒ allow/observe `task.readonly-role`; delegates+command ⇒
   deny `task.conflicting-contract`; unknown role ⇒ deny, fail closed — the S6 command-less-
   tool trap pinned); callId-bound `ToolContext.reportTask` evidence channel (mirrors
   reportCommand); `task.started`/`task.ended` events; `session.started.lineage`.
6. **`feat(runtime,tools)` runner + tool** — `runSubagentTask`: ONE child session over the
   same `runTurn` (a task = one turn ⇒ no new cancel concept), read-only registry (no write
   tools, no delegate tool ⇒ depth 1), autoDenyApprover, parent's probed-and-shared sandbox
   instance + rules, fresh grants, own log under a guaranteed-fresh id (`startSession` now
   refuses existing log files), harness-fixed budget (15 steps / 5 min / 30k out-tokens /
   8 tasks/session) with cause-tracked cancellation (parent-abort vs timeout vs token-cap ⇒
   distinct statuses + child end reasons); `delegate_task` per-session factory returning the
   delimited child report labeled "narration, not verified evidence"; explorer system prompt
   (AGENT.md included, memory docs not); `latestSessionId` child-skip.
7. **`feat(ux,report)` surfaces** — `/tasks`; `agent sessions` child labels; report "Delegated
   tasks" section + usage-separation footer; `reconstruct` answers a crash-orphaned delegate
   call with the surviving child-log pointer; `[task]` progress chrome in both interfaces;
   parent-prompt Delegation rule (reports are narration; the main agent owns final claims).

### Verification evidence

- **Gate:** `npm run typecheck` + `npm run build` clean per commit; `npm test` **450 passed /
  1 skipped across 40 files** (was 403+1; **+47**), covering: journal roll/caps/user-edit
  byte-preservation goldens; atomic-write/corrupt-tolerance; injection sections + staleness +
  crash-note discrimination (incl. torn-tail and lineage fixtures); update-flow happy path /
  script-exhaustion fallback / gate skips / resume-replace / cache-prefix spy (byte-identical
  prior conversation + same system/tools) / unreadable-journal refusal; delegation policy
  branch (wide-schema stubs pin the engine, not the tool schema; existing decide() table
  unchanged); full subagent E2E with separately scripted parent+child (event order + callId
  join + resultSha256, lineage, child-cannot-write/escalate, budget matrix
  steps/tokens/timeout/parent-abort, task cap spawns nothing, TOOLS purity, latestSessionId
  skip, aborted-parent completeness); report/reconstruct task surfaces.
- **Live API E2E** (real claude-opus-4-8 via proxy; temp TinyCalc workspace with `AGENT.md`):
  Session 1 — banner `memory: AGENT.md 180b`; `delegate_task` auto-ran (`task.readonly-role`)
  with live `[task]` progress lines; the child explored in 1 step (4 in / 962 out tok); the
  parent model then **re-read the files itself to verify the subagent's claims before
  summarizing** (the delegation-rule behavior, unprompted) and its summary ended with the exact
  marker line AGENT.md demanded; `/tasks` rendered the row; `/quit` → "updating project
  memory…" → JOURNAL.md + CODEBASE.md written with provenance (parent session: 6 uncached
  input tokens — caching intact). Session 2 — banner
  `memory: AGENT.md 180b · journal 1.6k (1 session) · codebase 1.3k (fresh)`; asked "what
  happened last session?" with no file reads: answered correctly from the journal/codebase
  (session id, the delegation, formatSum details), volunteered the context-not-authority
  caveat, honored AGENT.md again; being chat-only it correctly SKIPPED the journal update.
  CLI: `agent sessions` labels the child `[task:explorer of <parent>]`; parent report shows
  the Delegated-tasks section; `agent report <childId>` is self-contained (sandbox header,
  usage, task).

### Decisions (and why)

- **Memory home = state root** (`<projectDir>/memory/`), names `JOURNAL.md`/`CODEBASE.md`
  (user-confirmed): zero git pollution, harness write-ownership, still plain user-editable
  markdown (`agent memory` shows paths); distinct names avoid dogfooding collisions with this
  repo's hand-written ROADMAP/ARCHITECTURE.
- **Memory is context, never authority — structurally:** sovereignty wording injected verbatim;
  evidence sections derived from events (never model recollection); the narrative call recorded
  as its own event type because faking message events would replay into resumes; crash
  detection from log evidence so absence-of-memory never accuses a session.
- **A delegated task is ONE turn** of the same runTurn — no second loop, and turn-level
  cancellation IS task cancellation; parallelism deliberately deferred until worktrees.
- **Delegation is a first-class policy fact** with a fail-closed step-0 branch; budgets are
  harness-fixed, never model-controlled; child narration is labeled and the parent prompt
  instructs verification (observed working live).
- **Aborted ≠ user-quit** (`endReasonForTurn`): post-session work must never fire after Ctrl+C.

### Open issues / v1 boundaries (deliberate, documented)

- One task at a time; cancelling a task = Ctrl+C on the whole turn; task cap is per process
  run; `--script` mock shares one script between parent and child (tests inject a second
  provider). Parallel tasks, mutating/approval-forwarding roles, worktree isolation (+ its
  trust-inheritance decision), task resume, child memory, and deeper child-report scanning are
  Session 8+ material.
- Memory docs are lock-less: re-read-at-quit + atomic rename leaves a seconds-wide
  last-writer-wins window (two simultaneous quits); the log remains the evidence.
- The journal inject cap slices the newest-first file top; `sessionCount` counts the loaded
  window only. Assistant/user-text compaction and journal topic files remain future work.
- Child usage is deliberately excluded from parent totals (stated in report footer); a
  cross-log cost roll-up view does not exist yet.

### Recommended next step

Session 8 per BLUEPRINT: coordinated parallelism on these primitives — worktree-isolated
children (GitClient/checkpoint are already instance-scoped; decide trust inheritance for
worktree paths; add the sessionId suffix to checkpoint temp-index names), bounded parallel
read-only tasks, then the first mutating role behind approval forwarding. Fold in the
auto-run system-prompt hint and the cached sandbox host when touching those areas.

---

## Earlier Milestones (Sessions 1–6.5 — compressed per the rolling-docs policy)

### Session 6.5 (2026-07-19) — V0.5 capability demo + production-style validation

One continuous ~68-min recorded run (real ConPTY → xterm.js → Playwright, byte-truthful,
supervisor-driven, live claude-opus-4-8): Agent CLI built **LedgerLite** (personal finance
tracker; 20 files, 51 unit tests, esbuild build) from a natural-language brief with 13 live
approvals, then demonstrated status/diff/attributed commits (`package-lock.json` honestly
excluded as unattributable)/checkpoint/restore/undo/report, sandboxed auto-run `git status`,
deny-adapt (the fallback summary labeled itself "not a live diff read"), harness-note
coherence after /undo, and **124 uncached input tokens** for the whole session (cache 2.07M
read). Two product fixes with regression coverage from the pre-run foundation review: sandbox
probe 60s+retry behind an injectable ProbeRunner (`763032f` — a loaded probe took ~18s vs the
old 30s timeout, silently degrading to fail-closed) and the Low-IL test's absolute-System32
whoami (`21a8c40`). Suite 403+1. Evidence: `C:\Users\A\Desktop\ledgerlite\validation\` (MP4,
raw PTY transcript, deterministic session report, VALIDATION.md). Lasting decisions: validation
sessions live OUTSIDE the product repo; the bridge identifies itself truthfully
(`TERM_PROGRAM`); demo briefs state git authority explicitly. Standing findings: the
positive-proof auto-run gate rarely fires for the model's natural chained/flagged command
style (system-prompt hint in the deferred pool); probe cost ~4–11s on this machine.

### Session 6 (2026-07-18) — V0.5: Git-native, reviewable, context-efficient

GitOps as a **harness-only capability** — a policy regression test pins why it must never be a
model tool (a command-less, mutation-less tool auto-allows as observe; a "git_commit tool"
would commit with NO approval): hardened substrate (absolute-path git resolved by scanning
PATH — a workspace-planted git.exe must never execute; `core.fsmonitor=false`;
`GIT_OPTIONAL_LOCKS=0`; GIT_* scrub; no prompts; bounded timeouts), probed `git.context`,
attributable `/diff` + `agent diff` (first pre-image blob → disk, undo folded, DRIFTED
flagged), session-scoped `/commit` (stages ONLY status∩attribution; blockers where attribution
would corrupt; Session line + Co-authored-by trailer), hidden-ref checkpoints
(`refs/agent-cli/checkpoints/<session>/<n>`, user git state byte-identical, "low-pollution
not zero") with snapshot-first restore that is ONE applyUndo unit — git is never the undo
mechanism (the Codex ghost-commit data-loss lesson). Context efficiency: two-breakpoint prompt
caching (live: ~6 uncached input tokens/session), deterministic monotone elision (boundary a
function of raw only-growing size ⇒ no oscillation, no stored state, identical on resume;
tool outputs only), git-backed workspace map (nested gitignore correct; pre-trust keeps the
pure walker). Editing: replace_all + line paging. **Consent contract made explicit:**
user-typed commands ARE consent under three conditions — preview+confirm on every mutating
flow, a provenance event per operation, GitClient structurally unreachable from the model.
398+1 tests; scripted REPL + CLI round-trip + live-API E2E. Still-open from S6: approved
run_command file effects structurally under-claimed by attribution; restore materializes the
git-native worktree form (same lossy round-trip as git itself); `agent commit`/`checkpoint`
need the session lock (a live session blocks them by design).

### Session 5 (2026-07-18) — V0.4: enforced isolation + automatic command review

An OS-enforced Windows boundary plus deterministic automatic command review, **feasibility proven
by direct machine probe before any code**: as a standard non-admin user, a Low-integrity child
(duplicated, lowered copy of our own token via `CreateProcessAsUser`) is write-DENIED by MIC to
the workspace/profile/state dirs while stdout flows through inherited pipes; `WRITE_RESTRICTED`
restricted tokens FAILED (err 1314) — so Low IL + Job Object (KILL_ON_JOB_CLOSE, process cap) is
the mechanism. `src/sandbox/`: `SandboxBackend` with a `wrapSpec` transform-at-spawn seam, honest
`none` backend, and `windows-lowil` — a versioned PowerShell + inline-C# (Add-Type P/Invoke) host
that re-launches the target at Low IL forwarding inherited std handles, so `runManaged`
capture/kill are unchanged; enforcement is established by a runtime **self-test probe**, never
assumed, and degrades fail-closed. `policy/command-review.ts`: `analyzeCommand` is a POSITIVE
proof of safety (single simple command, zero metacharacters/encoding, curated read-only
allowlist, per-executable arg checks, escape guard); auto-run requires proof AND an active
boundary and executes INSIDE it; otherwise ask; no enforcement ⇒ every command asks. Approved
commands deliberately run unsandboxed (the user accepted the risk — Codex's model). Labels
hardened (LOLBAS/encoded no longer read benign) but only ever inform the human. `run_command`
moved to `-EncodedCommand`; report gained the sandbox header + per-command boundary markers +
mode-aware honesty footer. **Evidence:** 321 passed/1 skipped (+80); 8 real-OS win32 tests
(write DENIED to workspace+state, reads allowed and stated, child at Low IL, detached grandchild
reaped on kill — closing the S4 taskkill gap); 66-assertion adversarial corpus (40+ escape forms
NEVER auto-run); live CLI E2E with sandboxed auto-run + non-interactive auto-deny. **Honest
scope (unchanged since):** confines writes + lifecycle on Windows only; reads, network,
Low-labeled locations, and service-reparented work are NOT confined. **Still open from S5:**
per-command Add-Type host latency (S6.5 measured the probe at ~4–11 s on this machine); CLIXML
stderr cosmetics.

### Session 4 (2026-07-17) — V0.3: execution kernel hardening

Managed exec substrate (`src/exec/`: env hygiene with a non-excludable core floor, verified
best-effort tree kill, `runManaged` kill/drain state machine that never awaits `'close'`
unconditionally — the nodejs/node#21960 grandchild-pipe hang class, regression-tested); real
mid-command cancellation end-to-end (REPL + one-shot, proven with a genuine delivered console
CTRL_C against the live API); typed termination — **a killed command has no exit code,
everywhere**, and the report vetoes CHECKED on kill evidence; additive `command.started/ended`
lifecycle events; Ctrl+C wiring + live render-only output preview. **Lasting decisions:**
force-kill only, labeled best-effort (no graceful console kill from stock Node on Windows;
`taskkill /T` cannot reach re-orphaned grandchildren — later closed by the S5 Job Object for
sandboxed runs); `'interrupted by user'` reserved for never-spawned calls; env hygiene
default-on with proxy passthrough documented as an honest limitation, not a boundary; evidence
channels are callId-bound by the runtime so tools cannot forge another call's evidence.
**Evidence:** 240 passed/1 skipped (+35); two live E2E runs (env-hygiene echo; keystroke-level
CTRL_C interrupt with full evidence chain). **Cost lesson (now a CLAUDE.md rule):** a
per-finding 3-verifier fan-out exploded (19 findings → ~57 agents) and was aborted; findings
were salvaged from the workflow journal and verified BY HAND — review workflows stay bounded
(~a dozen agents), no per-finding verifier panels. Three low-severity review findings remain
open (append-inside-spawn-listener robustness; live-preview per-chunk decode; one-shot
approval-prompt Ctrl+C path).

### Session 3 (2026-07-16) — Recorded live E2E demo + two defects it surfaced

Not a product increment: a truthful, continuous **11m20s Playwright-recorded** demonstration of
the V0.2 loop (empty-folder launch, on-camera trust consent, natural-language build of a complete
web app with inline approvals, in-session `/report`, quit, interactive resume with a follow-up
change, starting the generated server, driving it in the browser). Artifacts live OUTSIDE this repo
(`C:\Users\A\Desktop\agent-cli-demo-20260716\`). The agent (real `claude-opus-4-8`) built
**FlowBoard** (7 files, ~865 lines, 15 unit tests) in one 128s turn + a 35s resumed turn, 2
approvals, all files CHECKED. **Product yield (2 fixes, both regression-tested):** the CLI entry
guard now realpaths `argv[1]` so the `npm link` shim no longer exits 0 silently (Node realpaths the
main module URL); vitest `testTimeout` raised to a 60s hang backstop (bare Node spawns can take
seconds under load). **Lasting decision:** record a browser-hosted real terminal (xterm.js ↔ ConPTY
bridge) since the CLI needs a real TTY; every displayed byte comes from the PTY, injected setup
lines disclosed. **Evidence:** 205 passed/1 skipped; the recorded session's evidence chain was
independently audited by a 4-agent workflow (report ↔ raw JSONL consistent, snapshots re-hash,
isolation clean). **Still-relevant nuance:** the report's "Files changed" uses last-mutation-per-path
semantics, so a create-then-edit renders as `modify`.

### Session 2 (2026-07-15) — V0.2: interactive REPL, workspace trust, narrowing-only config

One-shot CLI evolved into a practical interactive REPL sharing the exact same runtime (one
`runTurn`, no parallel loop), with turn abort at tool boundaries, a live `EventLog.onAppend`
renderer, and subprocess smoke tests. **Lasting decisions:** workspace trust is recorded consent
(never a sandbox) — prompt only on a real TTY, `--trust-this-workspace` never persists, a folder
cannot self-grant (state-root-inside-workspace refusal), corrupt trust store is a hard error;
workspace config narrows only (strict schemas structurally cannot widen; no allowlists) and
carries no preferences; the screen renders from the persisted log, stdout stays model-text-only;
`user-quit` for every human-initiated end; approval questions accept only lines typed after the
prompt is visible (type-ahead cannot answer a security prompt); approval prompts sanitize
model-controlled text (ANSI/bidi). **Evidence:** 204 passed/1 skipped; three live E2E rounds
(build + deny-adapt + `/undo` + interactive resume) with three real defects found and
regression-tested (in-session `/report` status, denied command listed as run, piped transcripts
losing dialogue); post-E2E adversarial review found four more real defects, all fixed + tested
(type-ahead approval, unsanitized approval prompt, abort-skipped commands under "Commands run",
trust-consent Ctrl+D exiting 0). **Still relevant:** `agent map` stays ungated pre-trust
(documented exception); V0.2's "abort lands at the next tool boundary" limitation was removed in
Session 4.

### Session 1b (2026-07-14) — Automatic proxy support + verified live E2E

Reusable proxy-aware transport (`net/transport.ts`): pure `resolveProxy` over standard env vars
with correct precedence/`NO_PROXY` bypass; per-request undici `ProxyAgent` dispatcher (never
`setGlobalDispatcher`); credentials redacted from descriptions and never persisted; no `--proxy`
flag (argv is logged — a credential-bearing URL must not land in `session.started`). Closed
Session 1's one unverified surface: the full live loop (create + edit + undo) verified against
the real API through the system proxy; 143 passed/1 skipped.

### Session 1 (2026-07-14) — V0.1: the bounded local agent loop

The seven-pillar foundation, all tested (121 passed/1 skipped + dogfood run): typed contracts
(`types.ts`), append-only JSONL event log (atomic lock, tail repair, corruption refusal,
versioned schema), one pure policy choke point + Windows-first path validator (device/UNC/ADS/
reserved rejects, junction escape, sibling-prefix containment), five file tools + `run_command`
(PowerShell `$LASTEXITCODE` propagation), content-addressed snapshots with drift-refusing
restore + undo, resume with postHash crash reconciliation, bounded gitignore-aware workspace map,
deterministic evidence report (mechanical CHECKED/UNCHECKED), Mock + streaming Anthropic
providers. **Lasting decisions:** no *widenable* allowlist config — the label only informs the
human (V0.1 asked on every command; **superseded in S5** by deterministic automatic review, where
a positive-proof-safe command auto-runs *inside* the enforced sandbox); in-workspace writes
auto-allow but snapshot first; sandbox vs approval kept separate — V0.1 shipped approval only and
said so, **and S5 added the enforced Windows sandbox axis**; one path validator for policy and
tools; secret reads redacted in the log via salted HMAC (model still sees real bytes; redacted
reads deliberately cannot replay on resume); state lives outside the workspace; `thinking` omitted
pending block-preservation work. **Still-true limitations:** command output not scrubbed for
secrets; path checks TOCTOU-racy; undo is file-only; single-user lock assumption. (V0.1's "no OS
sandbox" limitation is closed on Windows in S5 — writes only; reads/network remain unconfined.)

---

## Deferred pool (accumulated, still open)

Adaptive thinking with block preservation; per-action / `--to` / `--steps` undo; tree-sitter
ranked repo map with selective retrieval (S6 shipped the git-backed file LIST only); network/web
tools; MCP and workflow packs; SQLite index over the JSONL; conversation rewind; session
pruning/sanitized export; prompt-history persistence + line-editing niceties; background/
long-running process sessions; PTY support; output spill-to-file for huge command output.
**Task/subagent follow-ups (post-S8; S8 shipped parallel groups, worktree-isolated executors
with approval forwarding + reviewed integration, and the planner/reviewer roles):** a mid-turn
per-task management UI (list/cancel while running — today: forwarded deny-stop + harness
causes); task resume/continue (SendMessage-style); deeper scanning of child reports for
instruction-shaped content (v1 ships delimiters + provenance labels); cross-log cost roll-up
view; the stale-displayed-forwarded-prompt line-consumption wart (needs an io redesign);
per-child sandbox scratch TEMP isolation; pruning/GC policy for accumulated task-base
checkpoint refs; a structural (not prompt-shaped) review gate. **Memory follow-ups (post-S7):** journal topic files / retrieval beyond the
newest-first inject window; a memory relocation/config knob; model-generated compaction of
assistant/user text (deterministic tool-output elision shipped; loud warning when even full
elision exceeds the target). **Git follow-ups (post-S6):** patch/multi-edit editing; model-
generated commit messages; attribution of approved run_command file effects (structurally
under-claimed today); push/PR flows; submodule + multi-repo workspaces. **Sandbox follow-ups
(post-S5):** network-egress control and a read/confidentiality boundary (the two enforced gaps
that most matter); a cached/compiled sandbox host to cut per-command Add-Type latency (~1.2 s;
probe ~4–11 s on this machine); macOS/Linux enforcement backends; containment of
service-reparented work (schtasks/sc/wmic/BITS) that escapes the Job Object.
**Command-review follow-up (S6.5 finding):** a system-prompt hint describing the auto-runnable
command shape (single unchained read-only command, no extra global flags) — the model's natural
chained/flagged style meant nearly every command asked during the demo; the hint raises the
auto-run hit rate without weakening the positive-proof gate.
