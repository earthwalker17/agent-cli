# ROADMAP

Rolling execution record: the latest one or two sessions in full detail, older sessions
compressed under **Earlier Milestones** (per the rolling-docs policy in `CLAUDE.md`). Newest
first. Contracts and mechanisms live in `ARCHITECTURE.md`; this file records what each session
attempted, verified, decided, and left open.

---

## Session 12 (2026-07-25/26) — Unified verification gate and typed recovery

### Objective

Make testing, building, checking, and debugging an explicit part of the task-graph lifecycle
rather than a collection of model-chosen shell commands: a task declares how it will be verified,
targeted checks run after it completes, dependents unblock only when the required gate is green,
broader checks run at the integration and completion boundaries — and every failure is CLASSIFIED
before any repair is planned, with repair bounded by policy and stopping honestly instead of
looping.

### Planning provenance

3 Explore recon lenses + 1 Plan-agent adversarial critique, load-bearing claims hand-verified;
four user decisions asked up front (replay consent per exact command; no dependency-install check
kind; Node/TS first-class + Python minimal; full recovery incl. the bounded ledger). The critique
killed three of my own designs before code: widening `GRANTABLE` to make checks session-grantable
would have silently rendered a no-op `[s]` on the executor-spawn ask (a consent the user gives
that does nothing); a new `unverified` task STATE would have taken a fully-integrated task out of
R5's duplicated-mutation refusal while R10's ceiling could not bound the re-runs (a field, not a
state); and `decide()` resolving recipes would have put filesystem I/O in the pure policy gate.

### What was implemented (commits `8938cfe`, `640e44b`, `7134639`, `5823a3f`, `05e55ef`, + docs)

Full contracts in ARCHITECTURE (Typed verification / The verification gate / Typed recovery):

1. **`feat(checks)`** — `src/checks/`: bounded never-throwing project detection with a stat
   fingerprint over a FIXED candidate list; a declarative recipe table (a project's own script
   beats a guessed tool; first applicable row wins, so resolution is deterministic and consent
   can bind to it); `toCommand` as the single composer; and normalization whose one rule is
   **the exit code is the verdict** — parsers only enrich, and the named signals they emit are
   what keeps later classification derivable from the log alone.
2. **`feat(types,policy,runtime)`** — the `check` policy FACT and its explicit fail-closed branch
   before the command branch, all four fact-combination denials, and replay consent in a separate
   store keyed by `(recipeId, command, bodySha)` — `GRANTABLE` untouched. `ApprovalRequest.kind:
   'check'` with its own wording and a `describeCall` branch, without which the prompt was
   literally blank.
3. **`feat(tools,runtime,repl,report)`** — `run_check` (parent-only, snapshot-held, three
   refusals that spawn nothing); `check.started` emitted from `onSpawn` ONLY so it means what
   `command.started` means; `check.completed` with status, reason, signals and findings;
   crash replay that says a killed check produced no verdict; `/checks`; and CHECKED extended to
   typed checks (merged and **sorted by seq**, or `find` credits the wrong evidence).
