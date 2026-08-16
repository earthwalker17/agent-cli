# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Development history before 1.0.0 is recorded session-by-session in
[`ROADMAP.md`](ROADMAP.md), with implemented contracts in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## [1.10.1] — 2026-08-16

**Production release hardening** (Session 22.5). No new capability: a repo-wide audit (six
differentiated lenses, ~21 findings, every actionable one hand-verified against source) followed
by fixes for every substantiated defect, a packaging pass, and a documentation reconciliation.
Behavior changes are all corrections of unsound behavior. The result was then proven by the
final full-system live E2E: an empty folder to a public GitHub release (research → arrow-key
plan approval → parallel build surviving a real mid-build kill via `agent resume` → typed
checks/previews/browser flows → DOCX/PDF inspected by the model → review → commit → acceptance
→ push/tag/Release, each mutation individually approved), validated **37/37 from persisted
evidence plus the live remote** — see `ROADMAP.md` Session 22.5.

### Fixed

- **Approval answers are exact tokens, gated on what the prompt offered.** The scope keys parse
  only as `s`/`session` and `a`/`always`, and only when that scope was actually offered;
  `allow` means once; `stop`, `skip`, `sure` and `abort` now DENY. Before this, `stop` typed at
  a remote-write prompt parsed as a session grant — and since the engine executes on any allow,
  it executed the push.
- **Read-only git subcommand names get read-only ARGUMENT proofs.** `git tag v1` created a ref
  via auto-run, `git remote update` reached the network (which the sandbox does not confine),
  and `git remote add origin ./x` rewrote `.git/config` — all under subcommand names the
  allowlist treated as reads. Per-subcommand rules now admit only the list/read forms
  (16 adversarial + 9 safe corpus rows added).
- **A live executor's worktree is never swept on age.** The 8h "age hatch" could force-remove a
  LIVE executor's worktree: approval wait is excluded from the executor clock, so a legitimate
  task's age is unbounded, and nothing file-based distinguishes a live owner from a crashed one
  with a recycled pid. A live pid now always skips; dead pids still sweep immediately.
- **Crash replay consults recorded completion evidence.** Resume now indexes
  `command.ended`/`check.completed`/`setup.completed`/`remote.mutated` and replays recorded
  verdicts instead of "effects unknown — re-run": a VERIFIED remote push used to replay as a
  generic crash inviting a second push. Resume also survives an unreadable spill file (EBUSY no
  longer degrades crash recovery to a raw fs error), and abort wording is cause-neutral (child
  aborts fire for wall-clock/budget reasons, not only the user).
- **A spent artifact byte budget no longer refuses a browser flow** — the flow runs and drops
  artifacts with the existing omission markers; the check-budget refusal now names its exits.
- **`[c]` at the completion prompt no longer mints an acceptance for a commit that did not
  complete** (a cancelled or declined commit recorded `session.accepted` anyway), and the
  completion header no longer claims "everything the plan declares is done" in plan-less
  sessions.
- The `/` menu names the candidates for an ambiguous prefix instead of calling it unknown;
  `/research` and `/remote` keep their section separators; the untracked-file checkpoint guards
  say that declining skips the whole checkpoint; one-shot runs that exit 2 on denials say so on
  stderr with the count and where the specifics live.

### Changed

- **Node floor enforced at startup**: below Node 22 the CLI prints one actionable line and exits
  non-zero (`engines` is advisory, and the old failure mode was a cryptic crash mid-session).
- **The npm tarball halves**: release builds emit no source maps (sources are not shipped and
  nothing passes `--enable-source-maps`) and the build cleans `dist/` first, so stale files
  cannot ride along. `package-lock.json` is restamped on every version bump and a test now pins
  lockfile version == package version (it had said 1.4.0 since six releases ago).
- The previously unpinned load-bearing bounds joined the visible limits table (plan graph size
  and task count, flow steps and step waits, artifact session budgets, capture/spill ceilings,
  config `maxSteps`, review finding/observation caps) — pins only, no value changed.
- `--help` names all six subcommands that honor `--session`; HELP teaches the bare-`/` menu and
  Tab completion; the command table's commit row shows `[--no-trailer]`.

## [1.10.0] — 2026-08-14

**Terminal UX consolidation** (Session 22). The interactive surface catches up with everything
the harness has learned to do: prompts become arrow-key menus, long output folds honestly with the
end kept on screen, `/` discovers the command surface, and the completion question fires at a
delivery-shaped boundary. Runtime truth is untouched — the UI stays a projection of the events —
and the piped/non-TTY contract is byte-stable — proven by a v1.9.0-vs-HEAD byte-diff of the same
scripted session — with ONE deliberate exception: the `task.changes` chrome glyph now follows the
ASCII table off-TTY (`±` becomes `+-`), aligning the one Unicode straggler with the documented
piped-ASCII doctrine. A pattern table pinned to `±` must update.

### Added

- **Arrow-key selection on every prompt, over the ONE readline.** A select widget (`select.ts`)
  drives consent prompts, approval prompts, and the new `/` menu: arrows move, Enter confirms the
  highlight, letters still work exactly as before (a typed answer goes through the same parser it
  always did — the widget owns no answer grammar). **The initial highlight is always the
  decline/deny row, so Enter never grants**; Ctrl+C/EOF keep their fail-closed meanings. Approval
  menus derive from the same label derivations as the frozen prompt text, cross-pinned so the two
  cannot drift — and for arrow users the old first-character hazards (`stop` reading as a session
  grant, `abort` as a durable one) simply vanish.
- **The fold tail and `/expand`.** Past the 8 KiB live-output cap, lines feed a bounded ring and
  the command's end prints an honest fold marker plus the last eight lines — the verdict of a long
  build is on screen the moment it exits, instead of never. `/expand [last | <n> | <call-id>]`
  reprints a folded output in full from the record (the spill blob when saved, the recorded
  head+tail otherwise, provenance named either way); **Ctrl+E** on an empty idle prompt is the
  chord for it.
- **`/` opens the command menu; Tab completes.** The slash surface is mirrored as data
  (`command-table.ts`), drift-pinned against the dispatch switch in both directions; the menu is
  windowed with honest "… N more" edges and typed names still work.
