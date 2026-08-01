# ROADMAP

Rolling execution record: the latest session in full detail, older sessions compressed to
milestones that keep their objective, lasting decisions (with why), evidence, and still-open
limitations. Newest first. Contracts live in `ARCHITECTURE.md`.

---

## Session 16.5 (2026-08-01) — Proving S16: the review, the fixes, and how far the live run got

### Objective

Two goals. First, a bounded evidence-backed adversarial review of the Session 16 change set,
fixing what is real — with priority on anything that would stop a large full-stack job from
completing honestly. Second, the Live E2E that S16 deliberately did not claim: a genuinely
dependency-bearing two-project application, built from one natural-language request against the
live API, monitored, recorded.

The first goal is complete. The second is **partially complete and stopped by an external limit**;
this entry says exactly which parts are proven and which are not.

### The review — 5 lenses, 30 findings, 16 fixed

One bounded batch of five differentiated read-only lenses over `8a4ddf4..HEAD` (63 files,
+4717/−184), aimed at the shape of the outstanding run rather than at the diff in the abstract:
two projects, two dev servers, a browser flow over the integrated stack, and an install that must
happen before anything can be verified. No per-finding verifier fan-out (the CLAUDE.md cost rule);
every finding hand-verified against the code before any fix.

**Two were measured on this machine before a line changed**, and neither is reachable by any amount
of single-project testing:

- **Readiness could not reach an IPv6 server.** Node 22 resolves `localhost` verbatim; here that is
  `::1`. Measured: `listen(0,'localhost')` bound `::1`, `http://127.0.0.1:<p>/` was ECONNREFUSED,
  `http://[::1]:<p>/` answered 200. The harness probed IPv4 only, so a Vite front end could never
  become ready — it would wait out its full 60s and then stop a healthy server as "failed to
  start". Both loopback literals are probed now, and **the address that ANSWERED is recorded**,
  because that URL becomes the origin a browser flow is locked to.
- **A colourised banner would hide its own port.** picocolors enables colour whenever
  `platform === 'win32'`, regardless of TTY. `parsePortCandidates` needed digits immediately after
  `localhost:`, so a banner reading `http://localhost:<ESC>[1m5173<ESC>[22m/` matched nothing.
  **Honest correction, found later by the fixture:** Vite 6 itself does NOT colourise to a non-TTY
  here — measured three ways including `FORCE_COLOR=1`. The lens verified picocolors in isolation
  and inferred Vite's bytes from it. The ANSI strip is therefore **defensive and correct, but it
  was not a live blocker**; `probe-preview.mjs` asserts the measurement so the claim stays honest
  if Vite changes.

The other fixes that mattered, all verified against the code first:

- **A project-scoped `browser` gate was permanently unsatisfiable AND unwaivable.** `browser_flow`
  recorded no `projectId` while every S16 gate consumer folds a missing one to the root, and
  `run_check` cannot produce kind `browser` at all — a dead end at `/accept` with no exit but
  amending the plan or `/accept confirm`. **Live-confirmed unplanned:** take 1's model wrote
  exactly that plan (`project: web`, `checks: [typecheck, test, browser]`).
- **With TWO previews ready, an unbound flow was DENIED** with "start one with the preview tool
  first" — in precisely the shape S16 raised `MAX_CONCURRENT_PREVIEWS` to enable, and whose most
  plausible reading is to start a third. The fact now carries the ready set so the denial names
  them; and because an unbound flow still binds to whatever single preview is ready (which can
  legitimately be the API), the result now says what it drove.
- **"Dependencies are not installed" WAIVED a user-approved gate.** True before S16, when the
  harness could not install anything; `project_setup install` makes it a transient state with a
  named cure. A session that installed `api` and forgot `web` could be accepted as COMPLETE with
  its own caveat claiming a project shipping a build and a test suite *cannot* run them. New
  additive `precondition-curable` keeps the gate PENDING; old events keep the permissive reading.
- **The first check / preview / migrate after an install was always refused** with "the project
  changed after this call was approved" — for a call nobody approved and a project nobody changed.
  The three tools held independent detection snapshots. One `SharedWorkspace` now backs all three;
  the window the private copies protected does not exist (tool calls execute strictly one at a
  time), and the never-gated case gets its own honest message.
