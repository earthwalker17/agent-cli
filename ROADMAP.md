# ROADMAP

Rolling execution record: the latest session in full detail, older sessions compressed to
milestones that keep their objective, lasting decisions (with why), evidence, and still-open
limitations. Newest first. Contracts live in `ARCHITECTURE.md`.

---

## Session 21 (2026-08-11) — Bounded memory and global initialization (v1.7.0)

### Objective

Make project memory deliberate, bounded and useful over long-running projects; give the harness
a user-level global workspace with an optional onboarding flow; design durable machine-level
approvals as the one explicit exception to "authority is not durable" — and first, close the two
runtime defects the S20.5 live E2E carried forward, from the runtime's own semantics rather than
as patches.

### What shipped — the two carried-in fixes

- **A session-targeted repair escalation finally has a user-side closure** (`repair.dismissed`).
  The live-demonstrated deadlock was a three-part conjunction: the ledger closes an escalation
  only via a later PROVEN attempt, `evaluateRepair` refuses to record attempts for
  non-auto-eligible classes, and acceptance's `resolvedTargets` covers plan tasks only — so a
  fully-green session pinned at PARTIAL. Now: `/repair` renders the ledger; `/repair dismiss <n>
  <reason>` appends the additive event, joined on the escalation event's OWN seq (a shared
  signature can never clear a neighbor), `source: 'user'` required by the fold (the recover tool
  has no dismiss action — consent stays the user's structurally), the blocker closed while an
  acceptance CAVEAT always remains. `repair.dismissed` joins `WORK_EVENT_TYPES` so a prior
  PARTIAL acceptance goes stale and re-accepting is meaningful; plan task id `session` is now
  refused as reserved; `/status` gains the repairs line the surface never had.
- **A review round can no longer be spent where it could never bind.** While a once-approved
  plan's approval is invalidated (`approvedSha !== null && !approvedAndCurrent` — an amendment,
  a diverged hand-edit, a vanished document), a reviewer group refuses EX ANTE naming a cure
  that works in the named state. The S20.5 dead end — both rounds ran unbound inside an
  amendment window and the spent cap then blocked the bound round the plan's review task needed
  — is prevented at the gate; `MAX_REVIEW_ROUNDS` itself is untouched, and the decision that
  unbound rounds still count (a binding-aware count would be a repetition-bound loosening) is
  now written on the constant. `planApprovalSha` clears on `plan.discarded`, so discarded plans,
  never-approved drafts and plan-less sessions keep voluntary rounds.

### What shipped — the memory system (three documents → six, every bound a pinned contract)

- **`LESSONS.md`** — durable project lessons, proposed (≤3) in the existing end-of-session
  narrative response as an OPTIONAL schema key (a missed or INVALID value costs the lessons,
  never the journal — enforced by a lenient two-stage parse), merged by slug (reuse = update,
  entry moves to front), harness-stamped provenance per entry, heading-shaped body lines
  visibly defused so a proposal cannot fabricate an entry boundary, user edits preserved
  byte-verbatim. 30 entries / 16 KiB on disk, 8 KiB injected.
- **`RESEARCH.md`** — the durable surface S19 deferred, PERISHABLE by design: a deterministic
  fold over recorded `research.findings` (no model call — it succeeds when the narrative fails),
  idempotent by noteId across resume re-folds, newest-first by harness-stamped retrieval date,
  entries past 30 days dropped at the next write with an honest leading count. Findings
  previously vanished from cross-session memory at quit; the journal evidence section gains the
  missing research line.
- **Coherence pass:** the one truncation-marker gap fixed (an oversize CODEBASE.md was silently
  head-cut); every memory cap pinned in `test/limits.test.ts`, including ONE worst-case
  total-injection ceiling (86,016 chars across all six docs — a new doc must trip a deliberate
  decision, not quietly grow the cached prefix).

### What shipped — the global workspace and /init

- **The global `AGENT.md`** at the state root: one user constitution for every workspace on this
  machine, injected FIRST with a heading stating that the project constitution overrides it on
  conflict (the ecosystem's local-wins convention — Codex/Gemini/goose all layer this way, per
  the session's primary-doc research). Cap 16 KiB, deliberately smaller than the project's;
  recorded in `memory.loaded` with additive `scope: 'user'`; deliberately NOT injected into
  subagents (children execute briefs; injected chars multiply across fan-outs).
- **`/init`** — skippable onboarding no surveyed CLI agent combines: four questions into the
  global doc plus a starter project `AGENT.md` offer. Never rewrites an existing file; each file
  writes atomically or not at all; EOF during the global questions aborts with nothing written;
  answers sanitized; the model told via a pending note that the docs load NEXT session. A
  TTY-only one-line tip points at it while no global doc exists. `agent init` joins `KNOWN`
  (the `agent version` lesson: an unknown positional starts a PAID one-shot).

### What shipped — durable machine approvals

The one explicit, user-recorded exception to "authority is not durable, spending is", designed
against the ecosystem's studied failure (Codex #22181: a vague "don't ask again" minting a
machine-wide program-name allow):