- **Semantic style roles and one glyph table.** Chrome names what a line IS —
  ok/fail/warn/muted/heading/agent/user/accent, one 16-color SGR pair each, severity never
  color-only — and the previously hardcoded Unicode markers (`▸ ⚑ · ±`) join the ASCII fallback
  table, so legacy consoles stay readable. `NO_COLOR` and `TERM=dumb` still disable paint
  entirely; piped output never carried color and still does not.
- **A display-width clip for the status region** (`width.ts`): CJK, emoji and combining marks
  measure in COLUMNS now — the prerequisite the old code-unit clip itself documented before
  free-form text (menu labels) could land in status lines.

### Changed

- **The plan-less completion prompt moves to the typed `/quit`.** With no plan, acceptance is
  "complete" after any mutating turn, so the question re-armed on every one (the recorded S21.6
  nag). Plan-carrying sessions keep the turn-boundary offer — an approved plan completing IS a
  delivery boundary; plan-less work is asked once, when the user says they are done. Never at
  EOF, never at a double-Ctrl+C.
- **The io liveness fix**: the pending resolver installs before the prompt bytes, so a zero-delay
  scripted answer can no longer vanish into type-ahead; the fatal path clears the status region
  before its last line.
- The prompt glyph carries the user role color and a blank line precedes the idle prompt (both
  TTY-only): where the human speaks is visually distinct from where the agent answered.

## [1.9.0] — 2026-08-13

**The git capability pack** (Session 21.6). Natural-language Git intent now reaches the safe
machinery that was already there. The pack is checkpoint-first by design: the model gets reads and
additive recovery state, while the commit stays the user's and becomes a *choice* at the delivery
boundary rather than a printed suggestion.

### Added

- **`git_status` — the local repository as structured state.** Views: `summary` (branch, HEAD,
  upstream, how dirty the tree is, read live), `changes` (every uncommitted path in the workspace
  subtree, which ones THIS session changed, per-path churn, and whether a commit would be blocked
  — built by `prepareCommit`, the same function that builds the human's `/commit` preview, so the
  model's answer and the user's screen cannot drift), `log`, and `checkpoints`. **It takes a view
  name and a bounded integer and nothing else** — no ref, path, author or format argument. That is
  the whole argument for running it without an approval on machines with no enforced sandbox,
  where the equivalent `run_command git log` asks today: the model names a VIEW, the harness names
  the command. It never returns file contents.
- **`git_checkpoint` — a recovery point before risky work,** taken without interrupting anyone.
  `{ label? }` and nothing else; the schema cannot express a restore, reset, commit or push. It
  writes a commit object plus one hidden ref under `refs/agent-cli/checkpoints/`, on no branch,
  with the index, HEAD, branches and tags untouched. Bounded at **12 per session**, reclaimed at
  clean session end, and it **refuses** to capture secret-named files `.gitignore` does not
  already exclude — `git add -A` excludes exactly what gitignore excludes and nothing else, and a
  git blob cannot be redacted.
- **Two new policy facts, `gitRead` and `gitCheckpoint`,** each with its own fail-closed engine
  branch. Two rather than one with a mode, on the Session 20 `remoteRead`/`remoteWrite` argument:
  the conflicting-contract rule then refuses a tool that could both read and write, so "the read
  tool writes nothing" is verified by finding no second fact. Both branches deny a conflicting
  contract, a non-empty mutation plan, a subagent lineage, and the tool's own stated blocker.
- **The commit is a key on the completion prompt.** When a session finishes with attributable
  uncommitted changes, the acceptance question offers *commit the N file(s) this session changed,
  then accept*. It runs the same `/commit` body, with its own preview and confirmation.

### Changed

- **`HarnessRefKind` gains `agent`.** A model checkpoint rides `harness.checkpoint` rather than
  getting an event type of its own, so it inherits three folds already written and pinned: the
  owed-prune reclaim at clean session end (which is what makes taking them freely safe), the
  pre-integration covered-change rule, and exclusion from `WORK_EVENT_TYPES`. `git.checkpoint`
  stays what it has always been — user-commanded consent provenance — and is not widened.
- **The GitOps consent contract is now four conditions, split by what the user can SEE.** The
  section headed "never a model tool" and its condition "GitClient is structurally unreachable
  from the model" were true until this release and are rewritten in the same change, with the
  compound invariant restated verbatim: the model cannot commit, and a push transmits committed
  refs only, so **the model cannot publish content a human did not commit**.
- **A word that means no is a decline.** The contextual-prompt parser resolves an answer by its
  first character, so `cancel` typed at the completion prompt would have selected the new commit
  key. A small exact-word negative list is checked first; it can only ever turn a key into a
  decline.
- `agent checkpoint prune` identifies delivery anchors by an anchored match on the whole
  harness-composed subject instead of a substring, so a checkpoint LABEL cannot forge one.

### Fixed

- **The session-end prune skipped agent refs.** The owed-refs fold returned them correctly while
  the prune loop iterated a hard-coded list of three kinds — so model checkpoints would have
  stayed pinned in the user's repository forever while the harness announced a prune that deleted
  nothing. The loop is driven by the kind union now.
- **The secret guard failed open on a truncated listing.** The exec substrate keeps the head and
  tail and drops the middle while git still exits 0, so a secret-named path in the elided middle
  was invisible to the scan. Truncation refuses, the rule the remote pack already applies to a
  partial `ls-remote`.
- **An unreadable working tree reported as a clean one.** `prepareCommit` answers a failed status
  probe with an empty entry list, which every renderer reads as "nothing is uncommitted".
  `CommitPreview` now carries `statusFailed` (also set on truncation, which blocks a commit built
  from an incomplete listing), and the `changes` view refuses instead of shipping the negative.
- Accepting and then committing made the acceptance stale the instant it completed, because
  `git.commit` is work-shaped; the boundary now commits first so the acceptance stays the final
  word. An interrupted `git_checkpoint` replays from its recorded evidence instead of reading as
  an orphan and spending a second allowance slot.

## [1.8.0] — 2026-08-12

**Command and interaction surface simplification** (Session 21.5). The session began with a
code-traced audit of every user-reachable surface — 24 slash cases, 4 sigils, 17 CLI subcommands,
23 flags, 13 prompt families and 4 incompatible answer grammars — and then acted on it.

