# ROADMAP

Rolling execution record: the latest session in full detail, older sessions compressed to
milestones that keep their objective, lasting decisions (with why), evidence, and still-open
limitations. Newest first. Contracts live in `ARCHITECTURE.md`.

---

## Session 20.5 (2026-08-09) — Full-system review, limits retune, and a zero-to-remote proof

### Objective

A consolidation-and-proof session before S21's memory work, not a feature session: find and fix
what six sessions of rapid capability growth (S15–S20) left behind — real bugs, fail-open seams,
doc/code drift, and above all **fixed caps sized for the fixtures they were introduced against**
rather than for what a v1.6 session now does (research + documents + remote delivery in one
coherent run) — then prove the whole system end to end from an empty folder to a real GitHub
release.

### What shipped — the review (5 lenses, bounded, hand-verified)

One Workflow, five differentiated finder lenses over the whole system; every finding verified by
hand against the code before any fix, each fix with a regression test, committed in five clusters.
The largest class was **accounting and honesty seams that only bite hours into a real session**:

- **Policy ordering.** A pre-resolution remote refusal (budget spent, gh absent, no repo — all of
  which legitimately have no host yet) recorded `remote.unresolved-target` with a cure no input
  could satisfy; the guard now honors the tool's own blocked fact before the host checks, with
  lineage above both so a child hears the permanent answer. `command()`/`readsPaths()` were the
  last two bare fact calls in `decide()` — a throw escaped the gate and crashed the turn; both now
  deny like every other branch.
- **Remote accounting + scale.** `remote_release` charged the write allowance on success only
  while every failure recorded its `remote.mutated` event, so live and events-rebuilt spends
  disagreed both ways (the S20 push invariant, which this tool had only half of). And the
  observation `ls-remote` was unscoped with a silent 2,000-row cap: GitHub exposes two refs per PR
  under `refs/pull/`, which sort before tags, so a busy repo starved a real tag out of the listing
  and misreported it `new`. Now scoped to heads+tags, 4 MiB capture, 20k reported rows, truncation
  folded into `basesIncomplete` with a single-ref absence re-check.
- **Runtime honesty (six gaps).** A deny-&-stop on a turn's final step read as `max-steps` (a
  child's as `budget-steps`, spending an R10 attempt) — the cause is now explicit on `TurnResult`.
  `repairDanglingToolUses` claimed "the turn failed before this call ran" for calls that had
  snapshotted, written bytes, or spawned — and its appended completion SHADOWS reconstruct on every
  resume; it now tells the same truth. Elision monotonicity was process-memory only and reset on
  resume (and diverged in the end-of-session narrative) — both seeded from `context.compacted` now.
  The exhausted-context warning was gated on the elided set GROWING, so it went silent exactly in
  the steady state heading for a hard context-window failure — a latch fires it once at the
  crossing. The task-base untracked guard was the only human consent with no durable record.
- **Gate folds (one HIGH + three refunds).** Project-scoped gates compared `projectId`
  case-SENSITIVELY while `selectUnit` folds case, so a plan scoped `'API'` over on-disk `api` was
  permanently unsatisfiable AND unwaivable — the exact unclearable-gate trap, one fold layer up.
  Plus three quiet budget refunds across resume (a never-started delegated attempt, an
  all-formats-failed render, a failed release), each closed with an additive event.
- **Long-run robustness.** A wedged `taskkill` could hang the exec outcome forever (the helper
  wait was unbounded while settle awaits it — the sibling preview module already bounded the same
  call); a TTL/log-cap reap landing mid-flow was misdiagnosed `preview-died` → runtime-process; the
  spawn-to-register crash scan sliced 50 entries before the recency filter, so >50 accumulated logs
  blinded the window. All three fixed.

Bounded deferred-pool pickups: **CI test portability** (21 Windows-shaped fixtures ported so the
advisory Linux job can assert real behavior — zero src changes), **`reasoningTokens`** surfaced in
the report and `/status`.

### What shipped — the limits retune (audit acted on)

