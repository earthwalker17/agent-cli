# Agent CLI — Project Context and Product Thesis

## 1. Project Overview

Agent CLI is an open-source exploration of a local-first, terminal-native, general-purpose AI agent
and harness. It is intended to work directly in a user's local environment and help complete real
work across software development, files, shell commands, testing, verification, Git, deployment,
external services, research, documents, slides, PDFs, images, video, and other repeatable workflows.

The project is not being started primarily as a near-term commercial product. Its first purpose is
to learn by building: to understand how modern CLI agents, coding harnesses, tool runtimes, safety
systems, memory layers, and workflow engines actually work by implementing them from first
principles. The development process should be open, evidence-driven, and suitable for build-in-public
sharing so that engineering lessons and failures can be useful to others.

The long-term ambition is broad, but the architecture should remain disciplined. Agent CLI should
not become a giant prompt attached to unrestricted shell access, nor a directory of unrelated tools.
It should be a trustworthy execution system with a small kernel and carefully designed extensions.

## 2. Origin and Motivation

The project follows Agent OS, a local AI project workbench built with a Python backend and a
TypeScript frontend. Agent OS explored many layers of agent engineering, including orchestration,
memory, multi-agent execution, Git operations, deployment, browser verification, recovery, skills,
and project context.

That work was valuable as a learning system, but it also revealed limitations that should inform
Agent CLI:

- The product surface became broad enough that architectural boundaries were sometimes difficult to see.
- Large phase-oriented changes and noisy commit history reduced reviewability.
- Some modules risked becoming god files or accumulating unrelated responsibilities.
- Application-level path restrictions, allowlists, and confirmation gates could be mistaken for stronger OS-level sandboxing.
- A polished UI and many visible capabilities did not automatically prove maintainability or trustworthiness.
- Summaries and claims were less useful than direct evidence linked to diffs, commands, tests, and artifacts.
- A project workbench is not the same as a true terminal agent that can operate across arbitrary workspaces and local tools.

External criticism of Agent OS was often harsh, but the useful parts should be treated as engineering
input rather than dismissed. Agent CLI should demonstrate quality through clear boundaries,
reviewable changes, tests, honest limitations, and observable evidence.

## 3. Core Product Thesis

> Build a small, trustworthy local agent kernel, then expand it through high-quality workflow packs.

Agent CLI should be capable of understanding a workspace, planning a task, acting through explicit
capabilities, observing results, verifying real outcomes, recording attributable evidence, recovering
safely, and resuming work in a later session without starting from zero.

A useful conceptual loop is:

`Understand -> Plan -> Act -> Observe -> Verify -> Record -> Resume`

This loop is more important than any individual feature. Coding, document generation, media work,
research, deployment, and external integrations should all reuse the same core execution and
state model where practical.

## 4. What Agent CLI Should Be

Agent CLI should aspire to be:

- **Local-first:** the workspace, tools, state, and artifacts remain under user control by default.
- **Terminal-native:** interactive use should feel natural in a shell and not require a graphical workbench.
- **General-purpose:** coding is important, but the system should also support high-value non-coding work.
- **Safely extensible:** new tools and workflows should plug into explicit contracts rather than bypass policy.
- **Evidence-driven:** results should be supported by tool output, diffs, tests, previews, and artifact inspection.
- **Resumable:** long-running projects should carry trustworthy state across sessions.
- **Workflow-aware:** important tasks should use optimized pipelines rather than improvising every step from scratch.
- **Efficient:** minimize unnecessary repository scans, context repetition, token usage, subprocess churn, and rework.
- **Honest:** security, platform, verification, and capability limits should be described precisely.
- **Open and inspectable:** users and contributors should be able to understand how actions were chosen and executed.

## 5. What Agent CLI Should Not Become

The project should avoid drifting into:

- A clone whose only identity is “another Claude Code.”
- An unrestricted shell wrapper controlled by model-generated text.
- A feature checklist with weak end-to-end reliability.
- A collection of MCP servers or external tools without coherent workflow quality.
- A microservice system created to compensate for poor internal modularity.
- A project where generated code volume is mistaken for engineering progress.
- A system that silently edits, deploys, uploads, deletes, or exposes data without clear authority.
- A memory layer that treats old model summaries as ground truth.
- A framework that promises equivalent sandbox guarantees on platforms where they are not enforced.
- A media and document generator that rebuilds ad hoc scripts on every task and produces inconsistent artifacts.

## 6. Enduring Design Principles

### 6.1 Evidence Over Narration

Tool results should outrank explanations. A failed command remains a failure. An unrun test remains
unrun. A generated file is not complete until the relevant checks have been performed. The system
should preserve enough evidence for users to review what happened.

### 6.2 User Intent Stays Sovereign

The current user request should outrank stale plans, memory, previous handoffs, inferred preferences,
and agent personality. Durable context should assist execution, not silently override the user.

### 6.3 Reversible by Default

Prefer patches, previews, snapshots, worktrees, side-state, dry runs, temporary outputs, and bounded
operations. Irreversible actions should be rare, explicit, and proportionate to the user's request.

### 6.4 Sandbox and Approval Are Different

A sandbox defines what a process can technically access. An approval policy defines when the agent
must pause and ask. Both matter, and neither should be used as a substitute for the other.

The system should distinguish among:

- path validation and workspace boundaries;
- logical policy checks;
- process and filesystem isolation;
- network isolation;
- container or virtual-machine isolation;
- user confirmation and delegated authorization.

When a platform cannot provide a strong boundary, the product should label the mode accurately and
reduce authority rather than imply protection that does not exist.

### 6.5 Small Kernel, Broad Workflows

The runtime should remain compact and stable. Domain-specific quality should live in workflow packs
that compose core capabilities, templates, validators, and recovery logic. This allows the project to
support broad tasks without turning the kernel into a monolith.

### 6.6 Structured State, Not Prompt Dumping

Persistent context should be concise, attributable, queryable, and auditable. Loading every historical
conversation or document into each prompt would be expensive and unreliable. The system should load
a small current-state view and retrieve deeper context only when needed.

### 6.7 Verification Is Part of Execution

The agent should plan how it will know that work succeeded. Verification may include tests, static
checks, command exit status, diff review, schema validation, rendering, screenshot inspection,
artifact metadata, live requests, or other domain-specific evidence.

### 6.8 Quality Before Capability Count

The project should prefer a few dependable workflows over many shallow integrations. Each supported
workflow should reduce friction, avoid repeated tool discovery, and produce outputs that are useful in
real work rather than merely technically valid.

## 7. Conceptual System Shape

The following layers are a useful long-term model. They are architectural guidance, not a fixed
implementation mandate.

### 7.1 Interface Layer

Potential interfaces include:

- an interactive terminal UI;
- a one-shot CLI command for direct tasks;
- a headless or JSONL mode for scripts, CI, and other agents.

These interfaces should share one runtime rather than evolve into separate implementations.

### 7.2 Agent Runtime

The runtime may own:

- the agent loop and streaming interaction;
- plan and execution state;
- tool-call scheduling;
- interruption, cancellation, retry, and resume;
- context and token budgeting;
- event capture;
- model-provider abstraction;
- verification gates;
- task completion and failure semantics.

The runtime should not need to understand the internal details of PowerPoint layout, video editing,
GitHub APIs, or other domain workflows.

### 7.3 Capability Kernel

Core capabilities may include:

- file reading, search, writing, and patching;
- shell and long-running process execution;
- Git and source-control operations;
- network and HTTP access;
- browser automation;
- clipboard and selected local-system operations;
- secrets and credentials;
- image and media tooling;
- external service adapters.

Each capability should eventually expose a machine-readable contract: inputs, outputs, permissions,
side effects, reversibility, required resources, error states, and verification options.

### 7.4 Policy and Sandbox Layer