### Added

- **Contextual consent.** The harness now ASKS when a decision is actually needed, instead of
  requiring a remembered lifecycle command: a plan awaiting its first approval, an approval
  invalidated by an amendment, an open repair escalation, and a session that would accept cleanly.
  One keystroke, at most one prompt per turn boundary, at most once per state. Answering records
  exactly the same evidence as typing the command — structurally, because both call one extracted
  body. **TTY-only**: on piped stdin a prompt would consume the next scripted line, so `--no-input`
  and expect-style drivers keep using the commands.
- **`@review [focus]` — a Review Agent.** A new read-only `inspector` role that inspects the
  CURRENT codebase for bugs, regression risks, architectural problems, fragile spots and debug
  leads, records typed observations through `report_observation`, and hands them to the main agent
  to act on. Its observations are **advisory**: they block no gate and consume no adversarial
  review round, enforced by construction rather than convention (a `reviewer` finding blocks
  `/accept` regardless of requirement and every round spends one of only two).
- **`/report [section]`** slices the one rendered evidence report into any of fifteen named
  sections, so the record is navigable without another parallel fold. `/report inspections` is
  where `@review` output lands.
- **`agent run "<task>"`** is now documented — the explicit one-shot form, and the escape hatch
  for a task that looks like a command.
- **`/grants revoke <id>`** works in-session. Authority could previously be minted by `[a]` and
  withdrawn only from another process.

### Changed

- **BREAKING: `@direct` was removed.** The system prompt already instructs the complexity routing
  it forced ("a SIMPLE request … is done DIRECTLY … no plan document, no delegation ceremony"), it
  never appeared in `/help`, and treating `@` as "invoke a specialist" rather than "flip a mode" is
  what makes the surface teachable. The `plan.route` event keeps its `direct` member so historical
  logs still replay.
- `/help` rewritten around what a user needs and when: conversation first, then the specialists,
  then see/undo, deliver, and the manual controls. `/accept` and `/plan approve` are demoted to the
  "drive it yourself" group — still fully supported, no longer the taught path.
- `agent trust` prints the grammar it accepts. It advertised `[o] proceed once`, rejected it as a
  decline, and accepted an unadvertised `y`; the options line is now derived from what the caller
  can actually honour, and only `t` is accepted.
- `--no-input` means it. The flag auto-denied every tool approval while `/commit`, `/checkpoint`,
  `/accept` and `/init` still stopped and asked a human.

### Fixed

- **A typo no longer starts a billed session.** `agent <anything-not-known>` fell through to a real
  one-shot run with the typo as the task — verified before the fix: `agent stauts` ran and charged.
  A single bare word that is an in-session command, or is a short edit distance from one, is now
  refused with a did-you-mean before any session, state directory or provider call exists.
- `/undo` validates its argument instead of coercing it. `/undo --all` — the spelling the README
  teaches for the CLI — silently reverted only the most recent tool call and reported success.
- `/commit -m` no longer swallows the flags after it. Typing exactly what the help printed,
  `/commit -m "fix" --all`, committed the subject `fix" --all` and dropped `--all`.
- `/checkpoint` refuses reserved verbs and flag-shaped arguments instead of turning them into
  labels; `/checkpoint prune` used to create a checkpoint subjected "prune".
- `@plan.md is stale` is prose again. The `\b` guard matched it, stripped the sigil, and sent
  `.md is stale` to the model with a full plan-mode routing note attached. Unknown `@word`s are now
  refused by name rather than vanishing into prose.
- `agent undo` is trust-gated. It was grouped with the read-only commands and is not read-only.
- `agent diff` honours `secretPatterns`, matching `/diff`; a config that cannot be parsed refuses
  the diff rather than degrading to no redaction.
- `/research` says when research was unavailable instead of rendering an empty record.
- `/plan show` no longer rewrites the plan view — a READ command was regenerating the file the help
  text said you could edit, archiving hand edits to an opaque blob without a word.

### Documentation

- README, ARCHITECTURE and the in-app help brought back into exact agreement with the code,
  including the previously undocumented `/exit`, the provider name aliases, `--session`'s six
  commands, `--yes`'s four, exit code `130`, the non-one-shot exit-2 cases, and the deliberate
  trust exception for `agent map` / `agent diff`.

## [1.7.0] — 2026-08-11

**Bounded memory and global initialization** (Session 21), plus the two runtime defects the
S20.5 live E2E carried forward — both closed from the runtime's own semantics rather than
patched around.

### Fixed

- **A session-targeted repair escalation finally has a closure path.** The live-demonstrated
  deadlock (an escalation of a non-auto-eligible class could only clear via a proven repair
  attempt the policy refuses to record, pinning a fully-green session at PARTIAL acceptance) is
  closed by the user-side dismissal: `/repair` renders the bounded-repair ledger, and
  `/repair dismiss <n> <reason>` records `repair.dismissed` — joined on the escalation event's
  own seq, `source: 'user'` required by the fold (the recover tool has no dismiss action), the
  blocker closed while an acceptance CAVEAT always remains. Dismissed is not resolved, and every
  surface says so. Plan task id `session` is now refused as reserved.
- **A review round can no longer be spent where it could never bind.** While a once-approved
  plan's approval is invalidated (an amendment, a diverged hand-edit), a reviewer group refuses
  ex ante naming `/plan approve` as the cure — previously the round ran UNBOUND, still consumed
  one of the two `MAX_REVIEW_ROUNDS`, and the spent cap then blocked the bound round the plan's
  review task needed (the S20.5 live dead end, exited only by a waiver amendment). The cap
  itself is untouched; unbound rounds in plan-less/never-approved/discarded sessions stay legal
  and still count — that decision is now written on the constant.
- An oversize `CODEBASE.md` now injects with the shared truncation marker (it was the one
  memory doc silently head-cut), and every memory cap is pinned in the limits suite.
- **`tool.completed` now records the ERROR text the model saw** (found by this session's live
  E2E validator against a real refusal): a failing result whose message lived only in `error`
  with an empty `output` — every delegate-gate refusal — persisted an EMPTY preview, so the log
  could not say why the call failed and a resumed conversation replayed a placeholder where the
  live model had read the reason.

