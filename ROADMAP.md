# ROADMAP

Rolling execution record: the latest session in full detail, older sessions compressed to
milestones that keep their objective, lasting decisions (with why), evidence, and still-open
limitations. Newest first. Contracts live in `ARCHITECTURE.md`.

---

## Session 20 (2026-08-08) — Remote Git and GitHub delivery

### Objective

Carry a verified, accepted, committed local result across the machine boundary to an explicitly
identified GitHub destination — and do it without ever letting "the work is done" become "the work
may be published".

The failure this exists to prevent is not "the agent cannot push". It is **authority creep**: a
capability that reads a remote and one that changes a remote, arriving as one thing, so that
consent to look becomes consent to publish, and a green check becomes a licence.

### What shipped

**Two policy facts, not one capability with a mode.** `FACT_KINDS` gains `remoteRead` AND
`remoteWrite`, each with its own fail-closed branch before the command branch. The split is
structural rather than documentary: the engine's existing conflicting-contract rule now makes a
tool that could both read and publish an **automatic deny**, so "the read tool cannot publish" is
verified by grepping this object for a second fact and finding none. Consent follows the split —
a read asks `external` and is session-grantable within a real counter (`[s] allow further remote
READS this session (never a push, tag or release)`); a write asks every time, is never passed
through `applyGrant`, offers no `[s]`, and stores nothing at the grant-storage site. That last
sentence is written in three places on purpose: a consent surface that disagrees with itself is
how standing authority gets won by accident.

**Observation binding.** A mutation must carry the live look at the remote its effect was computed
from. Absent, or older than `REMOTE_OBSERVATION_MAX_AGE_MS`, is a **deny** — the
`browser.no-preview` precedent — and the bound is kernel-owned so a workflow pack cannot widen its
own leash. Only `remote_status view=refs` produces observations, so "understand the remote before
you change it" is enforced by the engine rather than requested in a prompt. Observations and the
gh identity are in memory only and do not survive a resume; the read/write SPEND is rebuilt from
events. Authority is not durable; spending is.

**Looking never writes.** The only network verb is `git ls-remote` — no fetch, no remote-tracking
refs, no `FETCH_HEAD` — so an agent being curious can never change the state of the user's
repository. The honest cost is stated rather than hidden: a commit the remote holds and this
repository has never seen is genuinely outside our object database, so the relation reports
`unknown` and a force push over it is refused **even with `force`**, because the harness cannot say
what would be discarded.

**What the human approved is what executes.** The refspec source is the observed OID, not a branch
name. Execute re-resolves the push URL from git's own config, re-reads the local rev and the remote
ref, runs `git push --dry-run --porcelain` and compares it **structurally** (exactly one ref line,
to the approved ref, from the approved oid, on a run git said it finished), pushes with
`--no-follow-tags`, and re-reads the remote to record `verified` as a field distinct from `ok`. A
force push carries `--force-with-lease=<ref>:<observed-oid>`, so the server enforces the same
binding; `--force-if-includes` is deliberately absent because it is a no-op without a lease and its
real check reads a reflog this pack never writes.

**Three tools, and a deliberately small catalogue.** `remote_status` (auth / repository / refs /
pulls / issues / runs / run), `remote_push` (branch or tag, optional destructive force),
`remote_release` (a Release for a tag that is ALREADY on the remote, always `--verify-tag` —
without it gh creates the tag from the default branch as a side effect, a publish nobody asked for
at a commit nobody named). No `gh api` passthrough, no generic escape: every argv is
harness-composed in `--flag=value` form, so model text lands only in value positions.

**The harness never holds a credential.** Authentication is gh's own store and git's credential
helper. `buildChildEnv` drops every `*token*` name, so a `GH_TOKEN` in the user's shell is not
forwarded and cannot be — recorded as a fact rather than worked around. `GH_REPO` is scrubbed (it
retargets every gh command the way `GIT_DIR` does) and `GH_DEBUG`/`DEBUG` with it (gh's debug mode
prints the Authorization header); `GH_HOST`/`GH_CONFIG_DIR` pass through because an enterprise
install needs them, are recorded so an override is auditable, and now refuse a gh read whose host
they contradict. `shared/secrets.ts` scrubs credential shapes from all gh/git output at the pack
boundary and again at the event emit site — the installed gh 2.96.0 predates the
GHSA-cg6r-mpgc-h9mm fix in which `gh auth status` printed part of the token.