4. **`feat(plan,graph,recovery,runtime)`** — `PlanTask.checks?` / `PlanGraph.gates?` (optional,
   no default, so every existing plan's approval sha is byte-identical); the `verification` field
   and the ONE `depSatisfied` predicate that blocks dependents; the integration and completion
   boundary gates; and `src/recovery/` — nine classes as a DATA catalogue, deterministic
   classification, a ledger whose outcomes are DERIVED (no `repair.ended` to lose in a crash), a
   bounded policy with typed stop reasons, the `recover` tool, and R11/R12 at the scheduler gate.
5. **`fix`** — the adversarial-review batch (below).

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite 689 → **868 passed / 1 skipped
across 66 files (+179)**: the recipe/detection matrices, the exit-code-is-the-verdict matrix, the
four policy fact-combination denials, the replay-consent matrix (including the body-rewrite
re-ask and the untouched executor-spawn `[s]`), TOCTOU and budget refusals, real `npm run`
executions through `runTurn`, the sha-compat pins, the gate-satisfaction matrix (seq ordering,
all-bindings anchor, waiver reasons, targeted scope), acceptance's three new axes and its
caveats, R11/R12 with their hatches, the nine-class classification matrix, and the ledger's
derived outcomes.

Bounded adversarial review: **4 differentiated read-only lenses, 21 findings, every one
hand-verified against the code before fixing** — 1 critical, 6 high, 9 medium, 2 low fixed, plus
2 I had already found while building the E2E, each with a regression pin. The critical one was
mine and was exactly the property this session set out to establish: replay consent bound the
command STRING, so rewriting `package.json`'s `test` script — an ordinary auto-allowed write —
left the key identical and turned one `[s]` into standing consent to execute anything. Consent
now binds the script body.

**Live proof** (`C:\Users\A\Desktop\agent-cli-s12-live\` — setup/driver/validate, VALIDATION.md,
per-phase transcripts, report.md): four-life piped run against real claude-opus-4-8 on a fresh
dependency-free Node project with four REAL checks, each seeded with one representative defect.
**39/40 post-hoc checks over persisted evidence only, 0 failures.** Plan with a completion gate →
sha-bound approval → execution → **SIGKILL landing inside a running check** → resume replayed it
as *"produced no verdict"* → `test` failed → `recover(attempt)` classified `test-assertion`,
recorded a hypothesis and its proof, fixed the expectation and **said plainly it had changed a
test** (the catalogue's own instruction for that class) → all four green → `/accept` complete →
clean quit + journal handoff. A fourth life then exercised the two paths the first three missed:
`s` on a check ask produced a genuine `check.replay-consent` re-run with no prompt, and an
induced `module-not-found` was classified `dependency-setup`, REFUSED an automatic repair, and
escalated — after which `/accept` refused COMPLETE naming the open escalation, and only
`/accept confirm` recorded a partial. All four checks re-verified exit 0 independently at
validation time; the user repo carries zero `refs/agent-cli` refs.

### Decisions (and why)

- **The model names KINDS; the harness names COMMANDS.** This is the whole trust argument for
  letting checks be consented to once rather than every time — and it is why the consent key had
  to bind the script BODY, not just the stable `npm run test` string.
- **A field, not a state.** Keeping `completed` preserves R5's duplicated-mutation refusal and
  R10's ceiling; the cost is that acceptance needed an explicit verification axis rather than
  getting one for free. Worth it.
- **A gate may only be waived by a PROJECT-capability fact.** `unsupported` was doing double
  duty for "this project cannot" and "you asked wrong"; the second must never discharge
  verification the user approved.
- **Repair outcomes are derived, never recorded.** There is no `repair.ended` to lose in a crash:
  an attempt is proven only when the regression check it declared actually passed after it.
- **Enforced / detected / recorded are three different words.** Attempts, wall time and budgets
  are enforced; scope expansion is DETECTED (it stops the next attempt, it does not block a
  write); whether a hypothesis is genuinely new is only recorded for review. The code and the
  tool output now say which is which.

### Open issues / boundaries (deliberate, documented)

- A `session`-targeted escalation clears only via a proven repair attempt for the same failure —
  fixing the problem by hand does not retract it, so full acceptance stays blocked and
  `/accept confirm` is the exit. A plan-task-targeted escalation resolves by evidence. Observed
  live; the asymmetry is the honest cost of not letting a model retract its own hand-to-the-user.
- `run_check` is parent-only: an executor worktree has no gitignored dependencies, so the parent
  verifies after integration. Executors therefore cannot self-verify.
- Non-Node/Python projects are `unsupported` with the reason; there is no dependency-install kind.
- The per-task gate is not invalidated by unrelated later changes (the completion gate covers
  combined state) — deliberate, and documented where both live.
- A plan whose tasks are all `role: main` cannot use per-task gates at all (validation refuses
  them); this is what the live run did, so the per-task gate is covered by unit tests only.

### Recommended next step

Session 13 per BLUEPRINT: managed preview processes and browser/visual verification — now with a
real precedent for what a typed check capability, its consent model, and its failure classes look
like. The first question to settle is whether a preview server is a check kind or a distinct
managed resource with its own lifecycle events.

---

## Session 11.5 (2026-07-24) — The durable session: lifecycle completion, acceptance boundary, crash-proof continuation

### Objective

A focused consolidation before Session 12: make a session a durable, self-contained unit of
work — every artifact needed to continue or audit it at clear local paths, resume that
reconstructs cleanup debts as well as conversation, attempt/definition state that survives
amendment and crash, and an EXPLICIT completion boundary (user acceptance) that gates cleanup
and drives the memory handoff. Also correct BLUEPRINT's stale post-Session-10 framing.

### Planning provenance

3 Explore recon lenses + 1 Plan-agent adversarial critique, load-bearing claims hand-verified;
three user decisions asked up front (supersede-in-place plan retirement — the critique showed
archive-by-delete adds a 4-step crash-window cluster to save two tiny files; retry ceiling
excludes crash-interrupted attempts; spill scope = commands + delegates only — file reads are
recoverable from files, and spilling them would persist full out-of-workspace reads). The
critique also caught: post-accept executor behavior was mis-designed (F3 refuses on a vanished
approved plan — retirement must go through plan.discarded); reusing `git.checkpoint` for base
refs would let old readers misattribute harness plumbing as user consent (new event type
instead); and the pre-existing `deleteCheckpointRefs` missing-ref-counts-as-failed bug that
would have made event-seeded retries re-fail forever.

### What was implemented (commits `c940e9f`, `ff52273`, `dbc7987`, `5e2f7fb`, `f436f26`, `efdc57a`, `901ebec`, `025bca4`, + docs)

Full contracts in ARCHITECTURE (spill choke point / task DAG definition identity / acceptance
boundary / executor base-ref lifecycle):

1. **`fix(git,repl)`** — `deleteCheckpointRefs` treats an already-missing ref as deleted
   (show-ref probe, exit 1 = gone; retries converge, never re-fail forever); live-table cap
   denominators derived from the enforced constants.
2. **`feat` crash-covered task-base refs** — additive `task.base-checkpoint {callId, ref, oid}`
   at creation (deliberately NOT `git.checkpoint`: that is user-consent provenance); assembly
   seeds the owed prune list FROM EVENTS (creations minus successfully-pruned), so a SIGKILLed
   life's leaked refs are pruned at the resumed life's quit or /accept. Crash-covered except
   the creation instant (documented; `agent checkpoint prune` backstop).
3. **`feat` truncation spill blobs** — transient `ToolResult.fullOutput` attached ONLY by
   run_command and delegate_task; the tool.completed choke point stores the pre-truncation
   bytes as `objects/<fullOutputSha256>` + `fullOutputSaved` (skipped under ANY redaction,
   2 MiB cap, never turn-failing, flagged only on verified hash equality). reconstruct never
   reads blobs back (the model never saw the full bytes live). Report wording: "captured
   output preserved" — never "full" (the exec capture cap may have dropped bytes first).
4. **`feat` definition identity + attempt history** — `task.started.planTaskSha` (canonical
   per-task sha, dependsOn sorted); the fold re-opens a completed task whose definition
   changed (note carries the completed-as sha; legacy sha-less bindings stay id-sticky;
   integrating integrates first); `attemptHistory` (every binding with outcome + sha) +
   `definitionSha` on PlanTaskState; the interrupted note states provable re-run safety
   honestly (worktree captured nothing; external shell side effects unknown).
5. **`feat` R10** — the bounded retry ceiling: 3 genuine failures (error/timeout/budget/
   stalled) per CURRENT definition refuse identical retries, naming every hatch; crashes and
   user terminations (cancelled/user-stopped/aborted) never count; amendment resets.
6. **`feat` the acceptance boundary** — `runtime/acceptance.ts` pure fold (COMPLETE = plan
   fully executed AND every applicable capture applied, registry-wide; a DRAFT plan is
   deliberately not silently complete); `/accept` (user-typed consent, stateless
   `/accept confirm` for partial, idempotent, piped-deterministic) records `session.accepted`,
   prunes refs now, retires a fully-executed approved plan via the existing discard flow
   (`plan.discarded reason:'accepted'`, file kept); `/status` + quit summary completion line;
   report `## Completion`; deterministic journal `### Handoff` built inside runMemoryUpdate
   (one-shot parity); resume-after-accept startup note.
7. **`feat` mid-turn /tasks unification** — the fold+live-overlay `[plan]` line (first
   production wiring of livePhases; same visibility gate as idle /tasks); overlay-fed
   summaries name running/awaiting-approval work.
8. **`fix` review batch** — 3 read-only lenses over the session diff, hand-verified: the
   accept's own retirement no longer reads as work-since (duplicate-consent trap); the
   crash-limbo (killed between accepted and retirement) repairs idempotently on the next
   /accept; R10 stopped counting user stops as failures; acceptance STALENESS is honest on
   every surface (the handoff lists the LIVE blockers, never the frozen accepted list;
   one-shots say not-applicable; resume pointer keys off live incompleteness).

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite 645→**688 passed / 1 skipped
across 57 files (+43)** — ref-tolerance + event-seeded prune fold (incl. failed-prune retry),
real-git creation-event + prune e2e, the spill matrix (sha equality, redaction skip, size cap,
putBlob failure, file-tools-excluded pin, real-spawn >16k, delegate long-report), the
definition-reopen matrix (A→B→A, legacy stickiness, integrating-not-reopened), attemptHistory,
R10 matrix (interrupted + user-stop exclusions, legacy counting, amendment reset), /accept
flows (refuse→confirm, retire, idempotence incl. the self-retirement pin, piped determinism),
buildHandoffLines unit matrix (stale acceptance, one-shot wording), report rendering pins
(Completion, task-base section, spill pointer wording, retirement provenance). Bounded
adversarial review: 3 lenses, findings hand-verified — 2 MEDIUM + 1 MEDIUM-plausible + 3 LOW
fixed (item 8); kernel-invariant lens: 7 of 8 HOLD, the 1 violation (duplicate consent) fixed
and pinned.

**Live proof** (`C:\Users\A\Desktop\agent-cli-s11.5-live\` — driver.mjs, validate.mjs,
VALIDATION.md, per-phase transcripts): three-life piped run against real claude-opus-4-8,
**30/30 post-hoc checks over persisted evidence only**. Phase A: `@plan` → 3-task canonical
plan → sha-bound approve → one 2-executor wave (single group approval, bindings displayed) →
deliberate SIGKILL mid-wave. Phase B: resume → orphaned worktrees swept → `/tasks` folds both
`interrupted` → re-run as one group with IDENTICAL planTaskShas (`attempt 2` displayed) → 8
forwarded approvals → integrate (zero refusals) → parent runs both delivered test files (real
exit 0) → a 20,001-char command output spills to a verified blob → `/accept`: both task-base
refs pruned INCLUDING the phase-A crash-leaked one, plan retired, acceptance recorded. Then an
UNPLANNED second kill (a driver bug crashed the pipe after /accept) — absorbed by design.
Phase C: resume announced "accepted (complete) … covers only work up to that point" → clean
quit → journal Handoff (`accepted: yes (complete)`; `plan retired (accepted) · captures
integrated`). 26 uncached parent input tokens across all three lives (cache 156k read); the
workspace carries ZERO agent-cli refs; the delivered tests re-verified exit 0 at validation.

### Decisions (and why)

- **Supersede-in-place, never archive-by-delete** — the desired end state already existed as
  the discard flow; deletion would have added the system's only un-undoable act plus crash
  reconciliation, to reclaim two small files.
- **A NEW event type for base-ref creation** — `git.checkpoint` is user-consent provenance;
  for old readers, misattribution is strictly worse than skipping an unknown type.
- **Spill is a runtime evidence write, not a tool mutation** — same category as snapshots
  (content-addressed, state-dir, never model-visible); the S6 observe-trap stays closed.
- **`completed` binds to the definition that ran** — re-running too much beats silently
  skipping changed work; legacy logs keep the conservative id-sticky reading.
- **The retry ceiling counts only model failures** — crashes and user interventions are not
  the model retrying; counting them mislabeled user pauses as failed attempts.
- **Acceptance is recorded consent with live-state honesty** — the event freezes what was
  accepted; every surface derives freshness (staleness) rather than replaying the frozen view.

### Open issues / boundaries (deliberate, documented)

- Cleanup at acceptance is deliberately conservative: snapshots, capture blobs, spill blobs,
  plan files, and session logs are never deleted (rollback/audit/resume outrank disk); blob
  GC remains pooled.
- The report's `## Completion` renders the frozen acceptance event (its provenance); staleness
  annotations live on /status, the quit line, and the journal handoff.
- The journal Handoff evaporates when its entry is compressed by the roll (newest-2 stay full
  — by then the pointer is stale anyway).
- The mid-turn `[plan]` line is TTY-gated like the rest of the mid-turn surface: exact-pattern
  unit tests + the fold pins; no piped-driver proof by design.
- One-shot sessions cannot accept (documented; their handoff says not-applicable) — a
  post-hoc `agent accept <id>` CLI remains pooled.

### Recommended next step

Session 12 per BLUEPRINT: the unified verification gate and typed recovery — typed check
adapters feeding the plan tasks' `verify` criteria, a failure classifier over the now-complete
attempt history, and the bounded repair policy on top of R10's ceiling.

### Addendum (2026-07-24/25) — the recorded capability demo and the fix it forced

A live recorded demo (ConPTY → xterm.js → Playwright, real claude-opus-4-8; evidence + the
4-minute MP4 at `C:\Users\A\Desktop\arcade-demo\`) exposed one real defect: a plan whose tasks
were all `role: main` produced the on-camera contradiction "session accepted (complete) —
plan 0/4 completed". Fixed as `4d86650` (fold summaries count parent-owned tasks apart —
"X/Y completed · N parent-owned (asserted)" / "all N task(s) parent-owned"; update_plan's
role guidance now states the executor-vs-main division of labor, because the demo model had
put an entire buildable app under `main`, silently opting out of orchestration and
verification). Suite 689 passed / 1 skipped. The re-recorded demo then showed the intended
lifecycle end to end: auto-routed plan → sha-bound approval → one parallel executor wave
(bound, definition-sha'd, live status area + mid-turn `[plan]` line) → drift-checked
integration (8 files, 0 refusals) → parent-run verification → `/accept` (complete; plan
retired; refs pruned) → memory handoff → the built app played on camera.

---


## Earlier Milestones (Sessions 1–11 — compressed per the rolling-docs policy)

Contract detail for everything below lives in `ARCHITECTURE.md`; entries here keep the
objective, the lasting decisions (with why), the evidence, and what stayed open.

### Session 11 (2026-07-23/24) — V0.9: iterative planning, task graphs, parallel-first execution

The planning/orchestration lifecycle, landed as designed (commits `d8f7587`…`5250aca`; suite
574→645+1). Landed: ONE canonical `<id>.plan.json` task graph with two deterministic projections;
approval binding `planContentSha = sha256(canonicalJson(plan))` so status flips are sha-neutral
BY CONSTRUCTION (the V0.7 approve-rewrites-the-file quirk died structurally, its pin deliberately
inverted) and any semantic amendment invalidates; structured `update_plan` whose validation
errors return complete with NOTHING written (the revision loop is the design); observable routing
(`plan.route`, `@plan`/`@direct` — no harness classifier, the hard floor stays structural);
the delegate DAG gate R1–R9 with plan bindings, plan-informed briefs, and events-rebuilt caps;
bounded supervision (loop 3/5, budget-pressure 80%, stall) dual-surfaced as events AND the
head-of-result group digest; task-scoped `/cancel` via an idempotent registry seam; and the
TTY-only sticky status area (all chrome through one status-aware writer, ZERO escape bytes
off-TTY) with the live task table. Lasting decisions: execution status is a PURE EVENT FOLD, never
a field in the plan (two writable status sources would be the double-truth trap); the scheduler is
a GATE plus guidance, not an in-tool wave engine — the parent integrates between waves, so a
dependent's base checkpoint naturally includes its dependencies; mid-turn interception is TTY-only
because piped drivers pre-supply lines and determinism is a contract. Review (3 hand-verified
lenses) fixed a capture-loss false-completed, a vanished-plan gate hole, and display honesty.
Live: two-phase run with a deliberate mid-wave SIGKILL and resume. Still relevant: the sticky area
and mid-turn commands are TTY-gated and have no piped-driver proof (exact escape-byte tests plus a
manual Windows Terminal smoke instead).

### Session 10 (2026-07-23) — V0.8: repository intelligence and focused exploration

Selective, ranked, task-directed retrieval replaced the broad file-list map (commits
`3a6bd2d`…`9ed0426`; suite 515→574+1). Landed: `src/retrieval/` (git-backed inventory +
path-SET digest, charset-constrained regex extraction for ts/js+py, import-graph PageRank, a
persisted incremental index written ONLY at assembly with honest `partial` states, tiered
hard-budget map render whose complete directory tree is the recall backstop); the read-only
`retrieve` tool (signal-attributed hits, live-read excerpts) for the parent and read-only
child roles via the NAMED structural admission seam; explorer focus/avoid briefs with sibling
coverage + overlap warnings; the six-section explorer report contract (non-blocking check);
delimiter neutralization of child reports. The Plan-agent critique caught two CRITICAL flaws
pre-code: never redefine `WorkspaceMap.sha256` (additive `inventorySha256` instead) and never
let an observe tool write the index at query time (the S6 trap). Live proof on a 3,064-file
vitest clone: flat map 0/14 packages visible → ranked map 14/14 in ≤16k chars; two
disjoint-focus explorers, zero shared reads; 16 uncached parent input tokens. Evidence:
ROADMAP git history + `test/retrieval.*` (the s10 live dir was later cleaned up). Lasting
decisions: excerpts/line numbers ALWAYS from live reads (a stale index may misrank, never
fabricate); recall backstop over ranking confidence; regex over tree-sitter (Windows-first, no
native deps; same interface if recall pressure demands). Still relevant: CODEBASE staleness
over-marks transiently across map-mode flips (safe direction); partial-index stale-symbol
carryover is disclosed; `/map` REPL-branch chrome untested.

### Session 9 (2026-07-22/23) — pre-expansion consolidation + the live V0.7 proof

Audit-driven fixes (3 Explore lenses + 1 Plan critique, hand-verified), no new capability.
Landed: concurrent-session worktree safety (owner-stamped registry entries, in-process mutex +
token `O_EXCL` lock, live-pid sweep skip with a 2h age hatch, merge-on-save — a live same-pid
holder is NEVER reclaimed, group members share the pid); plan-approval state displayed at the
executor spawn ask (the display-only `approvalContext` seam); task-base refs pruned at session
end with `git.checkpoint.pruned` provenance; command grants keyed on the command FACT (a
session grant is stored only when `tool.command` is undefined; `[s]` hidden where no grant
would store — found live). Suite 498→515+1. The live V0.7 proof (evidence:
`C:\Users\A\Desktop\agent-cli-s9-live\`): `@plan` → sha-bound approve → ONE call → TWO
parallel worktree executors with real node assert-suites → forwarded approvals → capture →
apply ×2 → `/undo` → honest recovery → reviewer panel auto-denied its shell attempts and the
parent re-ran the probe itself → refs pruned live; 42 uncached input tokens; sovereignty
observed unprompted (told applied files were gone, the model checked the workspace instead).
Lasting decisions: sweep liveness errs toward keeping; display mirrors enforcement for grants;
live drivers never pre-supply approval answers. Still relevant: the stale-forwarded-prompt
line-consumption wart (io redesign, deferred pool); command labels stay cosmetic-noisy.

### Session 8 (2026-07-22) — V0.7: coordinated parallelism + the minimal agent-teams layer

Roles as two-layer explicit contracts (policy fact table + runtime contract rows, pinned
consistent at load); parallel groups living in the delegate TOOL (one call = 1–3 tasks =
one evidence unit = ONE approval for a mutating group; `runTurn` byte-identical); plan mode
(harness-owned documents, `update_plan` behind the fail-closed `planDoc` branch, `/plan
approve` binding the exact sha); the executor role (base checkpoint → detached worktree →
bounded binary-safe capture that OUTLIVES the worktree → reviewed drift-refusing apply through
the existing snapshot/undo machinery); serialized approval forwarding that fails closed for
non-interactive parents. Commits `d0abbb1`…`a67cd94`; 450→498+1 tests. Lasting decisions:
worktrees of a trusted workspace are trusted BY DERIVATION (never written to trust.json); the
plan-approval gate landed BEFORE the capability it gates; executor spawns are never grantable;
worktrees live in the OS temp dir because validatePath DICTATES it. Still relevant: Ctrl+C
aborts the whole turn (per-task cancel = forwarded deny-stop only); worktrees lack gitignored
files (honest UNVERIFIED reporting); the stale-forwarded-prompt line-consumption wart.

### Session 7 (2026-07-20/21) — V0.6: main-agent control layer — memory + subagent tasks

Three-document project memory (AGENT.md user constitution; harness-generated rolling
JOURNAL/CODEBASE with deterministic event-derived Evidence sections and the verbatim
"CONTEXT, NOT AUTHORITY" framing) + the first read-only explorer tasks over the SAME `runTurn`
(a task = one turn) + `assembleSession` as the ONE construction path (trust is a parameter —
assembly is structurally impossible untrusted). 450+1 tests (+47); live two-session E2E with
unprompted parent re-verification of child narration and 6 uncached input tokens. Lasting
decisions: memory is context-not-authority STRUCTURALLY (evidence from events; crash notes
from log tails — absence of memory never accuses a session); `aborted ≠ user-quit`
(post-session work must never fire after Ctrl+C); delegation budgets are harness-fixed, never
model-controlled. Still relevant: memory docs are lock-less (seconds-wide last-writer-wins
window at simultaneous quits; the log stays the evidence).

### Session 6.5 (2026-07-19) — V0.5 capability demo + production-style validation

One continuous ~68-min recorded run (real ConPTY → xterm.js → Playwright, byte-truthful, live
claude-opus-4-8): built **LedgerLite** (20 files, 51 unit tests) from a natural-language brief
with 13 live approvals, then demonstrated diff/attributed-commit/checkpoint/restore/undo/report
and deny-adapt honesty; **124 uncached input tokens** total (cache 2.07M read). Two product
fixes with regression coverage (probe 60s+retry behind an injectable ProbeRunner; absolute-
System32 whoami in the Low-IL test). Suite 403+1. Evidence:
`C:\Users\A\Desktop\ledgerlite\validation\`. Lasting decisions: validation sessions live
OUTSIDE the product repo; the bridge identifies itself truthfully; demo briefs state git
authority explicitly. Standing finding: the positive-proof auto-run gate rarely fires for the
model's natural chained command style; probe ~4–11s on this machine.

### Session 6 (2026-07-18) — V0.5: Git-native, reviewable, context-efficient

GitOps as a harness-only capability (a policy regression test PINS why it must never be a model
tool — a command-less, mutation-less "git_commit tool" would auto-allow as observe), with the
hardened git substrate, attributable `/diff`, session-scoped `/commit`, and hidden-ref
checkpoints whose restore is ONE applyUndo unit — git is never the undo mechanism (the Codex
ghost-commit data-loss lesson). Context efficiency: two-breakpoint prompt caching (live ~6
uncached input tokens/session) + deterministic monotone elision + the git-backed map. The
consent contract made explicit: user-typed commands ARE consent under preview+confirm, a
provenance event per operation, and GitClient structurally unreachable from the model. 398+1
tests; scripted + live E2E. Still open from S6: approved run_command file effects are
structurally under-claimed by attribution; `agent commit`/`checkpoint` need the session lock.

### Session 5 (2026-07-18) — V0.4: enforced isolation + automatic command review

The OS-enforced Windows boundary (Low IL + Job Object; `WRITE_RESTRICTED` tokens FAILED in the
machine probe, which ran BEFORE any code) + deterministic automatic command review
(`analyzeCommand` as a POSITIVE proof of safety; auto-run requires proof AND an active probed
boundary, else ask; approved commands deliberately run unsandboxed — the user accepted the
risk, Codex's model). Enforcement is probed per session, never assumed, and degrades
fail-closed. 321+1 tests (+80) incl. 8 real-OS win32 tests and a 66-assertion adversarial
corpus (40+ escape forms never auto-run); live E2E. Honest scope (unchanged since): confines
writes + lifecycle on Windows only — reads, network, Low-labeled locations, and
service-reparented work are NOT confined. Still open: per-command Add-Type host latency
(~1.2s; probe ~4–11s); CLIXML stderr cosmetics.

### Session 4 (2026-07-17) — V0.3: execution kernel hardening

The managed exec substrate (typed termination — a killed command has NO exit code, everywhere,
and the report vetoes CHECKED on kill evidence; the kill/drain state machine that never awaits
`'close'` unconditionally — the nodejs/node#21960 grandchild-pipe hang class) + real
mid-command cancellation proven with a genuine console CTRL_C against the live API. 240+1
tests (+35). Lasting decisions: force-kill only, labeled best-effort; evidence channels are
callId-bound by the runtime so tools cannot forge another call's evidence. **Cost lesson (now
a CLAUDE.md rule):** a per-finding 3-verifier fan-out exploded (19 findings → ~57 agents) and
was aborted; findings were salvaged from the journal and verified BY HAND — review workflows
stay bounded, no per-finding verifier panels.

### Session 3 (2026-07-16) — Recorded live E2E demo + two defects it surfaced

Not a product increment: an 11m20s Playwright-recorded, byte-truthful demonstration of the
V0.2 loop (trust consent on camera, a complete web app built with inline approvals, resume,
browser verification). Artifacts outside the repo (`C:\Users\A\Desktop\agent-cli-demo-20260716\`);
the evidence chain independently audited. Product yield: the CLI entry guard realpaths
`argv[1]` (npm-link shim exited 0 silently); vitest 60s hang backstop. Lasting decision:
record a browser-hosted real terminal (xterm.js ↔ ConPTY) since the CLI needs a real TTY.
Nuance that still matters: the report's "Files changed" uses last-mutation-per-path semantics.

### Session 2 (2026-07-15) — V0.2: interactive REPL, workspace trust, narrowing-only config

The REPL on the exact same runtime (no parallel loop), turn abort, the live event-log renderer.
Lasting decisions: workspace trust is recorded consent, never a sandbox (TTY-only prompt, no
self-granting folders, corrupt store = hard error); workspace config narrows only; the screen
renders from the persisted log with stdout reserved for model text; type-ahead cannot answer a
security prompt; approval prompts sanitize model-controlled text. 204+1 tests; three live E2E
rounds + post-E2E adversarial review — seven real defects total found, fixed, and
regression-tested. Still relevant: `agent map` stays ungated pre-trust (documented exception).

### Session 1b (2026-07-14) — Automatic proxy support + verified live E2E

Reusable proxy-aware transport (pure `resolveProxy`, per-request undici ProxyAgent, no global
dispatcher; credentials never persisted; deliberately no `--proxy` flag — argv is logged).
Closed Session 1's one unverified surface: the full live loop through the system proxy. 143+1.

### Session 1 (2026-07-14) — V0.1: the bounded local agent loop

The seven-pillar foundation (typed contracts, append-only JSONL log with tail repair, one pure
policy choke point + Windows-first path validator, five file tools + run_command, snapshots
with drift-refusing undo, resume with crash reconciliation, deterministic evidence report).
121+1 tests + dogfood run. Lasting decisions: no widenable allowlist config — labels only
inform the human; in-workspace writes auto-allow but snapshot first; sandbox vs approval kept
separate and stated honestly (V0.1 shipped approval only; S5 added the enforced axis); secret
reads redacted via salted HMAC and deliberately non-replayable on resume; state lives outside
the workspace. Still-true limitations: command output not scrubbed for secrets; path checks
TOCTOU-racy; undo is file-only; single-user lock assumption.

---

## Deferred pool (accumulated, still open)

Adaptive thinking with block preservation (`pause_turn` is mapped but the loop would end the
turn — latent until thinking ships); per-action / `--to` / `--steps` undo; network/web
tools; MCP and workflow packs; SQLite index over the JSONL; conversation rewind; session
pruning/sanitized export; prompt-history persistence + line-editing niceties; background/
long-running process sessions; PTY support; output spill-to-file for huge command output;
`--max-turns` flag vs internal `maxSteps` naming alignment; plan-file pruning (one doc per
session accumulates in the state dir).
**Retrieval follow-ups (post-S10):** tree-sitter (or richer) extraction behind the same
extract interface, more languages (go/rust/java/c#) as data-shaped table additions; a user
config knob for the map budget; /map REPL-branch + mapNote chrome tests; a post-group child
read-set overlap metric (child logs already carry the evidence); retrieval-aware journal
topics; ranked→flat staleness over-marking (transient, safe direction) if it ever bites.
**Durable-session follow-ups (post-S11.5):** blob-store GC/retention (snapshots, capture
blobs, and now spill blobs accumulate with no refcount — a reference walk over event-named
shas is the likely shape); a post-hoc `agent accept <id>` CLI so one-shot sessions can reach
the acceptance boundary; the report's `## Completion` deliberately renders the frozen
acceptance event (staleness lives on /status, the quit line, and the journal handoff) — an
annotation there if it ever misleads; the journal Handoff evaporates when its entry
compresses (accepted-by-then, deliberate).
**Verification/recovery follow-ups (post-S12):** a `session`-targeted escalation has no
harness-derived resolution (only a proven attempt for the same failure, or `/accept confirm`) —
a user-side dismissal recorded as an event is the likely shape; per-task gates are unit-tested
only, since a plan of all-`main` tasks cannot declare them (live-proven path is the graph-level
gate); executors cannot self-verify (parent-only `run_check`, because a worktree lacks
gitignored deps) — a worktree-aware precondition or a post-apply auto-check would change that;
more ecosystems as data-shaped recipe rows (go/rust/java) behind the existing `applies()` seam;
an incremental check cache keyed by file hashes + tool versions (BLUEPRINT §6, still unbuilt);
`test-targeted` scope defaults from the plan task's `touches` instead of requiring the model to
restate them; and a check-result surface in `/diff` so a reviewer sees verdicts beside the diff.
**Planning/orchestration follow-ups (post-S11):** a width-aware status-area clip before any
free-form text may land in status lines (today: structurally ASCII + a 2-column margin);
sibling-task chrome printing over a DISPLAYED forwarded-approval prompt (pre-existing, part
of the io redesign); plan-file pruning (one canonical JSON + generated md per session
accumulate; S11.5's retirement deliberately keeps the files as audit); a `/cancel` surface
for non-TTY sessions; richer wave guidance (the model still chooses group composition; the
gate only refuses).
**Task/subagent follow-ups (post-S8/S9):** task resume/continue (SendMessage-style); deeper
scanning of child reports for instruction-shaped content (v1 ships delimiters + provenance
labels); the stale-displayed-forwarded-prompt line-consumption wart (the discard is LOUD
since S8, but the typed line is still consumed — needs an io redesign); per-child sandbox
scratch TEMP isolation; a per-child `--script` seam for the mock provider (tests use the
providerForTask seam; production children share one script); a structural (not
prompt-shaped) review gate. **Memory follow-ups (post-S7):** journal
topic files / retrieval beyond the newest-first inject window; a memory relocation/config
knob; a cross-process memory-doc lock (today: a seconds-wide last-writer-wins window at
simultaneous quits); model-generated compaction of assistant/user text (deterministic
tool-output elision shipped; loud warning when even full elision exceeds the target).
**Git follow-ups (post-S6):** patch/multi-edit editing; model-generated commit messages;
attribution of approved run_command file effects (structurally under-claimed today);
push/PR flows; submodule + multi-repo workspaces. **Sandbox follow-ups (post-S5):**
network-egress control and a read/confidentiality boundary (the two enforced gaps that most
matter); a cached/compiled sandbox host to cut per-command Add-Type latency (~1.2 s; probe
~4–11 s on this machine); macOS/Linux enforcement backends; containment of
service-reparented work (schtasks/sc/wmic/BITS) that escapes the Job Object.
**Cosmetics (recorded, informational-only):** command-label noise — word-boundary matches
can mislabel (the literal "format" in `format.js` → destructive; `-e` ESM one-liners →
external); labels never grant and never gate, they only inform the human. PowerShell CLIXML
progress-stream noise on some chained commands' stderr.