### Added

- **`LESSONS.md`** — durable project lessons (pitfalls, failure patterns, debugging knowledge).
  The model may propose up to 3 in the existing end-of-session narrative (no tool, no
  mid-session writes; an optional schema key, so a missed key never costs the journal); the
  harness merges by slug (reuse = update), stamps per-entry provenance, preserves user edits
  byte-verbatim, and rolls under 30 entries / 16 KiB.
- **`RESEARCH.md`** — the durable research surface S19 deferred. A deterministic fold over the
  session's recorded findings (claim, sources, corroboration, harness-stamped retrieval date) —
  perishable by design: entries age out after 30 days with an honest count, because a stale
  research note is the exact overconfidence web research exists to prevent. Findings previously
  vanished from cross-session memory at quit; the journal evidence section gains the missing
  research line.
- **The global `AGENT.md`** — one user constitution for every workspace on this machine, at the
  state root, injected before the project `AGENT.md` (which overrides it on conflict). Created
  only by `/init`; hand-edited after; recorded in `memory.loaded` with `scope: 'user'`.
- **`/init`** — optional, skippable onboarding: four questions into the global `AGENT.md`, plus
  a starter project `AGENT.md` offer when none exists. Never rewrites an existing file; each
  file is written atomically or not at all (EOF during the global questions aborts with nothing
  written; after the global doc exists, an abort in the project phase keeps it and says so).
  `agent init` points at it (and can no longer start a paid one-shot session by accident).
- **Durable machine approvals** — an `[a]` "always allow on this machine" option on exactly
  four eligible surfaces: a typed check's exact resolved commands (body-sha-bound and
  workspace-scoped — any drift re-asks), bounded web searches, research-subagent spawns, and
  remote READS (machine-wide; per-session budgets still bound all three). Stored in
  `<state>/grants.json` (strict schema, corrupt = hard error, registry-locked writes) with an
  append-only `grants.log` audit; loaded VISIBLY at every assembly as a `grants.loaded` event;
  inspected via `/grants` in-session and revoked via `agent grants revoke <id>`. A publish, a migration,
  an executor spawn, a raw shell command, and every sensitive read remain ineligible — each
  with its reason written on the closed eligibility set. A failed persist downgrades the
  recorded scope honestly; `--dangerously-allow-all` can never create one.

### Changed

- The memory system is one documented inventory: six documents, every per-doc cap and the
  worst-case total injection (86,016 chars) pinned as deliberate contracts in the limits suite.
- `/status` gains a repairs line (open escalations were previously visible only through a
  refused `/accept`).

## [1.6.1] — 2026-08-10

**Consolidation.** No new capability — a full-system review, a limits retune sized for what a v1.6
session actually does, and three module-boundary cleanups. A five-lens engineering review of the
whole system found and fixed 18 defects (each hand-verified, each with a regression test); the
largest class was accounting and honesty seams that only bite hours into a real session.

**The zero-to-remote live E2E this release's claims rest on is COMPLETE** (2026-08-10, Kimi K3, a
first attempt having stalled on provider balance): an empty folder → source-backed research → a
sha-approved task graph → three parallel worktree executors → typed checks across Node, TypeScript
and Go with two real failures found and fixed live → managed previews and five passing browser
flows → a DOCX/PDF overview the model visually corrected → two adversarial review rounds → one
user-typed commit → verified push, tag `v0.1.0` and GitHub Release on a repository that started
verified-empty. Post-hoc validator **62/62** over the persisted logs plus the live remote.
**Honest caveat the proof surfaced:** the session's acceptance is PARTIAL by the documented
`/accept confirm` override — a session-targeted escalation has no closure path in this version
(the known deferred-pool gap, now live-demonstrated and scheduled for S21) — with every check
green and the escalation named in the handoff. Full record: `ROADMAP.md` Session 20.5 and the
evidence directory's `DEMO.md`.

### Fixed

- **Policy:** a pre-resolution remote refusal (budget spent, gh missing, no repository) kept its
  own rule id instead of the misleading "name the host it contacts"; a throwing `command()` /
  `readsPaths()` fact now denies instead of crashing the turn — the last two bare fact calls.
- **Remote:** a failed `gh release create` now charges the write allowance (record and charge
  were inseparable everywhere but here, so live and resume-rebuilt spends disagreed); the
  observation `ls-remote` is scoped to heads+tags with a real capture bound, so a repository with
  many pull-request refs can no longer starve a tag out of the listing and misreport it absent.
- **Runtime honesty:** a deny-&-stop on a turn's final step reads as user-quit, not max-steps (a
  child's no longer spends an R10 attempt); the crash-repair replay tells the truth about a call
  that changed disk before it was interrupted; elision monotonicity survives resume and the
  end-of-session narrative; the context-exhausted warning fires in the steady state instead of
  going silent exactly when a hard context-window failure is coming.
- **Gate folds:** a plan scoped `project: 'API'` now matches checks recorded under the on-disk
  `api` (it was permanently unsatisfiable AND unwaivable); the failing-artifact caveat's
  retirement actually fires; three quiet budget refunds across resume (a never-started delegated
  attempt, an all-formats-failed render, a failed release) are closed.
- **Long-run:** a wedged `taskkill` can no longer hang the exec outcome forever (the helper wait
  is bounded); a preview reaped mid-flow is no longer misdiagnosed as an app crash; the
  spawn-to-register crash scan can no longer be blinded by accumulated logs.

### Changed