Policy should be centralized enough to remain understandable. It should evaluate the capability,
requested scope, target resources, reversibility, external side effects, sensitivity, and existing
user authorization.

A useful action taxonomy is:

- **Observe:** read, search, inspect, and query state.
- **Reversible:** bounded workspace edits, generated artifacts, temporary state, recoverable commands.
- **External:** network access, uploads, messages, deployments, and third-party mutations.
- **Destructive:** deletion, overwrite, force operations, migrations, and irreversible state changes.
- **Sensitive:** credentials, private data, identity, system locations, and privileged access.

This taxonomy may evolve, but the distinction between consequence classes should remain visible.

### 7.5 Workflow Packs

Workflow packs are where Agent CLI can develop meaningful product quality. Possible packs include:

- coding;
- documents;
- slides;
- PDF operations;
- image creation and editing;
- video editing and production;
- research;
- workspace organization;
- deployment and service integration.

A workflow pack should be more than a prompt. It may contain:

- workflow definitions;
- skills and domain instructions;
- allowed capabilities;
- templates;
- structured intermediate representations;
- dependency checks;
- deterministic renderers or adapters;
- validators;
- recovery strategies;
- examples and test fixtures.

The exact plugin or package format should emerge from implementation experience rather than be fixed
prematurely.

### 7.6 State, Memory, and Evidence

The project should eventually represent concepts such as:

- session;
- turn;
- task;
- tool event;
- approval;
- artifact;
- verification result;
- snapshot;
- project state;
- handoff;
- decision;
- lesson or durable memory.

A structured local store such as SQLite may be useful as an internal source of truth, while Markdown
can provide transparent, editable, user-readable views. This is a recommendation rather than a hard
technology requirement.

## 8. Cross-Session Continuity and Memory

Long-running work should not require a full workspace rediscovery at the beginning of every session.
Agent CLI should carry forward enough trusted context to resume efficiently while avoiding stale or
self-reinforcing model summaries.

Useful categories include:

- **Project instructions:** enduring constraints, conventions, and user-authored rules.
- **Project state:** current progress, active components, known failures, and verified status.
- **Session handoff:** what changed, what was checked, what remains, and the recommended next action.
- **Decisions:** important choices and their rationale.
- **Lessons:** reusable debugging knowledge, failure patterns, and workflow improvements.

Important memory rules:

1. Memory is context, not authority or permission.
2. Current observable state outranks stale summaries.
3. User instructions outrank remembered preferences and previous plans.
4. Facts, inferences, and user-provided claims should be distinguishable.
5. Important entries should retain provenance or links to supporting evidence.
6. Startup context should remain small; deeper history should be retrieved on demand.
7. Conflicts and outdated entries should be detectable and correctable.
8. Session summaries should be grounded in actual events, diffs, and verification, not generated from recollection alone.

The project's own `CLAUDE.md`, `PROJECT.md`, `ROADMAP.md`, and `ARCHITECTURE.md` provide an initial
manual version of this philosophy and should also serve as a useful dogfooding target.

## 9. Optimized Artifact Workflows

A major opportunity is to improve tasks that general coding agents often handle inefficiently, such
as presentations, documents, PDFs, images, and video. A generic agent may repeatedly discover tools,
write temporary scripts, fix dependencies, rerender everything, and consume large amounts of context
while still producing inconsistent results.

Agent CLI should explore structured intermediate representations and deterministic rendering paths.
For example:

### Slides

`request -> content outline -> SlideSpec -> layout/template selection -> PPTX render -> page render -> layout and visual checks -> targeted revision`

### Documents and PDFs

`request -> document model -> style system -> DOCX/PDF render -> pagination/table/heading checks -> targeted revision`

### Video

`source analysis -> edit decision list -> timeline/subtitles/audio plan -> deterministic media render -> frame/audio inspection -> revision`

### Images

`request -> asset plan -> generation/edit operation -> metadata and dimension checks -> visual review -> export variants`

