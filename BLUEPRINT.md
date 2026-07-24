# Agent CLI — Near-Term Development Blueprint

## 1. Purpose

This is the rolling near-term direction guide for Agent CLI after Session 11.5.

It begins from the implemented and live-proven V0.9 state described in `ARCHITECTURE.md` and
`ROADMAP.md`. It does not replace the enduring thesis in `PROJECT.md`, and it should not become a
detailed implementation checklist. Each session must still begin in plan mode, inspect the current
repository, validate the assumptions below, and propose a session-sized design from evidence.

The near-term decision has changed slightly:

> Before the first non-coding workflow pack, turn the current coding capabilities into a coherent,
> proportionate, evidence-driven workflow that can understand large repositories, plan iteratively,
> execute in parallel when justified, verify real outcomes, recover from typed failures, and leave
> every change reviewable and reversible.

This is not a reason to inflate `runTurn` into a workflow engine. The coding flow should become the
first optimized workflow layer built on the small kernel, and should establish reusable contracts
for later document, PDF, image, and video packs.

## 2. Current Starting Point (post-Session 11.5, V0.9)

The foundation is already substantial and has four recorded live proofs (the V0.7 loop, the V0.8
large-repo retrieval run, the V0.9 crash/resume planning run, and the Session 11.5 durable-session
run through interrupt → resume → acceptance → cleanup):

- one shared `runTurn` for one-shot, REPL, parent, and child sessions;
- a central fail-closed policy choke point, recorded approvals, and narrowing-only configuration;
- append-only evidence, crash repair, deterministic reports, snapshots, undo, and project memory;
- managed subprocess execution with typed termination and real cancellation;
- a probed Windows Low-IL write/lifecycle sandbox, honestly separate from approval;
- Git-aware diff, checkpoints, restore, and worktree-isolated executor groups;
- ranked incremental repository retrieval, focused explorer briefs, and structured child reports;
- one canonical structured plan per session with content-sha approval, amendment invalidation,
  observable routing, and user/agent projections;
- a dependency-aware task DAG gate (R1–R10) over bounded parallel executor groups, plan bindings
  with per-definition identity, events-rebuilt budgets, bounded supervision, task-scoped
  cancellation, and the live TTY task surface;
- Session 11.5 — the durable session: crash-covered task-base ref lifecycle (creation events +
  resume-seeded pruning), truncation spill blobs (command/delegate output survives as
  content-addressed evidence), per-attempt history with a bounded retry ceiling, completed-state
  bound to the task definition that ran, and the explicit acceptance boundary (`/accept` →
  recorded consent → plan retirement + cleanup → journal handoff with resume pointers).

The largest remaining coding-flow gaps are now verification and delivery quality rather than
coordination:

- verification is still mainly command-oriented rather than a typed gate with project-aware checks;
- failure handling lacks a structured classifier and bounded repair policy (the fold's
  attemptHistory and the R10 ceiling are the ground it will build on);
- no managed long-running preview process or browser/visual verification path exists;
- the final review stage is still prompt-shaped rather than a structural completion gate;
- Git recovery is strong, but automatic phase-level audit history needs a policy that does not
  silently pollute the user's intentional branch history.

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

### Session 11 — Iterative Planning, Task Graphs, and Parallel-First Execution: COMPLETE (V0.9)

Landed as designed; full record in `ROADMAP.md`, contracts in `ARCHITECTURE.md`. One canonical
JSON plan with content-sha approval (amendment structurally invalidates; superseded un-trapped),
user/agent projections, observable routing (`@plan`/`@direct` + `plan.route`), the DAG gate
(R1–R9) with plan bindings and events-rebuilt caps, bounded supervision (loop/budget/stall) with
the head-of-result group digest, task-scoped `/cancel`, the TTY sticky status area + live task
table, and crash/resume honesty (interrupted tasks re-spawnable; capture loss folds to failed).

### Session 11.5 — The Durable Session (consolidation): COMPLETE

Landed as designed; full record in `ROADMAP.md`, contracts in `ARCHITECTURE.md`. A session is
now a durable, self-contained unit of work: crash-covered task-base ref lifecycle, truncation
spill blobs, definition-bound completed state with per-attempt history, the R10 retry ceiling,
and the explicit `/accept` completion boundary with cleanup and journal handoff — live-proven
through a deliberate mid-wave SIGKILL, resume, completion, acceptance, and memory handoff.

### Session 12 — Unified Verification Gate and Typed Recovery

Make verification a first-class runtime/workflow result rather than a collection of persuasive shell
logs.

Introduce typed check capabilities and project detection for common build, test, lint, typecheck,
format, static-analysis, and targeted-test workflows. Avoid a giant hardcoded Bash/PowerShell snippet
library. Prefer typed adapters or recipes with:

- declared applicability and dependencies;
- normalized inputs and outputs;
- timeout, cancellation, and output caps;
- structured pass/fail/error/unsupported results;
- artifact and command evidence pointers;
- explicit scope, such as targeted checks before broad checks.