- **CHECKED had no project axis** — a green `build` in `web/` marked an `api/` file CHECKED in the
  report *and* `/diff`. Passing evidence now carries its scope (a check's unit, a command's cwd)
  and the correlation requires containment; `'.'` still covers everything.
- **A boundary gate discarded WHICH project was unsatisfied**, so `/accept` suggested a
  `run_check` a multi-project workspace refuses as ambiguous — a loop that cannot converge.
- **The user-facing plan view omitted `project` and `gates.projects`** — the document whose sha the
  approval binds could not distinguish "both halves" from "any one half".
- **`update_plan` never warned** about the unscoped-gate reading that produces a false green, and
  scolded a correct `./api` for naming a project that does not exist (raw string comparison),
  pushing the model toward dropping scoping altogether.
- **Repair proofs were project-filtered only for check/setup failures** — a `preview-startup`
  failure in `api` could be closed by a green flow against `web`.
- **An install's consent identity bound only lockfile + package.json + `.npmrc`.** `.pnpmfile.cjs`
  (a `readPackage` hook) and `.yarnrc.yml` (`yarnPath`) also rewrite what an install executes and
  are ordinary auto-allowed writes — the S14.5 body-binding lesson, two files over.

Plus: `run_command`'s `cwd` refused for protected directories (`.git` and the state dir are
protected as PLACES, not only as write targets); a preview dying DURING a browser step re-checked
for liveness so a dead server stops reading as a UI defect; `/checks` showing an interrupted setup
as NO VERDICT; and the system-prompt project block labelled AS OBSERVED AT SESSION START, because
it is a cached prefix that goes stale by design in a session whose purpose is to install things.

### The defect only a live run could find

Take 1 ran the whole arc and was discarded, and it was worth its cost.

On the first step of the build turn the agent amended its own approved plan. The amendment was
legitimate. But an amendment invalidates the approval by design, and an unapproved plan blocks
every executor spawn — so the two tasks the user had explicitly asked for "as two parallel isolated
tasks" silently became unspawnable. The agent did all of that work serially in the main session
instead, and the human found out ten minutes later when `/accept` refused for the fourth time.

The harness was not dishonest here. It said so in the `update_plan` result and again in the
standing plan note, every turn. It said so **to the model**, which cannot type `/plan approve`.
The gap is narrower and worse: **the one blocker only the USER can clear was the one thing never
said to the user.**

`planApprovalReminder` now prints one undimmed end-of-turn line naming the blocked tasks and the
command that clears them — and only when an approval EXISTED and no longer covers the plan. The
first version fired on every freshly written plan, which is the ordinary state; take 2 showed that
within minutes, and it was narrowed. `update_plan` now tells the model to stop and ask rather than
absorb the work, and says plainly that amending an approved plan to record PROGRESS buys nothing
(execution state is an event fold) and costs the approval mid-build.

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite **1322 → 1340** across 95 files.
`test/live-e2e-blockers.test.ts` pins all of it together — the ANSI strip against a real
colourised banner, an IPv6-only listener, the curable precondition in both the gate and the
resolver, the browser `projectId` unblocking a project-scoped gate, the two-preview denial naming
what runs, CHECKED refusing to cross a project boundary, per-scope gate detail, the unscoped-gate
warning, the install identity moving on a `.pnpmfile.cjs` write, `cwd` refusing protected
directories, the shared snapshot, and the re-approval reminder through the real readers.