**Surfaces.** `/remote` (an accountability record: remotes, identity, live observations, every
read, every mutation with its verification verdict — including failures), a `## Remote delivery`
report section, REPL chrome, a conditional system-prompt paragraph, and acceptance **caveats** in
both directions. `remote.*` is deliberately absent from `WORK_EVENT_TYPES` — accept → commit →
push is the ordinary order, so a publish must not stale the acceptance it delivers.

**The compound invariant.** The model cannot commit (`/commit` is still user-typed) and a push
transmits committed refs only. Together: *the model cannot publish content a human did not commit.*

### The live proof (`agent-cli-s20-live/`, Kimi K3, against the real `earthwalker17/agent-cli`)

Dogfooding, at the user's explicit choice. The fixture is a real clone; the branches are real; the
destination has real CI and a real credential whose scopes are what they are. The scripted human is
deliberately **not** "always yes": reads take the session grant once, and the **first publish is
DENIED**, because a run in which every prompt is answered `y` proves the automation and not the
boundary.

**225 events, 12 remote reads, 3 mutations — all verified against the remote, zero
credential-shaped strings anywhere in the log.** Eleven approvals resolved: two `allow/session`
(both remote READS), eight `allow/once`, and **one `deny/once`**. Published to the real repository
and verified there at the time: `refs/heads/s20-proof-b`, the annotated tag `refs/tags/s20-tag-b`,
and a draft Release for it. Every one of those was deleted by hand once v1.6.0 shipped, so none of
it is inspectable on the repository today — the transcript and the event log are the evidence; the
refs were only what the evidence was about.

The order that matters. `/remote` before any authority reports the local inventory and nothing
else — no identity, full allowance, no observations. The first read asks and offers `[s] allow
further remote READS this session (never a push, tag or release)`. The first **publish is denied**,
and `/remote` immediately afterwards still says *"Mutations (0) — nothing on any remote was changed
by this session"*: the refusal is not a message, it is the absence of a mutation in the durable
record. Re-asked, the same publish executes and is verified by re-reading the ref. Asked for a
release, the model reads the remote, finds the tag absent and reports the two-step shape before
being told — `--verify-tag` surfacing as behaviour — so the tag is published under its own
approval and the release under a third. Four publishes, four separate approvals, no `[s]` anywhere.

**The resume leg is the other half.** Resumed, the session reports `spent 10 read(s), 3
mutation(s)` and **`Live observations (0)`**; the read grant is gone too. Told to publish again
"right now", it is denied twice by policy, in order: `remote.unauthenticated` (no gh identity is
established — identity is in-memory only), then, after re-reading `auth`, `remote.precondition`
(the ref already holds that commit). Spending is durable so a restart cannot refill an allowance;
authority is not, so a restart cannot inherit one.

**What the live run found that 2000 hermetic tests could not** — two honesty defects, both fixed
with regression tests:

- **A new branch reported the whole branch.** Publishing ONE commit to a fresh branch announced
  *"207 commit(s)"* and a `.github/workflows/` change published months earlier, because a ref the
  remote lacks was previewed by walking the tip's own history. The observation now takes one full
  `ls-remote` and uses every other remote ref whose objects we hold as exclusion bases; the same
  push now reads *"CREATE … (1 commit(s) in the branch)"*, one file.
- **The workflow-scope warning was asserted as a certainty, and was wrong.** The first run said
  *"GitHub will REJECT this push"* over an https remote and GitHub accepted it: `git push` over
  https authenticates with the CREDENTIAL HELPER's token, not gh's, and they routinely carry
  different scopes — the harness can see one and not the other. It is now a stated risk that names
  which credential it means. In the second run the model reached the same conclusion from evidence
  (*"it must have been pushed under a differently-scoped credential or via the web UI"*), declined
  the workflow-touching push and asked how to proceed — so that path was previewed here and
  executed in the earlier run, which is where the overclaim was disproved.

