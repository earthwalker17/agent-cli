# Agent CLI — Near-Term Development Blueprint

## 1. Purpose

This is the rolling near-term direction guide for Agent CLI after **v1.0** (Session 14.5).

It begins from the implemented and live-proven **v1.0** state described in `ARCHITECTURE.md` and
`ROADMAP.md`. It does not replace the enduring thesis in `PROJECT.md`, and it should not become a
detailed implementation checklist. Each session must still begin in plan mode, inspect the current
repository, validate the assumptions below, and propose a session-sized design from evidence.

The near-term decision, now that the coding flow is complete:

> Build the first NON-CODING workflow pack on the contracts the coding flow established —
> reusing context, tasks, verification, recovery, review, and delivery rather than copying them —
> and let that reuse prove the kernel generalizes beyond code.

This is not a reason to inflate `runTurn` into a workflow engine. The coding flow is the first
optimized workflow layer built on the small kernel; the documents/PDF pack is the second, and the
seam between them is what the next sessions are really testing.

## 2. Current Starting Point (post-Session 14.5, **v1.0**)

The foundation is substantial and has eight recorded live proofs — most recently the V1.0 demo
(one natural-language request → plan → user-requested revision → sha-bound approval → parallel
worktree executors → integration → typed checks → managed preview → browser verification →
adversarial review → crash → resume → acceptance → memory handoff). The coding flow is complete
and the kernel is clean; Session 15 begins the first non-coding workflow pack.

- one shared `runTurn` for one-shot, REPL, parent, and child sessions;
- a central fail-closed policy choke point, recorded approvals, and narrowing-only configuration;
- append-only evidence, crash repair, deterministic reports, snapshots, undo, and project memory;
- managed subprocess execution with typed termination and real cancellation;
- a probed Windows Low-IL write/lifecycle sandbox, honestly separate from approval;
- Git-aware diff, checkpoints, restore, and worktree-isolated executor groups;
- ranked incremental repository retrieval, focused explorer briefs, and structured child reports;
- one canonical structured plan per session with content-sha approval, amendment invalidation,
  observable routing, and user/agent projections;
- a dependency-aware task DAG gate (R1–R12) over bounded parallel executor groups, plan bindings
  with per-definition identity, events-rebuilt budgets, bounded supervision, task-scoped
  cancellation, and the live TTY task surface;
- Session 12 — typed verification and recovery: project-aware check recipes with normalized
  exit-code verdicts and named signals, a `check` policy fact with body-bound replay consent, the
  task-graph verification gate (dependents unblock only on green) with integration/completion
  boundary gates and honest waivers, and the eleven-class recovery catalogue with deterministic
  classification, a derived-outcome repair ledger, and a bounded policy enforced at the scheduler;
- Session 11.5 — the durable session: crash-covered task-base ref lifecycle (creation events +
  resume-seeded pruning), truncation spill blobs (command/delegate output survives as
  content-addressed evidence), per-attempt history with a bounded retry ceiling, completed-state
  bound to the task definition that ran, and the explicit acceptance boundary (`/accept` →
  recorded consent → plan retirement + cleanup → journal handoff with resume pointers).

- Session 13 — managed previews + browser/visual verification: a preview server as an explicit
  session resource (supervised fd-logged process, announced-port readiness, TTL/log caps,
  identity-verified crash sweep, deterministic teardown, body-bound replay consent with honest
  persistent-process wording); typed browser flows over playwright-core + the system browser
  (declared readiness, typed failure taxonomy, origin lock, sha-addressed screenshots/traces,
  check-kind 'browser' feeding the same gates/acceptance/recovery); wire images (the model sees
  screenshots live, the log keeps pointers, elision ages pixels to markers); two new recovery
  classes.

- Session 14 — the delivery boundary: harness checkpoint lineage (event-before-ref, three kinds,
  the covered-change rule, a delivery anchor keyed on the acceptance that consumed it) and the
  structural review gate (typed findings recorded at the source, a pure fold deriving
  requirement/qualification/triage worth, open critical/high blocking `/accept`).

- Session 14.5 — v1.0 consolidation: a repo-wide 4-lens adversarial review (23 findings, all
  hand-verified and fixed, including a replay-consent hole where a 200-char display cap was the
  consent identity, a `max_tokens`-mid-tool-call wire bug that permanently invalidated a live
  session, and an unreachable `aborted` classification branch that turned cancellations into
  repairable defects); the executor-capture EOL pin; review-gate coherence (in-window
  de-qualification, capture-as-work, a reviewer budget that fits its own brief, a harness round
  cap); and honest-degrade fixes across the hygiene paths.