- **Context budgets** move from a flat 100k tokens to a per-model derivation rule (window fit +
  provider billing clamps, verified against each provider's docs and pinned by test): a
  1M-window model no longer elides at ~10% of its real window, and the 200k/128k-window models
  that were quietly overflowing now fit. `CATALOG_VERIFIED` → 2026-08-09; `glm-5.2`'s row
  corrected to its real 200K base window.
- **Scale bounds retuned** for the v1.6 shape (research + documents + remote delivery in one
  session), while every repetition and consent bound is deliberately unchanged: max steps
  40→60, delegated-task pool 16→32, checks 80→160, preview TTL 60→120 min, research session
  pools raised, exec capture 1→4 MiB, and more — all pinned with their rationale in
  `test/limits.test.ts`. The executor wall clock now EXCLUDES time spent waiting on a human
  approval (an away human used to kill the executor mid-work). A one-shot run that hits the step
  budget ends loudly, with the resume command.
- **Reasoning tokens** surface in the report and `/status` when a provider reports them.
- **Module boundaries** are enforced by a test: three cycles cut (`plan↔memory`,
  `retrieval↔workspace`, `types↔exec`), `shared/` made a true leaf, and the frozen removal-only
  cycle set pinned. The Windows-shaped test fixtures were ported so the advisory Linux CI job can
  assert real behavior.

## [1.6.0] — 2026-08-08

**Deliberate remote delivery to GitHub.** The harness could take a project from a natural-language
request to a verified, accepted, committed result — and then it stopped at the machine boundary. It
can now carry that result to an explicitly identified GitHub destination: understand what the
remote actually holds, publish a named branch or tag, cut a release against a tag that is already
there, and watch the CI run it triggered. What makes it a *delivery* capability rather than a
`git push` wrapper is that reading a remote and changing one are two different authorities, and the
harness cannot be talked out of the difference.

### Added

- **`remote_status`** — the only way this harness looks at a remote: `auth` (which GitHub account
  would act, and its scopes), `repository` (your permission, default branch, archived), `refs`
  (read ONE remote ref and produce the observation a publish must cite), `pulls`, `issues`, `runs`,
  `run`.
- **`remote_push`** — publish one named branch or tag to one named remote, with an optional
  `force` that is classified **destructive** and bound to the exact commit the remote held when it
  was observed.
- **`remote_release`** — a GitHub Release for a tag that is **already** on the remote.
- **`/remote`** — an accountability surface: the configured remotes, which account would act, live
  observations, every remote read, and every remote MUTATION with its verification verdict —
  including the ones that failed.
- A `## Remote delivery` report section, REPL chrome for reads and publishes, a conditional system
  prompt paragraph, and acceptance **caveats** naming what was published, what could not be
  verified, and what was attempted and failed.
- A `remoteBlockedHosts` narrowing knob in both config layers. As with research, there is
  deliberately no permit-list counterpart, and an entry refuses reads as well as mutations.

### Security and safety

- **Two policy facts, not one capability with a mode.** `remoteRead` and `remoteWrite` are separate
  members of `FACT_KINDS` with separate fail-closed branches, so the engine's existing
  conflicting-contract rule makes a tool that could both read and publish an automatic deny. A read
  asks `external` and is session-grantable within a real counter; a **write asks every single
  time**, is never passed through `applyGrant`, offers no `[s]`, and stores nothing on a session
  answer — the same rule written at all three consent surfaces, because a consent surface that
  disagrees with itself is how standing authority is won by accident.
- **A publish must be bound to a fresh observation** of that exact remote and ref. Absent, or older
  than the kernel-owned freshness bound, is a **deny** rather than an ask. The bound lives in the
  kernel so a workflow pack cannot widen its own leash.
- **What the human approved is what executes.** The refspec source is the observed OID rather than
  a branch name; execute re-reads the local rev and the remote ref, runs `git push --dry-run
  --porcelain` and compares its flag column against what the observed relation permits, and
  re-reads the remote afterwards to record `verified` separately from `ok`. A force push carries
  `--force-with-lease=<ref>:<observed-oid>`, so the server enforces the same binding.
- **Looking never writes.** The only network verb is `git ls-remote` — no fetch, no
  remote-tracking refs, no `FETCH_HEAD`. The honest cost: a commit the remote holds and this
  repository has never seen is genuinely unknowable, so the relation reports `unknown` and a force
  push over it is refused **even with `force`**.
- **The harness never holds a credential**, and `GH_TOKEN`/`GITHUB_TOKEN` are deliberately not
  forwarded to child processes (recorded as a fact, not worked around). All gh/git output passes a
  credential scrubber at the pack boundary and again at the event emit site — gh below 2.97.0 could
  print part of the token from `gh auth status` (GHSA-cg6r-mpgc-h9mm), and a session running a
  vulnerable gh is told so.
- **`GH_REPO` is scrubbed** from the child environment because it retargets every gh command the
  way `GIT_DIR` does; `GH_DEBUG`/`DEBUG` are scrubbed because gh's debug mode prints the
  Authorization header. `GH_HOST`/`GH_CONFIG_DIR` deliberately pass through and are **recorded** so
  an override is auditable.
- **No subagent reaches the remote** — both facts are inadmissible in a child registry, and the
  engine refuses either under any lineage as a second lock.
- **Local completion is never permission to publish**, and a green gate is never a precondition
  either: the local verification state is shown in the publish prompt and enforces nothing. With
  the model still unable to commit, the compound invariant is that it cannot publish content a
  human did not commit.
- A GUI credential prompt cannot be structurally prevented on Windows; `-c
  credential.interactive=false` plus a bounded timeout is the backstop, and that limit is
  documented rather than implied away.

### Fixed

- `scrubSecrets` ran its token pattern before its URL-userinfo pattern, so
  `https://x-access-token:<token>@host` lost the secret but kept the username half. Userinfo now
  runs first.
- `parsePushPorcelain` sliced the flag character off before splitting on tabs, leaving the leading
  tab in place; every line parsed as unrecognisable, which would have aborted every push at the
  dry-run comparison.

### Deliberately out of scope

No `gh api` passthrough or generic escape; no pull-request or issue creation, no merges, no
repository creation or deletion, no settings, secrets or workflow dispatch; no `git fetch`/`pull`
(being behind is reported, not fixed); no multi-repo, fork or upstream-sync flows; no upstream
tracking configuration as a side effect of a push.

## [1.5.0] — 2026-08-08

**Source-backed web research.** Until now the harness had no network capability at all: it could
write code against an API that had moved, from recall, and be sure of itself. It can now search the
public web as an explicit, budgeted, read-only capability — and, more usefully, send a dedicated
**researcher subagent** that reads pages in its own context and hands back short claims with their
sources, so the raw material never enters the main conversation.

### Added

- **`web_search`** — bounded search returning ranked source snippets with URLs. Available to the
  main agent for a single narrow lookup.
- **A `researcher` subagent role** (`delegate_task role: "researcher"`, or the `@research` sigil) —
  read-only in the workspace, external on the network, holding **no tool that writes, runs, or
  delegates**. It also gets `web_extract` (full page text) and `record_source`, neither of which
  the main agent ever holds.
- **`record_source`**, the researcher's only structured findings channel: one falsifiable claim,
  the URLs behind it, and a corroboration verdict. It **refuses** `corroborated` backed by a single
  distinct source, and stamps the retrieval date from the harness clock rather than the model.
- **`@search`** (one bounded lookup) and **`@research`** (delegate a researcher) input sigils, and
  **`/research`** — a privacy surface first: every query this session sent, the sources that
  answered, the recorded findings, and what is left of the budget.
- A `researchBlockedDomains` narrowing knob in both config layers. Note what is deliberately
  absent: no allowed-domains counterpart — a permit list is widening, and the schema structurally
  cannot express one.
- Provider: **Tavily** (`TAVILY_API_KEY`, env-only). No credential means the tools are not
  registered and the system prompt says nothing about them.

### Security and safety

- Network is a **seventh policy fact** with its own fail-closed branch, before the command branch
  and every fall-through. A research call is command-less and mutation-less, so without it the
  decision record would have read "read-only workspace access" for a call whose actual consequence
  is sending model-authored text off the machine.
- **The budget is the consent.** One session allowance (24 searches / 12 extracts / 80 provider
  credits / 800k retrieved characters), shared by the main agent and every researcher, rebuilt from
  events on resume so a restart cannot refill it. The approval prompt shows the query verbatim, the
  per-call bounds, and what remains; `[s]` is worded as bounded by that budget, not by the session.
- Retrieved content is neutralized at ingestion and rendered inside an explicit UNTRUSTED fence.
  Documented honestly as a **mitigation, not a boundary** — the real containment is that a
  researcher holds no tool that can act.
- URLs are identifiers: non-http(s) schemes, embedded credentials, loopback/private/link-local
  hosts, bare IP literals and over-long inputs are **refused**, not escaped. IDN hosts are flagged
  rather than refused.
- **Research is never verification.** It never marks a file CHECKED and never satisfies a plan gate.
  Acceptance carries a caveat naming that the web was consulted, and a second naming findings that
  rest on a single source or on sources that disagreed.
- The egress claim is scoped precisely: *the research tools'* egress is one host. Not the harness's
  — `npm view` is on the auto-run allowlist and the sandbox does not confine network.

### Fixed

- `childTools`' admissibility predicate was a hand-written deny-list, fail-open for every policy
  fact invented after it was written — which is why `artifact` was missing from it. It is now an
  exhaustive table that breaks the typecheck when a fact is added.
- The six `conflicting-contract` guards each hand-listed the other five; they now derive from one
  table.
- The provider tool-naming rule had gone four names stale since 1.2.0 and was enforcing nothing
  about `project_setup`, `read_document`, `render_document` or `inspect_pages`.

### Known limits

- `RESEARCH.md` (a durable curated research surface) is **not** in this release; ephemeral research
  is bounded session evidence. It is planned alongside the Session 21 memory work.
- A researcher subagent cannot see its own budget pressure — supervision notes reach the parent.
  The per-task bounds compensate.
- Live-proven on **Kimi K3** against the real Tavily API, one task. Other providers run the same
  bounded loop but this capability has not been live-smoked on each.

## [1.4.0] — 2026-08-07

**Polyglot repository intelligence and verification.** Before this release, an ecosystem the
harness did not recognize did not fail loudly — it went inert: a Rust repository resolved every
check to `unsupported/no-recipe` claiming *"no supported project manifest was detected (Node/TS
and Python are supported)"*, and because `no-recipe` waives declared gates, a session could reach
`/accept` COMPLETE having verified nothing. That run is on the record (the v1.3.0 BEFORE capture
in `agent-cli-s18-live/`, validated 17/17) and this release exists to end it.