A third, smaller one is visible in the run-b log and was fixed after it: `basesIncomplete` fired on
every repository with annotated tags, because `ls-remote` reports the tag OBJECT id and a
membership test over commits never finds it. A signal that always fires tells a reader nothing.

Full transcript, evidence and honest limits: `agent-cli-s20-live/DEMO.md`.

### Decisions (and why)

- **Two facts rather than one with a mode.** Read and write are different authorities, and the
  cheapest way to make that true rather than merely stated was to let the existing
  conflicting-contract rule enforce it. It cost nothing and it closes the whole class.
- **A write is never granted, and the class still tells the truth.** Publishing is `external`;
  overwriting remote history is `destructive` (non-grantable by construction, so the strongest
  case is protected twice). Reaching for `destructive` on an ordinary publish would have been the
  cheap way to make it non-grantable, and would have spent the word.
- **Local verification is SHOWN, never required.** Making a green gate a precondition would make a
  green gate an authorization — the exact inversion this capability exists to prevent. So the
  prompt states the gate state and enforces nothing.
- **`ls-remote`, never `fetch`.** Looking at a remote must not mutate the user's repository as a
  side effect of the agent being curious. The cost is a genuinely `unknown` relation, which is
  reported as unknown.
- **A publish is an acceptance caveat, never a blocker** — and so is a publish that failed, and a
  publish that succeeded unverifiably. Local completion and remote delivery are separate questions
  in both directions.

### Open issues / boundaries

- **A GUI credential prompt cannot be structurally prevented on Windows.** `-c
  credential.interactive=false` plus a bounded timeout is the backstop, and a non-conforming helper
  ignores both.
- **`--dangerously-allow-all` covers remote mutations.** The engine always returns `ask` and never
  consults a grant, but that flag replaces the human at the prompt; the publish is auto-allowed and
  recorded as `source: "dangerous-mode"`. Documented in SECURITY.md and printed by `/remote`.
- **The workflow-scope preview is a risk, not a verdict** — see the live findings above.
- **Out of scope by decision:** `gh api` passthrough, PR/issue creation, merges, repository
  creation or deletion, settings/secrets/workflow dispatch, `git fetch`/`pull` (being behind is
  reported, not fixed), multi-repo and fork/upstream-sync flows, and upstream-tracking
  configuration as a side effect of a push.
- The gh JSON parsers are tolerant by design; a gh that renames a field degrades to an empty value
  rather than crashing a publish flow, which means a silent shape change reads as missing data.
- Only `github.com` was exercised live. Enterprise hosts are handled by the same code paths and are
  **not** live-proven.

### Recommended next step

Session 21 per BLUEPRINT: bounded memory and initialization — size and token budgets, staleness
rules, provenance, `LESSONS.md`, and the `RESEARCH.md` deferred from S19 precisely because a
durable research surface needs the staleness and provenance semantics that session builds.

---

## Session 19 (2026-08-07/08) — Source-backed web research

### Objective

Give the harness its first deliberate connection to the external web, as a bounded read-only
capability: search deliberately, prefer primary sources, corroborate anything load-bearing, and
hand the main agent short **source-backed claims** rather than raw pages — with network authority
that is explicit, budgeted, and honest about what it is.

The failure this exists to prevent is not "the agent cannot search". It is **stale confidence**:
writing code against an API that moved, from recall, sure of itself.

### What shipped

**A seventh policy fact and its branch.** `Tool.research()` + engine branch 0g, before the command
branch and every fall-through. The S6 trap it closes is sharper than the previous six: a research
call is command-less and mutation-less, so it would auto-allow as `observe` with the recorded
reason *"read-only workspace access"*. For a call that ships model-authored text to a third party
that sentence is not imprecise — it is false in the only direction that matters. Reading is not the
consequence; **sending** is, and the network is the one boundary the OS sandbox explicitly does not
confine.

**The budget is the consent.** The first call asks (`external`, grantable) with the query verbatim,
the per-call bounds, and the remaining session allowance in the reason, so `[s]` means "the bounded
research capability is authorized this session" against a real shared counter. An exhausted budget
is a DENY the engine owns; a held grant does not rescue it, nor a blocked domain, nor an unusable
target, nor a mutating spawn.

