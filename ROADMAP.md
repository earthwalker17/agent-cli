# ROADMAP

Rolling execution record: the latest session in full detail, older sessions compressed to
milestones that keep their objective, lasting decisions (with why), evidence, and still-open
limitations. Newest first. Contracts live in `ARCHITECTURE.md`.

---

## Session 16.5 (2026-08-01 … 08-03) — Proving S16 end to end: two reviews, four takes, one complete live run

### Objective

Two goals, both now COMPLETE. First, evidence-backed adversarial review — one bounded batch over
the S16 change set (08-01), then a second bounded batch over the whole current implementation
(08-03) — fixing what is real, with priority on anything that could stop a legitimate full-stack
job. Second, the live E2E Session 16 had been owing since it shipped: a genuinely
dependency-bearing two-project application built from one natural-language request against a live
API, monitored, recorded, accepted, and post-hoc validated. The finished run took four takes
across two providers, and three of the four takes each bought a real harness fix — which is what
the takes were for.

### Review one (08-01, Opus 5): 5 lenses over `8a4ddf4..HEAD`, 30 findings, 16 fixed

Aimed at the shape of the then-outstanding run. The two measured-on-this-machine finds: readiness
could not reach an IPv6-loopback server (Node 22 resolves `localhost` verbatim → `::1` here; a
Vite dev server was unreachable by the IPv4-only probe — both loopback literals are probed now
and the ANSWERING address is recorded, because it becomes a browser flow's origin lock), and a
colourised banner could hide its announced port (the ANSI strip is defensive; Vite 6 measured NOT
colourising to a log file — `probe-preview.mjs` asserts the measurement). The rest, all
hand-verified: a project-scoped `browser` gate was permanently unsatisfiable AND unwaivable
(browser evidence now carries the driven preview's `projectId`); "dependencies are not installed"
WAIVED a user-approved gate (`precondition-curable` keeps it PENDING — an uninstalled project is
unverified, not unverifiable); the first check/preview/migrate after an install was falsely
refused as "changed after approval" (ONE `SharedWorkspace` now backs all three tools); CHECKED
had no project axis (passing evidence carries its scope; correlation requires containment);
a two-preview denial told the model to start a third; an install's consent identity missed
`.pnpmfile.cjs`/`.yarnrc.yml`; boundary gates and repair proofs lost their project axis;
`run_command` `cwd` refused for protected PLACES; the plan views got the project axis; and
`update_plan` learned to warn about the unscoped-gate false green. Pinned together in
`test/live-e2e-blockers.test.ts`.

Takes 1–2 ran against Anthropic. Take 1 found the session's best defect: the agent amended its
own approved plan mid-build, delegation silently became impossible, and the ONE blocker only the
user can clear was never said to the user — `planApprovalReminder` now prints one undimmed
end-of-turn line, narrowed (d93be56) to fire only when an approval EXISTED and no longer covers
the plan. Take 2 proved installs ×2, migrate, seed, per-project checks and the parallel executor
wave live, then stopped: the Anthropic credit balance was exhausted mid-run.

### Review two (08-03, this session): 5 lenses over the whole implementation, 25 findings, 16 fixed

One workflow batch of five differentiated read-only lenses (provider/wire under an
always-thinking compat model; preview/browser under two long-lived servers; plan/review/
acceptance convergence; setup/checks/consent; staleness and contradictions across docs, metadata
and in-code prompt text), findings verified BY HAND against the code before any fix — no
verifier fan-out. Fixed, in four commits:

- **`08b978a` the wire.** A compat stream dying with NEITHER `[DONE]` nor a `finish_reason`
  (proxy/LB idle half-close) was silently committed as a completed turn — a truncated sentence
  became the model's "final" answer. It now throws a non-retryable typed server error (part of
  the stream was consumed; a replay would double-bill). Consecutive USER messages now coalesce at
  the compat wire (the crash-resume shape; only Anthropic coalesced, while the runTurn comment
  claimed all did). Elision no longer double-weighs compat reasoning blocks (`text` is a display
  copy equal to `payload` there — the doubled weight could fire the "history still exceeds the
  context target" alarm at half the real volume). Rate-limit 429s get a deeper default retry
  budget (4; a throttle is EXPECTED to clear, and kimi Tier 0 is 3 req/min) while an explicit
  `retries` stays verbatim.
- **`b01ab86` the preview/browser truth.** A transiently FAILED browser probe was cached for the
  whole session — every later flow became the gate-WAIVING `unsupported/precondition`, so
  acceptance could reach COMPLETE without the UI ever driven; `cacheSuccessfulProbe` caches
  success only. Over-budget screenshots dropped silently (now `screenshotsOmitted` + a
  do-not-cite output line). A harness lifecycle stop (TTL/log-cap/stop) between approval and a
  flow read as `preview-died`→runtime-process — repairs hunted a crash that never happened; the
  preview tool now exposes `endedReason` and the flow reports `preview-stopped-lifecycle`,
  routed to `timeout-resource`. `preview status` surfaces a PREVIOUS-life registry survivor of
  the same session id (it was invisible in both lists exactly while it held the port Vite
  strictPort needs), and the resume note names the stop-it-first way out. The preview tool's
  nothing-was-gated drift refusal got the honest split its siblings already had.
- **`7a36525` every prescribed cure must be a call the harness allows.** With no qualifying
  review round and the round cap spent, the requirement blocker prescribed a reviewer group
  delegate REFUSES — `MAX_REVIEW_ROUNDS` now lives in `review/ledger.ts` (delegate re-exports
  it) and the blocker hands the exits to the USER once the cap is spent. The e933677 carve-out's
  BOUND-but-dead variant (reviewer child ended failed/cancelled/interrupted, requirement
  satisfied by a sibling round, cap spent) is now a caveat; while rounds remain it still blocks.
  `planApprovalReminder` fires after ERROR-ended turns and once at resume startup. `update_plan`
  names the COMPLETED tasks an amendment re-opens. `validatePlanGraph` warns when gate kind
  `browser` rides multi-project `gates.projects` (EACH-of demands a flow against EACH project's
  own preview, including non-UI ones).
- **`306907e` say what is true.** migrate/seed blocked only by missing `node_modules` records
  `precondition-curable`, not a false `no-recipe` capability claim; `agent help` interpolates
  `DEFAULT_MAX_STEPS` (it said 20; the default is 40); REPL `/help` no longer claims "shell
  commands always ask" (false since S5's sandboxed auto-run); README's capability section
  matches the 5-file install consent identity; the CI comment and bug-template placeholder
  updated; `policy/engine`'s purity doc states its one real exception (run_check's `planTouches`
  reads the plan document at decide — mechanism gap recorded below, not papered over).

Plus **`3df42e1` the "working" heartbeat**, built FOR this run: kimi-k3 thinks before every reply
and streams nothing while it does, so the REPL looked frozen for minutes. One dim TTY-only status
line (`· model working (Ns)`) driven by a render-only `Session.onModelRequest` seam, drawn only
while a request is in flight with no text streamed, erased synchronously before the first stdout
byte (the status area's no-interleaving invariant holds), zero bytes off-TTY.

### The live E2E — takes three and four (Kimi K3)

**Take 3 stopped on a real harness gap, found live.** Kimi serialized `update_plan`'s nested
`plan` object as a STRING, and fed the zod "expected object, received string" error it cycled
YAML, single-quoted JSON, XML-ish tags and entry-pair arrays for twelve minutes — no plan could
ever be written. Fixed the same hour (**`5ffb7c4`**): a narrow one-level tolerant decode at the
runtime's input-parse choke — fires only after the schema rejected the input, only at
`invalid_type` paths expecting object/array where a string sits, accepts only a string that
itself `JSON.parse`s to a structure, re-validates once, and otherwise keeps the original error
plus a plain-language hint naming the stringified path. The recorded `tool.requested` and the
wire history keep the model's original bytes; policy and execution see the decoded input.
Pinned end to end.

**Take 4 is the complete arc — 84.6 minutes, EXIT=0, then `validate.mjs` 38/38.** One request →
investigation → a 13.8 KB task graph (the first write succeeded one attempt after the hint) →
user revision → amendment → `/plan approve` → installs ×2 through `project_setup` (`npm ci` from
each lockfile) → `.env` → migrate → seed → per-project checks including the lint kind resolving
only in `api` → the parallel executor wave (two worktree children bound to plan tasks, captured,
applied, zero refusals) → post-integration re-checks green in both projects → **two dev servers
at once under harness management** (`127.0.0.1:3001` and `[::1]:5173` — the IPv6 case) → **three
passing project-attributed browser flows** (17/17, 20/20, 19/19; D2 proven fixed on camera; one
flow drove the 409 error path a lens had flagged) → **a three-lens review whose security lens
recorded the seeded XSS** (fixed in the delivered source; two lenses hit their 8-minute wall
under kimi's pace — honest `timeout` with captured findings still counted, the round qualifying
through the completed lens) → `/diff` → **kill + `agent resume <id> --provider kimi` on camera**
(state intact; post-resume preview restarts first failed honestly on still-held ports, then
succeeded) → **`/accept` COMPLETE on round 1, no override**, with the e933677 unbound-reviewer
carve-out firing in production as a caveat → clean `/quit` → the finished app walked through in
the same recording. 567 events, 43 model turns, 104 tool calls, 21 approvals, 6 session logs,
3 `input.invalid` denials all recovered within one attempt.

Recording chain: `edit.mjs`'s first live render found its own bug — ffmpeg 8 rejects the old
`C\\:` subtitle-path escaping (measured: `'C\:/path'` parses; fixed and commented). The
polished MP4 (~5 min, burned-in narration subtitles, ×N badges on accelerated stretches,
`narration.json` for a later voice mix) lives at `agent-cli-s165-live/agent-cli-depot-demo.mp4`;
evidence and honest limitations in `agent-cli-s165-live/DEMO.md`.

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite **1342 → 1366** (1355 passed + 11
skipped) across 96 files. New pins: the stream-end guard, compat user-message coalescing, the
reasoning display-copy weight, the kind-aware retry budget, `cacheSuccessfulProbe`, screenshot
omission accounting, `preview-stopped-lifecycle` classification, the previous-life status line,
the nothing-gated preview refusal, the cap-aware review blocker (both directions), the
bound-but-dead reviewer caveat (both directions), the reopened-completed-tasks warning, the
browser×projects gate warning, the curable setup reason, the heartbeat (5 tests incl. the
zero-bytes-off-TTY pin), and the tolerant decode (6 tests incl. the end-to-end loop pin).
Live: take 4's own event log, validated post hoc **38/38**.

### Decisions (and why)

- **A tolerant decode is not intent-guessing.** The adapter already JSON-decodes the arguments
  once; decoding an unambiguous nested string ONE more level against the schema that rejected it
  is the same operation, bounded — and the alternative was a model provably unable to converge on
  the error text alone. Everything else (YAML, quasi-JSON) still fails, now with a hint written
  for the model that failed.
- **Cache probe SUCCESS, never failure.** A cached failure silently converted "the machine was
  busy for 30 seconds" into "this session cannot produce browser evidence", and that conversion
  was gate-waiving. Seconds of re-probing can never cost honesty.
- **A blocker must name a cure the harness will allow.** Third occurrence of the class (S16.5a
  found two); the fold now knows the round cap so its guidance and delegate's refusals can never
  disagree about what is possible.
- **`MAX_REVIEW_ROUNDS` belongs to the fold.** The pure derivation adapts its own blocker text;
  the tool re-exports the constant. Knowledge lives where the decision is derived.
- **A display copy must not weigh.** `text` on reasoning blocks is contractually never re-sent;
  charging it doubled every compat block and made context-health reporting false in exactly the
  long sessions where the report matters.
- **Validator assertions are session-scoped.** "Zero commits" means zero SINCE the session
  started; ref hygiene means THIS session's refs. Environment history (fixture upgrades, archived
  takes) must not be able to fail a run that behaved perfectly.
- **The reviewer-budget philosophy held under a slower model.** Two lenses timed out but their
  captures counted and the round qualified — the S14.5 capture-before-completion design is what
  made a slow always-thinking reviewer usable at all.

### Open issues / boundaries

- **Multi-kind `run_check` batches re-probe drift once, before the first spawn** — a
  workspace-authored script run by an earlier kind could rewrite a later kind's body within one
  approved batch (cannot fire on Depot; consent-fidelity gap on the S14.5 axis). Deferred with
  design intent: per-iteration re-probe.
- **`planTouches` purity exception**: run_check's fact reads the plan document at decide and the
  plan file is outside the drift stamps (documented in `policy/engine.ts`; the window is an open
  approval prompt). Likely shape: stamp the plan file into the drift probe.
- **Resume identity is flags>config>default, not sticky.** A bare `agent resume` of a kimi
  session resumes on the default provider — recorded and surfaced honestly, but the least
  surprising default would be the session's own identity, with flags overriding. The driver
  passes the flag explicitly; a design decision for later.
- **Reviewer wall-clock vs always-thinking models**: two of three kimi lenses hit the 8-minute
  wall. Budgets are harness-fixed by design; a per-provider budget scale is a possible follow-up.
- Kimi occasionally stringifies OTHER structured arguments too (one `review` triage call denied
  and recovered in take 4) — covered by the same decode+hint, worth watching.
- Carried from S16, still true: npm-workspaces-root per-unit installs fragment hoisting
  (design decision pending); macOS `caseFold` no-op on an unexercised platform; yarn implemented
  from documentation, unit-tested only.
- Take evidence: `take1-failed.log`/`take1-marks.json`, `take2-state/` + `take2-partial.log`,
  `take3-format-churn.log`, and take 4's full `state/` + recording, all under
  `agent-cli-s165-live/`.

### Recommended next step

Session 17 per BLUEPRINT: the first non-coding workflow pack (documents/PDF), now standing on a
live-proven full-stack coding workflow.

---

## Earlier Milestones (compressed per the rolling-docs policy)

Contract detail lives in `ARCHITECTURE.md`; entries keep the objective, lasting decisions, the
evidence, and what stayed open.

### Session 16 (2026-07-31) — Real local software engineering: project units

The coding workflow made dependable for realistic local applications (commits `0b7aff1`…
`6f2a55e`; suite 1164→1322). Before it, a repository holding `web/` and `api/` with no root
manifest detected NOTHING — every check kind `unsupported`, no preview script, every gate
unrunnable: the workflow went inert, not loud. Landed: project UNITS (bounded never-throwing
discovery — declared workspaces + a general depth-1 scan + conventional containers; a unit
exists only where a MANIFEST exists; unglossed globs are refused with a reason); deterministic
ordering because unit ids qualify recipe ids and recipe ids are what consent binds to (the root
unit is never qualified, so single-project workspaces keep byte-identical grants); `selectUnit`
refuses ambiguity, never picks; per-unit checks/previews with per-unit cwd and `projectId` on
check events; `project_setup` (install/migrate/seed) — the model names an INTENT and a UNIT, the
harness names the command from the LOCKFILE, installs may replay under `[s]` bound to
`sha(lockfile + package.json + install-affecting config files)` while migrate/seed ask EVERY time
(not idempotent; destructive is structurally non-grantable); `setup.*` as NEW event types that can
never satisfy a verification gate (an install exiting 0 means dependencies were fetched — the
paired asymmetry test is the contract); `PlanTask.project` + `gates.projects` (sha-neutral when
absent); `run_command` cwd; ONE detection per session feeding the system prompt; secret-named
contents withheld from the session diff; the audited limits table (scale bounds raised, repetition
bounds deliberately not). Its four-lens review found four critical/high holes — each an S16 change
re-opening an earlier session's closed hole one axis over (an install `[s]` as standing shell
consent via a package.json rewrite; a monorepo root silently waiving gates; a repair proven by
another project's green; a plan strandable on a nonexistent project) — all fixed and pinned.
Live proof of the RESOLUTION layer: 21/21 against a real two-package fixture. The end-to-end
agent run it owed was delivered by Session 16.5.

### Session 15 (2026-07-29/30) — V1.1: the multi-provider runtime

Five providers over two genuinely different protocols behind one runtime (commits `1af04c6`…
`7932fed`; suite 1072→1155+1). Landed: an opaque `reasoning` ContentBlock carrying the
provider-NATIVE artifact verbatim, tagged provider+model, persisted additively and replayed per
each provider's documented scope (kimi `all`, anthropic/deepseek/openai `current-loop`, glm never)
— which is what makes always-thinking models and reasoning tool loops legal at all; `catalog.ts`
as capability DATA with a verified date; one profile-parameterized Chat-Completions adapter plus a
separate **OpenAI Responses** adapter (Chat Completions cannot tool-call with reasoning off since
GPT-5.4, so "OpenAI-compatible" would have been a false equivalence at the point that matters);
`/provider` + `/model` + `agent providers`; env-only key discovery; `DEFAULT_MODEL =
'claude-opus-5'` as ONE constant; catalog-driven `maxTokens`/`contextBudget`; honest vision
degradation at one choke. Lasting decisions: reasoning payloads are OPAQUE and only the emitting
adapter may interpret one; persist them VERBATIM and uncapped (kimi and deepseek reject a
tool-looping message whose reasoning was altered); capabilities are advisory DATA and the wire
answer always outranks them; availability is env presence, a switch VALIDATES, and every outcome is
labeled (`models-list` / `presence-only` / `unverified-network`). **Live proof: all five providers**
— 10/10 gated adapter smokes plus two multi-provider sessions, one switching through DeepSeek,
Kimi and GLM with each writing its own file; no key value, `sk-` prefix or `Bearer` token appears
anywhere in either log. The session's most valuable find was live: `validateKey` used a bare global
fetch, so on a proxied machine it returned 401/403 for a key that works — `/provider anthropic`
would have refused a valid credential. Review: 4 lenses, 17 findings, 11 fixed, including two of
the wire-invalid-history class (`scopeReasoning` could emit an empty assistant content array;
elision monotonicity broke once `contextBudget` became mutable) and two test-quality defects that
would have shipped a false green. Still relevant: only each provider's DEFAULT model was
live-tested; GLM's key check is presence-only; reasoning deltas are captured but never rendered.

### Session 14.5 (2026-07-28) — V1.0: consolidation, repo-wide review, live proof

Not a feature session (commits `a5ca9a7`…`6f3ca84`; suite 1043→1072+1). Landed: CLI correctness
(`agent version`/`help` were not in `KNOWN`, so they started a REAL one-shot session with the
literal task string; count flags refusing NaN; `agent plan <id>` joined the ONE reader);
`test-targeted` scope defaulting from the bound plan task's touches; `/diff` carrying the report's
CHECKED verdict through ONE shared correlation; and the review-gate coherence commit (round-voiding
narrowed to applies INSIDE the round window, executor captures counting as real work, the reviewer
budget raised to 24 steps because 15 starved exactly the diligent lenses into `budget-steps`, which
cannot qualify a round). **The executor-capture EOL pin** was the top live-found gap: with system
`core.autocrlf=true` over an LF tree, `worktree add` and `checkout-index` re-applied the smudge
filter, so EVERY captured file refused at apply as base drift — the harness now pins
`core.autocrlf=false -c core.eol=lf` on both invocations when the parent tree is uniformly LF, and
a mixed tree keeps the refusal with an honest diagnosis. Lasting decisions: **a display cap must
never be a consent identity** (`scripts` is truncated for prompts; `scriptShas` carries the full
hash — an append past character 200 had ridden the earlier `[s]`); blocks and stopReason can
diverge, so the loop answers tool_uses on their EXISTENCE (a `max_tokens` cut mid-call had left the
history permanently invalid); a non-verdict is not a diagnosis (timeout and abort sit together at
the top of classification); honest degrade beats silent proceed. Review: 4 lenses, 23 findings, all
23 fixed. **Live proof: the recorded V1.0 demo** — one continuous session on the "Pulse" fixture
with three seeded defects each reachable by a different capability, **48/48 post-hoc evidence
checks**, `/accept` REFUSING twice with honest lists, the security lens finding the seeded XSS, a
browser flow catching a real defect, exactly ONE surviving harness ref, and **zero commits added to
the user's branch**. Two honest notes recorded in `DEMO.md`: the first take was discarded for a
DRIVER bug, and the validator's own first run had a wrong assertion.

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

**Provider/model (new, S15; amended S16.5):** surface `Usage.reasoningTokens` in the report and
`/status` (recorded on `assistant.message`; no reader folds it yet); a live reasoning render
channel — the S16.5 heartbeat covers the frozen-screen half; the CONTENT half (streaming the
reasoning text dim) remains open; reasoning-payload spill-to-blob if event logs grow
uncomfortable; strict-schema transformation for OpenAI/Kimi strict tool mode (currently
`strict:false` — the S16.5 tolerant decode handles the observed double-encoding, but strict mode
would prevent it at the source); resume identity stickiness (a bare `agent resume` of a kimi
session resumes on the default provider — recorded honestly, but the least-surprising default is
the session's own identity, flags overriding); per-provider reviewer/executor budget scale (two
of three kimi lenses hit the 8-minute wall; budgets stay harness-fixed, but a slow
always-thinking model may deserve a scaled wall); per-role model tiers (a cheap explorer model);
exposing Anthropic `output_config.effort` / reasoning-effort controls per provider; `undici` 8
and `diff` 9 majors (deferred deliberately — proxy dispatcher and patch API need live
verification).

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

**Verification/recovery (amended S16.5):** multi-kind `run_check` batches re-probe drift once,
before the first spawn — a workspace-authored script run by an earlier kind could rewrite a later
kind's body within one approved batch (per-iteration re-probe is the likely shape); run_check's
`planTouches` fact reads the plan document at decide and the plan file is outside the drift
stamps (stamp it in); a `session`-targeted escalation has no harness-derived resolution (a
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