What remains open on the coding axis is narrow and deliberate:

- the review requirement is PLAN-scoped, so executor work delegated with no plan derives none
  (recorded findings still block) — the user's explicit choice over "any mutating session";
- executors cannot self-verify (a worktree has no gitignored dependencies, so `run_check` and
  the preview/browser tools are parent-only) — acceptable because the parent verifies after
  integration;
- the EOL pin covers a uniformly-LF parent tree; a genuinely MIXED tree still refuses captured
  files at apply, now with a diagnosis that names line-ending normalization and exits that work.

## 3. Target Coding Workflow

The desired default flow is:

`Classify -> Retrieve / Explore -> Plan -> Revise -> Approve -> Schedule -> Execute -> Integrate -> Verify -> Recover -> Review -> Checkpoint / Deliver -> Record`

This is one workflow with proportional stages, not one expensive ritual for every request.

- A small, well-scoped task may classify directly into a short single-agent path.
- A complex, ambiguous, cross-cutting, or high-risk task should enter focused exploration and plan
  mode automatically.
- Parallel exploration or execution should be selected only when scopes are genuinely separable.
- Every mutating task should have explicit completion criteria and a verification path.
- Every task reaches a completion gate, but the gate may range from a focused diff/check by the main
  agent to a bounded multi-agent review panel.
- No stage may claim success from narration alone.

The workflow state should be explicit and event-backed so the REPL, reports, resume logic, and future
workflow packs all observe the same truth.

## 4. Indicative Session Sequence

Sessions 11 → 14 built the coding workflow and are COMPLETE; their full records live in
`ROADMAP.md` and their contracts in `ARCHITECTURE.md`. In one line each:

- **11 — iterative planning, task graphs, parallel-first execution.** One canonical JSON plan
  with content-sha approval, observable routing, the DAG gate, bounded supervision, `/cancel`,
  the live task surface.
- **11.5 — the durable session.** Crash-covered ref lifecycle, spill blobs, definition-bound
  completed state, the retry ceiling, and the `/accept` boundary with cleanup and handoff.
- **12 — unified verification gate + typed recovery.** The model names KINDS, the harness names
  COMMANDS; exit-code-is-the-verdict; gates that block dependents; the failure-class catalogue
  with derived repair outcomes and a bounded policy.
- **13 — managed previews + browser/visual verification.** A preview is a RESOURCE, not a check
  kind; typed flows over the system browser emit check evidence of kind 'browser'.
- **14 — the delivery boundary.** Harness checkpoint lineage (event-before-ref, delivery keyed on
  the acceptance that CONSUMED it) and the structural review gate.

### Session 14.5 — v1.0 consolidation: COMPLETE

Landed as designed; full record in `ROADMAP.md`. A repo-wide bounded adversarial review (4
lenses, 23 findings, 48 invariants held, every finding hand-verified before fixing), the
executor-capture EOL pin that closed the last live-found S14 gap, review-gate coherence, the
deferred-pool items worth doing now, the V1.0 stamp, and a documentation consolidation pass.
Suite 1029→1072+1. The skipped live-API test was reviewed and RUN live: the guard stays (CI must
be hermetic), and the run re-proved the default model id and the provider adapter.

### Session 15 (next horizon) — First Non-Coding Workflow Pack

The coding flow is complete and live-proven; begin the documents/PDF pack originally planned
for Session 10.

Its likely shape remains:

`request -> structured document model -> deterministic renderer -> artifact evidence -> pagination /
heading / table checks -> visual inspection -> targeted revision`

The pack should reuse the context, task, verification, recovery, browser/artifact evidence, and
delivery contracts established above without moving domain logic into `runTurn`, policy, or the REPL.

## 5. Design Decisions to Preserve

### One canonical plan, multiple views

The user-facing and agent-facing plans should be projections of one structured source of truth.
Maintaining two independent plan documents would create approval drift and contradictory state.

### Targeted retrieval before delegation

A larger agent count is not a retrieval strategy. First identify the questions and likely code
regions; then delegate bounded scopes. Detect and avoid redundant explorer assignments.