Support means **language + build system + layout + available toolchain** — never file-extension
recognition. Everything below is data-table and bounded-extractor work on the existing kernel:
no new loop, no plugin system, no parser dependencies, schema still v1.

### Added

- **Rust/Cargo and Go modules, the complete path.** Unit discovery reads cargo
  `[workspace] members` and `go.work` `use` directives (bounded hand-extraction, the
  pnpm-workspace precedent); `Cargo.toml`/`go.mod`/`CMakeLists.txt` join the unit manifests and
  the TOCTOU stat-fingerprint. Recipe rows: `cargo build` / `cargo test` / `cargo check`
  (typecheck) / `cargo clippy -- -D warnings` (lint — clippy's plain exit ignores lint findings,
  so the strict CI form IS the recipe) / `cargo fmt --check`; `go build ./...` (build AND
  typecheck — Go's compiler is its typechecker, and an honest gate beats a waived one) /
  `go test ./...` / `go vet ./...`, plus a `test-targeted` mapping of path scopes onto
  `./pkg/...` package patterns, which only Go can honestly express. Holes are decisions with
  stated reasons: no rust test-targeted (cargo selects tests by NAME), no go format (`gofmt -l`
  exits 0 either way — the exit code is the verdict). Cargo compile rows declare
  `workspaceAuthored` (build.rs/proc-macros execute workspace code at build time).
- **Toolchain availability as a first-class fact** (`checks/toolchain.ts`): cargo/rustc/go
  probed on PATH and rustup components/targets on disk — stat-only, never spawning, and never
  through the `~/.cargo/bin` proxy shims that exist for every component name whether or not the
  component does. A missing toolchain resolves to an explicit **`toolchain-unavailable`** state
  naming the exact cure (*install via rustup*, `rustup target add <triple>`) BEFORE anything is
  put in front of the user; it waives a declared gate (the browser-unavailable precedent) but
  LOUDLY — the acceptance caveat reads "TOOLCHAIN IS NOT INSTALLED on this machine". Freshness
  rides the workspace drift seam as `~toolchain/` pseudo-stamps: installing a toolchain (or a
  rustup target) mid-session is noticed exactly like an edited manifest; absence is never cached.
- **Embedded honesty**: a crate whose `.cargo/config.toml` declares `[build] target = <triple>`
  splits at the host boundary — `cargo fmt` host-verifiable, compiles gated on the installed
  rustup target, and `cargo test` refusing PERMANENTLY with the reason (cross-compiled test
  binaries cannot execute on this host; the harness manages no hardware or emulators).
- **Compiler-aware evidence**: `rust-error` and `go-error` signals (appended — the emitted order
  stays pinned), `syntax-error` widened for Go's lowercase spelling, `assertion-failed` for
  Rust ≥1.73's backticked form, and rustc two-line / Go one-line finding extractors carrying
  file:line. Classification changed ONE line: both ids join the compile-type branch.
- **Polyglot retrieval**: Rust/Go/C-C++ join the symbol index (`pub`/case exported rules,
  struct/trait/mod/macro kinds, no index version bump — warm loads converge) and, decisively,
  the import GRAPH a polyglot repo entirely lacked: rust `use`/`mod` edges through the crate
  root, go directory-suffix matching onto one deterministic representative, C/C++ `#include`
  edges. `Cargo.toml`/`go.mod`/`CMakeLists.txt` rank as manifests, `lib`/`mod` as entry stems,
  `_test.go` as a test path.
- **Ecosystem-true surfaces**: the prompt's project block renders cargo/go facts (toolchain
  installed or NOT, the cross-target line) instead of npm vocabulary; `project_setup` answers
  cargo/go installs with "nothing to install — dependencies are fetched during the build itself"
  instead of implying a missing feature; C/C++ (CMake) projects are NAMED in refusals instead of
  "no supported project manifest".

