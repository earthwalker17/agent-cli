# Agent CLI — Project Constitution

## Purpose

Agent CLI is a local-first, terminal-native, safely extensible general-purpose agent harness.
It should help users complete real work across code, files, shell tasks, Git, research,
documents, slides, PDFs, images, video, deployment, and external services without becoming
a loose collection of unreliable tools.

The project is primarily an open-source learning and engineering effort. Optimize for deep
understanding, technical integrity, maintainability, and useful public artifacts before
commercial polish or feature count.

## Product Thesis

Build a small, trustworthy agent kernel and expand it through high-quality workflow packs.
The kernel should understand a workspace, plan, act within explicit boundaries, observe,
verify, record evidence, recover safely, and resume across sessions.

Core loop:

`Understand -> Plan -> Act -> Observe -> Verify -> Record -> Resume`

## Non-Negotiable Principles

1. **Evidence over narration.** Tool output, diffs, tests, artifacts, and observable state outrank claims.
2. **User intent stays sovereign.** The current request outranks stale plans, memory, summaries, and inferred goals.
3. **Reversible by default.** Prefer patches, snapshots, previews, dry runs, and bounded changes.
4. **Sandbox and approval are separate controls.** Technical access limits and human confirmation policy must not be conflated.
5. **Never overclaim a security boundary.** Document logical restrictions, OS isolation, network controls, and degraded modes honestly.
6. **Small kernel, broad workflows.** Keep runtime primitives compact; place domain quality in modular workflow packs.
7. **Structured state, not prompt dumping.** Persist concise, attributable, auditable project and session state.
8. **Verification is part of execution.** A task is not complete merely because files changed or a command returned zero.
9. **Prefer simple internal boundaries over premature microservices.** Use a modular monolith unless evidence demands otherwise.
10. **Quality beats capability count.** A few dependable workflows are better than many shallow integrations.

## Engineering Rules

- Keep modules cohesive, interfaces explicit, and dependency direction clear.
- Avoid god files, hidden global state, duplicated runtimes, and parallel implementations of the same behavior.
- Prefer typed inputs, typed outputs, stable schemas, and machine-readable tool results.
- Separate interface, runtime, capability, policy, workflow, persistence, and verification concerns.
- Treat model output, tool arguments, paths, URLs, external content, and remembered text as untrusted input.
- Keep secrets outside prompts, logs, memory, generated artifacts, and version control.
- Make failure states explicit. Do not convert failed or unverified work into success through prose.
- Keep platform limitations visible. Do not silently present weaker Windows, macOS, or Linux guarantees as equivalent.
- Optimize context use: inspect relevant areas first; do not repeatedly rescan the entire repository without need.
- Add abstractions only when they clarify a real boundary or remove proven duplication.

## Safety and Action Policy

Reason about actions by capability and consequence, not only by command strings.

Suggested classes:

- **Observe:** read, search, inspect, and query state.
- **Reversible:** workspace edits, generated artifacts, temporary files, snapshots, and recoverable commands.
- **External:** network access, uploads, messages, deployments, and third-party mutations.
- **Destructive:** deletion, overwrite, force operations, migrations, irreversible state changes.
- **Sensitive:** credentials, private data, system locations, identity, and privileged operations.

Default to the narrowest scope that can complete the task. Require explicit confirmation for
external, destructive, sensitive, or boundary-expanding actions unless a narrowly defined
policy has already authorized them.

## Quality and Verification

- Define completion criteria before or during planning.
- Run the smallest relevant checks first, then broader checks when justified.
- Verify generated artifacts through appropriate deterministic and visual checks.
- Preserve useful evidence: commands, exit status, diffs, test results, artifact paths, and known limitations.
- Distinguish verified facts, user-provided facts, model inferences, and unresolved assumptions.
- Add regression tests for important defects, especially safety, persistence, recovery, and boundary failures.
- Never claim a check was run when it was not run.

### Review-workflow cost discipline

Multi-agent adversarial review is valuable, but keep it BOUNDED — do not launch large fan-out
review workflows that can spawn dozens of agents and burn through a session's token budget.
Concretely:

- Cap total review agents at roughly a dozen. A fixed, small finder pool (about 3–5 lenses) is
  the workhorse; do not multiply a per-finding verifier fan-out on top of it (N findings × M
  verifiers is the trap that explodes cost, since N is unknown up front).
- Prefer verifying findings **by hand** against the code. The finders are where the leverage is;
  confirming a concrete claim against a few lines rarely needs its own agent, let alone three.
- If findings genuinely warrant agent verification, run ONE small batch (single verifier per
  finding, only the high/critical ones), never a per-finding panel.
