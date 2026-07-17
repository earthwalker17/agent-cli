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

## 2. Current Starting Point (post-Session 4, V0.3)

The runtime spine now includes a hardened execution kernel: one shared `runTurn`; a practical
REPL; central policy choke point; recorded consent + narrowing-only config; append-only evidence
with crash repair and deterministic reports; and — new in V0.3 — a managed exec substrate
(`src/exec/`) with real mid-command cancellation (REPL and one-shot), typed termination semantics
(killed commands have no exit code), verified best-effort tree kill, bounded drain (no
grandchild pipe-hangs), default-on child-env hygiene, and `command.started`/`command.ended`
lifecycle evidence consumed by report and resume.

The remaining structural gaps, in rough order of load-bearing-ness:

- there is **no OS-enforced isolation** of any kind — policy and approval are the only controls,
  and this is stated rather than solved;
- `run_command` remains a full-privilege escape hatch by design; nothing constrains what an
  approved command may touch;
- no background/long-running process sessions (a dev server can only live inside one command's
  lifetime); no PTY; no Job-Objects-grade tree kill;
- repository context, long-session token management, Git-native review, and isolated parallel
  work are still immature — prerequisites for dependable subagents.

## 3. Indicative Session Sequence

### Session 5 (next) — Enforced Isolation and Honest Safety Modes

Establish a sandbox architecture and prove at least one genuinely enforced isolation path,
starting with targeted research and threat modeling rather than a "sandbox" label. Distinguish:
workspace/path policy; approval policy; process containment; filesystem isolation; network
isolation; privilege reduction; container/VM/OS-native backends.

Evidence-informed anchors from Session 4's research (verify against current sources when the
session starts):

- **Codex CLI ships a real native Windows sandbox** — elevated mode (dedicated sandbox users +
  ACLs + WFP firewall) and unelevated mode (restricted token: write requires BOTH user ACL and
  restricted-SID checks; env-level network suppression, documented as weaker) — with honest,
  documented failure modes. This is the strongest existence proof that Windows-first enforcement
  is achievable, and its docs model the honesty posture this project requires.
- **Claude Code has no native Windows sandbox at all** (bubblewrap/Seatbelt only; WSL2 required)
  — a warning about the gap, not a license to overclaim.
- The V0.3 exec substrate is the intended seam: a sandbox backend should be a **transform on
  `ExecSpec` (argv/env) at spawn time** (Codex's `SandboxManager::transform` pattern), so policy,
  approval, and evidence do not change shape when a mode is enforced.
- A likely honest Windows starting point: restricted-token / low-privilege spawn for
  *unapproved-class* work, explicit `mode` reporting in the banner/report, and reduced authority
  when no enforcement is available. Any native helper must fail closed and visibly.

Completion criterion (unchanged): a clear architecture, an enforced boundary on at least one
supported path, and tests or adversarial E2E evidence demonstrating what the boundary does and
does not prevent. May span more than one session. Cross-platform uniformity must not be simulated
by weakening terminology.

### Session 6 — Git-Native, Reviewable, Context-Efficient Coding

Unchanged in intent: precise patch/diff editing, Git status and change review, optional
checkpoints and delivery-boundary commits, isolated worktrees where they solve real problems, a
higher-quality repo map with selective retrieval, and long-session token budgeting with
evidence-backed compaction. Git serves review, recovery, and future isolation; it must not
silently replace the snapshot model or the no-Git-unless-asked rule.

### Session 7 — Task and Subagent Runtime Primitives

Unchanged: small bounded subagents with explicit inputs/outputs, isolated context, scoped tools,
inherited-or-narrowed permissions, independent lifecycle/cancellation/budget, and attributable
evidence lineage. Session 4's cancellation work supplies the per-call signal plumbing this
requires; Session 5 must answer which boundary a subagent actually runs inside. Read-only roles
first. A subagent result is evidence, not accepted truth.

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

**Before broad multi-agent work** — still needed: enforced boundary per platform (Session 5);
task permission inheritance/narrowing; collision-free concurrent workspaces; context/budget
bounds; parent/child evidence lineage; reviewable integration + final verification.
Now satisfied by V0.3: process cancellation and reaping semantics.

**Before the first workflow pack** — still needed: capability/dependency declarations; artifact
identity and metadata in evidence; structured validator results; targeted-revision flow.
Now satisfied by V0.3: managed subprocess execution with clear cleanup and evidence.

## 7. Recently Completed (outcome notes)

- **Session 4 (2026-07-17) — Execution kernel hardening: COMPLETE.** Managed exec substrate;
  real mid-command cancellation (REPL + one-shot, proven with a genuine delivered console
  CTRL_C against the live API); typed termination with no-exit-code-when-killed enforced through
  report/resume/renderer; verified best-effort tree kill + bounded drain (grandchild pipe-hang
  regression-tested); default-on child-env hygiene with narrowing-only config; command lifecycle
  evidence events. Full detail: `ROADMAP.md` Session 4; design contracts: `ARCHITECTURE.md`.
