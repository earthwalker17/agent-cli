# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Development history before 1.0.0 is recorded session-by-session in
[`ROADMAP.md`](ROADMAP.md), with implemented contracts in [`ARCHITECTURE.md`](ARCHITECTURE.md).

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

[1.1.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.1.0
[1.0.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.0.0