The S16 principle, reaffirmed: **raise SCALE bounds, never REPETITION or CONSENT bounds.** Pinned
with per-change rationale in `test/limits.test.ts`. The load-bearing one: catalog context budgets
became a **per-model derivation rule** — `budget×1.25 + 40k overhead + defaultMaxTokens ≤
contextTokens`, clamped under provider billing thresholds (gpt-5.6's 272K whole-request 2×,
verified live) — replacing a flat 100k that sat at ~10% of a 1M window on flagships and
*overflowed* the 200k/128k-window models once overhead was priced in. A latent GLM overclaim
surfaced (`glm-5.2`'s row named its `[1m]` sibling's window; corrected to 200K). Provider windows
and pricing re-verified 2026-08-09. Other raises: steps 40→60 (+ loud one-shot end), task pool
16→32 / 400k, checks 80→160, research pools raised, preview TTL 60→120 min, exec capture 1→4 MiB.
The **executor wall clock now excludes measured approval wait** (an away human used to kill the
executor mid-work), coupled with the worktree sweep's live-pid hatch (2h→8h).

### What shipped — maintainability (boundaries, not reorganization)

Verdict from the structural audit (171 files, 28 flat modules): the flat depth-2 tree is the right
design — moving files would churn 164 test files and the published layout for aesthetics. What was
eroding was BOUNDARIES. `test/architecture.test.ts` now pins the invariants (no `../../`, `shared/`
leaf, `sandbox/` entry-only, module cycles a frozen removal-only set) — and immediately found a
fifth cycle nobody knew about. Three cut: `plan↔memory` (→ `shared/docio.ts`),
`retrieval↔workspace` (→ `git/ls.ts`), `types↔exec` (`ExecSpec` → `types.ts`); `shared/` made a
true leaf (`isAlive` → `shared/proc.ts`). ARCHITECTURE's src tree regenerated complete (three whole
modules had been missing).

### The live proof (`agent-cli-s205-live/`, Kimi K3, EMPTY folder → `earthwalker17/agent-cli-e2e`) — **STARTED, NOT COMPLETED; deferred to S20.6**

The E2E was built and partially run, then **blocked by provider-account funding, not by any code,
harness or driver defect**. What was proven live before it stalled:

- **Leg 0 (bootstrap):** an EMPTY folder became a git repo on `main` with `.gitignore` and origin
  = the scratch repo — correctly gated by run_command approvals, on camera.
- **Leg 1 (partial):** source-backed **web research** on Open-Meteo (a researcher subagent, 12
  searches, corroborated findings with sources) PLUS the model directly probing the live API with
  `curl` to verify the wire format; a well-formed **task graph** (three executor scaffolds with
  per-unit checks incl. Go, a main integrate-verify, three reviewer lenses); user plan approval
  (sha-bound); and **three parallel executors that scaffolded and CAPTURED real code** (9/12/9
  files in isolated worktrees, `task.changes` ×3). Every stage that ran, ran correctly.

**Why it stalled:** the **Moonshot/Kimi account was suspended for insufficient balance** — HTTP
429 `exceeded_current_quota_error` — mid-run. Early turns had funds; later turns returned empty
completions, so the parent never integrated the captured changes and `/accept` correctly refused
incomplete work. Confirmed by a direct API probe (`agent-cli-s205-live/probe-kimi.mjs`). Anthropic
is out of credit and DeepSeek/GLM keys are absent, so Kimi was the only funded option and it ran
dry. The account was **recharged ($20) by the user after the session**, so a re-run is unblocked.

**Two real driver fixes made along the way** (the harness itself needed none): an **engagement
gate** — the scripted driver's `atIdle()` could match the `› ` prompt in the seconds before an
always-thinking model starts, silently returning before the turn ran (this skipped the git
bootstrap and the post-build integration); it now waits for the model to visibly engage
(heartbeat / output / approval) and surfaces a genuine non-response loudly. And an **explicit
integration push** — after the executor group returns, drive `apply_task_changes` + verification
rather than accepting a premature idle.

**Remaining, deferred to Session 20.6:** run leg 1 to completion on the recharged Kimi (integrate
→ per-unit checks → two previews → browser flow → DOCX/PDF + inspect → review → `/accept` →
`/commit` → push + tag + release), record it, run the ~45-check validator, cut the subtitled MP4,
and fill this subsection + `DEMO.md` from the evidence. The full run-book is in the handoff:
`agent-cli-s205-live/HANDOFF.md` and the `[[s205-handoff]]` memory.