**A `researcher` subagent role** (`read-only-external`, a third access class — the engine's ordering
is a total order over strictness, and a boolean flag would let a future role be both without anyone
deciding which ask wins). Spawned through the existing `delegate_task`: one runtime, one loop, no
new orchestration. It holds `web_search`, `web_extract`, `record_source` and the workspace read
tools, and **nothing that writes, runs, or delegates**.

**The parent gets `web_search` only.** Full page text and the findings channel are researcher-only,
which makes "the main agent never receives raw webpages" a property of the registry rather than a
hope about behaviour.

**`record_source` is where research stops being a pile of search results.** One falsifiable claim,
the URLs behind it, and a corroboration verdict — and it **refuses** `corroborated` backed by a
single distinct source, which is the exact way one page becomes consensus. `retrievedAt` is stamped
by the harness clock: research is perishable, and a date the model authors is a date it can be
wrong about.

**Untrusted content, three mechanisms.** Character neutralization at ingestion (`sanitizeBlock` —
like `sanitizeLine` but preserving newlines, because a page is a block), fence neutralization
shared with the memory docs, and the fence itself with the prompt contract. The third is documented
as a **mitigation, not a boundary**: a sufficiently persuasive page can still influence a model.
What it cannot do is act, because a researcher holds no tool that acts.

**Research is never verification.** Not in `WORK_EVENT_TYPES`, never marks a file CHECKED, never
satisfies a plan gate — the S16 setup / S17 artifact asymmetry, reused. But acceptance carries a
**caveat**: a session accepted as COMPLETE whose conclusions rest on external sources says so, and
a second caveat names findings resting on a single source or on sources that disagreed.

### Structural fixes made along the way

Three fail-open patterns were found and closed while working here, each the same shape — a
hand-maintained list that silently stops covering things:

- The six `conflicting-contract` guards each carried a hand-written list of the other five. A
  seventh fact is absent from all six until someone remembers. They now derive from one
  `FACT_KINDS` table with a `Record<FactKind, string>` label map, so the **eighth** fact breaks the
  typecheck.
- `childTools`' admissibility predicate was a deny-list of the facts that existed when it was
  written — which is why `artifact` was missing from it. Now `satisfies Record<FactKind, boolean>`.
- The provider naming rule read a tool list that had gone **four names stale** since S16. A rule
  that cannot see a tool enforces nothing about it, and nothing failed. Both it and the child
  registry checks now read `SESSION_TOOL_NAMES` / `CHILD_ONLY_TOOL_NAMES`, pinned three ways
  against a real assembly.

### Verification

Suite **1547 → 1828** (12 new files, 292 research tests; 119 files, 0 failures). `npm run typecheck` clean.

**Live E2E — two runs, one variable.** Same fixture, same provider (Kimi K3), differing only in
whether `TAVILY_API_KEY` was in the child env. The task: implement a client for the Tavily Search
API, whose current auth header is a known stale-prior trap. Full record: `agent-cli-s19-live/DEMO.md`.

- The **control** implemented from recall, typechecked PASS, and said: *"Moderately confident — not
  certain. No live verification… a quick check of `docs.tavily.com` would settle everything below.
  Auth mechanism drift: earlier versions passed the key in the JSON body as `api_key`."*
- The **proof** delegated a researcher, which ran 14 searches and 3 extracts in its own context and
  recorded **7 corroborated findings with real source URLs** — including the `api_key`-in-body
  legacy trap the control had flagged as its top risk, and an honest *"could NOT establish an
  authoritative date/changelog for the switch"*. The main agent implemented from those findings,
  typechecked PASS, and the produced code names both pitfalls it avoids.
- Budget accounting held across both logs: `/research` showed 15 searches = 1 parent + 14 child,
  and pointed at the child's log rather than pretending to have read it.

**Honest reading of that result:** the control's wire format was already *correct*. Research did not
rescue a wrong answer; it converted a plausible one into a supported one, added `exclude_domains`,
and named what remained unknown. That is a narrower claim than "research fixed it", and it is the
true one.