### Changed

- The precondition WHY is row-owned (`UnmetPrecondition {reason, why}`): only a recipe row knows
  whether its blocker is an uninstalled project (curable, gate stays pending), a machine
  toolchain gap (waives loudly), or a host incapability (waives quietly). Node/Python answers
  are byte-identical to the old central rule, test-pinned, and the recipe-id table is pinned as
  a consent surface.

### Live proof (kimi-k3, `agent-cli-s18-live/`, all validated post hoc from persisted evidence)

- **BEFORE (v1.3.0): 17/17** — the defect this release fixes, on the record.
- **Proof A (this release, toolchains absent): 17/17** — 6 units named across four ecosystems,
  8 polyglot files symbol-indexed, six `toolchain-unavailable` states with exact cures, ZERO
  check spawns, loud waiver caveats at `/accept`.
- **Proof B (after `winget` Go 1.26.5 + rustup gnu-host 1.97.1): 27/27** — a seeded Go test
  failure found, fixed in the code (test untouched) and proven with a path-scoped targeted run;
  a seeded E0308 found via the `rust-error` signal's file:line finding and fixed; the embedded
  cross-build refusal cured by a mid-session `rustup target add` that the drift seam noticed
  (same kind, re-resolved, PASSED) while `cargo test` kept refusing with the reason; `/accept`
  COMPLETE on GREEN gates. 9.3 minutes, 170 events, 15 real spawns + exactly 2 honest refusals.

### Fixed (the session's own adversarial review — 4 lenses, 10 unique findings, all hand-verified, all fixed)

- An all-outside-unit `test-targeted` scope resolved to gate-WAIVING `no-recipe` instead of
  `bad-request` — a caller mistake could discharge a user-approved gate. Three lenses found it
  independently.
- **Cargo/go replay consent bound no content identity, although for these ecosystems the check
  IS the install**: one `[s]` on `cargo build` survived an auto-allowed `.cargo/config.toml`
  write redirecting the crates registry. The steering files (Cargo.toml, Cargo.lock,
  `.cargo/config*`, `rust-toolchain*`; go.mod + go.sum) now ride the consent body, so both the
  replay key and the execute-time drift refusal change when any of them does — the S16
  install-identity rule, applied to the ecosystems whose build fetches.
- A stale waiver survived a LATER recorded failure of the same kind: toolchain-unavailable
  recorded, the user installs the toolchain, the re-run FAILS — accepted as "COMPLETE, its
  TOOLCHAIN IS NOT INSTALLED", false twice. Both gate folds now apply a recency rule: a waiver
  older than a real fail/error of the same kind is refuted evidence and the gate stays pending.
- Non-rustup Rust installs (apt/scoop/standalone) read as missing clippy/rustfmt, falsely
  waiving lint/format gates: the PATH-shim distrust now applies only where rustup actually
  manages the install (a machine with no toolchains dir has no proxy shims either).
- Caveat rendering: mixed waiver reasons for one gate kind split (the toolchain sentence is
  never asserted about a project whose waiver was a genuine capability answer), and `'.'` in
  `gates.projects` renders as "the workspace root" instead of being silently filtered.
- Cargo member / go.work entries carrying control characters (or oversize go.work lines) are
  refused at ingestion and counted in a note — never echoed; eight dated nightlies can no
  longer evict the stable toolchain from the bounded component scan; a leaked PATHEXT on POSIX
  no longer loses the bare binary name; the rustlib walk is entry-capped; `go build ./...`
  declares `writesOutputs: true` (a single-main-package build writes the exe into the cwd).

### Honest limits

Live claims cover the rustup **gnu** host and go.dev Go on one Windows 11 machine — MSVC-hosted
Rust, cgo, cargo features/build tags and `rust-toolchain` version selection are recorded facts
the harness never manipulates. Component/target probing unions across installed rustup
toolchains (a stated approximation). C/C++ is detection+indexing only. Symbol extraction stays
column-0 regex by design: Rust `impl` methods and C++ templates are invisible to the map, never
to live reads. No preview recipes for `cargo run`/`go run` servers yet.

## [1.3.0] — 2026-08-05

**The first non-coding workflow pack: documents and PDF.** The question this release exists to
answer is whether the contracts that made the coding workflow trustworthy — one policy choke
point, typed evidence, snapshot-backed undo, honest degradation, an explicit completion boundary
— generalize beyond source code without a second agent loop, a plugin system, or a parallel
framework. They do: the pack is three per-session tools, ONE new policy fact, TWO additive event
types, and a module of pure format logic outside the kernel.

