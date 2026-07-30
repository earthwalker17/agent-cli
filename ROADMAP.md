# ROADMAP

Rolling execution record: the latest session in full detail, older sessions compressed to
milestones that keep their objective, lasting decisions (with why), evidence, and still-open
limitations. Newest first. Contracts live in `ARCHITECTURE.md`.

---

## Session 15 (2026-07-29/30) — V1.1: the multi-provider runtime

### Objective

Generalize the provider layer per BLUEPRINT S15: Anthropic, OpenAI, DeepSeek, Kimi and GLM behind
one runtime with an explicit capability model, `/provider` + `/model` switching, env-only key
discovery, and honest degradation — preserving streaming, tool calls, cancellation, usage
accounting, resume and evidence semantics. Plus public-release hygiene (v1.1.0) and an enduring
CLAUDE.md release-alignment rule.

### Planning provenance

Three Explore recon lenses (provider/runtime, REPL/config/evidence, tests/release) + a 5-agent
first-party research workflow (Anthropic, OpenAI, DeepSeek, Moonshot/Kimi, Zhipu/GLM — official
docs only, ~205 tool calls) + one Plan-agent design pass. **The research paid for itself
immediately:** `deepseek-chat`/`deepseek-reasoner` had been RETIRED five days earlier
(2026-07-24), the entire `kimi-k2-*` preview generation and `kimi-latest` were discontinued, the
Moonshot docs had rebranded to kimi.ai (API hosts unchanged), and OpenAI's Chat Completions can no
longer tool-call with reasoning off — every one of which would have shipped as a broken default
from memory. User decisions: default model → `claude-opus-5`, full reasoning round-trip in scope,
international endpoints as defaults, live keys to be configured during the session.

### What was implemented (commits `1af04c6` … `7932fed`)

1. **`feat(types,provider,runtime)`** — the reasoning core: an opaque `reasoning` ContentBlock
   (provider-native payload, tagged provider+model), persisted additively on `assistant.message`,
   replayed by `reconstruct` at the head of assistant content, weighed but never rewritten by
   elision; `Usage.reasoningTokens`; `Provider.describeTransport()`; the `provider.changed` event;
   the Anthropic adapter mapping thinking/redacted_thinking both ways with `scopeReasoning` as the
   wire-view filter and a cache marker that walks past replayed thinking blocks.
2. **`feat(repl,cli)`** — a refusal turn is stated instead of ending like a finished answer.
3. **`feat(provider)`** — the data layer: `catalog.ts` (capabilities as DATA + `CATALOG_VERIFIED`),
   `profiles.ts` (per-provider wire deviations), `errors.ts` (ProviderError taxonomy + bounded
   connection-phase-only retry), `sse.ts` (one incremental parser).
4. **`feat(provider)` ×2** — the two new adapters: one profile-parameterized Chat-Completions
   adapter (deepseek/kimi/glm) and the OpenAI **Responses** adapter (`store:false` + encrypted
   reasoning replay).
5. **`feat(config,cli,provider)`** — the registry seam, `provider` as a user-config preference,
   `DEFAULT_MODEL = 'claude-opus-5'` as ONE exported constant (ending a 5-site literal
   duplication), catalog-driven `maxTokens` + `contextBudget` (production finally sets it), and
   both `instanceof AnthropicProvider` checks replaced by the interface.
6. **`feat(runtime,tools)`** — the vision choke: no image input ⇒ honest pointers, evidence intact.
7. **`feat(repl,runtime,report)`** — `/provider` + `/model`, the live `currentRuntime()` getter so
   children follow switches, resume-mismatch recording, newest-wins report identity + `modelsUsed`,
   journal model line.
8. **`feat(cli)`** — `agent providers` (+`--json`), joined to `KNOWN`.
9. **`test(live)`** — per-provider live smokes double-gated on `AGENT_LIVE_TEST=1` + that
   provider's key.
10. **`chore(deps)`** — `@anthropic-ai/sdk` ^0.115.0; undici 8 / diff 9 deferred with reasons.
11. **`fix(provider)`** — the live-found transport fix (below).

### The live-found defect (the session's most valuable finding)

`validateKey` used a bare global fetch, so the key-validation probe did **not** take the
proxy-aware path every adapter uses. On this proxied machine that returned **401/403 for a key
that works perfectly through the SDK** — meaning `/provider anthropic` would have refused a valid
credential with "present but REJECTED", the most damaging possible false negative for a brand-new
switch flow. Fixed by building `createTransport()` per provider inside the probe. Re-verified
live: anthropic 11 models visible, openai 126. The same probe also **cross-checked the shipped
catalog against reality**: `claude-opus-5`/`sonnet-5`/`fable-5` and `gpt-5.6-sol`/`terra`/`luna`
are all genuinely callable.

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite **1072 → 1155 passed / 1 skipped
across 84 files** (+83). New pins: reasoning recording/replay/old-log-validity/elision exemption,
Anthropic thinking round-trip incl. scope + drop-on-switch + the cache-marker guard, the SSE parser
at hostile chunk boundaries, the error taxonomy and retry policy, per-profile request goldens and
SSE fixtures (usage from all three documented locations, glm `sensitive`→refusal,
`model_context_window_exceeded`→throw, deepseek 402=balance, kimi type strings), the Responses
request/replay/incomplete/error mapping, **`test/context.test.ts` closing the zero-coverage gap on
the construction seam**, the workspace-cannot-set-`provider` pin, `/provider` and `/model` drive()
flows incl. credential-shaped-argument refusal and no-key refusal, report newest-wins + modelsUsed,
and `agent providers` creating no session and leaking no key value.