### Verification

Suite **2038 → ~2080** (net; new regression + architecture tests, minus none). `npm run typecheck`
clean, `npm run build` clean. Full suite verified green by running it in two halves (the
browser-dependent suites flake only under parallel msedge contention; each passes in isolation — a
documented non-defect). The retune's expected fallout — seven fixtures that hardcoded an old
bound's value — now derive from the constants, so the next retune moves them for free. The E2E
post-hoc validator (`validate.mjs`, ~45 checks) has NOT run — it needs a completed live take.

### Decisions (and why)

- **A per-model budget RULE, not a flat number.** The flat 100k was only ever "reproduce the
  pre-S15 chars"; on a 1M-window model that is a 90%-idle window paying cache-invalidation cost,
  and on a 200k model it was a silent OVERFLOW. Pinning the fit-and-billing rule as an invariant
  over every catalog row means the next model added cannot quietly overflow.
- **The boundary is a TEST, not a matrix.** A full allowed-edge matrix breaks on every legitimate
  import and decays into a change log; invariants + a frozen removal-only cycle set catch the
  thing that actually matters (a NEW cycle) without taxing ordinary work.
- **Consent and repetition bounds stay put, again.** The audit raised scale bounds only. Migrate/
  seed still ask every time; a remote write still asks every time; MAX_REVIEW_ROUNDS, MAX_TASK_
  ATTEMPTS, the 5-minute observation staleness — untouched. Those are authority, not capacity.

### Open issues / boundaries

- The executor approval-wait exclusion is proven hermetically (the E2E's scripted driver answers
  in seconds, so the live run does not exercise it); the LOUD max-steps end likewise.
- The context-budget rule is verified against each provider's *documentation* as of 2026-08-09,
  not against a live long-context bill; catalogs go stale before harnesses do.
- The advisory Linux CI job's fixtures are ported but the green is validated by CI on the next
  push, not on this Windows machine — the advisory flag flips only once it is OBSERVED green.

### Recommended next step

**Session 20.6 FIRST: complete the deferred live E2E and the demo video** (Kimi recharged; the
harness is built and the driver hardened — see `agent-cli-s205-live/HANDOFF.md`). Only the live
proof and the MP4 remain before v1.6.1 can be honestly published; the engineering is done and
reviewed. THEN Session 21 per BLUEPRINT: bounded memory and initialization — size/token budgets,
staleness, provenance, `LESSONS.md`, and the `RESEARCH.md` deferred from S19.

**Do NOT publish v1.6.1 until the live E2E is genuinely green** — the release protocol requires a
live-proven capability, and the zero-to-remote claim is exactly what the E2E exists to prove.

---

## Earlier Milestones (compressed per the rolling-docs policy)

Contract detail lives in `ARCHITECTURE.md`; entries keep the objective, lasting decisions, the
evidence, and what stayed open.

### Session 20 (2026-08-08) — Remote Git and GitHub delivery

Carried a verified, accepted, committed local result across the machine boundary to an explicitly
identified GitHub destination — v1.6.0, pushed, tagged and released (commits `3f34c8f`…`19269f9`;
suite 1828 → 2037). The failure it prevents is **authority creep**: reading a remote and changing
one arriving as one capability, so that consent to look becomes consent to publish and a green
check becomes a licence.