### Main-agent ownership of critical context

The main agent owns user intent, the critical path, integration, final verification, and final
claims. Subagents provide compressed evidence and implementation candidates, not authority.

### Parallelism is earned by independence

The scheduler should consider dependencies, expected touch sets, shared generated files, migrations,
configuration, and verification coupling. Parallel-first means actively looking for safe concurrency,
not forcing every plan into multiple worktrees.

### Deterministic evidence before model judgment

Test results, type checks, DOM assertions, process health, diffs, and structured events outrank model
review. Model judgment adds value where the success criterion is semantic or visual, but cannot erase
failed deterministic evidence.

### Recovery is a policy, not “try again”

Every automatic repair needs a typed failure, bounded eligibility, a checkpoint, a materially changed
hypothesis, and a stopping condition. Unknown or repeated failures become an honest escalation.

### Automatic Git safety without hidden history pollution

Use automatic harness-owned recovery state by default. User-visible commits require an explicit
standing repository policy or a clear delivery boundary; they should never be a side effect of merely
running Agent CLI.

### Workflow orchestration stays outside the kernel

`runTurn`, the central policy gate, the event log, and the managed executor remain reusable
primitives. Coding-specific routing, recipes, verification matrices, browser flows, and review gates
belong in a workflow/orchestration layer attached through explicit contracts.

## 6. Additional Cross-Cutting Upgrades

Fold these in only where they are directly required by the sessions above:

- explicit workflow-phase and verification events that support report, resume, and later indexing;
- idempotency keys for resumable task, integration, verification, and repair steps;
- command-output spill-to-file with bounded model summaries;
- capability/dependency declarations so unsupported checks refuse honestly;
- incremental caches keyed by file hashes, repository HEAD, tool versions, and configuration;
- a small benchmark/evaluation set covering repository retrieval, plan quality, parallel conflict
  avoidance, recovery convergence, browser verification, and review recall;
- cost and latency budgets by workflow phase, not only by session or child task;
- sanitization and provenance labels on explorer, test, browser, and reviewer reports;
- structured completion reasons such as success, partial, blocked, user-stopped, budget-exhausted,
  unsupported, and failed-unrecovered.

Do not pull in SQLite, a general graph runtime, MCP, deep inter-agent messaging, or a plugin framework
only because they appear relevant. Adopt them only when the implemented workflow state can no longer
remain clear and correct with the current modular-monolith contracts.

## 7. Patterns to Borrow (References, Not Templates)

Research current implementations again when each session begins.

- **Aider:** tree-sitter-backed repository maps, dependency-graph ranking, token-budgeted selective
  context, diff-centered editing, and Git review ergonomics.
- **Claude Code:** focused subagents with separate context/tool permissions, editable plan approval,
  worktree-based parallel sessions, task/background-process visibility, and deterministic lifecycle
  hooks.
- **OpenAI Codex:** plan mode for difficult or ambiguous tasks, explicit sandbox/approval separation,
  specialized parallel subagents, task goals, and inspectable commands/diffs.
- **OpenCode:** explicit per-agent allow/ask/deny permissions, task and to-do surfaces, and stuck-loop
  controls.
- **Playwright:** assertions before screenshots, managed web servers, traces containing DOM/network
  evidence, and visual comparisons where stable baselines exist.
- **LangGraph:** durable checkpoints, resumable human interrupts, retry policies, and the idempotency
  lessons created when a resumed node restarts. Borrow the semantics without adopting a graph
  framework prematurely.

## 8. Architectural Guardrails

1. One runtime — no second agent loop, browser loop, recovery loop, or interface-specific executor.
2. One policy choke point — workflows, subagents, checks, browsers, and Git delivery get no side
   doors.
3. Capability is not authorization; a detected tool or recipe is not automatically allowed.
4. Preserve inherited-or-narrower authority for every child and workflow stage.
5. Keep task, process, browser, approval, verification, and recovery lifecycle explicit.
6. New state transitions must be attributable, crash-repairable, reportable, and resumable.
7. Plans, memories, explorer reports, reviewer findings, and visual judgments are context or
   evidence, never authority.