The intermediate formats, libraries, and exact workflow engines are not predetermined. The enduring
idea is that the model should make high-level decisions while repeatable software handles rendering,
validation, and localized revision whenever possible.

## 10. Git, Recovery, and Change Review

Git support should be useful without turning every model action into noisy permanent history.
Potential directions include:

- internal snapshots or side-git state for recovery;
- patch-based edits and clear diffs;
- optional worktrees for isolation;
- explicit user-facing commits at delivery boundaries;
- automatic commits only when configured and justified;
- targeted undo and rollback;
- separation between generated recovery state and the user's intentional Git history.

Commit quality matters. Large phase commits, unrelated rewrites, and generated churn make maintenance
and external review harder. The project should favor small, explainable change sets and should record
why important changes were made.

## 11. Maintainability and Architecture Discipline

A local CLI agent does not need to become a microservice platform. The default architectural stance
should be a modular monolith with explicit internal boundaries, one coherent runtime, and narrow
interfaces between modules.

Warning signs include:

- one file coordinating model calls, tools, UI, persistence, policy, and recovery;
- duplicated execution loops for TUI and headless modes;
- policy checks scattered through individual tools;
- workflow-specific logic embedded directly in the kernel;
- multiple sources of truth for session or task state;
- documentation that describes an ideal architecture rather than the code that exists.

Significant abstractions should solve observed complexity. Early code should remain easy to read,
test, and replace.

## 12. Technology Direction

The implementation language is intentionally not fixed by this document.

Rust is attractive for a local CLI runtime because it supports a compact binary, strong types,
process control, concurrency, low resource use, and cross-platform systems work. TypeScript offers
fast iteration, strong model and tooling ecosystems, and familiarity. Python and Node may remain
valuable as external adapters for mature document, media, browser, and automation libraries.

A reasonable current leaning is a single primary language for the core runtime, with carefully
controlled subprocess adapters where mature external tooling provides clear value. The first version
should avoid maintaining several equally important internal stacks before the boundaries are proven.
Final choices should follow prototyping evidence, platform requirements, contributor ergonomics, and
the learning goals of the project.

## 13. Suggested Early Boundary

An early version should first prove a trustworthy core loop rather than the full long-term vision.
A useful initial target would demonstrate that an agent can:

- operate in a bounded workspace;
- read, search, edit, patch, and run commands;
- apply explicit permission and network rules;
- persist events and resume a session;
- preserve evidence and report failures accurately;
- verify code or artifacts;
- recover or undo bounded changes;
- maintain concise project state and handoff context.

A coding workflow plus one non-coding artifact workflow may provide a strong first demonstration.
Document or PDF generation is a plausible early candidate because it exercises structured content,
rendering, artifact validation, and user-facing output without requiring the complexity of a full
video pipeline.

This is guidance, not a permanent scope contract. Claude Code should use repository evidence,
prototyping, and current constraints to propose the best session-sized increments.

## 14. Areas to Defer Until the Core Is Proven

The following may be valuable later but should not be allowed to obscure the initial runtime:

- multi-agent orchestration;
- broad autonomous deployment;
- unrestricted computer-use automation;
- a plugin marketplace;
- many SaaS connectors;
- remote distributed execution;
- fully autonomous long-term memory rewriting;
- claims of identical strong sandboxing across every operating system;
- simultaneous first-class support for every artifact category.

These are not permanent exclusions. They are reminders that the execution, safety, state, and
verification foundations should remain understandable as the surface expands.

## 15. Success Criteria

Agent CLI should eventually be judged less by the number of commands it exposes and more by whether
it can repeatedly complete this chain:

> The user requests real work. The agent understands the relevant workspace context, proposes a
> proportionate plan, acts within explicit authority, verifies the outcome, exposes evidence, leaves
> changes reviewable and recoverable, and resumes accurately in the next session.

A small version that achieves this reliably has more technical value than a “universal agent” with
many integrations but weak trust and inconsistent outputs.

