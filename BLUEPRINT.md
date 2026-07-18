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

## 2. Current Starting Point (post-Session 5, V0.4)

The runtime spine now includes a hardened execution kernel AND a genuinely OS-enforced Windows
boundary: one shared `runTurn`; a practical REPL; central policy choke point; recorded consent +
narrowing-only config; append-only evidence with crash repair and deterministic reports; the V0.3
managed exec substrate (real cancellation, typed termination, best-effort tree kill, env hygiene,
lifecycle evidence); and — new in V0.4 — `src/sandbox/` with a `windows-lowil` backend that runs an
auto-run command at Low integrity inside a Job Object (OS-denied writes to Medium+ objects;
guaranteed tree reaping via kill-on-close), plus **automatic command review** (a deterministic
positive-proof gate) that replaced "every command asks", is fail-closed, and is backed by the
enforced sandbox rather than the model's opinion.

The remaining structural gaps, in rough order of load-bearing-ness:

- the enforced boundary is **write + lifecycle only, and Windows only** — it does NOT confine
  reads, does NOT gate the network, and has no macOS/Linux analog; these are the honest next
  isolation targets (network egress control and a read/confidentiality boundary matter most);
- `run_command` when APPROVED remains a full-privilege escape hatch by design (the user accepted
  the risk); nothing constrains what an approved command may touch;
- per-sandboxed-command latency (a PowerShell start + `Add-Type` compile, ~1.2 s) wants a cached
  compiled host; service-reparented work (schtasks/sc/wmic/BITS) escapes the Job Object;
- no background/long-running process sessions (a dev server can only live inside one command's
  lifetime); no PTY;
- repository context, long-session token management, Git-native review, and isolated parallel
  work are still immature — prerequisites for dependable subagents.

## 3. Indicative Session Sequence

### Session 6 (next) — Git-Native, Reviewable, Context-Efficient Coding

Unchanged in intent: precise patch/diff editing, Git status and change review, optional
checkpoints and delivery-boundary commits, isolated worktrees where they solve real problems, a
higher-quality repo map with selective retrieval, and long-session token budgeting with
evidence-backed compaction. Git serves review, recovery, and future isolation; it must not
silently replace the snapshot model or the no-Git-unless-asked rule.

### Session 7 — Task and Subagent Runtime Primitives

Unchanged: small bounded subagents with explicit inputs/outputs, isolated context, scoped tools,
inherited-or-narrowed permissions, independent lifecycle/cancellation/budget, and attributable
evidence lineage. Session 4's cancellation work supplies the per-call signal plumbing; Session 5
answered which boundary a subagent runs inside on Windows (the `windows-lowil` sandbox) — a
read-only subagent could execute confined today, with the honest caveat that reads/network are not
yet confined. Read-only roles first. A subagent result is evidence, not accepted truth.

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
collision-free concurrent workspaces; context/budget bounds; parent/child evidence lineage;
reviewable integration + final verification. Now satisfied by V0.3: process cancellation and
reaping semantics. Now partially satisfied by V0.4: an enforced boundary EXISTS on Windows
(Low-IL + Job Object) and a subagent could run inside it — but only Windows, and writes/lifecycle
only (no read or network confinement yet), so "enforced boundary per platform" remains open.

**Before the first workflow pack** — still needed: capability/dependency declarations; artifact
identity and metadata in evidence; structured validator results; targeted-revision flow.
Now satisfied by V0.3: managed subprocess execution with clear cleanup and evidence.

## 7. Recently Completed (outcome notes)

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