8. Keep shell authority visible; typed adapters may wrap commands but must declare their real effects.
9. Do not trade honest failure for automatic completion.
10. No unbounded fan-out, retry, repair, review, or background process.
11. Do not pollute user Git history or overwrite unrelated work.
12. Preserve simple-task latency: the standard workflow must scale down as well as up.
13. Add abstractions only after a real implementation pressure reveals the boundary.
14. Require tests, adversarial review, and a realistic live E2E for every substantial increment.

## 9. Readiness Gates

### Before automatic parallel execution becomes the default consideration — ALL LANDED

- targeted explorer briefs and non-overlapping scopes — LANDED (Session 10);
- structured explorer evidence — LANDED (Session 10: six-section contract + harness check);
- canonical approved plan state — LANDED (Session 11: content-sha binding, strict gate);
- explicit task dependency and expected-touch metadata — LANDED (Session 11: the plan graph);
- task-scoped cancellation and visible status — LANDED (Session 11: /cancel + the live surface);
- conflict-aware integration and deterministic cleanup — LANDED (V0.7 drift-refusing apply +
  Session 11 R7/declared-vs-actual divergence in the digest).

### Before automatic recovery — ALL LANDED (Session 12)

- normalized verification results — LANDED (`CheckResult`, exit-code-is-the-verdict);
- typed failure classification — LANDED (eleven classes, deterministic, event-derivable);
- bounded eligibility and stopping rules — LANDED (`recovery/policy.ts`, typed stop reasons);
- checkpoints before each repair — LANDED by REUSE, not by new machinery: parent edits are
  snapshot-backed by construction and an executor re-run creates a fresh group base checkpoint,
  so a second recovery mechanism would have added crash windows to buy nothing;
- regression checks after repair — LANDED (an attempt is proven only by the checks it declared,
  which must include the kind that actually failed);
- honest escalation for unknown or repeated failures — LANDED (`recover escalate`, an acceptance
  blocker; `unknown` is a first-class stop, never a shrug).

### Before browser / visual claims — ALL LANDED (Session 13)

- managed preview lifecycle — LANDED (supervised runner, registry, identity-verified sweep);
- deterministic DOM, console, network, and process evidence — LANDED (typed step taxonomy,
  bounded records, preview lifecycle events);
- attributable screenshots/traces — LANDED (sha-addressed blobs, budgeted, report pointers);
- visual judgment labeled as judgment — LANDED (view_image + the prompt/report/tool wording;
  a screenshot can never discharge a gate);
- cleanup and recovery integrated with the same runtime contracts — LANDED (session-end
  stop-all on every path, two catalogue classes, the shared bounded repair loop).

### Before declaring the coding flow mature — ALL LANDED (Session 14)

- a structural review gate — LANDED (`review/ledger.ts`: typed findings recorded at the source,
  derived requirement + round qualification, triage whose worth is derived, open critical/high
  blocking `/accept`);
- Git/recovery state that survives crash and supports rollback — LANDED (event-before-ref
  creation, the seq/kind-aware owed fold re-folded from live events, phantom convergence);
- no hidden user-branch commits — LANDED (hidden refs only; `/accept` suggests `/commit`,
  never performs it);