## 16. Documentation Strategy

The repository uses four complementary documents:

- `CLAUDE.md`: stable constitution and Claude Code operating rules.
- `PROJECT.md`: this long-term context, product thesis, principles, and reference material.
- `ROADMAP.md`: session-by-session evolution, verification, open work, and next steps.
- `ARCHITECTURE.md`: the current implemented system, modules, contracts, data flows, and operational logic.

`ROADMAP.md` and `ARCHITECTURE.md` should be updated as the project evolves. `CLAUDE.md` and
`PROJECT.md` should change only when enduring assumptions genuinely change.

## 17. Reference Projects and Reading

These resources are starting points for targeted research, not templates to copy wholesale.

### Google Workspace CLI

- Repository: https://github.com/googleworkspace/cli
- README: https://github.com/googleworkspace/cli/blob/main/README.md
- Agent skills: https://github.com/googleworkspace/cli/blob/main/docs/skills.md

Useful for studying agent-friendly command surfaces, structured JSON output, generated API coverage,
authentication boundaries, and task-oriented skills.

### CodeWhale

- Repository: https://github.com/Hmbown/CodeWhale
- Architecture: https://github.com/Hmbown/CodeWhale/blob/main/docs/ARCHITECTURE.md
- Guide: https://github.com/Hmbown/CodeWhale/blob/main/docs/GUIDE.md

Useful for studying a terminal agent harness, TUI and headless modes, persistent state, approvals,
tool execution, snapshots, evidence-oriented behavior, and the maintainability challenges of a fast-growing runtime.

### OpenAI Codex CLI

- Repository: https://github.com/openai/codex
- Approvals and security: https://developers.openai.com/codex/agent-approvals-security
- Sandboxing concepts: https://developers.openai.com/codex/concepts/sandboxing
- Layered project instructions: https://developers.openai.com/codex/guides/agents-md

Useful for studying the separation of sandboxing, approvals, network policy, workspace boundaries,
project instructions, and a production-grade local coding-agent runtime.

### OpenCode

- Repository: https://github.com/anomalyco/opencode

Useful for studying terminal UX, provider abstraction, read-only planning versus full-access building,
and a modern open-source coding-agent product surface.

### Goose

- Repository: https://github.com/block/goose

Useful for studying a local general-purpose agent that extends beyond coding, supports multiple
interfaces, and connects capabilities through an extensible ecosystem.

### Aider

- Documentation: https://aider.chat/docs/
- Repository map: https://aider.chat/docs/repomap.html
- Git integration: https://aider.chat/docs/git.html

Useful for studying context-efficient repository maps, edit workflows, Git integration, and reversible changes.

### Claude Code Memory and Project Instructions

- Documentation: https://docs.anthropic.com/en/docs/claude-code/memory

Useful for understanding `CLAUDE.md`, auto memory, instruction scope, startup context, and the
trade-offs between persistent guidance and token usage. Agent CLI should aim beyond “memory exists”
and focus on structured, attributable project state and evidence-backed handoff.

## 18. Open Questions for Exploration

The project should leave room to discover answers through implementation:

- Which language and library stack best balances systems learning, portability, speed, and workflow integration?
- What is the smallest useful runtime contract shared by interactive, one-shot, and headless use?
- Which state belongs in an event log, relational store, Markdown view, or generated cache?
- How can Windows, macOS, and Linux expose honest but useful safety modes?
- How should long-running processes, cancellations, resumptions, and partial failures be modeled?
- What capability schema is expressive enough for policy without becoming bureaucratic?
- How should workflow packs declare dependencies, permissions, artifacts, and validation?
- What repository-context strategy minimizes tokens without hiding relevant code?
- Which first non-coding workflow best demonstrates the project's unique value?
- How can benchmarks evaluate trust, reversibility, continuity, and artifact quality rather than only task completion?

These questions are part of the project's purpose. The system should evolve from measured experience,
not from attempting to finalize every answer before implementation begins.