Large outputs should spill to evidence files rather than consume the model context or terminal.

Build a typed recovery matrix over verification and execution failures. Classification should happen
before repair planning and distinguish at least dependency/setup, compile/type, test/assertion,
lint/format, runtime/process, integration/conflict, policy/approval, timeout/resource, and unknown
failures. Each class should define whether automatic recovery is eligible, what evidence is required,
and when human confirmation is mandatory.

Automatic repair must be bounded by attempts, wall time, token budget, changed-file scope, and
regression criteria. Repeated identical failures, expanding diffs, uncertain external effects, or an
unknown classification should stop and escalate rather than loop. Every repair attempt should create
a recovery point and preserve before/after verification evidence.

### Session 13 — Managed Preview Processes and Browser / Visual Verification

Add the minimum long-running process substrate needed to verify locally built applications.

A preview server should become a managed session resource with explicit start, readiness probe,
health, logs, timeout, cancellation, port ownership, and deterministic cleanup. Do not hide a
background shell process outside the event and lifecycle model.

Build a narrow Playwright-based verification capability or coding-workflow adapter with a structured
flow specification: launch or attach to the preview, visit declared routes, perform bounded actions,
assert DOM/text/state, capture console and page errors, observe failed network requests, and save
screenshots and traces as attributable evidence.

Deterministic checks should come first. Visual model judgment is supplementary for layout, clipping,
hierarchy, consistency, and task-specific appearance; it must not turn a screenshot into unsupported
proof of functional correctness. Where stable baselines exist, deterministic screenshot comparison
may add another signal.

Browser failures should feed the same recovery matrix and bounded repair loop. The completion proof
should include a real local application, multi-step interaction, captured trace/screenshot evidence,
a deliberately introduced failure, targeted repair, and clean process teardown.

### Session 14 — Git Audit Trail, Structural Review Gate, and Coding-Flow Acceptance

Turn Git, review, and final acceptance into a coherent delivery boundary.

Automatic recovery checkpoints should be standard at meaningful workflow transitions: before
parallel mutation, before integration, before repair, and before delivery. These should use the
existing snapshots, hidden refs, disposable branches, or other harness-owned side state.

Do not silently commit to the user's active branch by default. If automatic local commits are added,
use an explicit repository/user policy or a harness-managed integration branch so the user's
intentional history remains distinct. Managed commits should be small, stage-specific, diff-reviewed,
verified, attributable, undo-aware, and easy to squash or promote at delivery.

Make adversarial review a structural gate for non-trivial mutating work rather than only a prompt
suggestion. The orchestrator should launch a bounded set of differentiated read-only lenses, require
severity, evidence, affected paths, confidence, and reproduction guidance, then require the main
agent to verify load-bearing findings. Critical/high verified findings block success; lower-severity
accepted limitations are recorded explicitly.

Finish with a live coding-flow acceptance run on a realistic project:

`complexity classification -> targeted retrieval -> focused explorers -> iterative approved plan ->
task graph -> parallel executors -> integration -> typed verification -> bounded recovery ->
Playwright/visual proof where applicable -> structural review -> Git delivery/checkpoints -> report
and memory -> resume`

The goal is not a perfect universal coding agent. It is a dependable reference workflow whose state,
authority, evidence, recovery, and completion semantics are strong enough to serve as the template
for later workflow packs.

### Session 15 (next horizon) — First Non-Coding Workflow Pack

After the coding-flow acceptance gate is live-proven, begin the documents/PDF pack originally planned
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

### Before automatic recovery

- normalized verification results;
- typed failure classification;
- bounded eligibility and stopping rules;
- checkpoints before each repair;
- regression checks after repair;
- honest escalation for unknown or repeated failures.

### Before browser / visual claims

- managed preview lifecycle;
- deterministic DOM, console, network, and process evidence;
- attributable screenshots/traces;
- visual judgment labeled as judgment;
- cleanup and recovery integrated with the same runtime contracts.

### Before declaring the coding flow mature

- a structural review gate;
- Git/recovery state that survives crash and supports rollback;
- no hidden user-branch commits;
- a realistic live end-to-end run with an induced failure and successful bounded recovery;
- resume proof from persisted task/workflow state;
- reports that reconstruct the full chain without relying on assistant narration.

## 10. Recently Completed

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
- full PTY/general interactive-process support beyond the minimum managed preview need;
- deep inter-agent messaging and task continuation conversations;
- broad web research, MCP, SaaS connectors, deployment, and push/PR automation;
- SQLite indexing of events and long-term memory topic retrieval;
- multi-repository/submodule orchestration;
- general plugin marketplace or remotely distributed execution;
- simultaneous work on multiple non-coding workflow packs.

The first non-coding pack should begin only after the coding workflow is coherent enough that it can
be reused rather than copied.
