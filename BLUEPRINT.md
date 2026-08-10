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
produced from the continuous recording. Suite 1342 → 1373. Details and honest limits:
`ROADMAP.md` Session 16.5, `agent-cli-s165-live/DEMO.md`, CHANGELOG 1.2.1.

### Session 16 — Real Local Software Engineering — **DONE (v1.2.0 implementation, live-proven by S16.5)**

Delivered project UNITS, per-unit typed checks and previews, `project_setup` (lockfile-driven
install / migrate / seed) with its own consent and event stream that can never satisfy a
verification gate, per-project plan scoping, and the audited limits table. Suite 1164 → 1322.
The end-to-end proof it owed was delivered by Session 16.5 (above). Details: `ROADMAP.md`
Earlier Milestones, `ARCHITECTURE.md` "Project units" and "Project setup".

### Session 17 — First Non-Coding Workflow Pack: Documents and PDF — **DONE (v1.3.0)**

Delivered, and the generalization question is answered: the coding-workflow contracts carried a
non-coding workflow with **three per-session tools, ONE new policy fact, TWO additive event types
and a module of pure format logic outside the kernel** — no second agent loop, no plugin system,
no widened `CheckKind`. `read_document` (DOCX/PPTX/PDF by magic bytes, with a coverage verdict),
`render_document` (byte-deterministic DOCX + browser-printed PDF, both parse-back validated), and
`inspect_pages` (pages rasterized so a vision model judges the real thing) sit behind the
spec-file revision loop, which inherits snapshots/undo/diff/attribution because the spec is an
ordinary workspace file. Artifacts are products, never verification. Review: 4 lenses, 29
findings, 19 fixed — including the structural discovery that the engine never evaluates
`readsPaths` on a tool with a non-empty mutation plan. Suite 1373 → 1480. Details and honest
limits (DOCX visual fidelity is Word's; PPTX read-only; Word COM cut; no plan-gate integration):
`ROADMAP.md` Session 17, `ARCHITECTURE.md` "The documents workflow pack", CHANGELOG 1.3.0.

### Session 18 — Polyglot Repository Intelligence and Verification — **DONE (v1.4.0)**

Delivered: Rust/Cargo and Go modules as the complete path (units incl. cargo `[workspace]
members` + `go.work`, symbols/imports/entry points, `cargo`/`go` recipe rows, rust-error/go-error
signals, compiler-aware classification), C/C++ (CMake) as detection+indexing with honest named
refusals, and **toolchain availability as a first-class stat-only fact** — missing toolchains
produce explicit `toolchain-unavailable` states naming the exact cure, gates waive LOUDLY
("TOOLCHAIN IS NOT INSTALLED"), and cross-target embedded crates split into host-verifiable
checks vs a permanent named refusal for what needs hardware. **Live-proven three ways** (all
post-hoc validated): the v1.3.0 BEFORE-defect capture (17/17 — gates waived silently on a Rust
crate), proof A on the pre-install machine (17/17 — six honest unavailable states, zero spawns),
and proof B after the rustup(gnu)+Go installs (27/27 — seeded E0308 and failing go test found,
classified and fixed; mid-session `rustup target add` noticed by the drift seam; `/accept` on
green gates). Suite 1480 → 1539. Details: `ROADMAP.md` Session 18, `ARCHITECTURE.md` (toolchain
facts, typed verification, retrieval), `agent-cli-s18-live/DEMO.md`, CHANGELOG 1.4.0.

### Session 19 — Source-Backed Web Research — **DONE (v1.5.0)**

Delivered: a **seventh policy fact** with its own fail-closed branch (a research call is
command-less and mutation-less, so it would otherwise auto-allow as `observe` with the reason
"read-only workspace access" — false in the one direction that matters, because reading is not the
consequence, **sending** is); a `researcher` subagent role with a third access class
`read-only-external`, spawned through the existing `delegate_task` with no new orchestration;
`web_search` for the parent and `web_extract` + `record_source` for the researcher only, so "the
main agent never receives raw webpages" is a registry property; and **the budget as the consent** —
one session allowance shared by parent and every child, rebuilt from events on resume, shown
verbatim in the approval prompt.

**Live-proven** as two runs of one fixture differing only in whether the credential was present:
the control implemented from recall and said *"a quick check of docs.tavily.com would settle
everything"*; the proof's researcher recorded 7 corroborated findings with real sources, including
the exact legacy trap the control had flagged. Honest reading: research converted a plausible
answer into a supported one, not a wrong one into a right one. Review: 4 lenses, 20 findings, 12
fixed — including a trailing-dot bypass of every internal-host refusal and a parallel-researcher
spend double-count. Suite 1547 → 1828. Details: `ROADMAP.md` Session 19,
`agent-cli-s19-live/DEMO.md`, CHANGELOG 1.5.0.

**Deferred, deliberately: `RESEARCH.md`.** It was the plan's declared cut line. Ephemeral research
works as bounded session evidence, which is what this session required; the durable curated surface
needs staleness rules, size budgets and provenance semantics that belong with Session 21's memory
work rather than bolted onto a capability release.

### Session 20 — Remote Git and GitHub Delivery — **DONE (v1.6.0)**

Delivered: **two** policy facts (`remoteRead`, `remoteWrite`) with separate fail-closed branches,
so the engine's conflicting-contract rule makes a tool that could both read and publish an automatic
deny; reads session-grantable within a counter, a publish asks every time and stores nothing; a
mutation must cite a fresh `ls-remote` observation of that exact ref; `ls-remote`-never-`fetch`.
Three tools, `/remote`, acceptance caveats both ways, the harness never holds a credential. Full
contract, evidence, and the deliberately-out-of-scope list: `ROADMAP.md` Session 20 milestone,
`ARCHITECTURE.md` "The remote-delivery pack", CHANGELOG 1.6.0.

### Session 20.5 — Full-System Review and Zero-to-Remote E2E — **DONE (v1.6.1)**

A consolidation-and-proof session, not a feature session. A five-lens engineering review of the
whole system (18 defects, each hand-verified with a regression test — the largest class was
accounting/honesty seams that bite hours into a real run); a **limits retune** that replaced the
flat 100k context budget with a per-model derivation rule (window fit + provider billing clamps,
verified 2026-08-09) and sized the scale bounds for the v1.6 shape while leaving every repetition
and consent bound untouched; three module cycles cut with the boundary now pinned by
`test/architecture.test.ts`; and a live zero-to-remote E2E from an empty folder to a real GitHub
release. Details: `ROADMAP.md` Session 20.5, CHANGELOG 1.6.1, `agent-cli-s205-live/DEMO.md`.

### Session 21 — Bounded Memory and Initialization  ← **NEXT**

Strengthen memory without turning startup into prompt dumping.

Add explicit size and token budgets, staleness rules, provenance, and deterministic or reviewable
compaction for harness-managed project memory. Introduce `LESSONS.md` for reusable failure patterns
and practical project knowledge, and `RESEARCH.md` — deferred from S19 precisely because a durable
research surface needs the staleness and provenance semantics this session builds: a research note
is perishable in a way a lesson is not, and it must carry its sources and its retrieval date or it
becomes exactly the stale confidence S19 exists to prevent. Keep startup context small and retrieve older detail only when it is
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
- ~~a document/PDF workflow whose completion is based on artifact and visual evidence~~ **(MET in
  S17: deterministic parse-back validation plus rasterized page inspection, live-proven on Kimi
  K3 — the model saw its own cramped first render, revised the spec, and re-rendered)**;
- ~~polyglot retrieval and checks over several different build ecosystems~~ **(MET in S18:
  Rust/Cargo + Go modules full-path live-proven, C/C++ indexed with honest refusals, missing
  toolchains and cross-target embedded crates answering explicitly — three validated runs)**;
- ~~source-backed research with bounded network authority and durable provenance~~ **(MET in
  S19 for the bounded-authority and provenance halves: a seventh fail-closed policy fact, one
  shared session budget rebuilt from events, findings carrying sources + corroboration +
  retrieval date, live-proven against the real provider. The DURABLE half — a curated RESEARCH.md
  — is deliberately deferred to S21 with the rest of the memory work)**;
- ~~explicit, previewed, user-approved remote Git/GitHub delivery~~ **(MET in S20: two policy
  facts so read and write cannot be confused, an observation-bound publish that refuses to reason
  about a remote from memory, and a live proof against a real GitHub repository in which the
  scripted human DENIED the first push and the record showed nothing had left the machine)**;
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
