# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Development history before 1.0.0 is recorded session-by-session in
[`ROADMAP.md`](ROADMAP.md), with implemented contracts in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## [1.2.1] — 2026-08-03

The Session 16 capability, now genuinely live-proven — and every defect that proving it exposed.
1.2.0 shipped multi-project support and `project_setup` with an honest caveat in its own release
notes: the resolution layer was proven, the end-to-end agent run on a dependency-bearing
full-stack project was not. This release closes that gap with a complete recorded run — one
natural-language request against live **Kimi K3**, through install ×2, migrate, seed,
per-project checks, a parallel executor wave, two simultaneous dev servers, three passing
browser flows, a three-lens adversarial review that caught the seeded XSS, a deliberate
mid-session kill and resume, and `/accept` COMPLETE with no override — validated post hoc by
38/38 checks over persisted evidence alone. It took four takes across two providers; three of
the four each bought one of the fixes below, which is what takes are for.

### Added

- **A one-level tolerant decode for double-encoded tool arguments.** Kimi K3 serialized
  `update_plan`'s nested `plan` object as a string, and fed the schema error it cycled YAML,
  single-quoted JSON, XML-ish tags and entry-pair arrays for twelve minutes — no plan could ever
  be written. The decode fires only after the schema rejected the input, only at paths expecting
  object/array where a string sits, accepts only a string that itself parses to a structure,
  re-validates once, and otherwise keeps the original error plus a plain-language hint. The
  recorded events and the wire history keep the model's original bytes.
- **The "working" heartbeat.** An always-thinking model streams nothing while it reasons, so the
  REPL looked frozen for minutes at a time. One dim TTY-only status line —
  `· model working (Ns)` — driven by a render-only `Session.onModelRequest` seam, drawn only
  while a request is in flight with no text streamed, erased synchronously before the first
  stdout byte, zero bytes off-TTY. (Its own first recording found its own bug: the line must be
  PLAIN text, because the status area sanitizes — and escapes — anything styled.)
- `preview status` now surfaces a previous-life registry survivor of the same session id — it
  used to be invisible in both the live and the another-session lists exactly while it still
  held the port a strict-port dev server needs.
- `update_plan` names the COMPLETED tasks an amendment re-opens (definition identity: prose
  participates in the sha; a full-graph resubmit that rewrites a done task's title silently
  re-queues it, and the model used to learn that only from `/accept` refusals).
- Plan validation warns when gate kind `browser` rides multi-project `gates.projects` — EACH-of
  semantics demand a browser flow against EACH named project's own preview, including non-UI
  projects, and the only exits after approval are an API-bound flow or a gates amendment.

### Fixed

- **A compat stream that died with neither `[DONE]` nor a `finish_reason` was silently committed
  as a completed turn** — a proxy idle-timeout half-close could turn a truncated sentence into
  the model's "final" answer, or a half-accumulated tool call into schema-error churn. It now
  throws a non-retryable typed server error; part of the stream was consumed, and a replay would
  double-bill.
- **Consecutive user messages now coalesce at the compat wire.** The crash-resume and
  aborted-turn shapes legitimately produce them; only the Anthropic adapter coalesced while the
  runtime's comment claimed they all did.
- **Elision no longer double-weighs compat reasoning blocks.** `text` is a display copy equal to
  the payload there and is never re-sent; charging both could fire the "history still exceeds
  the context target" alarm at half the real reasoning volume.
- **Rate-limit 429s get a deeper default retry budget** (4, Retry-After-aware; a throttle is
  EXPECTED to clear, and kimi Tier 0 allows 3 requests/min) while an explicit retry option is
  honored verbatim.
- **A transiently failed browser probe was cached for the whole session**, turning every later
  `browser_flow` into the gate-WAIVING unsupported/precondition — acceptance could reach
  COMPLETE without the UI ever having been driven. Success is cached; failure re-probes.
- **A preview reaped by the harness (TTL, log cap, stop) between approval and a flow read as
  `preview-died`** and classified runtime-process — repairs hunted a crash that never happened.
  The flow now reports `preview-stopped-lifecycle`, routed to timeout-resource.
- **Over-budget screenshots were dropped silently** while only traces recorded omission; the
  flow event and output now carry `screenshotsOmitted` and a do-not-cite line.
