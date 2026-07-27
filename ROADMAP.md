# ROADMAP

Rolling execution record: the latest one or two sessions in full detail, older sessions
compressed under **Earlier Milestones** (per the rolling-docs policy in `CLAUDE.md`). Newest
first. Contracts and mechanisms live in `ARCHITECTURE.md`; this file records what each session
attempted, verified, decided, and left open.

---

## Session 14 (2026-07-27/28) — The delivery boundary: Git audit lineage + the structural review gate

### Objective

Turn Git, review, and final acceptance into a coherent delivery boundary: harness-owned
recovery checkpoints at the workflow transitions that actually exist (before parallel mutation
— already landed — before integration, and at delivery), with an audit lineage that survives
crash and never pollutes the user's branch history; adversarial review promoted from ONE prompt
bullet to a structural completion gate with typed findings, hand-verified triage, and honest
blocking; and a live coding-flow acceptance run proving the whole chain.

### Planning provenance

3 Explore recon lenses + 1 Plan-agent adversarial critique (18 findings, 1 critical), all
load-bearing claims hand-verified. Four user decisions asked up front: review required for
executor plans by default (visibly waivable), the delivery ref SURVIVES the session, no managed
commits, and the parent may refute a finding with recorded evidence. The critique killed
designs before code: widening `task.base-checkpoint` for delivery refs (an old reader's owed
fold would prune the durable anchor — a NEW event type instead); "a checkpoint per apply"
(demoted to the covered-change rule); and the critical one — the review anchor degenerating
when no `task.applied` exists, which would have let a review-of-nothing satisfy the gate.

### What was implemented (commits `f99f41b`, `d4994c0`, `d911367`, `a2c49af`, `48182e6`, `ee6adcb`, `a9663bf`, `15ad955`, `82a1158`, + docs)

Full contracts in ARCHITECTURE (Harness checkpoint lineage / The structural review gate):

1. **`feat(git,types,runtime,tools)`** — the `onRefReady` seam (event BEFORE ref: the
   Session-11.5 creation-instant leak is now structurally closed, and a failed ref write leaves
   an honest phantom that prunes as already-deleted); the additive `harness.checkpoint` event +
   `HarnessRefKind`; the seq/kind-aware `owedHarnessRefsFromEvents` re-folded from live events;
   the pre-integration checkpoint under the covered-change rule (skip-never-refuse).
2. **`feat(repl,types)`** — the delivery checkpoint: captured before the consent event and
   referenced by it, surviving the session as the durable audit anchor, idempotent across the
   crash window (reuse only when nothing work-shaped happened AND the ref exists), never
   hostage to git, with a `/commit` suggestion instead of automation.
3. **`feat(plan)`** — `review?: {mode, reason?}`, sha-neutral by the `checks`/`gates`
   discipline; waivers require a substantive reason and render in both projections.
4. **`feat(review,types,runtime)`** — `src/review/ledger.ts`: the pure fold (derived
   requirement, round qualification against real work, never-expiring findings, derived triage
   worth) + the `ReviewFinding`/`ReviewEvidence` contracts and additive events.
5. **`feat(tools,runtime,roles,delegate)`** — `report_finding` (per-task accumulator, the
   SECOND named `childTools` admission, ingestion-time neutralization) + unconditional capture
   with severity counts in the head digest.
6. **`feat(tools)`** — the `review` triage tool: verify/refute/accept/address with every rule
   enforced twice (refused at the call, re-derived in the fold).
7. **`feat(acceptance,prompt)`** — the review axis; the main-agent bullet rewritten from
   suggestion to gate.
8. **`feat(report,repl,memory)`** — `## Adversarial review`, `## Git recovery and audit state`,
   `/review`, `/status` lines, chrome, journal evidence.
9. **`fix`** — the adversarial-review batch (below).

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite 972 → **1029 passed / 1 skipped
across 77 files (+57)**: the onRefReady order pin (the ref provably absent inside the callback),
a REAL phantom convergence via a planted ref lock including same-`n` reuse, the kind/seq fold
matrix, the pre-integration fires/skips matrix through real `runTurn` applies, the delivery
boundary end to end (ref survives the quit prune; exactly one ref under `refs/agent-cli`),
crash-window reuse vs phantom non-reuse, the review fold's qualification and triage matrices,
the admission matrix, and the report/journal surfaces.

