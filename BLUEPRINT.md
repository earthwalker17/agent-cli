# Agent CLI — Near-Term Development Blueprint

## 1. Purpose

A rolling, near-term direction guide. It begins from the implemented state in `ARCHITECTURE.md`
and `ROADMAP.md`, does not replace the enduring thesis in `PROJECT.md`, and is revised at the end
of every substantial session (rolling-docs policy in `CLAUDE.md`): completed sections shrink to
outcome notes, the next unresolved direction moves to the top, and later sections are corrected
whenever repository evidence invalidates them.

The central near-term decision stands:

> Deepen the execution kernel and its enforced safety boundaries before expanding horizontally
> into document, PDF, image, or video workflow packs.

## 2. Current Starting Point (post-Session 9, V0.7 consolidated + live-proven)

The kernel is a **coordinated main-agent control layer, proven live end-to-end**: one
`runTurn`; a central policy choke point with fail-closed delegation (batched,
role-table-driven) and plan-document branches; recorded consent + narrowing-only config;
append-only evidence with crash repair and deterministic reports; the managed exec substrate;
the enforced Windows Low-IL sandbox with positive-proof command review; GitOps; prompt
caching + deterministic elision; the three-document project memory; and the **minimal
agent-teams layer** (V0.7, hardened in Session 9): explicit two-table role contracts;
parallel task groups; plan mode with sha-bound approval AND the plan state displayed at the
executor spawn ask; worktree-isolated executors safe under CONCURRENT sessions
(owner-stamped, lock-protected registry; live-owner-skipping sweep), with approval
forwarding, bounded capture, drift-refusing integration, and session-end base-ref hygiene;
grants that can never store shell authority; a labeled cost roll-up; and a prompt-encoded
bounded review stage. The whole loop (plan → approve → 2 parallel executors → forwarded
approvals → apply → review panel → undo → memory) has ONE recorded live-API proof
(Session 9; artifacts outside the repo).

The remaining structural gaps, in rough order of load-bearing-ness:

- the enforced boundary is **write + lifecycle only, and Windows only** — reads and network are
  not confined; approved commands remain full-privilege by design;
- approved `run_command` file effects are **not attributable** (session-scope commits and /diff
  under-claim them; stated in every surface);
- task management UX debts: no mid-turn task list/cancel, no task resume; the
  stale-forwarded-prompt line-consumption wart;
- per-sandboxed-command latency (~1.2 s Add-Type host; probe ~4–11 s on this machine);
- no background/long-running process sessions; no PTY;
- context work covers tool outputs only; the repo map is a file list, not ranked retrieval;
- no workflow packs yet — the entire artifact-quality thesis (PROJECT.md §9) is untested.

## 3. Indicative Session Sequence

### Session 10 (next) — the First Workflow Pack (documents/PDF)

Begin the **documents/PDF workflow pack** on the live-proven kernel — the first test of the
"small kernel, broad workflows" thesis. Shape (per PROJECT.md §9): request → document model
(structured intermediate representation) → deterministic render (DOCX/PDF via renderer
processes through `runManaged` — typed termination, kill/drain, sandbox wrap for free) →
domain verification beyond exit codes (pagination/heading/table checks, artifact metadata in
evidence) → targeted revision. Constraints: NO renderer logic inside `runTurn`, policy, or
the REPL; pack capabilities plug in at the assembly-time tool-attachment seam (like
delegate/update_plan/apply); artifact identity + validator results become evidence events;
dependency checks are honest refusals, not silent degradation. Readiness-gate items to
resolve IN the session: capability/dependency declarations, artifact identity in evidence,
structured validator results, the targeted-revision flow. If pack work surfaces teams-layer
friction, pay only session-sized UX debts (mid-turn task management stays deferred unless it
blocks).

## 4. Patterns to Borrow (standing references)