- **With no qualifying review round and the round cap spent, the acceptance blocker prescribed a
  reviewer group that delegate refuses** — the third member of the refusable-cure class this
  release hunts. The fold now owns `MAX_REVIEW_ROUNDS` and hands the exits to the user once the
  cap is spent; the bound-but-dead reviewer variant of the same dead end became a caveat.
- **The plan re-approval reminder now also fires after an error-ended turn and once at resume
  startup** — a turn that amends the approved plan and then dies on a thrown provider error used
  to end with no re-approval line at all.
- migrate/seed blocked only by missing `node_modules` records `precondition-curable`, not a
  false `no-recipe` capability claim; the preview tool's nothing-was-gated drift refusal got the
  honest split its siblings already had; `agent help` no longer claims a 20-step default (it is
  40, now interpolated from the constant); REPL `/help` no longer claims "shell commands always
  ask" (false since 1.0's sandboxed auto-run); README's consent-identity claim matches the code.

### Honest limits

- The recorded run's video shows the heartbeat's pre-fix escaped-text rendering — the recording
  found the bug, and the frames stay because the footage is unedited.
- Two of three review lenses hit the 8-minute reviewer wall under Kimi's thinking pace; their
  captured findings counted and the round qualified through the completed lens, but their
  remaining scope went unreviewed and the acceptance says so.
- Kimi fixed the seeded failing test before running it on camera, so the fail-then-pass beat
  exists in the evidence only as the delivered green run.
- yarn remains implemented from documentation and unit-tested only; pnpm's install path exists
  but was not live-run; the npm-workspaces-root install shape still needs a design decision.

## [1.2.0] — 2026-07-31

Real local software engineering. A workspace is no longer assumed to hold one project at its root,
and dependency installation is no longer something the harness refuses to do and tells you to go
do yourself.

### Added

- **Project units.** `detectWorkspace` discovers every project in a workspace — declared npm/pnpm
  workspaces, every depth-1 directory holding a manifest, and the children of conventional
  containers — bounded (12 units, depth 2), never-throwing, and deterministically ordered.
  Anything it declines to interpret (a glob richer than a trailing `/*`, a truncating cap) is
  RECORDED as a note rather than silently dropped. Before this, a repository holding `web/` and
  `api/` detected nothing at all: every check `unsupported`, no preview script, every declared
  gate warned unrunnable. It did not fail loudly; it went inert.
- **Per-unit checks and previews.** `run_check` and `preview` take a `project`; the command runs in
  that unit's directory and the evidence says so. A frontend and a backend can run at once
  (concurrent previews 2 → 4). Recipe ids are unit-qualified, so an `[s]` for `api` is not an `[s]`
  for `web` — including when both resolve the byte-identical `npm run test`.
- **`project_setup`** — `install`, `migrate`, `seed`. The model names an INTENT and a UNIT; the
  harness resolves the command from the lockfile (`npm ci` / `pnpm install --frozen-lockfile` /
  yarn v1 vs Berry, refusing to guess when the project declares neither) or from the project's own
  declared script. An install is `external` and may replay under `[s]` bound to
  `sha(lockfile + package.json + .npmrc)`; migrations and seeds are `destructive` and ask EVERY
  time, because a migration is not idempotent.
- **Per-project verification scoping.** `PlanTask.project` and `PlanGraph.gates.projects` — both
  additive and sha-neutral when absent, so every existing plan keeps its exact approval binding. A
  `completion: ['test']` gate over a full-stack workspace can now require BOTH halves instead of
  going green on whichever ran first.
- **`run_command` takes a `cwd`**, so the recorded evidence names the directory the command really
  ran in rather than the workspace root.
- The system prompt names the detected projects, their package managers, lockfiles, whether their
  dependencies are installed, and whether they expect environment configuration they do not have.

### Changed

- **Limits, audited and raised where they would stop legitimate work** (`test/limits.test.ts` now
  records the whole table): per-turn tool calls 20 → 40, run_command timeout ceiling 600 → 900s,
  concurrent previews 2 → 4, preview TTL 30 → 60 min, readiness 30 → 60s, executor budget
  30 steps/12 min → 40/20 min, captured change files 200 → 400, checks per session 60 → 80,
  delegated tasks 12 → 16, child output tokens 150k → 200k, repair wall 20 → 30 min, exec capture
  512 KiB → 1 MiB, browser flow wall 60 → 90s. **No repetition bound was raised** — attempts,
  repairs and review rounds are unchanged, because a looser loop bound buys looping, not
  capability.