**Live proof (real money, real APIs) — ALL FIVE PROVIDERS.** Fixtures at
`C:\Users\A\Desktop\agent-cli-s15-live\`.

1. **Gated adapter smokes: 10/10** (`test/live-providers.test.ts`) — every provider did a streamed
   completion plus a tool round-trip whose second request replays the first turn's blocks, which is
   exactly the reasoning echo kimi/deepseek require and Anthropic validates byte-verbatim. First
   contact for DeepSeek/Kimi/GLM: **no adapter fixes were needed** — the byte-level fixtures built
   from first-party docs were accurate.
2. **E2E #1 (`ws`):** `claude-opus-5` wrote `notes.md` (2 turns carrying round-tripped thinking
   blocks, cache reads 12.8k/12.9k), then `/provider openai` validated `OPENAI_API_KEY` live through
   the proxy and switched, then `gpt-5.6-sol` appended line two via the Responses API
   (`reasoningTokens: 13`). Report: `modelsUsed: anthropic·claude-opus-5 → openai·gpt-5.6-sol`.
3. **E2E #2 (`ws2`) — three switches in one session:** `claude-opus-5` → `deepseek-v4-pro` →
   `kimi-k3` → `glm-5.2`, each writing its own file through the policy-gated `write_file` path
   (`ds.txt`, `kimi.txt`, `glm.txt` — all correct). Per-provider evidence: deepseek reported
   `reasoningTokens` 21/13 with 8832 cache reads; kimi-k3 accepted its mandatory complete-message
   round-trip with 7680 cache reads; glm streamed `reasoning_content` with 8704 cache reads. All
   three verification modes were exercised for real — `models-list` (deepseek, kimi) and
   `presence-only` (glm, which genuinely has no list endpoint). **The documented cross-provider
   history risk did not materialize:** every provider accepted a history containing another
   model's tool calls.

**In neither run does any key value, `sk-` prefix, or `Bearer` token appear anywhere in the log.**

### Decisions (and why)

- **Reasoning payloads are OPAQUE and provider+model-tagged.** Only the emitting adapter may
  interpret one; replay is scoped per provider's documented rule (kimi `all`, anthropic/deepseek/
  openai `current-loop`, glm never). Opacity is also the escape hatch: an adapter can widen its own
  payload shape without touching the schema.
- **Persist reasoning VERBATIM, uncapped.** Kimi and DeepSeek reject a tool-looping assistant
  message whose reasoning was altered or dropped, so byte fidelity beats log-size thrift; a
  spill-to-blob optimization is a deferred item, not a launch requirement.
- **OpenAI means the Responses API.** Chat Completions cannot tool-call with reasoning off since
  GPT-5.4, and reasoning replay is Responses-only — "OpenAI-compatible" would have been a false
  equivalence at the exact point that matters.
- **Capabilities are DATA with a verified date.** Only Anthropic and Kimi expose live capability
  metadata; OpenAI and DeepSeek list ids only and GLM has no list endpoint at all, so the shipped
  catalog is the honest source — advisory, cross-checked live where possible, and always outranked
  by the wire answer.
- **`budgetTokens` is OUR cost opinion, not the provider's window** — commented as such, so a
  reader cannot mistake a 100k working budget for a 1M context limit.
- **Availability is env presence; a switch validates, and every outcome is labeled.** models-list /
  presence-only / unverified-network are three different words and the event records which.
- **Every network path goes through the transport** — proven the hard way.

### Open issues / boundaries (deliberate, documented)

- **Only each provider's DEFAULT model was live-tested.** The rest of the catalog is documented
  from first-party sources, not individually exercised — the catalog is advisory and the wire
  answer outranks it.
- GLM's key check is presence-only because no model-list endpoint exists on either platform (its
  international host `api.z.ai` was reached successfully in the live run).
- **Credential-source boundary held under pressure.** The user initially placed the three new keys
  in an external project's `.env`; the harness did not see them, because credentials come from
  `process.env` alone. That is the designed behavior, not a bug — a file-based credential source is
  exactly what the design excludes. For the verification run the values were injected into ONE test
  child process (never printed, never persisted, never written into this repo). `.env` support was
  deliberately NOT added: it would contradict the README's env-only claim and widen the credential
  surface of a public security-sensitive tool without review.
- Reasoning deltas are not rendered live, so an always-thinking model can appear to pause before
  text (deferred: a reasoning render channel).
- OpenAI resume flattens interleaved reasoning order (reasoning→text→tool_use); live turns keep
  exact order.
- undici 8 / diff 9 majors deferred: both change surfaces (proxy dispatcher, patch API) that need a
  session able to live-verify them.

### Recommended next step

Session 16 per BLUEPRINT: real local software engineering (dependency-bearing full-stack projects).
The provider layer needs no further work to proceed — all five are live-proven; the remaining
provider items in the deferred pool (live reasoning render channel, strict-schema transformation,
per-role model tiers) are optimizations, not gaps.

---

## Session 14.5 (2026-07-28) — V1.0: consolidation, repo-wide adversarial review, live proof

### Objective

Not a feature session. Clean the remaining coding-flow debt found by a bounded repo-wide
adversarial review, resolve the practical items from the deferred pool, resolve the one
permanently skipped test, stamp V1.0, prove the whole system in a fresh recorded live demo, and
compress the documentation into high-density references for the first non-coding workflow pack.

### Planning provenance

3 Explore recon lenses + 1 Plan-agent adversarial critique, load-bearing claims hand-verified.
The critique reshaped the plan before code: the autocrlf fix scoped to the uniform-LF case only
(per-file byte rewriting was rejected as a harness that rewrites content), `/review dismiss`
deferred as the only consent-contract change with no demo value, the review-gate fixes
pre-decided as ONE commit so they could not thrash each other, and the V1.0 stamp moved BEFORE
recording so the demo shows the shipped banner.

### What was implemented (commits `a5ca9a7` … `6f3ca84`)

1. **`chore(runtime,config)`** — the raw NUL byte in `subagent.ts` replaced with its source
   escape (it made ripgrep classify the file as binary and silently skip it in every content
   search, including review sweeps); the vitest `fileParallelism` comment corrected to match the
   setting it contradicted.
2. **`fix(cli)` ×3** — `agent version`/`help` were not in `KNOWN`, so the unknown-positional
   fall-through started a REAL one-shot model session with the literal task string; `--version`
   added and the usage header now reads the version from package.json (it had said "V0.7" for
   seven sessions). Count flags refuse non-numeric values (a NaN `maxSteps` ended every turn
   after zero steps, silently); `--max-steps` is the honest name with `--max-turns` kept as the
   alias. `agent plan <id>` joined `readPlanState`, the ONE reader — it read only the legacy
   store, so every canonical plan printed `status: unknown` with a raw-file sha.
3. **`fix(store,memory)`** — the clean-end predicate reads the newest LIFECYCLE event:
   `agent checkpoint/undo/commit` append to an ended log, so "last event is not session.ended"
   was accusing cleanly-ended sessions of crashing.
4. **`fix(tools)`** — `report_finding` paths joined the ingestion choke point; a path that
   sanitization would ALTER is refused outright (an escaped form names no real file).
5. **`fix(repl,assemble,git)`** — session-end hygiene failures leave evidence: `/accept` and the
   quit path reported prune throws instead of swallowing them, the noted-refs fallback list is
   restored on throw, and `createCheckpoint`'s untracked guard records an honest note when it
   cannot run instead of failing open silently.
6. **`fix(review,roles,delegate,report,plan,git)`** — the review-gate coherence commit: the
   round-voiding rule narrowed to applies INSIDE the round window (the whole-log rule punished
   exactly the harness-recommended fix path); executor captures count as real work (a
   zero-net-change session could never satisfy its own gate); the reviewer budget raised to 24
   steps (15 starved diligent lenses into `budget-steps`, which cannot qualify a round —
   producing a double block with no forward path); `MAX_REVIEW_ROUNDS = 2` enforced at the
   delegate tool; all-lenses-died rounds now caveat; wiring assertions replace optional-chained
   evidence channels; the report states the requirement and open blockers for unaccepted
   sessions and annotates delivery refs the log records as pruned; `pruneCheckpoints` shares the
   missing-ref convergence rule; `approvedCurrentGraph` replaces the same predicate spelled in
   three files.
7. **`fix(git,runtime,tools)`** — the executor-capture EOL pin (below), the apply-side
   normalization diagnosis, and the task-base untracked guard asking through the forwarded
   channel instead of hard-refusing every executor group in a repo with a big un-ignored dir.
8. **`feat(checks,report,repl)`** — `test-targeted` scope defaults from the bound plan task's
   touches; `/diff` carries the report's CHECKED verdict through ONE shared correlation; five
   dead exports and three stale comments removed.
9. **`fix(checks,policy,runtime,report,repl,git)`** — the adversarial-review batch (below).

### The executor-capture EOL pin (the top live-found S14 gap)

With system `core.autocrlf=true` over an LF working tree, `worktree add` and capture's
`checkout-index` re-applied the smudge filter: the executor based its edits on CRLF bytes the
parent never held, so EVERY captured file refused at apply as base drift — and had the base
matched, the apply would have written CRLF over LF and attributed a whole-file EOL flip to the
task. `probeEolPin` now detects the case and pins `-c core.autocrlf=false -c core.eol=lf` on
BOTH invocations when the parent tree is uniformly LF. Deliberately that case only: a mixed tree
keeps the refusal, now with a diagnosis naming EOL normalization and exits that actually work
(the scheduler refuses re-running a task holding captured changes, so the old message pointed at
a dead end). The regression fixture sets repo-local `core.autocrlf=true` — the suite's emptied
GIT_CONFIG env had HIDDEN this entire class.

### The adversarial review — 4 lenses, 23 findings, 48 invariants held

One bounded batch of four differentiated read-only lenses (kernel/runtime, policy/consent/
injection, git/state lifecycle, verification/surfaces). Every finding hand-verified against the
code before any fix; all 23 fixed. The seven that mattered most:

- **The consent hole (the S12 critical's class, reopened by a display cap).**
  `DetectedProject.scripts` is capped at 200 chars for display, and check/preview replay consent
  hashed THAT — so an agent could append `&& <anything>` past character 200 and run it under the
  earlier `[s]` with no prompt. `bodySha` now binds the sha of the UNTRUNCATED value.
- **A session-killing wire bug.** `tool_use` blocks with a non-`tool_use` stop reason (a
  `max_tokens` cut mid-call) were never answered, so the live history went permanently invalid —
  every later turn 400'd, and the repair path could not help once a user message was last.
- **Evidence loss on a write.** An unguarded post-write readback threw away ALL `file.mutated`
  events, leaving `/undo` blind to bytes already on disk while the log claimed the call never
  ran. The mutation is now always recorded, with additive `postStateUnverified`.
- **An unreachable safety branch.** The `aborted` check-classification test sat below per-kind
  rules that match every kind, so a Ctrl+C'd typecheck classified as an auto-eligible
  `compile-type` defect — a cancellation becoming a diagnosis that spends the repair budget.
- **A report that claimed a clean end.** `find` took the FIRST `session.ended`, so a session that
  quit cleanly, was resumed, and then crashed reported the earlier clean end — in the one
  artifact whose job is exposing abnormal termination.
- **Secret classification on the wrong string.** `isSecretName` ran on the raw model-supplied
  path, so a symlink or Windows 8.3 alias of `.env` skipped both the ask and the redaction.
- **Prompt-fence spoofing.** Memory docs (AGENT.md is workspace bytes a cloned repo controls) and
  plan notes reached the system prompt and the `[[harness note: …]]` wrapper un-neutralized.

Also fixed: `agent checkpoint prune` — the documented backstop — deleted delivery audit anchors
(now kept unless `--include-delivery`); a failed `worktree add` unregistered the entry without
removing the directory, making the leak unreachable by any sweep; the capture cap could split a
rename pair and half-apply a move; the event-log lock could be stolen from a live holder whose
JSON was still being written; elision was not monotone once the image pass existed (an aging
screenshot restored older outputs, re-billing the cache suffix and contradicting the
`context.compacted` record); a swept preview log was re-reported as an "unaccounted" lost start
for 48h; `callSandbox` reported `active` with no backend to confine; an unknown-tool call
persisted an empty `outputPreview` while the model saw a different string.

### The permanently skipped test — resolved

`test/anthropic.test.ts:116` guards ONE live-API smoke call behind `AGENT_LIVE_TEST=1`. The skip
is **still justified**: CI must stay hermetic, and the test needs a real key, network, and money.
It was RUN live this session (9 passed instead of 8 + 1 skipped), which also re-proves the
hardcoded model id and the provider adapter against the real API. The invocation is documented
in the README rather than wired into an npm script (a bare `AGENT_LIVE_TEST=1 vitest` prefix is
not portable on Windows without adding a dependency).

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite **1043 → 1072 passed / 1 skipped
across 78 files**. New pins cover: the consent hole (an append past the display cap changes
`bodySha` while the command string stays stable), the `max_tokens` tool_use path (the next turn
must still reach the model), aborted classification across every check kind, the
lifecycle-aware report end, the secret alias, the EOL pin across three cases (pinned/unpinned/
mixed-tree), the untracked-guard deny path, `/diff` verdicts, scope defaulting, the review-round
cap identity, in-window vs after-window applies, and the all-dead-lens caveat.

### Live proof — the recorded V1.0 demo

A local demo workspace outside this repo (fixture generator, recording chain, `VALIDATION.txt`,
`DEMO.md`, a 4:54 MP4). A single continuous session against real claude-opus-4-8, driven by a
scripted typist over a real ConPTY, on the "Pulse" fixture — a working dependency-free habit
tracker with THREE seeded defects, each reachable only by a different capability: a failing
streak unit test (deterministic check), an add-without-reload bug (browser-only), and an
`innerHTML` XSS (adversarial review only).

**48/48 post-hoc evidence checks, 0 failures**, all re-derived from the event log, plan file, git
refs, journal, and the app on disk. The arc: one natural-language request → planning (with a
user-requested revision that INVALIDATED the approval, then a fresh sha-bound `/plan approve`) →
ONE parallel executor group in isolated worktrees → integration with **zero apply refusals** (the
EOL pin holding on a machine whose system git sets `core.autocrlf=true`) → typed checks → managed
preview → browser flows that **caught a real defect** → a 3-lens review round recording 10 typed
findings, the **security lens finding the seeded XSS** at `high` → **`/accept` REFUSING twice**
with honest unfinished lists → the XSS fixed and proven by a purpose-written browser flow → all
findings triaged → `/accept` COMPLETE with 7 accepted-limitation caveats → `/quit` with the
journal handoff → the delivered app walked through live (heatmap, weekday chart, and a habit added
WITHOUT a reload).

Hygiene verified independently: exactly ONE ref survives under `refs/agent-cli` (the delivery
anchor the acceptance consumed, pointing at a real commit object), the plan was retired, and
**zero commits were added to the user's branch**. The delivered suite re-runs green now (15/15,
up from 11 with 1 failing). Parent usage: 176 uncached input tokens against 6.1M cache-read.

Two honest notes, both recorded in `DEMO.md`: the first take was discarded for a DRIVER bug (the
planning turn asked to run a command and the driver only waited for the idle prompt instead of
answering approvals — no product behavior was changed for the demo), and the validator's own
first run had a wrong assertion (`passed` vs `pass`), now fixed and made stricter.

### Decisions (and why)

- **A display cap must never be a consent identity.** `scripts` stays truncated for prompts and
  preconditions; `scriptShas` carries the full-value hash. Any future field that is both shown
  to a human and bound by consent needs the same split.
- **Blocks and stopReason can diverge**, so the loop answers tool_uses on their existence, not
  on the stop reason. Wire validity is a property of what we SEND, not of what the model meant.
- **A non-verdict is not a diagnosis.** Timeout and abort now sit together at the top of
  classification: both produced no verdict, and only a verdict can justify a repair.
- **Honest degrade beats silent proceed, everywhere it was cheap**: an unrunnable untracked
  guard, a failed readback, a swallowed prune, a backend-less sandbox claim.
- **The EOL pin is a configuration choice, not a content rewrite.** The harness pins git's own
  normalization for the worktree it creates; it never edits bytes to make an apply succeed.
- **Compress by density, not deletion.** ARCHITECTURE dropped session attributions, duplicated
  rationale, and prose catalogues (the event surface is now a table) while keeping every
  contract, ordering, constant, and honest limitation.

### Open issues / boundaries (deliberate, documented)

- The EOL pin covers the uniform-LF parent only; a genuinely mixed tree still refuses at apply,
  now with an honest diagnosis and workable exits.
- `/review` still has no user-side per-finding dismissal (the design is recorded in the deferred
  pool); `/accept confirm` remains the coarse override.
- The review requirement stays PLAN-scoped: executor work delegated with no plan derives none.
- Browser-flow tests contend when many suites launch the system browser in parallel; they pass
  in isolation and the contention is environmental, not a product defect.

### Recommended next step

Session 15 per BLUEPRINT: the first non-coding workflow pack (documents/PDF), reusing the
context/task/verification/recovery/review/delivery contracts rather than copying them.

---

## Earlier Milestones (compressed per the rolling-docs policy)

Contract detail lives in `ARCHITECTURE.md`; entries keep the objective, lasting decisions, the
evidence, and what stayed open.

### Session 14 (2026-07-27/28) — the delivery boundary: Git audit lineage + the structural review gate

Git, review, and acceptance became one coherent delivery boundary (commits `f99f41b`…`82a1158`;
suite 972→1029+1). Landed: the `onRefReady` seam (event BEFORE ref, so the creation-instant leak
is structurally closed and a failed ref write leaves an honest self-converging phantom);
`harness.checkpoint` as a NEW event type with three kinds and a seq/kind-aware owed fold whose
delivery survival keys on the ref an acceptance actually CONSUMED; the pre-integration checkpoint
under the spawn-only covered-change rule; the `/accept` delivery anchor (idempotent across the
crash window, never hostage to git, `/commit` suggested not performed); and `src/review/` — typed
findings recorded at the source through `report_finding` (the second named childTools admission),
the pure `foldReview` deriving requirement/qualification/triage worth, and open critical/high
findings blocking `/accept`. Lasting decisions: a delivery ref's identity is the acceptance that
consumed it; recorded findings are the gate's only input (prose is narration); triage annotates,
never erases, and every rule is enforced twice. Review: 4 lenses, 16 findings, 8 fixed — all four
lenses independently found the phantom-delivery defect, and the first fix for it was itself wrong
until a regression pin caught it. Live proof: a two-life piped run on the QuickBoard fixture,
43/43 evidence checks, including a deterministic pre-work `/accept` refusal naming the review
blocker and a UI lens finding a seeded XSS. **Live-found and fixed in S14.5:** executor capture
refused everything under system `core.autocrlf=true`.

### Session 13 (2026-07-26) — managed previews + browser/visual verification

Locally built apps became verifiable as a user experiences them (commits `5b7b451`…`28fb29a`;
suite 868→972+1). Landed: `src/preview/` (a live handle over an fd-logged, TTL/log-capped,
unref'd process; a fixed dev/preview/serve/start allowlist; announced-port readiness; the
identity-verified crash sweep with no age hatch on kills) and `src/browser/` (playwright-core over
the system browser; a zod FlowSpec whose `goto` REQUIRES app-meaningful readiness; the typed
timeout/assertion/navigation/runtime/protocol taxonomy with a real origin comparison); wire images
(the model sees pixels live, the log keeps pointers, elision ages pixels to markers); check-kind
`browser` feeding the same gates/acceptance/recovery. Lasting decisions: **a preview is a
RESOURCE, not a check kind** (a check is a bounded process that ends; a preview deliberately does
not); browser evidence rides the check channel with `exitCode: null`, which satisfies gates while
staying structurally outside the file-CHECKED exit-0 rule; **kills need positive identity,
deletions do not**; flows inherit the preview's consent, origin-locked, with no ask path for
arbitrary origins. Live: two-life E2E with a browser-only seeded defect, classified repair, crash,
identity-verified orphan sweep, re-consent, 44/44 checks. Still relevant: readiness proves an
announced port answers HTTP (socket ownership unverified); a one-shot console Ctrl+C also reaches
the preview on Windows; grandchildren of a dead intermediate remain unreachable by kills.

### Session 12 (2026-07-25/26) — unified verification gate and typed recovery

Verification became a typed capability whose results are durable evidence (suite 689→868+1).
Landed: `src/checks/` (bounded never-throwing detection; a declarative recipe table where a
project's OWN script beats a guessed tool; `toCommand` as the single composer; normalization whose
one rule is **the exit code is the verdict**, with named SIGNALS keeping later classification
derivable from the log alone); the `check` policy fact with replay consent bound to the script
BODY; `PlanTask.checks`/`PlanGraph.gates` with one `depSatisfied` predicate plus integration and
completion boundary gates and honest waivers; and `src/recovery/` — failure classes as a DATA
catalogue, deterministic classification BEFORE any repair planning, a ledger whose outcomes are
DERIVED, and a bounded policy with typed stop reasons. Lasting decisions: **the model names KINDS,
the harness names COMMANDS** (the whole trust argument for consent-once checks — and why consent
had to bind the body: rewriting `package.json` otherwise turned one `[s]` into standing execution
consent, the critical review finding of that session); a FIELD, not a state, for verification; a
gate may only be waived by a PROJECT-capability fact; enforced/detected/recorded are three
different words. Live four-life E2E with four seeded defects: 39/40 checks, including a SIGKILL
inside a running check (replayed as "produced no verdict") and a `dependency-setup` failure that
REFUSED automatic repair and escalated.

### Session 11.5 (2026-07-24) — the durable session

A session became a durable, self-contained unit of work (suite 645→688+1). Landed: crash-covered
task-base ref lifecycle (creation events + resume-seeded pruning); truncation spill blobs
("captured" never "full"); definition-bound completed state with per-attempt history; the R10
retry ceiling (3 genuine failures per current definition; crashes and user stops never count); and
the `/accept` boundary — recorded consent, plan retirement via supersede (never archive-by-delete,
which would have added the system's only un-undoable act), immediate ref pruning, and a
deterministic journal Handoff. Live three-life E2E with a mid-wave SIGKILL and a second unplanned
kill absorbed: 30/30 checks. Still relevant: cleanup at acceptance is deliberately conservative
(snapshots, blobs, plan files, logs are never deleted); one-shot sessions cannot accept.

### Session 11 (2026-07-23/24) — iterative planning, task graphs, parallel-first execution

The planning/orchestration lifecycle (suite 574→645+1). Landed: ONE canonical `<id>.plan.json`
task graph with two deterministic projections; approval binding `planContentSha` so status flips
are sha-neutral BY CONSTRUCTION and any semantic amendment invalidates; structured `update_plan`
whose validation errors return complete with NOTHING written; observable routing (`@plan`/
`@direct`, no harness classifier); the delegate DAG gate with plan bindings and events-rebuilt
caps; bounded supervision dual-surfaced as events AND the head-of-result group digest; task-scoped
`/cancel`; and the TTY-only sticky status area with the live task table. Lasting decisions:
execution status is a PURE EVENT FOLD, never a field in the plan (two writable status sources
would be the double-truth trap); the scheduler is a GATE plus guidance, not an in-tool wave engine;
mid-turn interception is TTY-only because piped determinism is a contract.

### Session 10 (2026-07-23) — repository intelligence and focused exploration

Selective, ranked, task-directed retrieval replaced the broad file list (suite 515→574+1). The
Plan-agent critique caught two CRITICAL flaws pre-code: never redefine `WorkspaceMap.sha256`
(additive `inventorySha256` instead) and never let an observe tool write the index at query time.
Live proof on a 3,064-file vitest clone: flat map 0/14 packages visible → ranked map 14/14 in ≤16k
chars; two disjoint-focus explorers, zero shared reads; 16 uncached parent input tokens. Lasting
decisions: excerpts and line numbers ALWAYS come from live reads (a stale index may misrank, never
fabricate); recall backstop over ranking confidence; regex over tree-sitter (Windows-first, no
native deps, same interface if recall pressure demands).

### Session 9 (2026-07-22/23) — pre-expansion consolidation + the live V0.7 proof

Audit-driven fixes, no new capability (suite 498→515+1): concurrent-session worktree safety
(owner-stamped entries, in-process mutex + token `O_EXCL` lock, merge-on-save); plan-approval
state displayed at the executor spawn ask; task-base refs pruned with provenance; command grants
keyed on the command FACT (a session grant is stored only when `tool.command` is undefined; `[s]`
hidden where no grant would store — found live). The live V0.7 proof: `@plan` → sha-bound approve
→ ONE call → TWO parallel worktree executors → forwarded approvals → capture → apply ×2 → `/undo`
→ honest recovery → reviewer panel auto-denied its shell attempts and the parent re-ran the probe
itself; 42 uncached input tokens; sovereignty observed unprompted.

### Session 8 (2026-07-22) — coordinated parallelism + the minimal agent-teams layer

Roles as two-layer explicit contracts (policy fact table + runtime contract rows, pinned
consistent at load); parallel groups living in the delegate TOOL (one call = 1–3 tasks = one
evidence unit = ONE approval for a mutating group; `runTurn` byte-identical); plan mode; the
executor role (base checkpoint → detached worktree → bounded binary-safe capture that OUTLIVES the
worktree → reviewed drift-refusing apply). Lasting decisions: worktrees of a trusted workspace are
trusted BY DERIVATION; the plan-approval gate landed BEFORE the capability it gates; executor
spawns are never grantable; worktrees live in the OS temp dir because `validatePath` DICTATES it.

### Session 7 (2026-07-20/21) — main-agent control layer: memory + subagent tasks

Three-document project memory (AGENT.md user constitution; harness-generated rolling
JOURNAL/CODEBASE with deterministic event-derived Evidence and the verbatim "CONTEXT, NOT
AUTHORITY" framing) + the first read-only explorer tasks over the SAME `runTurn` +
`assembleSession` as the ONE construction path (trust is a parameter, so assembly is structurally
impossible untrusted). Lasting decisions: memory is context-not-authority STRUCTURALLY (evidence
from events; crash notes from log tails — absence of memory never accuses a session);
`aborted ≠ user-quit`; delegation budgets are harness-fixed, never model-controlled.

### Session 6.5 (2026-07-19) — V0.5 capability demo + production-style validation

One continuous ~68-min recorded run (real ConPTY → xterm.js → Playwright, byte-truthful): built
**LedgerLite** (20 files, 51 unit tests) from a natural-language brief with 13 live approvals,
then demonstrated diff/attributed-commit/checkpoint/restore/undo/report and deny-adapt honesty;
**124 uncached input tokens** total. Lasting decisions: validation sessions live OUTSIDE the
product repo; the bridge identifies itself truthfully; demo briefs state git authority explicitly.

### Session 6 (2026-07-18) — Git-native, reviewable, context-efficient

GitOps as a harness-only capability (a policy regression test PINS why it must never be a model
tool — a command-less, mutation-less "git_commit tool" would auto-allow as observe), with the
hardened git substrate, attributable `/diff`, session-scoped `/commit`, and hidden-ref checkpoints
whose restore is ONE applyUndo unit — git is never the undo mechanism (the Codex ghost-commit
data-loss lesson). Context efficiency: two-breakpoint prompt caching (~6 uncached input
tokens/session) + deterministic monotone elision + the git-backed map.

### Session 5 (2026-07-18) — enforced isolation + automatic command review

The OS-enforced Windows boundary (Low IL + Job Object; `WRITE_RESTRICTED` tokens FAILED in the
machine probe, which ran BEFORE any code) + deterministic automatic command review
(`analyzeCommand` as a POSITIVE proof of safety; auto-run requires proof AND an active probed
boundary, else ask; approved commands deliberately run unsandboxed — the user accepted the risk).
Enforcement is probed per session, never assumed, and degrades fail-closed. 8 real-OS win32 tests
and a 66-assertion adversarial corpus (40+ escape forms never auto-run).

### Session 4 (2026-07-17) — execution kernel hardening

The managed exec substrate (typed termination — a killed command has NO exit code, everywhere —
and the kill/drain state machine that never awaits `'close'` unconditionally: the
nodejs/node#21960 grandchild-pipe hang class) + real mid-command cancellation proven with a
genuine console CTRL_C against the live API. **Cost lesson (now a CLAUDE.md rule):** a per-finding
3-verifier fan-out exploded (19 findings → ~57 agents) and was aborted; findings were salvaged and
verified BY HAND — review workflows stay bounded, no per-finding verifier panels.

### Sessions 1–3 (2026-07-14/16) — the bounded local agent loop, the REPL, and the first recorded demo

V0.1's seven pillars (typed contracts, append-only JSONL with tail repair, one pure policy choke
point + Windows-first path validator, five file tools + run_command, snapshots with drift-refusing
undo, resume with crash reconciliation, deterministic evidence report); V0.2's REPL on the exact
same runtime (no parallel loop), workspace trust as recorded consent (TTY-only prompt, no
self-granting folders, corrupt store = hard error), and narrowing-only config; a reusable
proxy-aware transport (pure `resolveProxy`, per-request dispatcher, credentials never persisted);
and an 11m20s recorded E2E whose product yield was two real defects (an npm-link shim exiting 0
silently; a vitest hang backstop). Lasting decisions: no widenable allowlist config; in-workspace
writes auto-allow but snapshot first; sandbox vs approval kept separate and stated honestly;
secret reads redacted via salted HMAC and deliberately non-replayable on resume; state lives
outside the workspace. Still-true limitations: command output is not scrubbed for secrets; path
checks are TOCTOU-racy; undo is file-only; single-user lock assumption.

---

## Deferred pool (accumulated, still open)

**Design already agreed, not yet built:** `/review dismiss <id> <reason>` — a user-side
per-finding dismissal (`review.triage` widened with `action: 'dismiss'` + `source: 'user'|'model'`,
refused at the tool so consent stays the user's, marked ineffective in the fold when not
user-sourced, always a caveat); a static-server preview recipe for plain-HTML workspaces (a
harness-owned script, `workspaceAuthored: false`, requiring a declared port); `agent accept <id>`
so one-shot sessions can reach the acceptance boundary (needs `runAcceptFlow` extracted from the
REPL path, and the clean-end predicate already fixed in S14.5); `agent gc` — a dry-run-by-default
blob/plan-file collector over a conservative reference walk (treat every 64-hex string in every
event as a reference; refuse to delete anything when any log is corrupt or locked; age-gated).

**Cross-platform test portability (found by CI's first run, 2026-07-28):** the suite is
Windows-first in a way that is only now measured. On `ubuntu-latest`, 10 tests fail because the
TESTS encode win32 semantics, not because the runtime is wrong there: backslash traversal and UNC
rejection fixtures, case-insensitive child-env deduplication (Linux env vars are case-sensitive,
and `buildChildEnv` correctly does not fold them), taskkill-based tree-kill expectations, and a
git hook-failure fixture. The CI Linux job is kept and marked advisory so the gap stays visible;
the work is to gate or parameterize those fixtures per platform. Two REAL defects the same first
CI run found were fixed immediately: `resolveLayout` compared a realpath'd workspace against a
merely resolved state root (so a state dir inside the workspace could evade the refusal when
spelled as an 8.3 short path or through a symlink), and a test whose premise silently broke when
cwd and TEMP sit on different drives.

**Provider/model (new, S15):** live smokes for DeepSeek/Kimi/GLM once keys exist; a live reasoning
render channel (deltas are captured for round-trip but never displayed, so an always-thinking model
looks paused); reasoning-payload spill-to-blob if event logs grow uncomfortable; strict-schema
transformation for OpenAI/Kimi strict tool mode (currently `strict:false` — zod-derived draft-7
schemas are not strict-compatible); per-role model tiers (a cheap explorer model); exposing
Anthropic `output_config.effort` / reasoning-effort controls per provider; `undici` 8 and `diff` 9
majors (deferred deliberately — proxy dispatcher and patch API need live verification).

**Kernel/runtime:** `pause_turn` is mapped but the loop would end the turn; per-action / `--to` /
`--steps` undo; conversation rewind; session
pruning/sanitized export; prompt-history persistence + line-editing niceties; PTY support (the
supervised preview substrate deliberately stops at non-interactive servers); SQLite indexing of
events and long-term memory topic retrieval.

**Delivery/review:** the review requirement is plan-scoped, so an events-derived requirement for
plan-less executor work is available if "any mutating session" ever becomes the wanted default; a
phantom harness checkpoint suppresses the covered-change rule until the next spawn.

**Preview/browser:** socket-ownership verification for readiness (owner-pid via
Get-NetTCPConnection is the likely shape); deterministic screenshot BASELINE comparison where
stable baselines exist; preview log files join the blob-retention question; executor-side preview
(blocked on the same worktree-lacks-deps seam as `run_check`); headed/devtools browser mode and
multi-context flows; `ps` etime parsing for macOS/BSD sweep identity (Linux-shaped today, fails
safe); a Windows one-shot Ctrl+C console-group workaround if the documented 'crashed' mislabel
ever bites.

**Retrieval:** tree-sitter (or richer) extraction behind the same extract interface; more
languages as data-shaped table additions; a user config knob for the map budget; a post-group
child read-set overlap metric; retrieval-aware journal topics.

**Verification/recovery:** a `session`-targeted escalation has no harness-derived resolution (a
user-side dismissal recorded as an event is the likely shape); per-task gates are unit-tested only,
since a plan of all-`main` tasks cannot declare them; executors cannot self-verify (parent-only
`run_check`, because a worktree lacks gitignored deps); more ecosystems as data-shaped recipe rows;
an incremental check cache keyed by file hashes + tool versions.

**Planning/orchestration:** a width-aware status-area clip before free-form text may land in status
lines; sibling-task chrome printing over a DISPLAYED forwarded-approval prompt (part of the io
redesign); plan-file pruning (folded into `agent gc` above); a `/cancel` surface for non-TTY
sessions; richer wave guidance.

**Tasks/memory/git/sandbox:** task resume/continue; deeper scanning of child reports for
instruction-shaped content (v1 ships delimiters + provenance labels); the stale-displayed-
forwarded-prompt line-consumption wart (needs an io redesign); per-child sandbox scratch TEMP
isolation; a cross-process memory-doc lock (today: a seconds-wide last-writer-wins window at
simultaneous quits); model-generated compaction of assistant/user text; patch/multi-edit editing;
model-generated commit messages; attribution of approved `run_command` file effects (structurally
under-claimed); push/PR flows; submodule + multi-repo workspaces; network-egress control and a
read/confidentiality boundary (the two enforced gaps that most matter); a cached/compiled sandbox
host to cut per-command Add-Type latency; macOS/Linux enforcement backends; containment of
service-reparented work that escapes the Job Object.

**Cosmetics (informational only):** command-label noise — word-boundary matches can mislabel (the
literal "format" in `format.js` → destructive); labels never grant and never gate. PowerShell
CLIXML progress-stream noise on some chained commands' stderr.