- **`[a]` appears on exactly four surfaces**: a typed check's exact resolved commands
  (replay-sha bound — body drift re-asks structurally; workspace-scoped via the SAME `trustKey`
  derivation trust uses) and three read-only-external class rules (`web_search`, researcher
  spawns via `delegate_task`, `remote_status` reads — machine-wide, per-session budgets still
  bounding). The prompt prints the LITERAL stored rule, its scope, and the revoke path. The
  closed `DURABLE_CLASS_ELIGIBLE` set carries every exclusion with its reason: remote writes,
  migrate/seed, executor spawns, `run_command`, sensitive reads, artifact inspect, preview,
  install (deferred).
- **Structural offer, honest record**: `[a]` renders only from an interactive approver, never on
  forwarded child asks; an unoffered `'a'` parses as DENY; dangerous mode answers prompts that
  never render and can never persist. Persistence runs BEFORE `approval.resolved` is appended —
  a failed persist downgrades the recorded scope to `session` with the reason in `detail`.
- **Store + visibility + revocation**: `<state>/grants.json` (strict schema, corrupt = hard
  error, never rewritten — trust-store discipline) with registry-locked ATOMIC batch writes and
  an append-only `grants.log`; loaded at every assembly (resume identical), class entries
  validated against the eligibility set (an ineligible hand-edit refuses the session naming the
  revoke cure), replay entries seeded into a SEPARATE Grants set only the pure-check branch
  consults (a hand-minted install/preview-shaped key is dead weight); `grants.loaded` recorded
  whenever any entry applies. `agent grants [revoke <id>]` mutates; `/grants` is the in-session
  read-only view.

### Verification

`npm run typecheck` clean. Observed runs, stated exactly: one full parallel run at the
mid-session state ran **2,140 tests (2,126 pass, 11 skip, 3 contention flakes — different files
each run, the S20.5 documented class; every flaked file green in isolation)**; the FINAL tree
(review fixes + the outputPreview fix included; 139 test files, 7 tests added after that full
run) was verified in two sequential halves — half B fully green (69 files), half A green with
one browser flake that passed in isolation. **Adversarial review:
one bounded workflow, four differentiated lenses (consent/authority; memory injection
provenance; fold/event correctness incl. resume; prompt/docs honesty) — 14 findings, every one
hand-verified REAL and fixed with regression pins.** The sharpest: a research CLAIM shaped like
an entry heading forged a RESEARCH.md entry with a model-chosen retrieval date that evaded the
staleness horizon (HIGH — the lessons defuse, missed one document over); durable replay keys
seeded into the shared set would have let a hand-edited grants.json key unlock INSTALL replay;
and the reviewer-gate refusal for a missing plan document named two cures that both refuse in
that state — the S16.5 refusable-cure class, reintroduced and caught by the review.

