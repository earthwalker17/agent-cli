# Agent CLI — Near-Term Development Blueprint

## 1. Purpose

This is the rolling near-term direction guide for Agent CLI after the first public **v1.0** release.
It begins from the implemented state recorded in `ARCHITECTURE.md` and `ROADMAP.md`, while
`PROJECT.md` remains the enduring product thesis.

Each session must still begin in plan mode, inspect the live repository, validate the assumptions
below, and propose a session-sized design from evidence. This file sets direction, not a fixed
implementation checklist.

The next phase should broaden Agent CLI without weakening the qualities already proved in v1.0:

> Keep one small, trustworthy runtime; make it portable across model providers, capable of handling
> realistic local software projects and more languages, able to reach selected external services
> under explicit authority, and ready to generalize into high-quality non-coding workflows.

Do not postpone workflow generalization indefinitely while expanding the coding surface. The first
non-coding pack remains a near-term test of whether the existing contracts are genuinely reusable.

## 2. Current Starting Point

Agent CLI v1.0 already provides a live-proven coding workflow:

`Understand -> Plan -> Approve -> Execute -> Integrate -> Verify -> Recover -> Review -> Accept -> Resume`

The implemented foundation includes one shared runtime, one fail-closed policy choke point,
append-only evidence, snapshots and undo, crash-safe resume, Windows Low-Integrity sandboxing for
eligible automatic commands, Git checkpoints and worktree isolation, repository indexing and
targeted retrieval, bounded agent teams, a sha-approved task graph, typed verification and recovery,
managed previews, browser evidence, structural adversarial review, and an explicit delivery boundary.

The next work is therefore not a replacement runtime. It is a set of carefully bounded extensions
that should reuse the existing state, policy, evidence, task, verification, recovery, review, and
acceptance contracts.

## 3. Indicative Session Sequence

### Session 15 — Multi-Provider Runtime and Model Selection — **DONE (v1.1.0)**

Delivered: five providers over two protocols behind one runtime, a shipped capability catalog,
opaque reasoning round-trip, `/provider` + `/model` + `agent providers`, env-only key discovery
with bounded validation, `provider.changed` evidence, catalog-driven output/context budgets, and
honest vision degradation. **All five providers live-proven** through the real bounded tool loop
(10/10 gated smokes + two multi-provider sessions, one of them switching through DeepSeek, Kimi and
GLM with each writing its own file). Default model is now `claude-opus-5`. Details and honest
limits: `ROADMAP.md` Session 15, `ARCHITECTURE.md` "Providers".

### Session 16.5 — Proving Session 16 — **DONE (v1.2.1)**

Both goals complete. Two bounded adversarial reviews (5 lenses over the S16 diff: 30 findings,
16 fixed; then 5 lenses over the whole implementation: 25 findings, 16 fixed — the wire under an
always-thinking compat model, preview/browser truth, refusable-cure dead ends, and doc/metadata
staleness), the "working" heartbeat, and the tolerant decode for double-encoded tool arguments
that take 3 exposed live. **The live E2E is done end to end**: one 84.6-minute Kimi K3 session —
one natural-language request through installs ×2, migrate, seed, per-project checks incl. lint,
the parallel executor wave, two simultaneous dev servers, three passing browser flows, a
three-lens review that caught the seeded XSS, kill + resume, and `/accept` COMPLETE with no
override — post-hoc validated 38/38 from persisted evidence, with a 4.7-minute subtitled MP4
produced from the continuous recording. Suite 1342 → 1366. Details and honest limits:
`ROADMAP.md` Session 16.5, `agent-cli-s165-live/DEMO.md`, CHANGELOG 1.2.1.

### Session 16 — Real Local Software Engineering — **DONE (v1.2.0 implementation, live-proven by S16.5)**

Delivered project UNITS, per-unit typed checks and previews, `project_setup` (lockfile-driven
install / migrate / seed) with its own consent and event stream that can never satisfy a
verification gate, per-project plan scoping, and the audited limits table. Suite 1164 → 1322.
The end-to-end proof it owed was delivered by Session 16.5 (above). Details: `ROADMAP.md`
Earlier Milestones, `ARCHITECTURE.md` "Project units" and "Project setup".

### Session 17 — First Non-Coding Workflow Pack: Documents and PDF

Build the first optimized non-coding workflow on the existing kernel rather than creating a second
agent or execution loop.

A likely shape is:

`request -> structured document model -> deterministic render -> artifact evidence -> structural /
pagination checks -> visual inspection -> targeted revision -> delivery`

Support useful DOCX/PDF production with repeatable styles, headings, tables, pagination, artifact
metadata, visual review, bounded recovery, and explicit acceptance. The purpose is to prove that the
coding workflow contracts generalize beyond source code.

### Session 18 — Polyglot Repository Intelligence and Verification

Expand repository understanding and verification beyond the current Node/TypeScript and Python bias.
Prioritize Rust, Go, C/C++, and representative embedded projects.

Treat support as a combination of language, build system, and available toolchain—not merely file
extensions. Improve indexing, symbol/import relationships, entry-point detection, project maps, and
typed check recipes. Unsupported compilers, boards, targets, or hardware-dependent tests must refuse
or downgrade claims honestly rather than simulating coverage.

### Session 19 — Source-Backed Web Research

Add a bounded research path that can be triggered explicitly with `@research` and naturally from a
user request. Use a dedicated read-only research role and a search/extraction provider such as Tavily
to gather current external information, select high-value sources, and return concise findings with
provenance to the main agent.

