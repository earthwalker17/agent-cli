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

## 2. Current Starting Point (post-Session 7, V0.6)

The kernel is now an explicit **main-agent control layer** over the single shared runtime: one
`runTurn`; central policy choke point (now with a fail-closed delegation branch); recorded
consent + narrowing-only config; append-only evidence with crash repair and deterministic
reports; the managed exec substrate; the enforced Windows Low-IL sandbox with positive-proof
command review; the GitOps layer; prompt caching + deterministic elision; and — new in V0.6 —
the **three-document project memory** (user-owned `AGENT.md` every session; harness-generated
rolling `JOURNAL.md` + provenance-stamped `CODEBASE.md`, written by a cache-hot end-of-session
narrative call with deterministic fallback, loaded at start as labeled context-not-authority)
and the **first subagent task primitives** (read-only `explorer` role: one child session over
the same runTurn, read-only registry, auto-deny approvals, shared probed sandbox, harness-fixed
budget with cause-tracked cancellation, callId+childSessionId evidence lineage, own inspectable
log; live-proven, with the parent model observed verifying the child's narration unprompted).

The remaining structural gaps, in rough order of load-bearing-ness:

- **tasks are sequential, read-only, depth 1** — no parallelism, no worktree isolation, no
  mutating roles, no per-task cancellation, no task resume (Session 8);
- the enforced boundary is **write + lifecycle only, and Windows only** — reads and network are
  not confined; approved commands remain full-privilege by design;
- approved `run_command` file effects are **not attributable** (session-scope commits and /diff
  under-claim them; stated in every surface);
- per-sandboxed-command latency (~1.2 s Add-Type host; probe ~4–11 s on this machine);
- no background/long-running process sessions; no PTY;
- context work covers tool outputs only; the repo map is a file list, not ranked retrieval;
  journal retrieval is a newest-first inject window, not topic files.

## 3. Indicative Session Sequence

### Session 8 (next) — Coordinated Parallelism on the Task Primitives

Build outward from the proven single-task contract, in dependency order: (1) worktree-isolated
children — GitClient/CheckpointContext are already instance-scoped; the open design decisions
are trust inheritance for worktree paths (trust is keyed by realpath) and the sessionId suffix
on checkpoint temp-index names; (2) bounded PARALLEL read-only tasks (per-child logs and the
shared content-addressed snapshot store are already concurrency-safe; the delegate surface,
progress chrome, and /tasks need multi-task shapes; watch the two process-global hazards:
SIGINT handlers and process.exit stay parent-only); (3) the first MUTATING role behind
approval-forwarding to the parent (the approver-wrapper seam is designed; decide grant
routing), with worktree isolation + reviewable integration (the attributable diff/commit
machinery is the merge-review substrate). A subagent result remains evidence, not accepted
truth. Full teams (decomposition, inter-agent messaging) stay after this.

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

**Before broad multi-agent work** — now satisfied by V0.6: task permission
inheritance/narrowing (read-only registry + auto-deny + rules floor, structurally), parent/child
evidence lineage (callId + childSessionId join, lineage-stamped child logs), and per-subagent
budget enforcement (steps/tokens/wall-clock, cause-tracked). Still needed: collision-free
concurrent workspaces (worktrees — the S6 GitClient is instance-scoped for this; trust
inheritance for worktree paths is the open decision), parallel-task UX shapes, and merge review
for mutating children (the attributable diff/commit machinery is the substrate). Satisfied
earlier: process cancellation/reaping (V0.3); an enforced boundary on Windows (V0.4 —
writes/lifecycle only); wire-history budgeting + reviewable-integration primitives (V0.5).

**Before the first workflow pack** — still needed: capability/dependency declarations; artifact
identity and metadata in evidence; structured validator results; targeted-revision flow.
Now satisfied by V0.3: managed subprocess execution with clear cleanup and evidence.

## 7. Recently Completed (outcome notes)

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