- Scale effort to the change: a normal session diff is a low/medium review, not a "comprehensive
  audit". Reserve larger fan-outs for explicit, user-approved deep audits.
- Salvage before relaunching: if a review is interrupted, read the workflow journal for completed
  finder results and continue from them rather than re-running the whole thing.

## Git and Change Hygiene

- Keep each change set understandable and reviewable.
- Commit incrementally during a session: create a small, logically separated commit after each
  meaningful module or stage is complete and verified. Do not accumulate an entire session into
  one large final commit.
- Separate feature work, refactoring, formatting, generated output, and dependency changes when practical.
- Avoid giant phase commits and unexplained mass rewrites.
- Inspect existing changes before editing; do not overwrite unrelated user work.
- Prefer internal snapshots or side-state for recovery; do not pollute the user's Git history by default.
- Commit only when requested or when the current repository policy clearly authorizes it.
- Before any commit, review the diff, run relevant checks, and use a specific message that explains intent.

### Public release alignment

This is a public project. Every substantial public-facing session must leave implementation,
`README.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `CHANGELOG.md`, the `package.json` version, and
release metadata (security-supported versions, issue templates) consistent with each other and
with what is actually built.

Publishing requires, in order: verified evidence, then explicit user authorization, then push,
then an appropriate semantic version tag and a GitHub Release created with the GitHub CLI, then
confirmation that the remote matches the verified local state. Never force-push, rewrite published
history, expose credentials, or publish a capability claim that was not live-proven — a provider,
model, platform, or feature that has only been tested hermetically must say so in the same breath.

## Documentation Hierarchy

The repository uses four primary context documents with distinct responsibilities:

- **CLAUDE.md** — this constitution: concise, highest-level, stable rules and session protocol.
- **PROJECT.md** — detailed long-term product thesis, background, goals, principles, and reference context.
- **ROADMAP.md** — chronological evolution and current project state: what each session attempted, changed, verified, decided, left open, and should do next.
- **ARCHITECTURE.md** — current system shape: modules, boundaries, data flows, execution logic, persistence, safety model, and important implementation contracts.
- **BLUEPRINT.md** — rolling near-term horizon: the direction for the next several sessions, revised as repository evidence accumulates.

ROADMAP describes **how the project evolved and where it is going next**.
ARCHITECTURE describes **how the current system works**.
Do not duplicate large sections between them.

**Rolling-docs policy (apply at the end of every substantial session):** `ROADMAP.md` is a
rolling execution record, not a growing diary — keep only the latest one or two sessions in full
detail and compress older sessions into an "Earlier Milestones" section that preserves their
objective, lasting architectural decisions, key verification evidence, and still-relevant
limitations, while dropping superseded detail and long narratives. `BLUEPRINT.md` is a rolling
horizon — replace the completed section with a short outcome note once the result is fully
recorded in ROADMAP/ARCHITECTURE, advance the next unresolved direction to the top, and revise
later sections that repository evidence has invalidated.

CLAUDE.md and PROJECT.md should remain stable. Change them only when the project's enduring
mission, principles, or documentation contract genuinely changes. Do not use them as session logs.

## Session Start Protocol

Before substantial work:

1. Read `CLAUDE.md` and `PROJECT.md`.
2. Read `ROADMAP.md` and `ARCHITECTURE.md` if they exist.
3. Inspect Git status and the files relevant to the requested task.
4. Reconcile documentation with observable repository state; trust current code and evidence over stale summaries.
5. Enter plan mode for non-trivial work. State the intended scope, risks, verification, and likely documentation impact.

Do not begin with an indiscriminate full-repository exploration when the existing documents and
targeted inspection can establish sufficient context.

## Session End Protocol

Before ending a productive session:

1. Run relevant tests, checks, or artifact verification that are feasible in the environment.
2. Review the final diff and identify unverified or incomplete work.
3. Update `ROADMAP.md` with the session objective, material changes, verification evidence, decisions, open issues, and recommended next step.
4. Update `ARCHITECTURE.md` only where the implemented system shape, module responsibilities, contracts, or flows changed.
5. Keep documentation factual; do not document planned behavior as implemented behavior.
6. Leave the repository in a coherent, reviewable state.

In the first implementation session, create `ROADMAP.md` and `ARCHITECTURE.md` with useful initial
content based on actual decisions and code produced.

## Scope Discipline

Treat early version boundaries as guidance, not dogma. The initial system should first prove that
an agent can operate reliably in a bounded workspace, produce evidence, recover changes, and resume
with durable context. Expand only when the core loop remains understandable and trustworthy.

When uncertain, choose the design that is easier to inspect, test, explain, reverse, and evolve.