**Adversarial review — 4 lenses, 20 findings, 12 fixed**, every one verified by hand. Two lenses
independently found the same accounting bug, which is the shape of a real one. The three that
mattered most:

- A single **trailing dot** defeated every name-based internal-host refusal (`http://localhost./`
  passed). `URL` preserves it on non-IPv4 hosts, so `'localhost.'` beat the loopback check, all
  four private-suffix checks, and the single-label check at once. `shared/domain.ts` had always
  stripped it — the denylist and the validator disagreed about what an internal name is.
- **Parallel researchers each recorded the whole group's spend.** The delegate diffed the shared
  budget around each task, but the group fans out under one `Promise.all`, so every sibling
  snapshotted the same "before" (live 2, rebuilt 4). Spend now comes from a per-task counter, and
  the regression test asserts the live object EQUALS a fresh fold of the parent log.
- The **extract page URL** escaped ingestion sanitization on the no-match fallback — the one
  provider string that reached the untrusted fence and the durable log verbatim.

Plus: the client's timeouts had drifted from the pack constants so the prompt declared a bound it
did not enforce; a per-task cap was reported as the session budget being spent; *"the only host
contacted"* is false under a proxy; a partial extract rendered "N of N"; `/research` hid the privacy
record precisely when a user auditing a past run would need it; and excluding a denylisted domain
was denied with a reason asserting the model had tried to reach it.

**Three defects the live run found that no hermetic test did** — the spawn ask rendering with
generic wording, a duplicated budget line, and a researcher timing out at 420 s with 8 searches and
10 extracts spent and **zero findings recorded**. The last one is the interesting one: the
budget-pressure supervision note reaches the **parent**, not the child, so a researcher cannot pace
itself. Fixed with a per-task page cap, an extract timeout no longer exceeding the provider's own,
a larger wall clock, and a prompt that says a timeout takes unrecorded findings with it.

### Decisions

- **Consent comes from lineage, not a constructor flag.** The first design had the delegate hand
  the child an instance carrying `delegatedConsent: true` — a `() => true` constant, the tool
  telling policy it is authorized. The engine now reads `ctx.lineage.role`, which `startSession`
  stamps from the same value that lands on `session.started`. The rule says *"whose spawn this
  engine allowed"*, never *"the human approved"*: under `--dangerously-allow-all` no human approved
  anything, and a reason string must not claim otherwise.
- **The egress claim is scoped.** "The research tools' egress is one host" — never "the harness's
  egress". `npm view` sits on the auto-run allowlist and the sandbox does not confine network.
- **No `researcher` in `PlanTaskRole`.** `planner` is already absent; adding it would inherit the
  queued-forever acceptance dead-end that reviewers needed a dedicated clause to escape.
- **No credential ⇒ no tools registered**, and the prompt paragraph is conditional on the same flag
  (the `retrieveTool` precedent). A tool the model can see but never use costs a step and a retry
  loop every time it looks useful.

### Left open

- **`RESEARCH.md` was deferred** — it was the plan's declared cut line. Ephemeral research works as
  bounded session evidence, which is what BLUEPRINT S19 required; the durable curated surface
  belongs with Session 21's memory budgets, staleness rules and `LESSONS.md`.
- **A child cannot see its own budget pressure.** Supervision notes go to the parent. The bounds
  compensate; a real fix would surface pressure into the child's own context.
- **The live proof is one provider, one task, one API.** It shows the path works and the findings
  were sourced; it is not a measurement of research quality.
- `ResolvedCheckFact.effects.network` remains a declared-but-dead field, read by nothing.
- Tavily `/crawl`, `/map` and the async `/research` endpoint are unimplemented; there is no
  direct-fetch tool, deliberately.

### Recommended next step

Session 20 per BLUEPRINT: remote Git and GitHub delivery — the other half of the external
authority split, where read and **write** must stay visibly different things.

---

## Earlier Milestones (compressed per the rolling-docs policy)

Contract detail lives in `ARCHITECTURE.md`; entries keep the objective, lasting decisions, the
evidence, and what stayed open.

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