- The `dependency-setup` recovery class names a path forward (`project_setup install`) instead of
  dead-ending at "ask the user". It remains human-gated and never auto-eligible.

### Fixed

- **The session diff no longer prints the contents of secret-named files.** Writing `.env` became a
  routine step this session; `/diff` reconstructed it from the snapshot blob and printed it to a
  terminal that routinely gets pasted into issues. It now reports the shape of the change
  (`+1/−0 lines`) and withholds the body.
- **A supervision stall is no longer reported for a child that is running a command.** A legitimate
  five-minute install looked exactly like a hung child, which is how a signal stops meaning
  anything.
- Findings from a four-lens adversarial review, all verified by hand before fixing: an install
  `[s]` that was standing arbitrary-shell consent (package.json's lifecycle scripts were outside
  the consent identity); a workspaces-monorepo root that silently WAIVED declared gates; a repair
  that could be "proven" by a green check in a different project; a plan that could be stranded
  with no exit by a misnamed project; a session grant that was stored and never read;
  non-deterministic project discovery; a stale lockfile composing the wrong install command; a
  column-0 comment truncating a pnpm workspace list.

### Honest limits

- The **resolution layer** is live-proven against a real two-package project (Express +
  `node:sqlite` and Vite + React, real lockfiles, real `npm install`): 21/21 assertions. The
  **end-to-end agent workflow** on such a project — installs through real approvals, two
  simultaneous dev servers, a browser flow over the integrated stack — has NOT yet been run live.
- yarn support is implemented from documentation and unit-tested only; yarn is not installed on
  the development machine. npm is live-exercised.
- External database servers, Docker and container orchestration are out of scope: file-backed
  local databases and project-declared migrate/seed scripts are what this supports.
- Executor subagents still cannot verify their own work — worktrees materialise without
  `node_modules`, so the parent verifies after integration.

## [1.1.1] — 2026-07-30

### Fixed

- **Argument validation runs before provider construction.** v1.1.0 moved the missing-credential
  refusal upfront, which placed it ahead of CLI flag validation: on a machine with no API key, a
  typo'd `--max-steps`/`--max-turns` reported "provider needs a credential" instead of the flag
  error. Local validation is free and now runs first. Found by CI on a keyless runner — the
  author's machine had keys, so the whole 1163-test suite passed locally while the required
  Windows job failed on the v1.1.0 commit. The suite is now also run keyless before release.

## [1.1.0] — 2026-07-30

Multi-provider runtime. The provider layer is no longer an Anthropic special case: five providers
over two genuinely different protocols run behind the same loop, policy, evidence, and completion
semantics, with capability differences degrading honestly instead of silently.

### Added

- **Five providers, one runtime:** `anthropic` (Messages API), `openai` (**Responses API** — Chat
  Completions cannot tool-call with reasoning off since GPT-5.4), and `deepseek` / `kimi` / `glm`
  through one profile-parameterized Chat-Completions adapter. Each adapter streams, passes
  cancellation through, maps its own usage and error shapes, and shares the proxy-aware transport.
- **A shipped capability catalog** (`src/provider/catalog.ts`): per-model context/output limits,
  vision support and how images inside tool results can reach the model, reasoning mode and replay
  requirement, caching style, lifecycle tags, quirk notes, and the harness's own working-context
  budget — rendered with the date it was last verified against first-party documentation. Retired
  model ids are deliberately absent; invitation-only models are never advertised.
- **Opaque reasoning round-trip.** A new `reasoning` content block carries each provider's native
  reasoning artifact verbatim, tagged with the producing provider *and* model, persisted additively
  on `assistant.message`, replayed by `reconstruct`, and weighed but never rewritten by elision.
  Each adapter replays only its own blocks within that provider's documented scope. This is what
  makes always-thinking models and reasoning tool loops work at all.
- **`/provider` and `/model`** — between-turns commands (never tools) that list availability and
  capabilities or switch mid-session: bounded key validation where the provider has a model-list
  endpoint, a new `provider.changed` event recording env var *names*, API host, and how the key was
  checked, a harness note telling the model its predecessor produced the earlier turns, and a
  capability summary. Delegated children follow the live identity.
- **`agent providers [--json]`** — read-only, network-free listing of providers, models, key env
  vars (presence only), base URLs and overrides, and where to obtain each key.