- a realistic live end-to-end run with an induced failure and successful bounded recovery —
  LANDED (see ROADMAP S14 + `C:\Users\A\Desktop\agent-cli-s14-live\`);
- resume proof from persisted task/workflow state — LANDED (the review fold rebuilds from
  events across a mid-arc SIGKILL);
- reports that reconstruct the full chain without relying on assistant narration — LANDED
  (`## Adversarial review`, `## Git recovery and audit state`, both derived purely from events).

## 10. Recently Completed

- **Session 14.5 — v1.0: consolidation, repo-wide adversarial review, live proof: COMPLETE.**
  4 read-only lenses over the whole repo → 23 findings, all hand-verified and fixed, headlined by
  a replay-consent hole (a 200-char DISPLAY cap was serving as the consent identity, so an append
  past it rode the earlier `[s]`), a `max_tokens`-mid-tool-call wire bug that permanently
  invalidated a live session, an unguarded post-write readback that discarded all mutation
  evidence, an unreachable `aborted` classification branch, a report that claimed a clean end for
  resumed-then-crashed sessions, secret classification on the unresolved path, and prompt-fence
  spoofing through memory docs and plan notes. Plus the executor-capture EOL pin, review-gate
  coherence (in-window de-qualification, capture-as-work, a reviewer budget that fits its brief,
  a harness round cap), `agent version/help` no longer starting real sessions, and the docs
  compression. Suite 1029→1072+1.

- **Session 14 — the delivery boundary: Git audit lineage + the structural review gate:
  COMPLETE.** `onRefReady` (event-before-ref: the creation-instant leak closed structurally,
  phantoms honest and self-converging) + `harness.checkpoint`/`HarnessRefKind` + the seq/kind
  aware `owedHarnessRefsFromEvents` (delivery survival keyed on the ref the latest acceptance
  CONSUMED) + the pre-integration checkpoint under the spawn-only covered-change rule
  (skip-never-refuse) + the `/accept` delivery anchor (idempotent across the crash window,
  never hostage to git, `/commit` suggested not performed); `src/review/` + `report_finding`
  (per-task accumulator, second named admission, ingestion-time neutralization) + the `review`
  triage tool (every rule enforced twice) + the acceptance axis + the plan `review` field
  (sha-neutral) + `## Adversarial review` / `## Git recovery and audit state` / `/review`.
  Suite 972→1029+1; 4-lens hand-verified review (16 findings, 8 fixed, 32 invariants HELD; the
  phantom-delivery defect found independently by all four lenses).
- **Session 13 — managed previews + browser/visual verification: COMPLETE.** `src/preview/`
  (startSupervised — a live handle over an fd-logged, TTL/log-capped, unref'd process; preview
  recipes over the fixed dev/preview/serve/start allowlist; announced-port readiness; the
  identity-verified crash sweep with no age hatch on kills) + `src/browser/` (playwright-core
  channel probe; the zod FlowSpec with REQUIRED app-meaningful readiness; the deterministic
  executor with the typed timeout/assertion/navigation/runtime/protocol taxonomy and a real
  origin comparison) + wire images (transient pixels, pointer-only logs, aging elision) +
  `preview`/`browser_flow`/`view_image` tools behind explicit fail-closed policy branches +
  kind 'browser' through the existing gates/acceptance/CHECKED/recovery machinery + two new
  failure classes. Suite 868→972+1; 4-lens review (~39 findings, all hand-verified); live
  two-life E2E 44/44 (see ROADMAP + `C:\Users\A\Desktop\agent-cli-s13-live\`).
- **Session 12 — unified verification gate and typed recovery: COMPLETE.** `src/checks/`
  (bounded project detection, a declarative recipe table where a project's own script beats a
  guessed tool, `toCommand` as the single composer, and normalization whose one rule is the exit
  code is the verdict); the `check` policy fact + fail-closed branch + replay consent keyed on
  `(recipeId, command, bodySha)` in a store separate from `Grants`; `run_check` (parent-only,
  snapshot-held, three refusals that spawn nothing) with `check.started` emitted only on a real
  spawn; `PlanTask.checks`/`PlanGraph.gates` (sha-neutral when absent) with the `verification`
  field and the single `depSatisfied` predicate that blocks dependents, plus integration- and
  completion-boundary gates and honest waivers surfaced as acceptance caveats; `src/recovery/`
  (eleven-class DATA catalogue, deterministic classification, derived-outcome ledger, bounded
  policy, `recover` tool, R11/R12). Suite 689→868+1; 4-lens hand-verified review, 21 findings
  fixed — including the critical one where replay consent bound the command string and not the
  script body, so rewriting `package.json` turned one `[s]` into standing execution consent.
  Live four-life E2E on a fresh dependency-free Node project with four real seeded defects:
  39/40 evidence checks, 0 failures (see ROADMAP + `C:\Users\A\Desktop\agent-cli-s12-live\`).
- **Session 11.5 — the durable session (consolidation): COMPLETE.** Crash-covered task-base ref
  lifecycle (`task.base-checkpoint` creation events, resume-seeded pruning, missing-ref-tolerant
  deletion); truncation spill blobs for command/delegate output (redaction-guarded, size-capped,
  "captured" never "full"); per-attempt history + definition-bound completed state (an amendment
  re-opens changed completed tasks; R10 caps genuine failures at 3 per definition, user stops and
  crashes excluded); the `/accept` boundary (recorded consent, plan retirement via supersede,
  immediate ref pruning, staleness-aware surfaces, deterministic journal Handoff with resume
  pointers, one-shot parity). Suite 645→688+1; 3-lens hand-verified review (6 findings fixed);
  live three-life E2E: SIGKILL mid-wave → resume → attempt-2 re-run → integrate → verify →
  /accept → crash-leaked ref pruned → a second unplanned kill absorbed → resume → journal
  handoff → clean quit, 30/30 evidence checks (see ROADMAP).
- **Session 11 — iterative planning, task graphs, parallel-first execution: COMPLETE (V0.9).**
  Canonical `<id>.plan.json` task graph with `planContentSha` approval binding (amendment →
  draft + invalidation, structurally; approve-refuses-invalid; legacy md fallback); structured
  `update_plan` whose validation errors return complete with nothing written; observable
  routing (`plan.route`, `@plan`/`@direct`); the delegate DAG gate R1–R9 (strict status gate:
  diverged/superseded/vanished-approved now BLOCK) with plan bindings (`task.started.planTaskId`),
  plan-informed briefs, and events-rebuilt DelegateCaps; bounded supervision (loop 3/5,
  budget-pressure 80%, stall) dual-surfaced as `task.supervision` events + the head-of-result
  group digest; task-scoped `/cancel` (idempotent registry seam) + statuses cancelled/stalled;
  the TTY-only sticky status area (all chrome through one status-aware writer; zero escapes
  off-TTY) + the live task table + mid-turn `/tasks`. Suite 574→645+1; 3-lens hand-verified
  review (kernel lens: zero findings; fixes: capture-loss false-completed, vanished-plan gate,
  display honesty); two-phase live E2E with a deliberate mid-wave SIGKILL and resume (see
  ROADMAP for the evidence).
- **Session 10 — repository intelligence and focused exploration: COMPLETE (V0.8).** Ranked
  incremental repository index (regex ts/js+py extraction, import-graph centrality, honest
  partial states, assembly-only writes) rendering a hard-budget tiered map whose complete
  directory tree is the recall backstop; the read-only `retrieve` tool (signal-attributed
  hits, live-read excerpts) for the parent and read-only roles via a named structural
  admission seam; explorer focus/avoid briefs with sibling coverage and overlap warnings;
  the six-section explorer report contract with a non-blocking harness check; delimiter
  hardening. Suite 515→574+1; 3-lens hand-verified adversarial review (all invariants HOLD);
  live proof on a 3,064-file vitest clone: flat map showed 0/14 packages, ranked map 14/14
  in ≤16k chars; two disjoint-focus explorers with zero shared reads; parent re-verified all
  load-bearing claims; 16 uncached input tokens. Evidence:
  `C:\Users\A\Desktop\agent-cli-s10-live\` + ROADMAP.
- **Session 9 — consolidation and live V0.7 proof: COMPLETE.** Fixed concurrent-session worktree
  safety, surfaced plan-consent state at executor spawn, pruned task-base refs with provenance,
  hardened approval/render/apply/cost paths, fixed command-grant keying from the live run, and
  proved the complete V0.7 loop against the real API. Final suite: 515 passed / 1 skipped.
- **Session 8 — coordinated parallelism and minimal agent teams: COMPLETE.** Added explicit role
  contracts, persistent sha-approved plan mode, bounded parallel groups, worktree-isolated
  executors, approval forwarding, captured/replayable task changes, drift-refusing integration,
  and the first bounded review-stage rule.
- Earlier sessions established the single runtime, REPL, managed execution, enforced Windows sandbox,
  automatic command review, GitOps/context efficiency, project memory, and initial delegated tasks.
  Full evidence remains in `ROADMAP.md` and implemented contracts in `ARCHITECTURE.md`.

## 11. Deferred Beyond This Sequence

Keep these visible, but do not let them distract from the coding-flow acceptance path:

- network-egress control and a read/confidentiality sandbox boundary;
- macOS/Linux enforced sandbox backends and a cached Windows sandbox host;
- attribution of arbitrary approved shell-command file effects;
- full PTY/general interactive-process support (the supervised preview substrate deliberately
  stops at non-interactive servers; stdin stays disconnected);
- deep inter-agent messaging and task continuation conversations;
- broad web research, MCP, SaaS connectors, deployment, and push/PR automation;
- SQLite indexing of events and long-term memory topic retrieval;
- multi-repository/submodule orchestration;
- general plugin marketplace or remotely distributed execution;
- simultaneous work on multiple non-coding workflow packs.

The first non-coding pack should begin only after the coding workflow is coherent enough that it can
be reused rather than copied.