**Lasting decisions.** Two policy facts, not one capability with a mode — `remoteRead` AND
`remoteWrite`, each fail-closed — so the existing conflicting-contract rule makes a tool that
could both read and publish an automatic deny. A read asks `external` and is session-grantable
within a real counter; a **write asks every time**, never passes `applyGrant`, offers no `[s]`,
stores nothing — written at all three consent surfaces, because a consent surface that disagrees
with itself is how standing authority is won by accident (publishing stays `external`, force
`destructive`, so the strong word is not spent on an ordinary publish). A mutation must cite a
live **observation** of its ref within a kernel-owned age bound no pack can widen, and only
`remote_status view=refs` produces one — "understand the remote before you change it",
engine-enforced. Observations and gh identity are memory-only and die at resume; read/write SPEND
is rebuilt from events: authority is not durable, spending is. **Looking never writes** — the
only network verb is `git ls-remote`, never fetch, at the honest cost of a genuinely `unknown`
relation, which refuses a force push **even with `force`**. What the human approved is what
executes: refspec from the observed OID, a structurally compared `--dry-run --porcelain`,
`--no-follow-tags`, `--force-with-lease=<ref>:<observed-oid>`, `verified` recorded apart from
`ok`, `remote_release` always `--verify-tag`. Three tools, no `gh api` escape, no credential ever
held by the harness. Local verification is SHOWN, never required — a green gate must not become
an authorization. The compound invariant: the model cannot commit and a push transmits committed
refs only, so *the model cannot publish content a human did not commit.*

**Evidence — the live run** (Kimi K3 against the real `earthwalker17/agent-cli`; the scripted
human deliberately not always-yes): **225 events, 12 remote reads, 3 mutations — all verified
against the remote, zero credential-shaped strings in the log**; eleven approvals — two
`allow/session` (both READS), eight `allow/once`, and the **first publish DENIED**, with
`/remote` right after still reporting "Mutations (0)"; four publishes under four separate
approvals, no `[s]` anywhere. Resumed: `spent 10 read(s), 3 mutation(s)` yet `Live observations
(0)` and no read grant, then a re-publish denied twice by policy (`remote.unauthenticated`, then
`remote.precondition`) — a restart can neither refill an allowance nor inherit an authority.
Review: 4 lenses, 20 findings; **two overclaims only the live run caught** — a fresh branch
previewed as "207 commit(s)" by walking the tip's own history (now one full `ls-remote` with
exclusion bases: "1 commit(s)", one file), and "GitHub will REJECT this push" asserted where
https authenticates with the CREDENTIAL HELPER's token, not gh's; GitHub accepted it, and it is
now a stated risk naming which credential it means. The proof refs were deleted from the remote
once v1.6.0 shipped, and the local evidence directory `agent-cli-s20-live/` (`DEMO.md`) is gone
from disk too — the transcripts and this record are what remains.

**Still open.** Only `github.com` was exercised live; enterprise hosts run the same code paths
and are NOT live-proven. The gh JSON parsers are tolerant by design — a renamed field degrades to
missing data rather than crash a publish flow, so a silent shape change reads as absence. A
Windows GUI credential prompt cannot be structurally prevented (bounded-timeout backstop), and
`--dangerously-allow-all` auto-allows remote mutations, recorded as `source: "dangerous-mode"`.

### Session 19 (2026-08-07/08) — Source-backed web research

Gave the harness its first deliberate connection to the external web, as a bounded, budgeted,
read-only capability that hands the main agent short **source-backed claims** rather than raw
pages — v1.5.0 (commits `60dc67b`…`17f0456`; suite 1547 → 1828, 292 research tests). The failure
it prevents is **stale confidence**: writing code against an API that moved, from recall, sure of
itself.

**Lasting decisions.** A seventh policy fact and engine branch 0g, because a command-less,
mutation-less research call would auto-allow as `observe` ("read-only workspace access") — false
in the only direction that matters: **sending** model-authored text to a third party is the
consequence, and network is the one boundary the OS sandbox does not confine. **The budget IS
the consent**: the first call asks `external` with the query verbatim and the remaining session
allowance, so `[s]` authorizes the bounded capability against a real shared counter, and an
exhausted budget is an engine-owned DENY no held grant rescues. A `researcher` subagent role at
`read-only-external` — a third access class, not a boolean flag, because the engine's ordering
is a total order over strictness and a flag would let a future role be both without anyone
deciding which ask wins — holds nothing that writes, runs, or delegates, and the parent gets
`web_search` only, so "the main agent never receives raw webpages" is a registry property, not
a hope. `record_source` takes one falsifiable claim, its URLs, and a corroboration verdict, and
**refuses** `corroborated` backed by a single distinct source — the exact way one page becomes
consensus — with `retrievedAt` stamped by the harness clock; research never satisfies a
verification gate, and acceptance instead carries caveats naming externally-sourced and
single-source conclusions. Three fail-open hand-lists were closed en route, all one shape (a
list that silently stops covering things): the conflicting-contract guards now derive from the
one `FACT_KINDS` table so an eighth fact breaks the typecheck, `childTools` admissibility became
`satisfies Record<FactKind, boolean>`, and the provider naming rule — four names stale since
S16 — now reads `SESSION_TOOL_NAMES`/`CHILD_ONLY_TOOL_NAMES` pinned against a real assembly.