- **`provider` as a user-config preference** (`<state>/config.json`). The workspace config layer
  structurally still cannot choose a provider or model.
- **Per-provider opt-in live smokes** (`test/live-providers.test.ts`), gated on both
  `AGENT_LIVE_TEST=1` and that provider's key: a streamed completion plus one tool round-trip that
  proves the reasoning echo each provider requires.
- **`Usage.reasoningTokens`** and `Provider.describeTransport()` (additive).

### Changed

- **Default model is now `claude-opus-5`** (same price as `claude-opus-4-8`, which remains
  selectable). Adaptive thinking is therefore on by default, with thinking blocks round-tripped.
- **Output cap and elision budget derive from the catalog** instead of a provider name check, and
  production now sets the session context budget, so a small-window model is no longer fed a
  large-window history.
- **Report and journal identity fold newest-wins** and list every model that served a session.
- Banners and the one-shot header print provider *and* model via the Provider interface.
- `@anthropic-ai/sdk` to `^0.115.0`.

### Fixed

- **Key validation now takes the proxy-aware transport path** (found during live validation): a
  bare global fetch ignored system proxy settings, and on a proxied machine answered 401/403 for a
  valid key — which would have made `/provider` refuse a working credential.
- **Resuming under a different provider or model is no longer silent.** It records
  `provider.changed { source: 'resume' }` and says so, instead of letting the report keep asserting
  the original identity for later work.
- **A refusal turn is stated.** Classifier declines arrive as ordinary HTTP-200 turns and used to
  end looking like a finished answer.
- **Models without image input get honest pointers.** A screenshot is still captured, stored and
  recorded; the model is told where it is and why it cannot see it, and `view_image` refuses with
  the same explanation. Browser assertions, DOM checks, planning, checks and recovery are untouched.

Found by this release's adversarial review and fixed before shipping:

- **A thinking-only assistant turn could produce a wire-invalid history** (`content: []` on
  Anthropic, a bare `{content:null}` on the Chat-Completions family) once it aged out of the replay
  window — which would have 400'd every later request in that session.
- **Elision monotonicity**, which mutable per-model context budgets broke: switching to a
  larger-budget model could restore output the evidence log had already recorded as elided.
- **`/model` accepted a pasted credential** whose shape the old blocklist missed (a GLM-style
  `id.secret` key), and would have persisted it into the event log; model arguments are now
  positively validated. `/model` also ignored a definitive 401/403 and recorded the strongest
  verification word for a failed probe.
- **A `*_BASE_URL` override was invisible at startup** even though it redirects your credential to
  another host; it is now announced as a startup note naming the env var.
- **The OpenAI adapter re-homed tool-result screenshots without consulting the capability catalog**,
  so it could send pixels to a model the harness itself classifies as text-only.
- **`tool.completed` could not distinguish a screenshot the model saw from one withheld** (new
  additive `imagesWithheld`), and `agent sessions` neither folded provider/model identity nor used
  the newest lifecycle event.
- **The opt-in live tests gated on truthiness**, so `AGENT_LIVE_TEST=0` ran ten real, paid API
  calls; and the `agent providers` credential-leak assertion was a silent no-op on a keyless CI
  runner. Both are now deterministic.

### Honest limits

