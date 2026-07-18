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

## 2. Current Starting Point (post-Session 6, V0.5)

The single-agent execution kernel is substantially complete: one shared `runTurn`; a practical
REPL; central policy choke point; recorded consent + narrowing-only config; append-only evidence
with crash repair and deterministic reports; the managed exec substrate (real cancellation,
typed termination, env hygiene, lifecycle evidence); the enforced Windows Low-IL sandbox with
automatic positive-proof command review (fail-closed); and — new in V0.5 — the **GitOps layer**
(hardened harness-only git substrate; probed session git context; attributable session diff with
write-time diffstat evidence; deliberate session-scoped commits; hidden-ref checkpoints with
snapshot-first undoable restore), **prompt caching** (two-breakpoint, live-proven ~6 uncached
input tokens per short session), **deterministic wire-history elision** (monotone raw-size
boundary), a **git-backed workspace map** (nested gitignore correct), and editing precision
(replace_all, line paging).

The remaining structural gaps, in rough order of load-bearing-ness:

- **no task/subagent primitives** — bounded parallel work, isolated context, permission
  narrowing, and evidence lineage do not exist yet (Session 7);
- the enforced boundary is **write + lifecycle only, and Windows only** — reads and network are
  not confined; approved commands remain full-privilege by design;
- approved `run_command` file effects are **not attributable** (session-scope commits and /diff
  under-claim them; stated in every surface);
- per-sandboxed-command latency (~1.2 s Add-Type host) — hotter now that read-only git auto-runs
  are a common path;
- no background/long-running process sessions; no PTY;
- context work covers tool outputs only (assistant/user text is not compacted) and the repo map
  is a file list, not ranked retrieval.

## 3. Indicative Session Sequence

### Session 7 (next) — Task and Subagent Runtime Primitives

Unchanged in intent: small bounded subagents with explicit inputs/outputs, isolated context,
scoped tools, inherited-or-narrowed permissions, independent lifecycle/cancellation/budget, and
attributable evidence lineage. The prerequisites landed across S4–S6: per-call signal plumbing
(S4), the Windows boundary a subagent runs inside (S5, honest caveats), and — from S6 —
repo-scoped GitClient/checkpoint namespaces (a worktree is just another instance), attributable
evidence, and wire-history budgeting for parallel contexts. Read-only roles first. A subagent
result is evidence, not accepted truth.

### Session 8+ — Coordinated Agent Teams

Unchanged: smallest composable coordination kernel (decomposition, bounded parallelism, isolated
workspaces, reviewable integration, global verification, shared budgets and cancellation
propagation) — only after task isolation and lineage are proven.

### First Non-Coding Workflow Pack — After the Foundation

Unchanged: documents/PDF first, consuming stable kernel capabilities (the exec substrate now
provides managed renderer-process execution); structured intermediate representations;
domain verification beyond exit codes; no renderer logic inside `runTurn`, policy, or the REPL.

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

**Before broad multi-agent work** — still needed: task permission inheritance/narrowing;
collision-free concurrent workspaces (worktrees — the S6 GitClient is instance-scoped for this);
parent/child evidence lineage. Now satisfied by V0.3: process cancellation and reaping
semantics. Now partially satisfied by V0.4: an enforced boundary EXISTS on Windows (Low-IL +
Job Object) — but Windows-only, writes/lifecycle only. Now partially satisfied by V0.5:
context/budget bounds exist for the wire history (deterministic elision + caching), and
reviewable integration has its primitives (attributable session diff, session-scoped commits,
checkpoint recovery) — per-subagent budget enforcement and merge review remain open.

**Before the first workflow pack** — still needed: capability/dependency declarations; artifact
identity and metadata in evidence; structured validator results; targeted-revision flow.
Now satisfied by V0.3: managed subprocess execution with clear cleanup and evidence.

## 7. Recently Completed (outcome notes)

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
- **Session 5 (2026-07-18) — Enforced isolation + automatic command review: COMPLETE (scoped).**
  A real, OS-enforced Windows boundary (`windows-lowil`: Low integrity + Job Object) proven by
  direct machine probe and 8 real-OS tests — writes to the workspace/profile/system/state DENIED,
  detached grandchild reaped on kill; established by a fail-closed runtime probe and reported
  truthfully everywhere (never assumed, no cross-platform parity). Automatic command review
  (deterministic positive-proof `analyzeCommand`) replaced "every command asks": a provably-safe
  command auto-runs *inside* the sandbox, everything else asks, and with no enforcement auto-run is
  disabled — backed by policy + enforcement, never the model's opinion (66-assertion adversarial
  corpus). Honest scope: writes + lifecycle only; reads/network NOT confined. Full detail:
  `ROADMAP.md` Session 5; contracts: `ARCHITECTURE.md` "Sandbox and enforced isolation".
- **Session 4 (2026-07-17) — Execution kernel hardening: COMPLETE.** Managed exec substrate;
  real mid-command cancellation (REPL + one-shot, proven with a genuine delivered console
  CTRL_C against the live API); typed termination with no-exit-code-when-killed enforced through
  report/resume/renderer; verified best-effort tree kill + bounded drain (grandchild pipe-hang
  regression-tested); default-on child-env hygiene with narrowing-only config; command lifecycle
  evidence events. Full detail: `ROADMAP.md` Session 4; design contracts: `ARCHITECTURE.md`.
