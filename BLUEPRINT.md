# Agent CLI — Near-Term Development Blueprint

## 1. Purpose

This is the rolling near-term direction guide for Agent CLI after Session 10.

It begins from the implemented and live-proven V0.8 state described in `ARCHITECTURE.md` and
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

## 2. Current Starting Point (post-Session 10, V0.8)

The foundation is already substantial and has two recorded live proofs (the V0.7 loop and the
V0.8 large-repo retrieval run):

- one shared `runTurn` for one-shot, REPL, parent, and child sessions;
- a central fail-closed policy choke point, recorded approvals, and narrowing-only configuration;
- append-only evidence, crash repair, deterministic reports, snapshots, undo, and project memory;
- managed subprocess execution with typed termination and real cancellation;
- a probed Windows Low-IL write/lifecycle sandbox, honestly separate from approval;
- Git-aware diff, checkpoints, restore, and worktree-isolated executor groups;
- persistent sha-bound plan documents and explicit plan approval;
- explicit planner, explorer, executor, and reviewer role contracts;
- bounded parallel task groups, approval forwarding, captured task changes, drift-refusing
  integration, and attributable parent/child lineage;
- a bounded adversarial review pattern and a live V0.7 loop through plan, parallel execution,
  integration, review, undo, and memory;
- Session 10: a ranked, incrementally indexed repository map under a hard budget (complete
  dir-tree recall backstop, honest partial states, flat-map fallback everywhere it belongs),
  a task-directed `retrieve` tool with signal-attributed hits and live-read excerpts (parent +
  read-only roles), non-overlapping explorer focus/avoid briefs with sibling coverage, the
  six-section explorer report contract with a non-blocking harness check, and delimiter
  hardening of child reports/context — live-proven on a 3k-file monorepo.

The largest remaining coding-flow gaps are now coordination and product quality rather than basic
agent capability:

- plan approval exists, but plan revision and user-facing versus execution-facing views need a
  stronger contract;
- parallel execution exists, but there is no persistent task graph or complete mid-turn task
  management surface;
- verification is still mainly command-oriented rather than a typed gate with project-aware checks;
- failure handling lacks a structured classifier and bounded repair policy;
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

### Session 11 — Iterative Planning, Task Graphs, and Parallel-First Execution

Strengthen plan mode into a complete human-in-the-loop planning lifecycle and connect it to execution.

Use one canonical structured plan state rather than two independently editable documents. Derive:

- a concise user-facing projection for review and approval;
- a detailed agent-facing projection containing dependencies, candidate files, risks, ownership,
  verification criteria, and evidence references.

User feedback should amend the canonical plan, invalidate the previous approval, regenerate both
views, and return to review until the current plan bytes are approved. Complexity routing should be
observable and overridable through explicit plan invocation.

Convert approved plans into a bounded task graph rather than a flat narrative checklist. Each task
should carry an id, owner/role, dependencies, expected touch set, status, budget, verification rule,
and evidence lineage. The scheduler should prefer safe parallelism where dependency and path-conflict
analysis supports it, while keeping core, tightly coupled, or high-risk work serial.

Add a live task surface for both the main agent and user: queued, running, blocked, awaiting approval,
integrating, verifying, recovering, completed, failed, and cancelled. Mid-turn inspection and
task-scoped cancellation should become real contracts; crash/resume should not silently duplicate a
completed mutation or lose a blocked task.

The scheduler must remain bounded. It is not an autonomous swarm and should not introduce general
inter-agent chat unless repository evidence proves it necessary.

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

### Before automatic parallel execution becomes the default consideration

- targeted explorer briefs and non-overlapping scopes — LANDED (Session 10);
- structured explorer evidence — LANDED (Session 10: six-section contract + harness check);
- canonical approved plan state;
- explicit task dependency and expected-touch metadata;
- task-scoped cancellation and visible status;
- conflict-aware integration and deterministic cleanup.

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