**The live E2E (`agent-cli-s21-live/`, Kimi K3 + Tavily, fresh state root, piped driver — no
recording, per the session's scope): five legs, post-hoc validator 31/31 over persisted
evidence alone (`VALIDATION.txt`).** Its product yield beyond the S21 surfaces: the validator's
one initial FAIL exposed a PRE-EXISTING runtime honesty gap — `tool.completed.outputPreview`
recorded `output` alone, so a refusal carrying its message only in `error` (every delegate-gate
refusal) persisted as an EMPTY preview, and a resumed conversation lost why the call failed.
Fixed (error-led wire composition now persisted, resume-fidelity pinned) and proven by
re-running the leg against the fixed build. Leg 1: `/init` created both constitutions from a genuinely fresh machine
state (trust via the non-TTY `agent trust` consent path). Leg 2: the next session's banner
showed BOTH constitutions loading; a researcher spawn ask rendered `[a]` with the literal rule;
one keystroke minted the durable grant (verified in `grants.json` + `grants.log` + the
`scope: 'machine'` approval event); the researcher recorded source-backed findings and quit
wrote JOURNAL + RESEARCH.md. Leg 3: a `--no-input` one-shot CONSUMED the grant with nobody at
the keyboard (researcher spawned, zero user approvals, `grants.loaded` on the record), then
`agent grants revoke` removed it and the same shape auto-denied. Leg 4: a deliberately failing
check (its `[a]` minting durable replay), a live `recover escalate target:session`, `/accept`
refusing, `/repair dismiss`, and `/accept` COMPLETE with the caveat — the S20.5 deadlock,
closed on camera-less record. Leg 5: the check REPLAYED across sessions under the durable key
with no ask, and a plan approve → amend → reviewer-spawn attempt drew the Fix B refusal live.

### Decisions (and why)

- **Exact identity or no durable grant at all.** Claude Code documents its own Bash prefix-rule
  fragility; Codex's #22181 minted a machine-wide program-name allow from a vague prompt;
  Gemini closed "persist always-allow" as not-planned. The design answer: a durable grant is a
  body-bound replay sha or one (tool, class) pair from a closed set — no prefixes, no patterns,
  the literal rule printed before anything persists.
- **Class grants are machine-wide; replay grants are workspace-scoped.** The brief asks for
  decisions remembered across projects; trust remains the outer gate (grants apply only inside
  workspaces separately trusted), and the three eligible class rules are read-only-external
  with per-session budgets. Replay keys are project-relative by construction.
- **Lessons ride the narrative; research rides events.** No new tool, no mid-session memory
  writes, no second engine: the model's judgment enters through the one existing model call
  (optional, lenient), and the perishable surface is a pure fold that works even when that call
  fails.
- **Startup stays small by construction, not hope**: per-doc caps plus ONE pinned total ceiling;
  the global doc deliberately smaller than the project's; subagents excluded.
- **Ex-ante prevention over cap arithmetic** for the review-round trap: refusing the unbindable
  round keeps `MAX_REVIEW_ROUNDS` a repetition bound nobody loosened.

### Open issues / boundaries

- The `[a]`/durable-grant surfaces are live-proven for the research class grant and the check
  replay; the `remote_status` class grant is unit-tested only (no remote in the E2E workspace).
- `/init`'s TTY tip line and the real-TTY trust prompt are untestable through the piped driver
  (unit-tested); the piped `--interactive` driver IS the documented deliberate-opt-in path that
  makes `[a]` offerable there.
- Durable-grant revocation applies from the next assembly; a running session keeps its
  in-memory copy until it ends (documented on every surface).
- LESSONS.md quality depends on the model's judgment under the ≤3/session bound; the live E2E
  exercised the mechanism (skip evidence recorded honestly) — a long-horizon quality read needs
  real project mileage.
- The cross-process memory-doc lock stays deferred (last-writer-wins seconds window at
  simultaneous quits), as do SQLite/topic retrieval, trust.json write locking, `/init` rewrite
  flows, and install-replay durability (each recorded in the deferred pool).

### Recommended next step

v1.7.0 publishes on explicit user approval (push + tag + Release). Then Session 22 per
BLUEPRINT: terminal UX consolidation — the new states (repair ledger, grants, six memory docs)
put real pressure on the flat chrome, which is exactly the evidence that session needs.

---

## Earlier Milestones (compressed per the rolling-docs policy)

Contract detail lives in `ARCHITECTURE.md`; entries keep the objective, lasting decisions, the
evidence, and what stayed open.

### Session 20.5 (2026-08-09/10) — Full-system review, limits retune, and a zero-to-remote proof

A consolidation-and-proof session (v1.6.1; suite 2038 → 2078): a five-lens engineering review of
the whole system fixed 18 hand-verified defects — the largest class was accounting/honesty seams
that only bite hours into a real run (policy ordering, remote spend symmetry, six runtime-honesty
gaps, one unclearable case-folded gate, three long-run failure modes). The **limits retune**
replaced the flat 100k context budget with a per-model derivation rule (window fit + provider
billing clamps, verified 2026-08-09) and re-sized SCALE bounds for the v1.6 shape while touching
no repetition or consent bound — the reaffirmed S16 principle. Module boundaries became a TEST
(`test/architecture.test.ts`: no `../../`, shared/ leaf, frozen two-cycle set), which immediately
found and cut a fifth cycle. **The live proof: an EMPTY folder → a real GitHub release in one
Kimi K3 session** (1,006 events, three lives, 26 approvals; researcher findings all source-backed;
three parallel worktree executors; 46 typed check completions incl. two REAL failures found and
fixed live; the DOCX/PDF loop catching a visual defect; two review rounds; a first release attempt
DENIED by `remote.precondition` then re-observed and retried) — post-hoc validator **62/62**
(`agent-cli-s205-live/DEMO.md`). **The headline finding shaped S21**: the model's own
`escalate target:session` had no closure path, pinning a fully-green session at PARTIAL via
`/accept confirm`; and rounds run under an invalidated approval consumed the review cap they
could not satisfy. Still open from it: the executor approval-wait exclusion and LOUD max-steps
end are hermetically proven only; the context-budget rule is verified against provider docs, not
a live long-context bill; the advisory Linux CI green is validated by CI, not this machine.

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
stamps (stamp it in); per-task gates are unit-tested only,
since a plan of all-`main` tasks cannot declare them; executors cannot self-verify (parent-only
`run_check`, because a worktree lacks gitignored deps); more ecosystems as data-shaped recipe rows;
an incremental check cache keyed by file hashes + tool versions.

**Planning/orchestration:** a width-aware status-area clip before free-form text may land in status
lines; sibling-task chrome printing over a DISPLAYED forwarded-approval prompt (part of the io
redesign); plan-file pruning (folded into `agent gc` above); a `/cancel` surface for non-TTY
sessions; richer wave guidance.

**Memory/init/grants (new, S21):** install-replay and preview-replay durable grants (each
excluded from `[a]` deliberately — revisit with real usage pressure, not by default); a
reviewed `/init` rewrite path for existing AGENT.md files; a one-shot `agent init` Q&A;
workspace-scoping the class grants if machine-wide proves too broad in practice; `/review
dismiss` (the review-finding analog of `/repair dismiss` — design agreed since S14.5, still
pooled); LESSONS.md quality metrics once real project mileage accumulates.

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