- **All five providers are live-proven** through the real bounded tool loop on their default models:
  10/10 gated adapter smokes (a streamed completion plus a tool round-trip that exercises each
  provider's reasoning-echo requirement) and two full harness sessions — one switching
  `claude-opus-5` → `gpt-5.6-sol`, one switching `claude-opus-5` → `deepseek-v4-pro` → `kimi-k3` →
  `glm-5.2` with each model writing its own file through the policy-gated tool path. Cross-provider
  history after a switch was accepted by every provider.
- **Only the default model of each provider was live-tested.** The remaining catalog entries are
  documented from first-party sources, not individually exercised; the catalog is advisory and the
  wire answer always outranks it.
- GLM has no model-list endpoint on either platform, so its key check is presence-only and says so
  (its international endpoint `api.z.ai` was reached successfully in the live run).
- DeepSeek V4 models are vendor-labeled *preview* by DeepSeek.
- `undici` 8 and `diff` 9 majors are deliberately deferred: both change surfaces (proxy dispatcher,
  patch API) that deserve a session able to live-verify them.

## [1.0.0] — 2026-07-28

First public release. The coding workflow is complete end to end and proven by a recorded live
run; the kernel has been through a repo-wide adversarial review.

### The loop

- **Bounded agent loop** over one `runTurn` shared by the one-shot CLI, the interactive REPL, and
  every subagent — no parallel execution path.
- **One fail-closed policy choke point.** Every tool call is classified and decided before it
  runs; capability facts live on the tool, policy logic lives in the engine.
- **Append-only JSONL evidence** with tail repair, corruption refusal, and a versioned schema.
- **Content-addressed snapshots** with drift-refusing undo, and crash-reconciling resume.
- **Deterministic evidence report** (`agent report`) that marks a file CHECKED only when a real
  process exited zero after its last mutation — and says which command.

### Execution and isolation

- **Managed subprocess execution** with typed termination (a killed command has no exit code,
  everywhere), real mid-command cancellation, and verified best-effort tree kill.
- **OS-enforced Windows sandbox** (Low integrity + Job Object), probed per session and
  fail-closed: demonstrably read-only commands may auto-run *inside* the boundary; everything
  else asks. Reads, network, and approved commands are explicitly not confined.
- **Workspace trust** as recorded consent, stored outside every workspace.
- **Narrowing-only configuration** — a workspace can restrict the agent, never widen it.

### Understanding and planning

- **Ranked repository intelligence** under a hard context budget, with a complete directory tree
  as the recall backstop and a `retrieve` tool whose hits explain why they matched.
- **One canonical plan graph** per session with content-sha approval, an amendment contract that
  structurally invalidates approval, and deterministic user/agent projections.
- **A dependency-aware task DAG** (rules R1–R12) gating bounded parallel executor groups.

### Doing the work

- **Worktree-isolated executors** whose approvals forward to the user and whose changes reach the
  workspace only through reviewed, drift-refusing integration.
- **Typed verification**: the model names KINDS, the harness resolves COMMANDS; the exit code is
  the verdict; replay consent binds the resolved command *and* the script body it invokes.
- **Managed preview servers** with announced-port readiness, identity-verified crash sweeps, and
  deterministic teardown.
- **Browser verification** over the system browser via `playwright-core`, with declared readiness,
  a typed failure taxonomy, an origin lock, and sha-addressed screenshots and traces.
- **Typed recovery**: eleven failure classes as data, deterministic classification before any
  repair is planned, derived repair outcomes, and a bounded policy with typed stop reasons.
- **A structural review gate**: reviewers record typed findings, the harness derives what those
  records are worth, and open critical/high findings block acceptance.
- **An explicit delivery boundary**: harness-owned recovery checkpoints in hidden git refs, a
  durable delivery anchor at `/accept`, and zero commits to the user's branch unless asked.
- **Project memory** across sessions — always labeled context, never authority.

### Verification

1072 tests across 78 files, including real-OS Windows sandbox tests, real-repository git tests,
real system-browser flows, and adversarial-review suites. One additional test is opt-in and makes
a real API call (`AGENT_LIVE_TEST=1`); it is excluded from the default run so the suite stays
hermetic.

Live proof: a recorded end-to-end run in which one natural-language request produced a plan, a
user-requested revision, sha-bound approval, a parallel executor wave, integration, typed checks,
a managed preview, browser verification that caught a real defect, a three-lens adversarial review
that found a seeded stored-XSS vulnerability, a mid-session crash and resume, two honest `/accept`
refusals, and a final accepted delivery — validated by 48 post-hoc checks over persisted evidence
alone.

### Known limitations

These are documented choices, not oversights. The full list lives in `ROADMAP.md`; the ones most
likely to matter:

- Sandbox enforcement is **Windows-only**. macOS and Linux run with approval only.
- Reads and network are not confined even inside the sandbox; approved commands run unsandboxed.
- Command output and screenshots are **not scrubbed for secrets**.
- Undo covers file-tool changes only; side effects of approved shell commands are not attributed.
- Executors cannot self-verify (a worktree lacks gitignored dependencies), so verification is
  parent-side after integration.
- Non-Node/Python projects report check kinds as `unsupported` with a reason rather than guessing.
- Single-user assumption on the session lock.

[1.2.1]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.2.1
[1.2.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.2.0
[1.1.1]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.1.1
[1.1.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.1.0
[1.0.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.0.0