**Evidence — a control-vs-proof experiment**: two live runs, same fixture, same provider (Kimi
K3), one variable — whether `TAVILY_API_KEY` was in the child env — on a task whose current auth
header is a known stale-prior trap. The control implemented from recall, typechecked PASS, and
flagged the auth drift as its own top risk; the proof's researcher ran 14 searches and 3
extracts in its own context and recorded **7 corroborated findings with real source URLs** —
including that exact legacy trap and an honest "could NOT establish an authoritative date for
the switch" — with budget accounting holding across both logs (15 searches = 1 parent + 14
child). The honest reading: the control's wire format was already correct, so **research
converted a plausible answer into a supported one** — the narrower, true claim. Review: 4
lenses, 20 findings, 12 fixed, each verified by hand; the live run alone found a researcher
timing out at 420 s with **zero findings recorded**, because the budget-pressure note reaches
the parent, never the child. The live evidence directory `agent-cli-s19-live/` (`DEMO.md`) has
since been deleted from disk — the transcripts and this record are what remains.

**Still open.** `RESEARCH.md` deferred to Session 21, the plan's declared cut line: a durable
curated research surface needs that session's staleness and provenance semantics. A researcher
still cannot see its own budget pressure (the bounds compensate). The live proof is one
provider, one task, one API — it shows the path works and the findings were sourced, not a
measurement of research quality.

### Session 18 (2026-08-07) — Polyglot repository intelligence and verification

Extended repository intelligence and typed verification beyond the Node/TS + Python bias, with
support defined as **language + build system + layout + AVAILABLE TOOLCHAIN** rather than
file-extension recognition (commits `5bcb2cf`…`286bcdc`; suite 1480 → 1547). The audit finding
that shaped it: an unrecognized ecosystem resolved every check to `no-recipe`, and `no-recipe`
WAIVES declared gates — so a Rust session reached `/accept` COMPLETE having verified nothing while
claiming no supported manifest existed, over a workspace holding a `Cargo.toml`.

**Lasting decisions.** Machine toolchain availability became a first-class **stat-only** fact
(`checks/toolchain.ts`), with absence never cached and rustup components probed under toolchain
dirs rather than the `~/.cargo/bin` proxy shims — which do ship exactly the false positives the
design predicted. A missing toolchain is `toolchain-unavailable`: it waives (the
browser-unavailable precedent — an absence the harness will never install must not strand
acceptance) but is tracked apart through every fold, so the caveat names the toolchain and its
cure. Recipe ROWS own the precondition "why", because only a row knows whether its blocker is
curable, a machine gap, or a host incapability. `cargo test` under a cross target refuses
PERMANENTLY — cross binaries cannot execute here and the harness manages no hardware — which is
where the embedded line sits. Go's typecheck deliberately duplicates build (its compiler IS its
typechecker: an honest gate beats a waiver), and gofmt gets no format row because an output-parsed
verdict would break *the exit code is the verdict*. `LangId` and `ProjectKind` stay separate
vocabularies, so a lone `.rs` file indexes with no cargo unit in existence.