Bounded adversarial review: **4 differentiated read-only lenses in ONE batch, 16 findings,
every one hand-verified against the code before fixing** — and all four lenses independently
found the same critical defect: delivery survival keyed on the newest CREATION event, so a
phantom (update-ref failed after the append) superseded and pruned the real anchor of the last
acceptance, leaving a dangling `deliveryRef` and zero anchors. Survival now keys on the ref the
acceptance actually consumed. **My first fix for it was wrong** (an acceptance that captured no
ref cleared the anchor with `null`); the regression pin caught it, and the rule is now
conservative. Seven more fixed: address refs that predate a finding, refuted criticals invisible
at consent, ingestion-time neutralization of child-authored strings, the covered-change set
wrong in BOTH directions, the review tool folding an unapproved graph, `approved` without
`approvedAndCurrent`, and the `notedBaseRefs` splice dropping failed deletions. 32 attacked
invariants HELD. Two findings were documented as deliberate boundaries rather than changed.

**Live proof** (`C:\Users\A\Desktop\agent-cli-s14-live\` — setup/driver/validate, VALIDATION.md,
transcripts, driver-run.log): a two-life piped run against real claude-opus-4-8 on the QuickBoard
fixture (dependency-free node:http SPA with THREE seeded defects: a failing stats test, a
browser-only no-re-render bug, and an `innerHTML` XSS that every check and the happy path pass
over). **43/43 post-hoc checks over persisted evidence only, 0 failures, 2 not-done** (386s).
`@plan` → approve → **the deterministic gate proof: `/accept` REFUSED before any work, naming the
review-axis blocker** → 2 plan-bound executors in ONE parallel group → integration (a
pre-integration checkpoint fired live under the covered-change rule) → test gate green after the
last apply → preview + passing browser flow → a 2-lens review round whose UI lens **found the
seeded XSS** (`public/render.js:4`, medium/high-confidence) plus two real UX defects, while the
server lens honestly recorded zero → the parent hand-verified each at its sink and triaged all
three → **SIGKILL** → resume (the review fold rebuilt from events; `/review` showed the restored
gate state) → re-verify → `/accept` COMPLETE with the delivery checkpoint captured before the
consent event and referenced by it → `/quit`. Hygiene verified independently: EXACTLY one ref
survives under `refs/agent-cli` (the delivery anchor, a real commit object), the task-base and
pre-integration refs were pruned, and the accepted-limitation caveat rode the acceptance summary
into the journal handoff. The first run of this driver produced its own finding (below) and was
re-run after the fixture was corrected.

The two not-done legs are recorded honestly: no post-integration check FAILED (the planned fixes
landed first try, so the induced failure was the seeded failing test the plan itself fixed — the
`recover` path stays live-proven from S12/S13), and no finding came back critical/high (so the
gate discharged on the round alone; the `accept` path for medium/low is what ran).

### Decisions (and why)

- **A delivery ref's identity is the acceptance that CONSUMED it**, not the newest creation
  event. Under event-before-ref a creation can exist for a ref that never landed; keying on
  consumption is the only identity that is both durable and provable — and an acceptance that
  captured nothing must not destroy an anchor it cannot replace.
- **The covered-change rule keys on SPAWN events only.** `file.mutated`/`undo`/`restore` are
  snapshot-backed by construction, so counting them made every apply after the first pay a
  whole-tree capture; and a crash mid-command leaves only `command.started` — the exact
  unknown-effects writer the point exists for.
- **Recorded findings are the gate's only input; prose is narration.** That inversion (the same
  one checks made for verification) is what lets review be structural rather than rhetorical.
- **Triage annotates, never erases, and every rule is enforced twice.** A refutation is real
  evidence of a decision, so it clears the block — but it is a bare model claim, so it is
  recorded verbatim, labeled everywhere, and surfaced as an acceptance caveat.
- **The review requirement is PLAN-scoped** by the user's explicit choice; recorded findings
  block regardless of how the round came to run.

### Open issues / boundaries (deliberate, documented)

- **Live-found (first E2E run, kept as evidence):** on a workspace whose on-disk bytes differ
  from git's checkout normalization — here system `core.autocrlf=true` over an LF working tree —
  an executor worktree materializes CRLF files while the parent holds LF, so EVERY captured file
  is refused at apply as base drift. The harness is correct (the parent genuinely does not hold
  the bytes the executor based its edit on) and the model behaved exactly as designed: it got the
  work green by hand, then escalated `integration-conflict` naming the unsatisfiable bookkeeping
  rather than claiming completion. The fixture now pins `core.autocrlf=false`; making capture
  robust to a normalization mismatch is a real ergonomic gap, recorded in the deferred pool.
- Executor work delegated with NO plan derives no review requirement (the user chose "executor
  plans by default" over "any mutating session"); findings from a voluntarily-run round still block.
- A phantom creation suppresses the pre-integration rule until the next spawn — the checkpoint
  is best-effort by contract and the apply stays snapshot-backed, so the residual is one missing
  convenience point, never lost work.
- The user-commanded CLI/REPL checkpoint path keeps its (documented) creation-instant window:
  its ref-scan-based list/prune backstop converges without event coupling.
- `refs/agent-cli` is no longer empty after an accepted session — by design (the delivery
  anchor); `agent checkpoint prune` remains the user's broom.

### Recommended next step

Session 15 per BLUEPRINT: the first non-coding workflow pack (documents/PDF), reusing the
context/task/verification/recovery/review/delivery contracts rather than copying them.

---

## Session 13 (2026-07-26) — Managed preview processes and browser / visual verification

### Objective

Make locally built applications verifiable as a real user experiences them: a preview server
as an explicit managed SESSION resource (start, announced-port readiness, logs, TTL/log caps,
crash/resume, identity-verified sweep, deterministic teardown) and Playwright-based browser
verification (typed flows with declared readiness, real interactions, typed failure taxonomy,
screenshots/traces as sha-addressed evidence, model-visible screenshots for supplementary
visual judgment) — integrated into the Session-12 check/gate/recovery/acceptance machinery,
never beside it.

### Planning provenance

3 Explore recon lenses + 1 Plan-agent adversarial critique (33 findings, 2 critical), four
user decisions asked up front (playwright-core + system browsers, no downloads; flows inherit
preview consent, origin-locked; full wire-image support; dependency-free node:http E2E app).
The critique killed designs before code: the E2E's replay-consent-survives-resume assumption
(grants are session-scoped BY CONTRACT — the honest E2E re-asks), pipe-based preview capture
(an orphan would wedge on a full pipe buffer; fd-based file logging instead), a third failure
class that was dependency-setup in costume (cut), and a CHECKED-exclusion patch that was
already structural (one pin instead).

### What was implemented (commits `5b7b451`, `3cdb561`, `650ada8`, `0a639aa`, `370491a`, `11d36e3`, `9aff5f2`, `28fb29a`, + docs)

Full contracts in ARCHITECTURE (Managed preview processes / Browser verification / Wire
images):

1. **`feat(preview)` ×2** — `startSupervised` (runManaged's inverse: a live handle, fd-based
   file logging so an orphan can never wedge on a pipe, unref'd child, typed TTL/log-overflow
   stops, kill-helper-bounded stop with first-cause reasons); the shared registry-lock
   extraction; `previews.json` + the identity-verified sweep (encoded-CommandLine token +
   ±15s creation tolerance, NO age hatch on kills, retire-without-kill >24h, 20s wall budget,
   unaccounted-log reporting for the spawn→register window); the `preview` tool — the model
   names a SCRIPT from a fixed allowlist, the harness composes the command, and the engine's
   check branch splits on kind 'preview' so the persisted decision says KEEPS RUNNING /
   binds a port; body-bound replay `[s]` in the Session-12 store; registry-before-event and
   ended-before-unregister orderings; stop-all on every session-end path incl. force-quit.
2. **`feat(types,provider,runtime)`** — wire images: tool_result content widens to text+image
   parts; pixels ride a transient `ToolResult.images` whose blobs are already stored; the log
   records metadata + `objects/<sha>` (never base64, pinned); resume degrades to pointers BY
   CONSTRUCTION; elision's unconditional image pass ages pixels to markers after 2 assistant
   steps (monotone; additive `context.compacted` field; the cache marker stays on the
   top-level block).
3. **`feat(browser)`** — playwright-core probe (msedge → chrome → cache, cached per session,
   honest unsupported degrade); the zod FlowSpec whose `goto` REQUIRES app-meaningful
   `ready_when` and whose steps stop at the first typed failure (timeout / assertion with
   last-observed state / navigation via a REAL origin comparison / runtime / protocol);
   `browser_flow` emitting check evidence (kind 'browser', `exitCode: null`, no termination —
   gates satisfied, file-CHECKED structurally impossible) + the `browser.flow` detail event +
   putBlob'd screenshots/traces under a 64 MiB events-rebuilt budget; `view_image` gated by
   the `evidenceRead` fact's `admitted` answer (an un-admitted sha DENIES — the shared blob
   store also holds deliberately withheld bytes); the `browser` policy fact (preview-bound →
   allow, else deny; no ask path for arbitrary origins).
4. **`feat(recovery)`** — exactly two new classes (`preview-startup`, `browser-verification`;
   a missing browser is dependency-setup, a serving crash is runtime-process); the `preview`
   evidence arm; kind-keyed browser classification immune to lying legacy signals;
   `proveWith()` so no surface instructs the impossible `run_check browser`.
5. **`feat(report,repl,memory)`** — `## Preview processes (managed)` + `## Browser
   verification` report sections, `/preview`, `/status` + journal lines, prompt guidance
   (checks → preview ready → flows → visual evidence; visual judgment never overrides).
6. **`fix` ×2** — the adversarial-review batch (below) and the live-found resume 400 (an
   EMPTY error tool_result from a no-output failing command 400'd every request of a resumed
   conversation; `toolResultBlock` now substitutes a non-empty marker, pinned).

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite 868 → **972 passed / 1 skipped
across 74 files (+104)**: supervised-runner lifecycle with real children, sweep PID-safety
(mismatch → skip, verified → kill, live sibling → skip, recycled-self → identity path), a
real Windows CIM round trip proving the encoded-token identity form, replay/TOCTOU/resume
consent matrices, announced-port readiness incl. the foreign-service refusals, 7 real
system-browser flow runs (origin lock, readiness honesty, taxonomy, PNG + trace artifacts),
view_image's adversarial sha bounds, elision monotonicity + zero-base64 pins, classification
routing, ledger closure on flow passes, and the report/gate/CHECKED pins.

Bounded adversarial review: **4 differentiated read-only lenses, ~39 findings, every one
hand-verified against the code before fixing** — 2 critical-path (a wedged taskkill hanging
session end; foreign-local-service adoption via declared ports), the rest
high/medium/low + several verified-HOLDS reports. One fix was attempted and REVERTED with
recorded evidence (Windows DETACHED_PROCESS kills the PowerShell wrapper instantly), leaving
the one-shot console-Ctrl+C reaching the preview as a documented limitation.

**Live proof** (`C:\Users\A\Desktop\agent-cli-s13-live\` — setup/driver/validate,
VALIDATION.md, transcripts, driver-run.log): two-life piped run against real claude-opus-4-8
on the QuickNotes fixture (dependency-free node:http SPA; the seeded defect — `handleAdd`
never re-renders — passes every API test and is only visible in a browser).
**44/44 post-hoc checks over persisted evidence only, 0 failures.** Plan with
`gates.completion: ['test','browser']` → sha-bound approval → test check ([s]) → preview
(ask, [s]) → the flow FAILED typed on the seeded defect (failure screenshot at the moment of
failure) → `recover(attempt)` classified `browser-verification` BEFORE the fix → the model
viewed the failure screenshot to confirm its hypothesis, fixed app.js, re-proved with test +
flow — including refusing to weaken an assertion when a count mismatch turned out to be
in-memory test-data accumulation (it restarted the preview under replay consent instead) →
third preview left running → SIGKILL → resume → the sweep identity-verified and killed a live
orphan (pid genuinely dead, port free) → preview RE-ASKED (grants never restored; `[s]`
again) → flow green → `/accept` COMPLETE → clean quit. 11 sha-verified artifact blobs incl. a
real Playwright trace zip; the log carries pointers, never pixels; zero `refs/agent-cli`;
`previews.json` empty. An earlier run's phase B additionally recorded the model
reality-checking the crash aftermath (read the file, found no fix applied, predicted and
proved the flow failure, refused the driver's "confirm it works" framing) and `/accept`
refusing a draft plan — kept as `transcript-b` evidence of honest failure behavior.

### Decisions (and why)

- **A preview is a RESOURCE, not a check kind.** A check is a bounded process that ends; a
  preview deliberately does not. The check contract is reused exactly where it fits — consent
  to a harness-resolved command — and the lifecycle (registry, sweep, TTL, single-writer
  ended events) is its own machinery.
- **Browser evidence rides the check channel; the field scheme is the integration.**
  `check:'browser'` with `exitCode: null` satisfies gates through the status rule while
  staying structurally outside the file-CHECKED exit-0 rule — one honest shape instead of two
  parallel mechanisms plus exclusion patches.
- **Kills need positive identity; deletions do not.** The worktree sweep's age hatch was
  deliberately NOT copied: a recycled pid must never be killed on a guess. Retirement
  (deregistration without a kill) is the safe exit for stale unverifiable records.
- **Flows inherit the preview's consent, origin-locked.** One human decision covers "run this
  app and verify it as a user"; the engine refuses everything not bound to a running managed
  preview — there is no ask path to browse arbitrary origins.
- **The model sees pixels live; the log keeps pointers.** Wire images are transient by
  construction: resume replays what the log holds, elision ages pixels out after two steps,
  and the persisted record can never leak base64.
- **The environment is part of the evidence.** The E2E's live orphan is driver-synthesized
  because this machine's test-runner job object reaps every harness child on death (proven
  empirically and recorded); the sweep's identity check and kill are fully real, and the
  limitation is stated instead of papered over.

### Open issues / boundaries (deliberate, documented)

- Preview logs and screenshots are not scrubbed for secrets (same class as command output);
  screenshots capture whatever the app renders.
- Readiness proves an ANNOUNCED port answers HTTP — socket ownership is not verified (stated
  in every probeDetail); the origin lock binds the port, not the socket owner, and off-origin
  subresource egress is recorded, not confined.
- On Windows, a ONE-SHOT console Ctrl+C also reaches the preview's process group (detaching
  breaks the PowerShell wrapper — evidence recorded); its death reads as 'crashed' moments
  before session-end stop-all. The REPL is unaffected.
- Grandchildren of a dead intermediate remain unreachable by kills (the killTree gap) —
  observed live when an npm→node chain outlived its wrapper; EADDRINUSE guidance at the next
  start is the honest surface.
- A `['browser']` regression proof cannot discharge on a browser-less machine (the ledger
  accepts only real passes; escalation → `/accept confirm` is the honest exit there).
- macOS/BSD identity queries degrade to skip-not-kill (`ps` etimes is Linux-shaped; fails
  safe).

### Recommended next step

Session 14 per BLUEPRINT: the Git audit trail, the structural review gate, and the
coding-flow acceptance run — the browser/preview axis was the last missing verification
modality, so the delivery boundary is now the gap.

---

## Earlier Milestones (Sessions 1–12 — compressed per the rolling-docs policy)

Contract detail for everything below lives in `ARCHITECTURE.md`; entries here keep the
objective, the lasting decisions (with why), the evidence, and what stayed open.

### Session 12 (2026-07-25/26) — unified verification gate and typed recovery

Verification became a typed capability whose results are durable evidence (commits
`8938cfe`…`05e55ef`; suite 689→868+1). Landed: `src/checks/` (bounded never-throwing project
detection; a declarative recipe table where a project's OWN script beats a guessed tool, first
applicable row wins so consent can bind to it; `toCommand` as the single composer; normalization
whose one rule is **the exit code is the verdict**, parsers only enrich, and the named SIGNALS are
what keep later classification derivable from the log alone); the `check` policy fact with its
fail-closed branch before the command branch and **replay consent keyed on `(recipeId, command,
bodySha)`** in a store separate from `Grants`; `run_check` (parent-only, snapshot-held, three
refusals that spawn nothing) with `check.started` emitted only on a real spawn;
`PlanTask.checks`/`PlanGraph.gates` (sha-neutral when absent) with the single `depSatisfied`
predicate blocking dependents plus integration/completion boundary gates and honest waivers; and
`src/recovery/` — nine failure classes as a DATA catalogue, deterministic classification BEFORE any
repair planning, a ledger whose outcomes are DERIVED (no `repair.ended` to lose in a crash), a
bounded policy with typed stop reasons, and R11/R12 at the scheduler gate. Lasting decisions: **the
model names KINDS, the harness names COMMANDS** (the whole trust argument for consent-once checks —
and why consent had to bind the script BODY, not the stable command string: the critical review
finding of that session, where rewriting `package.json` turned one `[s]` into standing execution
consent); a FIELD, not a state, for verification (a new state would have taken an integrated task
out of R5's duplicated-mutation refusal); a gate may only be waived by a PROJECT-capability fact;
repair outcomes are derived, never recorded; and enforced/detected/recorded are three different
words. Review: 4 lenses, 21 findings, all hand-verified. Live four-life E2E on a fresh
dependency-free Node project with four real seeded defects: **39/40 evidence checks, 0 failures** —
including a SIGKILL landing inside a running check (replayed as "produced no verdict"), a classified
`test-assertion` repair that said plainly it had changed a test, a genuine `[s]` replay re-run, and
a `dependency-setup` failure that REFUSED automatic repair and escalated (after which `/accept`
refused COMPLETE naming the open escalation). Still relevant: a `session`-targeted escalation clears
only via a proven attempt for the same failure (`/accept confirm` is the exit); `run_check` is
parent-only (an executor worktree lacks gitignored deps); non-Node/Python projects are `unsupported`
with the reason; a per-task gate is not invalidated by unrelated later changes (the completion gate
covers combined state); an all-`main` plan cannot declare per-task gates, so that path is
unit-tested only.

### Session 11.5 (2026-07-24) — the durable session: lifecycle completion, acceptance boundary, crash-proof continuation

Consolidation landed as designed (commits `c940e9f`…`025bca4` + fixes; suite 645→688+1; live
three-life E2E with a mid-wave SIGKILL, resume, /accept, and an unplanned second kill absorbed —
30/30 evidence checks). Landed: crash-covered task-base ref lifecycle (`task.base-checkpoint`
creation events — deliberately NOT `git.checkpoint`, which is user-consent provenance — with
the owed prune list seeded FROM EVENTS and missing-ref-tolerant deletion so retries converge);
truncation spill blobs at the tool.completed choke point (commands + delegates only, redaction
skips spill, ≤2 MiB, sha-verified, "captured" never "full"; reconstruct never reads blobs
back); definition identity (`task.started.planTaskSha`; completed state belongs to the
definition that RAN — an amendment re-opens changed tasks; attemptHistory on every state); R10
(3 genuine failures per current definition; crashes and user stops never count); and the
`/accept` boundary (a pure fold; COMPLETE = plan fully executed AND every applicable capture
applied; user-typed consent; retirement via the EXISTING discard flow — supersede-in-place,
never archive-by-delete, which would have added the system's only un-undoable act; idempotent
re-accept finishes an interrupted cleanup; staleness honest on every surface; the
deterministic journal Handoff). A recorded capability demo then exposed the all-`main`-plan
contradiction, fixed as `4d86650` (parent-owned tasks counted apart; role guidance prefers
executors). Still relevant: cleanup at acceptance is deliberately conservative (snapshots,
blobs, plan files, logs are never deleted); one-shot sessions cannot accept (pooled);
the journal Handoff evaporates when its entry compresses (by design).

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
pruning/sanitized export; prompt-history persistence + line-editing niceties; PTY support
(the supervised preview substrate deliberately stops at non-interactive servers);
`--max-turns` flag vs internal `maxSteps` naming alignment; plan-file pruning (one doc per
session accumulates in the state dir).
**Delivery/review follow-ups (post-S14):** executor capture/apply is sensitive to a workspace
whose on-disk bytes differ from git's checkout normalization (system `core.autocrlf=true` over an
LF tree refuses every captured file as base drift — found live; capturing the base in the
PARENT's on-disk form, or detecting the mismatch at worktree creation, are the candidate shapes);
the review requirement is plan-scoped, so an events-derived requirement for plan-less executor
work is available if "any mutating session" ever becomes the wanted default; a phantom harness
checkpoint suppresses the covered-change rule until the next spawn (ref-existence probing would
close it, at the cost of I/O in a currently-pure rule); `/review` has no user-side dismissal for
a finding the user judges wrong (only the model's refute or `/accept confirm`); review rounds are
bounded by prompt guidance (2–3 lenses, ≤2 rounds) rather than a harness cap like DelegateCaps.
**Preview/browser follow-ups (post-S13):** socket-ownership verification for readiness (the
announced-port + alive-re-check design accepts a residual race; owner-pid via
Get-NetTCPConnection is the likely shape); deterministic screenshot BASELINE comparison where
stable baselines exist (BLUEPRINT named it; deferred — no baseline store yet); preview log
files join the pooled blob-GC/retention question; non-Node preview recipes (a static-server
recipe for plain HTML workspaces; python -m http.server as a data row); executor-side preview
(blocked on the same worktree-lacks-deps seam as run_check); headed/devtools browser mode and
multi-context flows; `ps` etime parsing for macOS/BSD sweep identity (Linux-shaped today,
fails safe); a Windows one-shot Ctrl+C console-group workaround if the documented 'crashed'
mislabel ever bites in practice.
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