Research the current repositories when planning relevant work; they are references, not
templates. Codex CLI: sandbox/approval/network-policy separation, Windows sandbox
implementation, exec-policy prefix rules that never let heuristics bypass the sandbox. Claude
Code: sandbox-runtime primitives, permission-rule fragility warnings (hooks as the hard
intercept), background-task lifecycle. OpenCode: layered tri-state permissions at one evaluate/
ask choke point; tree-sitter command parsing paired with (never replaced by) glob rules. Goose:
structured shell results, spill-to-file output limits, fail-closed lessons (its allowlist and
malware checks fail open — invert). Aider: repo maps and diff-centered editing (Session 6).
Google Workspace CLI: typed operations over shell composition for future external services.

## 5. Architectural Guardrails (standing)

1. One runtime — no parallel execution loops per interface or consumer.
2. One policy choke point — no side doors, including for sandbox modes and subagents.
3. Never hide shell authority behind friendly tool names.
4. Capability ≠ authorization; a tool may exist without being available everywhere.
5. Evidence stays structured and attributable; new execution types must emit events that
   support report, resume, recovery, and indexing.
6. Cancellation must stay real as concurrency grows (parent/task/process/subagent lifecycles
   explicit).
7. Prefer narrow enforced guarantees over broad claims; never describe policy as containment.
8. Workflow logic stays outside the kernel.
9. No premature frameworks — schemas and plugin formats emerge from implementation pressure.
10. Quality gates over capability counts: tests, adversarial review, realistic E2E per increment.

## 6. Readiness Gates

**Before broad multi-agent work** — satisfied through V0.7 + Session 9: permission
inheritance/narrowing, evidence lineage, budget enforcement (V0.6); collision-free concurrent
workspaces — including CONCURRENT PARENT SESSIONS (S9: owner-stamped locked registry,
live-owner-skipping sweep); parallel-task UX shapes; merge review for mutating children; the
consent surface displaying plan state at the spawn ask (S9); and the live recorded proof of
the whole loop (S9). Still deliberately absent before any "full teams" step: inter-agent
messaging, task resume, a structural review gate.