**Evidence — three validated live runs** (`agent-cli-s18-live/`): the v1.3.0 BEFORE-capture of the
defect itself (17/17 — approved gates on a real Rust crate, both silently waived, `/accept`
COMPLETE with zero checks run); proof A on the pre-install machine (17/17 — six explicit
`toolchain-unavailable` states naming exact cures with ZERO spawns, gates waiving LOUDLY); and
proof B after installing Go and rustup-gnu (27/27 — a seeded `go test` failure and a seeded rustc
E0308 each found, classified, fixed and re-proven; a mid-session `rustup target add` noticed
through the toolchain pseudo-stamp on the TOCTOU seam; `/accept` COMPLETE on GREEN gates with no
waivers). Review: 4 lenses, 13 findings, 10 unique, all hand-verified and fixed — the sharpest
being that cargo/go replay consent bound no content identity although for those ecosystems the
check IS the install (steering files now ride `bodySha`), and that a stale waiver survived a LATER
recorded failure of the same kind (both folds now apply a recency rule).

**Still open.** Live claims cover the rustup **gnu** host and go.dev Go on one Windows 11 machine;
MSVC Rust, cgo, cargo features/build tags and `rust-toolchain` version selection are recorded but
never manipulated. C/C++ is detection + indexing only. Rust `impl` methods, C++ templates and
generated Go code are invisible to the map (column-0 heuristics by design). No preview recipes for
`cargo run`/`go run`.


### Session 16.5 (2026-08-01 … 08-03) — Proving S16 end to end

Two bounded adversarial reviews (5 lenses over the S16 diff: 30 findings, 16 fixed; then 5 over
the whole implementation: 25 findings, 16 fixed) and the live E2E S16 had owed since it shipped
(commits `08b978a`…`86d0f05`; suite 1342→1373). The review's lasting fixes: a compat stream
dying with NEITHER `[DONE]` nor a `finish_reason` was committing a truncated sentence as the
model's final answer (now a non-retryable typed error — part of the stream was consumed, so a
replay would double-bill); consecutive USER messages coalesce at the compat wire; reasoning
blocks weigh their PAYLOAD only (the display copy doubled every kimi/deepseek block and could
fire the context alarm at half the real volume); rate-limit 429s draw a deeper retry budget;
`cacheSuccessfulProbe` caches browser probe SUCCESS only (a cached failure silently converted
"the machine was busy" into "this session cannot produce browser evidence", and that conversion
WAIVED gates); a harness lifecycle stop between approval and a flow reports
`preview-stopped-lifecycle` instead of a crash; `MAX_REVIEW_ROUNDS` moved into the fold's own
module so a blocker can never prescribe a call delegate refuses. Plus the **"working" heartbeat**
for always-thinking models (one dim TTY-only status line; its own first recording proved the line
must be PLAIN text, because the status area sanitizes and ESCAPES anything styled) and the
**tolerant one-level decode** for double-encoded tool arguments — kimi serialized a nested object
as a string and, fed only the schema error, cycled serialization formats for twelve minutes
without ever un-stringifying it. **Live proof: one 84.6-minute Kimi K3 session, EXIT=0, validated
post hoc 38/38** — one request through installs ×2, migrate, seed, per-project checks incl. lint,
a parallel executor wave, two simultaneous dev servers, three passing project-attributed browser
flows, a three-lens review that recorded the seeded XSS, kill + resume on camera, and `/accept`
COMPLETE with no override; a 4.7-minute subtitled MP4 and honest limitations live in
`agent-cli-s165-live/DEMO.md`. Lasting decisions: a tolerant decode is not intent-guessing (the
adapter already JSON-decodes once; one more unambiguous level against the schema that rejected it
is the same operation, bounded); cache probe SUCCESS, never failure; a blocker must name a cure
the harness will allow; a display copy must not weigh; validator assertions are session-scoped.
Still open: multi-kind `run_check` batches re-probe drift once before the first spawn;
`planTouches` reads the plan document at decide (the documented purity exception); resume
identity is flags>config>default rather than sticky; reviewer wall-clock vs always-thinking
models.

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

**Verification/recovery (amended S18):** cargo/go steering files ARE bound into check
replay-consent identity since the S18 review (`RustFacts.consentSha`/`GoFacts.consentSha` ride
`bodySha`); tsconfig/eslint configs remain outside the node rows' identity — the long-standing
stance, now a deliberate asymmetry (node checks are not installs; cargo/go checks are). Preview
recipes for `cargo run`/`go run` servers have no representation (the wording "declares no
preview-capable script" is node-voiced at a rust/go unit). Multi-kind `run_check` batches
re-probe drift once,
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