Network access must remain an explicit capability with domain, result, content, cost, and time bounds.
Research output is evidence or context, never authority. Introduce `RESEARCH.md` only as a bounded,
curated project memory surface for information with continuing value; ephemeral search results stay
in session evidence.

### Session 20 — Remote Git and GitHub Delivery

Extend the existing local Git boundary to deliberate remote delivery. Support user-requested
`git push` and selected GitHub CLI operations for an explicitly identified repository, account,
remote, branch, and change set.

Remote reads and remote mutations must remain distinct. Every mutation should show its exact target
and effect before confirmation, use existing user authentication without exposing credentials, emit
attributable evidence, and stop on ambiguity. Agent CLI must never create, push, force, publish, or
modify GitHub state merely because local work completed.

### Session 21 — Bounded Memory and Initialization

Strengthen memory without turning startup into prompt dumping.

Add explicit size and token budgets, staleness rules, provenance, and deterministic or reviewable
compaction for harness-managed project memory. Introduce `LESSONS.md` for reusable failure patterns
and practical project knowledge. Keep startup context small and retrieve older detail only when it is
relevant.

Add an optional `/init` or first-run onboarding flow for a transparent global profile in the normal
Agent CLI user-state directory, plus project initialization for a missing `AGENT.md`. Ask only a few
skippable questions, keep answers inspectable and editable, and separate preferences from secrets,
permissions, and authority. User-owned instruction files must never be silently rewritten or
compressed; the system may offer a reviewed update when they become too large.

### Session 22 — Terminal UX Consolidation

Polish the terminal surface after the new states are real. Explore bounded folding and expansion of
long outputs, clearer color and hierarchy, compact provider/model/task/check/research/remote status,
and better navigation through evidence without losing the clean non-TTY contract.

UI state must remain a projection of the event-backed runtime, not a second source of truth. Avoid a
large TUI rewrite unless real usage proves the current rendering architecture cannot support the
needed interactions cleanly.

## 4. Design Rules for the Next Phase

1. **One runtime and one policy boundary.** Providers, languages, research, artifacts, and remote
   delivery must not create side loops or side doors.
2. **Compatibility is not equivalence.** OpenAI-compatible endpoints still need provider-specific
   capability declarations, normalization, tests, and honest limitations.
3. **External read and external write are different authorities.** Search may be bounded and
   read-only; push, repository creation, releases, and other mutations require exact-target consent.
4. **Dependencies are real side effects.** Installs, scripts, migrations, and service startup remain
   visible, attributable, cancellable where possible, and verified from actual outcomes.
5. **Language support must be evidence-backed.** A language is not supported until retrieval,
   project detection, checks, failure handling, and a realistic live proof all work together.
6. **Memory is context, never authority.** Current user intent and observable repository state outrank
   global preferences, project memory, research notes, and lessons.
7. **User-owned and harness-owned memory stay distinct.** Automatic compaction belongs primarily to
   harness-managed documents; user-authored constitutions require review and consent.
8. **Provenance before persistence.** Research and lessons should retain source or event pointers,
   confidence, date, and scope, and should be removable when stale.
9. **Workflow packs stay outside the kernel.** Document/PDF quality belongs in structured models,
   renderers, validators, and recovery recipes attached through existing contracts.
10. **Claims remain proportional.** No provider, platform, language, research, GitHub, or artifact
    capability is advertised beyond what has been live-proven.

## 5. Readiness Gates

Before calling the next phase mature, Agent CLI should have demonstrated:

- ~~at least two genuinely different provider protocols and all named providers live-smoked through
  the same bounded tool loop~~ **(MET in S15: Anthropic Messages + OpenAI Responses + a
  Chat-Completions family, all five providers live)**;
- ~~a realistic dependency-bearing full-stack project built and verified locally~~ **(MET in
  S16.5: one live Kimi K3 session from natural-language request to `/accept` COMPLETE over a real
  two-package full stack, post-hoc validated 38/38)**;
- a document/PDF workflow whose completion is based on artifact and visual evidence;
- polyglot retrieval and checks over several different build ecosystems;
- source-backed research with bounded network authority and durable provenance;
- explicit, previewed, user-approved remote Git/GitHub delivery;
- bounded project/global memory that can be inspected, edited, compacted, and removed;
- terminal presentation that scales to these states without changing runtime truth.

Each substantial session still requires tests, differentiated adversarial review, documentation
updates, and a realistic live E2E. New provider names, model names, APIs, toolchains, and external
service behavior must be researched again at the start of the relevant session.

## 6. Deferred Beyond This Horizon

Keep these visible, but do not pull them forward without direct implementation pressure:

- broad SaaS deployment orchestration and autonomous production operations;
- network-egress enforcement and a true read/confidentiality sandbox;
- macOS/Linux sandbox parity;
- unrestricted computer use, deep inter-agent messaging, or remote distributed execution;
- MCP/plugin marketplaces or many shallow integrations;
- multi-repository orchestration and hardware-in-the-loop embedded execution;
- a database-backed memory/index layer before Markdown plus bounded retrieval is no longer adequate;
- simultaneous first-class development of several non-coding workflow packs.

The objective remains quality before capability count: broaden Agent CLI only when each new surface
inherits the same explicit authority, evidence, reversibility, recovery, and completion semantics
that made v1.0 credible.