**Before the first workflow pack** — still needed (now Session 10's in-scope items):
capability/dependency declarations; artifact identity and metadata in evidence; structured
validator results; targeted-revision flow. Satisfied already: managed subprocess execution
with cleanup and evidence (V0.3); the assembly-time tool-attachment seam (V0.6/V0.7).

## 7. Recently Completed (outcome notes)

- **Session 9 (2026-07-22/23) — pre-expansion consolidation + the live V0.7 proof: COMPLETE.**
  Bounded audit (3 Explore lenses + 1 Plan critique, hand-verified) → five fix commits:
  concurrent-session worktree safety (owner-stamped locked registry, live-owner-skipping
  sweep — closed a real destroy-live-work race); plan-approval state displayed at the
  executor spawn ask (the documented consent surface, now implemented); session-end
  task-base ref pruning with `git.checkpoint.pruned` provenance; a robustness batch
  (guarded onSpawn, stateful preview decode, one-shot Ctrl+C approval abort, omittedCount
  at apply, labeled cost roll-up, stale docblocks); and the live-E2E finding — grants and
  the [s] affordance now both key on the command FACT (a session grant can never become
  standing shell permission won by a label). Suite 498→515+1 (+17). The FULL V0.7 loop ran
  live (claude-opus-4-8: @plan → approve → 2 parallel worktree executors → forwarded asks →
  apply ×2 → /undo → 16-assertion check exit 0 → 2-lens review with parent re-verification →
  ref prune → memory write; 42 uncached input tokens; read-only contract held under attempt).
  Two recorded items found already closed (auto-run hint; gitignored disclosure). Evidence:
  `C:\Users\A\Desktop\agent-cli-s9-live\` (VALIDATION.md, transcript, decisions log, all 5
  reports, plan doc). Full detail: `ROADMAP.md` Session 9.
- **Session 8 (2026-07-22) — V0.7 coordinated parallelism + minimal agent teams: COMPLETE.**
  Explicit two-table role contracts (explorer/planner/reviewer/executor) over a batched
  fail-closed policy branch; parallel task groups inside the delegate tool (runTurn untouched);
  plan mode (persistent sha-approved plan documents behind the new planDoc policy branch,
  standing context-not-authority injection, @plan + /plan, executor gate); worktree-isolated
  executors (group base checkpoint → disposable tmp worktrees with path-guarded sweep →
  bounded binary-safe capture → drift-refusing snapshot-backed apply) with approval forwarding
  (serialized signal-linked queue over the session approver, per-task deny-stop =
  'user-stopped'); concurrency foundations (structural fresh-log refusal, 32-bit ids, atomic
  blobs, randomized git temp names); bounded review-stage prompt rule. 498 passed / 1 skipped
  (+48); mock-driven e2e only — the live proof is Session 9's first act. Full detail:
  `ROADMAP.md` Session 8; contracts: `ARCHITECTURE.md` "Tasks, roles, and parallel groups",
  "Executor isolation and integration", and "Plan mode".
- **Session 7 (2026-07-20/21) — V0.6 main-agent control layer: COMPLETE.** Three-document
  project memory (AGENT.md constitution every session; harness-generated JOURNAL.md/CODEBASE.md
  at the state root — grounded evidence sections, provenance stamps, rolling caps, verbatim
  context-not-authority framing; cache-hot narrative call with deterministic fallback, recorded
  as its own event) + read-only subagent task primitives (explorer role: one child session over
  the same runTurn, fail-closed step-0 policy branch, harness-fixed budgets with cause-tracked
  cancellation, callId+childSessionId lineage, /tasks + report + sessions surfaces,
  latestSessionId child-skip). 450+1 tests (+47); live two-session E2E proved delegation with
  unprompted parent verification of child narration, AGENT.md behavioral steering, and
  cross-session journal recall. Full detail: `ROADMAP.md` Session 7; contracts:
  `ARCHITECTURE.md` "Project memory" and "Tasks and subagents".
- **Session 6.5 (2026-07-19) — V0.5 capability demo + production-style validation: COMPLETE.**
  One continuous ~68-min recorded run (real ConPTY → xterm.js → Playwright, byte-truthful,
  supervisor-driven): Agent CLI built LedgerLite (20 files, 51 tests, esbuild build) from a
  natural-language brief under live approvals, then demonstrated status/diff/attributed
  commits/checkpoint/restore/undo/report, sandboxed auto-run `git status`, deny-adapt, harness-
  note coherence, and 124-uncached-input-token caching — ending with the app driven live in the
  recorded browser. Two product fixes with regression coverage came out of the foundation
  review (sandbox probe retry `763032f`; test whoami path `21a8c40`); suite 403+1. Evidence:
  `C:\Users\A\Desktop\ledgerlite\validation\` (MP4, PTY transcript, session report,
  VALIDATION.md); full narrative in `ROADMAP.md` Session 6.5. Standing UX finding: a system-
  prompt hint for the auto-runnable command shape (deferred pool).
- **Session 6 (2026-07-18) — Git-native, reviewable, context-efficient: COMPLETE (scoped).**
  GitOps as a harness-only capability (a policy regression test pins why it must never be a
  model tool): hardened git substrate (absolute-path resolution, fsmonitor off, optional-locks
  off, GIT_* scrub), probed `git.context`, `/diff` + `agent diff` (attributable, drift-flagged),
  session-scoped `/commit` + trust-gated `agent commit` (blockers where attribution would
  corrupt), hidden-ref checkpoints with snapshot-first restore that is one applyUndo unit —
  proven byte-identical user git state, and git is never the undo mechanism (the Codex
  ghost-commit lesson). Context efficiency: two-breakpoint prompt caching (live: 6 uncached
  input tokens), monotone deterministic elision, git-backed map. Editing: replace_all + line
  paging. 398 tests; scripted + CLI + live-API E2E. **Explicit deferrals** (not silently
  dropped): patch/multi-edit hunk editing; isolated worktrees (S7 dependency); ranked/selective
  repo map; model-generated compaction and commit messages; attribution of command file
  effects; cached sandbox host. Full detail: `ROADMAP.md` Session 6; contracts:
  `ARCHITECTURE.md` "GitOps" and "Context budget".
- Sessions 1–5: compressed to `ROADMAP.md` "Earlier Milestones" (V0.1 loop → proxy → recorded
  demo → V0.3 exec hardening → V0.4 enforced isolation + automatic review).