The loop is spec-centred: **request → read sources → author a `*.docspec.json` → render →
deterministic validation → SEE the pages → revise THE SPEC → re-render → deliver.** Because the
spec is an ordinary workspace file, revision inherits snapshots, `/undo`, the session diff and
attribution for free.

### Added

- **`read_document`** — DOCX / PPTX / PDF structure, text and metadata (XLSX: names only),
  identified by MAGIC BYTES rather than the extension, always with an explicit coverage verdict
  (`full` / `partial` / `structural`) and its reasons. A file that is not what it claims is
  refused without echoing a byte of it. PPTX slide ORDER comes from the declared `sldIdLst`
  resolved through the relationship map, not from file numbering.
- **`render_document`** — a document spec into a **byte-deterministic DOCX** (hand-rolled OOXML:
  real named styles with outline levels, one numbering instance per list, PAGE/NUMPAGES/DATE
  field codes, embedded PNG/JPEG, fixed timestamps, no rsids — same spec in, same sha out) and a
  **PDF printed through the system browser** from one self-contained page, then **parses each
  artifact back** and reports the verdict: outline equality, table shapes, dangling
  relationships, header/footer fields, page count, headings findable in the printed text.
  Structural mismatches fail; layout observations are notes that never block.
- **`inspect_pages`** — PDF pages rasterized so a vision model judges the real thing (breaks,
  clipping, cramped tables, balance), each page stored as content-addressed session evidence.
  `view_image` was widened in lockstep so those pages can be re-viewed after they age out.
- **The `artifact` policy fact** (engine branch 0f) with its own rule ids: `render` auto-allows
  in-workspace with a snapshot while its recorded reason names the headless browser launch and
  states where spec-referenced reads are enforced; `inspect` splits admission by provenance —
  an artifact this session rendered inherits that consent (content identity re-verified at
  execute), anything else asks as grantable `sensitive`, secret-named paths are denied outright
  because pixels cannot be redacted the way text can.
- **`artifact.rendered` / `artifact.inspected`** events (additive, schema still v1) surfaced in
  the report, `/status` and the REPL — and structurally unable to satisfy a verification gate,
  pinned by the same asymmetry test the dependency-install path has.
- Three pure-JS runtime dependencies with no install scripts and no native code loaded by Agent
  CLI: `fflate`, `@rgrove/parse-xml`, `unpdf`.

### Fixed (the pack's own adversarial review, all hand-verified before fixing)

- Zip caps gated the uncompressed-size field while a STORED entry is materialized by its
  COMPRESSED size — a forged central directory pulled 300 KB past a 1 KB cap before the
  after-inflate check fired. Both caps now gate the larger of the two, before any inflation.
- A 546-byte part nesting 5000 elements parsed fine and then overflowed the stack in the
  recursive walk: an UNTYPED error that killed the turn instead of refusing the file. XML parsing
  is depth-bounded (checked iteratively) and identification never throws.
- A font name could carry `</style><script>` into the printed page — HTML rawtext ends at the
  first `</style` regardless of CSS quoting. Font names are charset-constrained at the schema.
- `render_document` read its SPEC with no policy classification at all (the artifact branch
  returns before the engine's reads section), so pointing it at `.env` read the file and echoed a
  fragment through the JSON parser. The spec path is validated at execute exactly as image paths
  are, and JSON syntax errors report position only.
- A render+inspect pair could show the model pixels of arbitrary workspace images with no
  approval; inherited consent now requires a spec that embedded none.
- Validation compared artifacts against the READER's display bounds, manufacturing "does not
  match its spec" failures on correct renders — which the acceptance caveat then repeated as
  fact. Validation reads at validation scale, normalizes both sides the way the renderer does,
  and downgrades absence claims over a partial extraction to notes.
- A FAILED PDF print was reported as "SKIPPED" with `ok: true`; degradation and failure are now
  different answers. A locked output file is a typed failure instead of a throw escaping the tool.
- The acceptance caveat counted layout notes as failures (and under-counted past the emit cap),
  and never noticed an artifact that was deleted or undone.
- OOXML details: run properties in schema sequence, transitional alignment values, code-block
  tabs through the same conversion every other text path uses, and JPEG fill bytes no longer
  refusing a valid image.

### Fixed (found by the live runs, not the suite)

- The inspection approval prompt claimed "a workspace document the harness did NOT produce" about
  a PDF the harness had rendered minutes earlier; the real reason consent was not inherited is
  the embedded logo, and the prompt now says so.
- pdf.js font-substitution warnings went to stderr — the REPL's *chrome* stream — so library noise
  rendered as harness output. Both PDF paths run at `verbosity: 0`.
- `render_document`'s description now states the spec shape (block kinds, run fields, header/footer
  tokens, where image paths resolve). The live agent wrote *"page-number tokens weren't documented,
  so I probed the renderer"* and spent render calls rediscovering the schema.

### Live proof

Two Kimi K3 sessions in a fresh fixture workspace, both `/accept` COMPLETE. **Take 2 — 21 minutes,
312 events, 49 turns, 48 tool calls, post-hoc validated 28/28 from persisted evidence alone**: one
request → notes read → spec authored → both formats rendered and validated → pages SEEN → the
model judged its own output cramped at one page, built a throwaway probe spec to isolate the
page-break behaviour, applied the finding, re-rendered to two balanced pages → took a follow-up
revision turn (navy table accent + a "Next Steps" section) → re-rendered and re-inspected → cleaned
up its scratch files → accepted. Both admission paths of the new policy fact fired in that single
run: the logo-bearing report ASKED, the image-free probe auto-allowed. Take 1 (26/26) is archived
with its own honest note — its second turn was lost to a provider overload the harness recorded as
a typed failure and continued past. Evidence, artifacts and limitations:
`agent-cli-s17-live/DEMO.md`.

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

[1.10.1]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.10.1
[1.10.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.10.0
[1.9.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.9.0
[1.8.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.8.0
[1.7.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.7.0
[1.6.1]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.6.1
[1.6.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.6.0
[1.5.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.5.0
[1.4.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.4.0
[1.3.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.3.0
[1.2.1]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.2.1
[1.2.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.2.0
[1.1.1]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.1.1
[1.1.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.1.0
[1.0.0]: https://github.com/earthwalker17/agent-cli/releases/tag/v1.0.0