**Fixture (`C:\Users\A\Desktop\agent-cli-s165-live\`) — "Depot":** two INDEPENDENT packages, no
root manifest, two lockfiles, shipping with no `node_modules`, no `.env` and no database.
`api/` Express + TypeScript + `node:sqlite` with migrate/seed; `web/` Vite + React. Three seeded
defects, each reachable by exactly one capability. `probe-fixture.mjs`: **10/10** — D1 fails the
api unit test and nothing else sees it; D2 is invisible to unit tests, real in a browser, and the
API genuinely applied the change; D3 renders and only a review lens reads it.

**`probe-preview.mjs`: 14/14 against the REAL dev servers** — both units discovered in
deterministic order, unit-qualified recipe ids, the API ready at `127.0.0.1:3001`, **the web app
ready at `[::1]:5173`** (an IPv4-only probe could never have reached it), the shipped parser
finding the announced port, Vite measured as NOT colourising here, and `stop()` reaping both
servers with no leftover listeners.

**`validation/smoke-chain.mjs`: 18/18** — the mechanical chain (ports free, the `agent` shim on the
fresh dist, prompt detection, trust, session-id capture, kill-by-CommandLine, resume).

### The live E2E — PARTIAL, and stopped by an external limit

**The Anthropic API credit balance was exhausted mid-take-2.** The identical 400 is recorded in
three logs — the parent session and both executor children:
`"Your credit balance is too low to access the Anthropic API."` Nothing in this repository caused
it and nothing in it can clear it.

**What the two takes DID prove live**, from persisted evidence:

- One natural-language request → investigation → a task graph naming each task's project, with
  `gates: {completion: [test, typecheck, build], projects: [api, web]}` — the per-project scoping
  S16 built and S16.5 made warn-able.
- `project_setup` installing **both** projects from their own lockfiles, then migrating and seeding
  a real SQLite database: four setup events, all `ok`, none ever readable as verification.
- Per-project typed checks: `test/api=fail` (the seeded D1, correctly failing), `typecheck/api`,
  `test/web`, `typecheck/web` all passing, and `test/api=pass` after the fix.
- `.env` written for both projects from their `.env.example`.
- **The parallel executor wave spawning**: two executors in isolated worktrees, changes captured,
  worktrees removed.
- `/accept` refusing, repeatedly and correctly, with an honest unfinished list.
- The take-1 fix working on camera in take 2: the harness asked for re-approval, the user gave it,
  the run continued.

**What is NOT proven and must not be claimed:** two dev servers running simultaneously *inside the
agent loop*; a browser flow over the integrated stack catching D2; a review lens catching D3;
`/accept` reaching COMPLETE; and therefore no recorded video. The preview half of that list is
separately live-proven **outside** the loop by `probe-preview.mjs`, which is not the same thing and
is not presented as if it were.

### Decisions (and why)

- **An uninstalled project is unverified, not unverifiable.** The waiver rule is about what a
  project CAN do, and S16 changed what the harness can do about it. A reason with a named cure is
  a different answer from a capability gap.
- **Probe both loopback families, record the one that answered.** The recorded URL is not
  cosmetic — it becomes a browser flow's origin lock, so it has to be an address that was proven
  to answer rather than the one we tried first.
- **A shared session snapshot beats three private ones.** The isolation the private copies bought
  was never real (calls are strictly serialized) and it cost a false refusal at the busiest moment
  of a run.
- **Tell the human the thing only the human can fix.** Every other harness message is aimed at the
  model because the model is the actor. A blocked approval is the exception, and the exception had
  been missed.
- **A warning that fires in the ordinary case is not a warning.** Narrowing the reminder mattered
  as much as adding it.
- **Say which half of the claim is proven.** `probe-preview.mjs` proves the preview substrate
  against real servers; it does not prove the agent loop drives it. Both sentences are in the docs.

### Open issues / boundaries

- **The live E2E is unfinished for want of API credit.** Resuming needs only credits: reset the
  fixture (`cd ws && git reset --hard && git clean -xdf`), `smoke-chain.mjs`, then `run-demo.cmd`
  via `schtasks`. The harness, fixture, driver, recorder, subtitle pipeline and validator are all
  built and rehearsed.
- **No demo video exists yet.** `validation/edit.mjs` + `narration.mjs` are written (segment table,
  raw→output time mapping, burned-in ASS subtitles, `narration.json` emitted for later audio
  alignment) but have never run against a real recording.
- **Recorded, deliberately not fixed:** in an npm-workspaces-root shape (root lockfile, child
  manifests) a per-unit install resolves an unpinned `npm install` inside the child, fragmenting
  hoisting while the prompt says "versions are NOT pinned" in a repo whose versions are pinned at
  the root. Real, outside this fixture's shape, and needs a design decision (a declared workspace
  member should install at its root). The macOS `caseFold` no-op is likewise recorded, on an
  unexercised platform.
- The two takes' evidence is kept at `agent-cli-s165-live/` (`take1-failed.log`,
  `take1-marks.json`, `demo-run.log`, `state/`) and summarized in `DEMO.md`.

### Recommended next step

Add API credit and finish the take — it is the only thing standing between v1.2.1 and the claim
S16 has been carrying since it shipped. Then Session 17 (documents/PDF pack) per BLUEPRINT.

---

## Session 16 (2026-07-31) — Real local software engineering: project units

### Objective

Per BLUEPRINT S16: make the coding workflow dependable for realistic local applications — several
projects in one workspace, lockfile-aware dependency installation, environment configuration,
migrations and seed data, multiple simultaneous services, and verification scoped to the project
it actually verified. Plus an audit of every task, tool-call, token, time, output, verification,
recovery and supervision limit, raising the ones that would stop legitimate work.

### The gap, stated from repository evidence

Every live proof through v1.1 (Pulse, QuickBoard, LedgerLite) was a single-package,
dependency-free fixture. `detectProject(root)` read only root-level manifests, so a repository
holding `web/` and `api/` with no root manifest detected `kinds: []`: every check kind
`unsupported`, no preview-capable script, `availableKinds()` empty so every declared gate warned
unrunnable. The workflow did not fail loudly on a realistic project — it went **inert**. Three
spawn sites hardcoded the workspace root as cwd (the event schema already carried `cwd`; only the
producers lied), `MAX_CONCURRENT_PREVIEWS = 2` made a frontend plus a backend impossible, and
there was no install path at all — `recovery/catalogue.ts` could only say "ask the user".

### What was implemented (commits `0b7aff1` … `6f2a55e`)

1. **`feat(checks,tools,policy)`** — project UNITS: bounded, never-throwing discovery (declared
   workspaces + a general depth-1 scan + conventional containers), deterministic ordering,
   unit-qualified recipe ids, per-unit cwd, `projectId` on check events, ambiguity refusing.
2. **`feat(preview,tools)`** — per-unit previews: a frontend and a backend at once.
3. **`feat(setup,policy,types)`** — `project_setup` (install / migrate / seed): lockfile-driven
   install resolution, two different consent answers, `setup.*` events.
4. **`feat(report,repl,recovery,runtime)`** — setup evidence everywhere, as WORK and never as
   verification.
5. **`feat(plan)`** — `PlanTask.project` and `gates.projects`, both sha-neutral when absent.
6. **`feat(tools,workspace,cli,report)`** — `run_command` cwd, ONE detection per session, project
   facts in the system prompt, and secret-named file contents withheld from the session diff.
7. **`chore(limits)`** — the audited bound increases, asserted as one visible contract.
8. **`fix(setup,checks,plan,recovery)`** — the adversarial-review findings (below).

### Decisions (and why)

- **Setup is not verification, structurally.** New event types rather than a widened `check.*`,
  because `collectPassingEvidence` marks a file CHECKED on a zero exit, plan gates count a passing
  kind as verification, and the repair ledger accepts one as proof. An install exiting 0 means
  dependencies were fetched. A paired test now asserts the asymmetry directly: same file, same
  zero exit, same ordering — CHECKED via `check.completed`, UNCHECKED via `setup.completed`.
- **An install's "body" is three files.** The lockfile decides versions, package.json's lifecycle
  scripts decide what runs, `.npmrc` decides the registry and the shell. Binding only the first was
  the session's critical review finding.
- **Ambiguity refuses; it never picks** — including when a root unit exists, because a container
  root resolves most kinds to `unsupported`, and that reason WAIVES a gate.
- **The root unit is never qualified.** Single-project workspaces keep byte-identical recipe ids,
  grants, evidence and tests; qualification appears only where the ambiguity it resolves exists.
- **Scale bounds were raised; repetition bounds were not.** A looser loop bound buys more looping,
  never more capability. `test/limits.test.ts` records both categories with the reasoning.

### The adversarial review — 4 lenses, 4 critical/high findings, all fixed

One bounded batch (detection determinism; consent and authority; evidence, resume and gates;
integration and test quality), every finding hand-verified before any fix. The four that mattered
were all a Session-16 change re-opening a hole an earlier session had closed, one axis over:

- **An install `[s]` was standing arbitrary-shell consent.** Approve `npm ci` once; add a
  `preinstall` to package.json through an ordinary auto-allowed write (dependencies untouched, so
  the lockfile is unchanged); call install again — key matches, no prompt, arbitrary shell.
- **A monorepo root silently WAIVED declared gates**, so a full-stack session could be accepted as
  COMPLETE with zero tests run, its evidence claiming the project cannot be tested.
- **A repair could be "proven" by a green check in another project** — the S14.5 unrelated-green-
  check hole on the project axis, missed by the `scopePaths` guard because `build` is not
  scope-bearing.
- **A plan could be stranded with no exit**: a task scoped to a nonexistent project can never pass
  AND can never be waived.

Also fixed: a dead `(project_setup, external)` grant that was still being STORED (the prompt hid
`[s]`, the storage site had not been told); the resolver's "NO LOCKFILE — versions are NOT pinned"
sentence computed and never shown; discovery non-determinism (200 raw dirents capped over an
unsorted readdir); a stale `package-lock.json` composing `npm ci` for a pnpm project; a column-0
comment truncating a pnpm `packages:` block while suppressing its own note; duplicate units on
case-insensitive filesystems; a symlinked workspace entry resolving outside the workspace.

The review also named the session's least-tested claims, and all three are now pinned:
`project_setup` was attached in exactly one line of `assemble.ts` and deleting it left every test
green; the shared-detection wiring was unobservable; the supervision stall fix had no test at all.

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite **1164 → 1322 passed / 11 skipped
across 94 files** (+158). New pins cover unit discovery and its refusals, per-unit consent
disjointness (an `[s]` for `api` does not cover `web`, including two units with byte-identical
lockfiles), the install identity revoking on a package.json rewrite, the whole install resolution
table including both yarn dialects and the refusal to guess, plan-sha stability asserted against
the literal pre-S16 canonical form, `gates.projects` EACH-of semantics, the setup/verification
asymmetry, the assembly seam, and the limits table as a contract.

**Live proof — PARTIAL, and stated as such.** A real two-package fixture ("Roster":
`api/` Express + TypeScript + `node:sqlite` with migrate/seed scripts, `web/` Vite + React, three
seeded defects) was generated at `C:\Users\A\Desktop\agent-cli-s16-live\`, installed for real
(`npm install`, 136 packages in api), and its seeded unit-test defect confirmed failing. The BUILT
harness was then driven against it: **21/21 assertions** — two units discovered in deterministic
order, the root correctly not a unit, an unnamed call refusing, per-unit runnable kinds, unit-
qualified recipe ids with per-unit cwd, the same `npm run test` string in both projects yielding
DIFFERENT replay-consent identities, lockfile-driven `npm ci`, migrate/seed resolving each
project's own script, migrate never replayable, and a package.json rewrite revoking an install's
`[s]` — the critical review finding, verified against a real project.

**What was NOT proven live, and must not be claimed:** the full agent loop against a live model on
this fixture (no scripted piped-REPL session was run), a real `npm ci` executed *through*
`project_setup` with a real approval, two dev servers running simultaneously under harness
management, a browser flow catching the integrated date defect, and a review lens catching the
seeded XSS. The resolution layer is live-proven; the end-to-end workflow on a dependency-bearing
project is not yet.

### Open issues / boundaries (deliberate, documented)

- **yarn is implemented from documentation and unit-tested only** — yarn is not installed on this
  machine. npm is live-exercised; pnpm 11.1.3 is present but its install path was not run.
- **External database servers, Docker and container orchestration remain out of scope.** S16
  supports file-backed local databases and project-declared migrate/seed scripts.
- **Executors still cannot verify their own work** (worktrees materialise without `node_modules`);
  parent-only verification after apply remains the contract.
- A graph gate without `gates.projects` is satisfied by ANY project — the agent plan view says so
  verbatim; the user-facing plan view does not yet (review finding #3, not fixed).
- The report's CHECKED correlation is temporal and has no project axis, so in a multi-project
  session a file can be marked CHECKED by another project's passing check. In-contract as written,
  but the contract is weaker than it reads.
- `/preview` in the REPL does not label previews with their project (the tool's own `status` does).

### Recommended next step

Run the full live E2E on the Roster fixture before advertising the workflow: a scripted piped-REPL
session through install → `.env` → migrate → seed → executor wave → per-project checks → two
simultaneous previews → browser flow → review round → `/accept`, plus a resume-after-kill life for
the interrupted-setup replay. Then Session 17 (documents/PDF pack) per BLUEPRINT.

---

## Earlier Milestones (compressed per the rolling-docs policy)

Contract detail lives in `ARCHITECTURE.md`; entries keep the objective, lasting decisions, the
evidence, and what stayed open.

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

**Provider/model (new, S15):** surface `Usage.reasoningTokens` in the report and `/status` (it is
recorded on `assistant.message` but no reader folds it yet); a live reasoning
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
