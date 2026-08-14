# ROADMAP

Rolling execution record: the latest session in full detail, older sessions compressed to
milestones that keep their objective, lasting decisions (with why), evidence, and still-open
limitations. Newest first. Contracts live in `ARCHITECTURE.md`.

---

## Session 22 (2026-08-14) — Terminal UX consolidation (v1.10.0)

**Objective.** Make the interactive surface match what the harness became — arrow-key prompts,
honest folding of long output, command discovery, a delivery-shaped completion boundary — without
changing runtime truth (the UI stays a projection of the events) and without moving a byte of the
piped/non-TTY contract.

### The shape, and why it is this shape

**Incremental, no TUI framework, no alternate screen.** The code-traced exploration was decisive:
every seam was already injectable, `status.ts` was the only cursor-moving code, and colors had one
emitter with zero test pins. Three primitives were genuinely new, all confined to `repl/`:

- **`io.captureKeys`** — exclusive keypress routing behind the ONE readline, implemented by
  DETACHING readline's own keypress listener for a capture's lifetime (identified by a
  construction-time listener diff). Coexisting was the trap: arrow-up is history recall into
  `rl.line` and Enter emits `'line'` into type-ahead, so a stale buffered command could have
  answered a security prompt. Detached, the line path is structurally inert while a menu is up.
  The Node-internals dependence is deliberate and pinned: if a Node upgrade changes the listener
  shape, `captureKeys` returns null and every caller falls back to the line grammar (the
  reattach round-trip test breaks loudly in CI, not in a user's terminal).
- **The status-area overlay channel** — the select menu draws INSTEAD of the base lines;
  `setLines` during an overlay stores silently, so a forwarded-approval task update cannot
  clobber a menu; styled lines are painted BY THE AREA after sanitize and clip (the S16.5b
  lesson kept structural). `status.ts` remains the only cursor code, and its clip now counts
  DISPLAY COLUMNS (`width.ts`) — the prerequisite its own header had named before free-form
  menu labels could land there.
- **`select.ts`** — the widget over the two: capture BEFORE any output (a zero-delay driver
  cannot lose keys), clamped navigation, menu windowing with honest "… N more" edges (the
  overlay's erase math counts drawn lines, so a menu taller than the terminal must not exist),
  and NO answer grammar of its own.

### What shipped

- **Every prompt is a menu; Enter never grants.** The initial highlight is always the
  decline/deny row (the module's own documented "no affirmative default", now spatial), typed
  letters open a visible buffer submitted through the CALLER's parser — immediate first-letter
  action would have reintroduced the exact `cancel`-vs-`[c]` hazard NEGATIVE_WORDS closed —
  and eof/interrupt keep their fail-closed meanings, with Ctrl+C firing the interrupt handler
  BEFORE the widget resolves (the 'SIGINT' ordering, preserved). Consent prompts branch on the
  injected `askSelect`; approval menus derive from `approvalChoices`, which shares
  `sessionGrantLabel`/`durableGrantLabel` with the FROZEN `formatApprovalPrompt` strings and is
  cross-pinned by an eleven-request matrix so menu and text cannot drift. `parseAnswer` (now
  exported) stays the sole owner of approval-answer meaning. Free on the TTY: the `stop`→`[s]`
  and `abort`→`[a]` first-char hazards vanish for arrow users. Esc is handled but deliberately
  NOT advertised: Node's keypress decoder holds a bare ESC awaiting a sequence, so the chord is
  unreliable — and every meta-flagged key is dropped so an Esc-prefixed Enter can never confirm.
- **The fold tail and `/expand`.** Past the 8 KiB live cap, lines feed a bounded ring; command
  end prints `… N line(s) folded — tail below` plus the last eight lines (capped means folded,
  never vanished — the mid-batch remainder joins the ring too). `/expand [last | <n> |
  <call-id>]` reprints in full from the RECORD — the spill blob when saved, the recorded
  head+tail otherwise, provenance named either way — to stdout, the requested-artifact channel;
  renderer memory is never consulted, so it survives resume by construction. Ctrl+E claims
  exactly the state where readline's own binding is a no-op (empty line, idle PROMPT; a
  `pendingKind` guard keeps it out of questions, where '/expand' would parse as a deny).
- **`/` discovers the surface.** `command-table.ts` mirrors the dispatch switch as data,
  drift-pinned in BOTH directions (every row reaches a real branch; every case label has a row);
  readline gains the Tab completer (terminal-mode only — piped input untouched by construction);
  a bare `/` opens the menu, full-name keys, typed names and unique prefixes accepted.
- **Semantic style roles, one glyph table.** `seg(role, s)` with
  ok/fail/warn/muted/heading/agent/user/accent (16-color SGR, `accent` inverse video), one
  open/close pair with no compose API — the dim/bold shared-close-22 hazard closed by shape.
  The legacy names became role aliases (ninety-odd call sites did not churn); `NO_STYLE` is the
  default wherever a Style is optional, so every context built without one is byte-identical.
  The five hardcoded-Unicode marker sites (`▸ ⚑ · ±` in live-tasks, heartbeat, render,
  approvals' glyphs pending S6 wiring, cli) joined the ASCII fallback table. Severity is never
  color-only. FORCE_COLOR deliberately not added — piped purity outranks.
- **The completion boundary matches the session's shape** (the recorded S21.6 pressure). An
  approved plan completing IS a delivery boundary, so plan-carrying sessions keep the
  turn-boundary offer; plan-less work — where acceptance is "complete" after any mutating turn,
  so the old trigger re-armed on every one — is asked once, at the typed `/quit`. Never at EOF,
  never at double-Ctrl+C: walking away is not a consent moment. B/A/D stay turn-only; one
  anti-nag set spans both boundaries.
- **Two liveness/coherence fixes**: the io pending resolver installs BEFORE the prompt bytes (a
  PassThrough delivers 'data' synchronously, so a zero-delay driver's answer used to land in
  type-ahead where a `fresh` question never looks — the REPL waited forever; pinned by a
  same-tick-answer regression that hangs under the old order), and the fatal path clears the
  status region before its last line. Plus the composer boundary: a painted prompt glyph and one
  blank chrome line before the idle prompt, both TTY-gated.

### Verification

`npm run typecheck` clean at every stage. Suite **2307 → 2368** (new `repl.width`, `repl.format`,
`repl.select`, `repl.expand`, `repl.commands-table` files; overlay cases in `repl.status`;
driveTTY gains `sendRaw` and five new end-to-end TTY tests incl. arrow-approving a plan and an
approval with no letter ever typed). Ten stages, each committed suite-green (`7a0d66e`…`6312422`);
the S8–S10 combined gate observed **2355 pass · 2 fail**, both fails the documented contention
class — which this session's runs WIDENED on the record: it now demonstrably includes
`artifacts.pdf` and `artifacts.inspect` (browser-printing tests, 180s timeouts in files taking
500s+ under full parallelism), not only `browser.flow`; every failing file was re-run in
isolation and passed (10/10, 20/20) each time it appeared.

**The changed pins, listed** (the S22 analog of honest test churn): the pre-S22
"suppress-forever" cap test rewritten to the fold contract; the two S21.6 driveTTY completion
tests reordered to the quit boundary with a transcript-order assertion; the completion-mechanics
unit tests ask at the quit boundary; `/ex` completion became ambiguous when `/expand` landed
(the alias test now pins the ambiguity itself).

**Live E2E** (`agent-cli-s22-live/`, Kimi `kimi-k2.7-code`, injected-TTY driver, no recording;
the validated run is against the POST-review-fix build, re-run after the fourteen fixes landed):
**14/14 driver steps, 20/20 post-hoc checks from the persisted record** — an arrow-answered
approval whose transcript echo is the picked LABEL (`> allow once`, which a typed letter cannot
produce); the fold (`… 225 line(s) folded`) with the run's end on screen; Ctrl+E reprinting the
full spill blob; the `/` menu arrow-picking `/status`; and the plan-less completion prompt
firing ONLY after the typed `/quit`, arrows to `[c]`, commit `TODO.md` at seq 30, acceptance at
seq 32. **The piped control**: the same scripted mock session driven through the v1.9.0 baseline
build (a git worktree, `npm ci`-built) and HEAD — stdout AND stderr **byte-identical** after
normalizing only run-varying values, zero escape bytes on either HEAD stream. Two honest notes
recorded in `DEMO.md`: take 1 was discarded for a DRIVER cursor-order bug (the S21.6 per-stream
lesson, one step over), and the validator's own first run had one wrong assertion (counting menu
rows that legitimately redraw per keypress; the corrected check is positional).

**Adversarial review: one bounded workflow, four differentiated lenses over the session diff —
16 findings, every one hand-verified against the code; 14 fixed, one accepted-as-designed and
documented, one coverage gap closed.** (The workflow's first launch died entirely on a subagent
session limit and was relaunched after the reset — a failed review is not a clean review.) The
three that mattered:

1. **`captureKeys` split an in-flight typed line.** Mid-turn typing is unechoed; a select
   engaging mid-line froze the invisible prefix in readline and handed the SUFFIX to the menu,
   where a fragment like "sts for the parser" answers an approval by its first character — a
   session grant from an instruction fragment, the exact hazard class the `fresh` flag closes on
   the line path, reintroduced one layer down. `captureKeys` now DRAINS readline's buffer into
   the widget's visible typed buffer: the whole line stays one string the user can see, finish,
   clear or submit — which is also strictly better than the pre-S22 line path, where the same
   in-flight text was invisible until Enter.
2. **`/expand` replayed raw unsanitized command output** — recorded bytes straight to the
   terminal, so untrusted output could move the cursor, clear the screen or retitle the window,
   violating "untrusted text can never move the cursor". It now sanitizes per line, exactly as
   `/diff` always has; the true bytes stay in the record.
3. **The fold's final-partial promise was broken**: `flushCmdOutput(true)` consumed and dropped
   the buffered unterminated last line — often the verdict line the tail exists to show — before
   `flushFoldTail` could fold it. The suppressed path now leaves the buffer to the ring, pinned
   by a FINAL-VERDICT-without-newline regression.

Plus: the select header no longer prints the line-grammar "(Enter = not now)" clause above a
menu where Enter confirms the movable highlight (two contradictory instructions on one consent
surface); approved LEGACY plans keep their turn-boundary completion ask; the `/` menu falls back
honestly when capture is unavailable, clamps its window to the terminal's rows, requires ≥2
characters before prefix-resolving typed input (a lone `a` was one keystroke from `/accept`) and
echoes the resolved command; and five test-integrity repairs — the fold pin gained its
discriminating `not.toContain('line-3')` (the old assertion was vacuously true), the
quit-ordering assertion anchored on the banner's own "/quit to leave" and could never fail, the
approved-plan turn-boundary cell of the boundary matrix had no pin at all (added, on a main-only
plan fixture), the `/expand` provenance oracle matched a substring of the OPPOSITE message, and
the drift-scan regex silently exempted any command name containing a digit or hyphen (widened,
plus set-equality instead of a loose count). **Accepted, not fixed, and documented**: the
`task.changes` glyph now follows the ASCII table off-TTY (`±` → `+-`) — ONE deliberate piped
chrome-byte change, aligned with format.ts's own stated ASCII doctrine; external pattern tables
that pinned `±` must update.

### Decisions (and why)

- **The widget owns no answer grammar and no cursor code — both absences are the design.** Menu
  picks and typed buffers route through the parsers that already existed (`parseChoice`,
  `parseAnswer`), so every scope rule, negative word and fail-closed default holds without being
  re-implemented; the status area draws the menu, so "status.ts is the only cursor-moving code"
  survives S22 literally. Immediate first-letter action was rejected by name: it would have
  reintroduced the `cancel`-vs-`[c]` hazard at the keypress level.
- **Enter never affirms, spatially.** The decline/deny row is the initial highlight everywhere,
  which keeps the letter grammar's "empty is a decline, never a default-yes" true for arrows too
  — an approval still costs one deliberate keystroke of navigation before Enter can allow.
- **Detach readline during a capture, never coexist.** History recall and 'line' assembly are the
  two ways a menu answer could have leaked into the line path; removing readline's keypress
  listener for the capture's lifetime closes both structurally, and the fallback when the
  listener diff fails is the line grammar, not a broken menu.
- **Fold deterministically; expand from the record.** Model-authored summaries were rejected —
  narration over evidence, and a model call in a render path; the event log + spill blob are
  already the durable truth the model itself saw, so `/expand` reads THOSE and survives resume.
- **The completion boundary follows the session's shape** — turn-boundary where an approved plan
  makes completion a delivery boundary, typed-/quit for plan-less work — because the S21.6 nag
  was structural: plan-less acceptance is "complete" after every mutating turn, so any
  turn-boundary trigger re-arms perpetually.
- **Piped byte-stability is an output property, enforced two ways**: paint is identity off-TTY
  and every new interaction is TTY-gated (proven by the v1.9.0-vs-HEAD byte-diff); FORCE_COLOR
  was deliberately NOT added, and the stderr tint in the live preview was CUT rather than risk
  the flush machinery (the stream parameter stays threaded, unused).
- **Esc is handled but not advertised.** Node's keypress decoder holds a bare ESC waiting for a
  sequence continuation, so the chord cannot be reliable; meta-flagged keys are dropped instead,
  so an Esc-prefixed Enter can never confirm a highlight.

### Open issues / boundaries

- The PIPED path keeps `parseAnswer`'s first-character grammar untouched — `stop` still reads
  as `[s]` and `abort` as `[a]` where offered. Deliberate (the 44-pin family binds the frozen
  prompt text; scripted drivers type exact letters), pooled for a dedicated hardening pass.
- The approval prompt's `⚠` glyphs and the one-shot CLI's chrome stay hardcoded Unicode — the
  piped byte-stability constraint outranked the unification for surfaces piped transcripts pin.
- The live proof is one provider, one platform, one PLAN-LESS session; the plan-carrying
  turn-boundary completion path is unit- and driveTTY-tested only. `git_status
  view=checkpoints`-style breadth does not exist here: the / menu, Tab completion and Ctrl+E
  were each exercised once, live, not across terminals (Windows Terminal ASCII fallback was
  observed via the heartbeat's `.` dot; legacy conhost was not driven).
- `captureKeys` rests on readline installing exactly one 'keypress' listener (a
  construction-time diff); a Node upgrade that changes the shape degrades every menu to the line
  grammar and fails the reattach round-trip test loudly.
- The documented full-parallelism contention class WIDENED on this session's record: it now
  demonstrably includes `artifacts.pdf` and `artifacts.inspect` (browser-printing tests),
  not only `browser.flow`; each was green in isolation every time it appeared. Related machine
  lesson: a full-suite run whose shell wrapper is killed leaves child processes that FAIL every
  subprocess-spawning test bogusly (observed twice); detached suite runs are the cure.
- Deferred by the plan's cut order: the live-filter dropdown while typing, provider/model
  pickers on the widget, mid-turn `/expand`, the resize redraw hook, heartbeat/task-table
  styled overlay roles.

### Recommended next step

v1.10.0 publishes on explicit user approval (push + tag + Release). Then Session 23 per
BLUEPRINT: cross-platform honesty (the advisory-red Linux CI, `agent accept <id>`, `agent
gc`) or the second non-coding pack (slides) — decide in plan mode from repository evidence.

---

## Earlier Milestones (compressed per the rolling-docs policy)

Contract detail lives in `ARCHITECTURE.md`; entries keep the objective, lasting decisions, the
evidence, and what stayed open.

### Session 21.6 (2026-08-13) — The git capability pack (v1.9.0)

Let natural-language Git intent reach the safe machinery that was already there, checkpoint-first,
without widening the pinned invariant: *the model cannot publish content a human did not commit* —
v1.9.0 (suite 2254 → 2307). The model got the half of git that changes nothing the user can see;
the commit became a **choice at the acceptance boundary** (a `[c]` key running the same
`/commit` body, folded INTO condition C because a second question after `acceptSession` would
be the wizard S21.5's rule 2 forbids).

**Lasting decisions.** Two policy facts (`gitRead`, `gitCheckpoint`), each fail-closed, on the
S20 remoteRead/remoteWrite argument — the conflicting-contract rule then proves "the read tool
writes nothing" by finding no second fact; branches exist at all because a command-less git tool
would auto-allow as `observe` (the `hypothetical_git_commit` pin). `git_status` takes **a
view name and a bounded integer, nothing else** — that constraint IS the argument for allowing
reads unprompted, and `changes` reuses `prepareCommit` so model answer and human screen cannot
drift; it never returns file content. `git_checkpoint` is `{ label? }`, auto-allowed because a
hidden ref is the most reversible write in the system, bounded instead of prompted: 12/session, a
**secret guard** (git blobs cannot be redacted; truncated listings REFUSE — fail-closed), a label
guard. The ref rides a fourth `HarnessRefKind` `agent`, inheriting the owed-prune reclaim (what
makes free capture safe), the covered-change rule, and `WORK_EVENT_TYPES` exclusion for free.

**Evidence.** Four-lens review: 12 findings, all hand-verified and fixed — the sharpest: the
session-end prune iterated a hard-coded three-kind list, so the reclaim that pays for auto-allowing
checkpoints never ran; the secret guard failed open on a truncated listing; an unreadable working
tree reported as clean (`CommitPreview.statusFailed`). Accept-then-commit staled its own
acceptance (`git.commit` is work-shaped) → commit-then-accept; `cancel` at the completion
prompt parsed as `[c]` → the exact-word NEGATIVE_WORDS list. **Live-proven on Kimi** — 11/11
driver steps, 29/29 post-hoc checks (`agent-cli-s216-live/DEMO.md`): three `git_status` reads
as `git.read`/allow with zero approvals spent, a capture refused by name for a non-gitignored
`.env`, a scripted human DENYING the model's `git commit -am wip`, the completion prompt's
`[c]` producing commit-then-accept, the agent ref pruned at quit while the delivery anchor
survived, and the credential in neither the log nor any git object.

**Still open from it.** The monorepo scoping of `changes`, the truncated-listing refusal and the
crash-replay branch are unit-tested only; `git_status view=checkpoints` was not exercised live;
`prepareCommit` reads whole attributed files (a huge file means a huge allocation on a
model-triggered call); checkpoint numbering is shared across kinds in `/checkpoint list`.

### Session 21.5 (2026-08-12) — Command and interaction surface simplification

Made the harness operable by talking to it and answering questions it asks at the right moment,
without weakening authority, evidence or recovery — v1.8.0 (suite 2147 → 2254). It opened with a
code-traced inventory of every user-reachable surface (24 slash cases, 4 sigils, 17 CLI
subcommands, 23 flags in one flat namespace, 13 prompt families, 4 incompatible answer grammars,
41 doc/code conflicts), published as an artifact, then acted on it.

**Lasting decisions.** **Contextual consent** replaces remembered lifecycle commands for the four
decisions that matter (a plan awaiting first approval, an approval invalidated by an amendment, an
open repair escalation, a session that would accept cleanly). The design note that carries it:
`planApprovalReminder` existed *because* the harness could only tell the MODEL about a gate only
the user could clear — "a line is a broadcast with no channel; a question has an answer". Prompts
are **TTY-gated**, because off a TTY `io.question` ignores its `fresh` flag (`io.ts:126`) and would
eat a driver's next scripted line — which is why `/accept` and `/plan approve` were DEMOTED, not
removed: they are the automation path. At most ONE prompt per turn boundary (two consecutive
questions is a wizard, and a wizard trains people to press Enter through it), once per DERIVED
state, and the decline is deliberately not persisted — a `consent.declined` event would write a
non-decision into the evidence log for `/report`, the journal and `computeAcceptance` to
interpret. Every affirmative answer calls the same extracted body the slash command calls, so the
recorded evidence is byte-identical either way. **`@review` became a real `inspector` role**, not
an alias for the review gate: on `reviewer` its findings would block `/accept` regardless of
requirement, never expire, and burn one of only two `MAX_REVIEW_ROUNDS` — separation is structural
(the caps counter matches `role === 'reviewer'`, and the ledger mints rounds only from that or a
`review.findings` event). `@` became specialist routing with one table, a real unknown-sigil
branch, the `\b` trap fixed and `@direct` removed; a typo at the shell no longer starts a billed
session; `/report [section]` slices the one report.

**Evidence.** Ten audit defects fixed with regression pins; first dispatch coverage for nine slash
commands that had none; the consent property pinned by running one fixture twice (typed vs
answered) and asserting equal event arrays. A **new reactive TTY harness** drives `runRepl` with
`isTTY: true` end to end — it must be reactive, because `io.ts` installs its `pending` resolver
AFTER writing the prompt, so an instantly-written answer lands in type-ahead a `fresh` question
never consumes. **Live-verified on Kimi** (`agent-cli-s215-live/DEMO.md`, 16/16 post-hoc checks):
the contextual approval prompt fired on a real model-authored plan and `y` recorded
`plan.approved` with **no `/plan approve` ever typed**; `@review` found the seeded defect as its
first observation while consuming **zero** adversarial rounds.

**An honest correction recorded at the time.** The audit's headline claim — six read-only commands
re-implementing ~400 lines of `/report`'s folding — was an overestimate, and acting on it proved
so. `/checks`, `/preview`, `/remote` and `/research` carry live state a fold over events
structurally cannot have; `/repair`'s numbering is the affordance its dismiss action indexes into.
Only `/review` was a pure fold, and replacing it made the surface worse (a no-plan session lost its
"not required" line). Reverted.

### Session 21 (2026-08-11) — Bounded memory, global initialization, durable approvals

Made project memory deliberate and bounded, gave the harness a user-level global workspace, and
designed durable machine-level approvals as the one explicit exception to "authority is not
durable" — v1.7.0 (suite → 2147). It first closed the two runtime defects the S20.5 live E2E
carried forward, from the runtime's own semantics rather than as patches: **`repair.dismissed`**
gives a session-targeted escalation a user-side closure (joined on the escalation event's OWN seq
so a shared signature can never clear a neighbour, `source: 'user'` required by the fold because
the recover tool has no dismiss action, the blocker closed while an acceptance CAVEAT always
remains); and a **reviewer round can no longer be spent where it could never bind** — while a
once-approved plan's approval is invalidated, a reviewer group refuses EX ANTE naming a cure that
works in the named state, leaving `MAX_REVIEW_ROUNDS` untouched as a repetition bound.

**Lasting decisions — memory (three documents → six).** `LESSONS.md` rides the existing
end-of-session narrative as an OPTIONAL, leniently-parsed key (a missed or invalid value costs the
lessons, never the journal), merged by slug, provenance-stamped, with heading-shaped body lines
visibly defused so a proposal cannot fabricate an entry boundary. `RESEARCH.md` is the durable
surface S19 deferred and is **PERISHABLE by design**: a deterministic fold over recorded
`research.findings` with no model call (so it succeeds when the narrative fails), idempotent by
noteId across resume, entries past 30 days dropped with an honest leading count. The global
`AGENT.md` at the state root is injected FIRST with a heading stating that the project constitution
overrides it on conflict (the ecosystem's local-wins convention), is deliberately smaller than the
project's, and is deliberately NOT injected into subagents. Every cap is pinned, including ONE
worst-case total-injection ceiling — a new document must trip a deliberate decision rather than
quietly grow the cached prefix. **`/init`** is skippable onboarding that never rewrites an existing
file, writes atomically or not at all, and aborts with nothing written on EOF.

**Lasting decisions — durable grants,** designed against the ecosystem's studied failure (Codex
#22181: a vague "don't ask again" minting a machine-wide program-name allow). **Exact identity or
no durable grant at all**: `[a]` persists either an approved check batch's exact body-sha-bound
replay keys (workspace-scoped via the same `trustKey` derivation trust uses) or ONE `(tool, class)`
pair from a closed eligible set — the three read-only-external consents whose blast radius
per-session budgets already bound. No prefixes, no patterns; the prompt prints the LITERAL stored
rule and the revoke path before anything writes. The offer is structural (interactive approvers
only, never a forwarded child ask; an unoffered `'a'` parses as DENY), persistence runs BEFORE
`approval.resolved` so a failed persist downgrades the recorded scope to `session` with the reason
in `detail`, and the store is trust-store discipline: strict schema, corrupt = hard error, never
rewritten, registry-locked atomic writes plus an append-only audit log, `grants.loaded` recorded
whenever any entry applies.

**Evidence.** Four-lens review: 14 findings, every one hand-verified and fixed — the sharpest being
a research CLAIM shaped like an entry heading forging a RESEARCH.md entry with a model-chosen
retrieval date that evaded the staleness horizon. **Live E2E on a fresh state root** (Kimi K3 +
Tavily, five legs, post-hoc validator **31/31** over persisted evidence alone): `/init` from a
genuinely fresh machine state → both constitutions loading the next session → `[a]` minting a
durable grant with one keystroke → a `--no-input` one-shot CONSUMING it with nobody at the keyboard
→ revocation and an honest auto-deny → a live escalate/dismiss/accept-with-caveat closing the
S20.5 deadlock → a check REPLAYING across sessions under its body-bound durable key. Its own
product yield: the validator's one initial FAIL exposed a pre-existing honesty gap —
`tool.completed.outputPreview` recorded `output` alone, so every delegate-gate refusal (whose
message lives in `error`) persisted as an EMPTY preview and a resumed conversation lost why the
call failed. Fixed, pinned, and re-proven against the fixed build.

**Still open from it.** The `remote_status` class grant is unit-tested only; `/init`'s TTY tip and
the real-TTY trust prompt are untestable through a piped driver; durable-grant revocation applies
from the next assembly (a running session keeps its in-memory copy); LESSONS.md quality under the
≤3/session bound needs real project mileage.

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

**Planning/orchestration:** sibling-task chrome over a DISPLAYED forwarded-approval prompt — the
S22 select path handles it (the overlay pushes the menu below arriving chrome cleanly), but the
LINE-question fallback keeps the old wart; plan-file pruning (folded into `agent gc` above); a
`/cancel` surface for non-TTY sessions; richer wave guidance. (The width-aware status clip shipped
in S22 as `width.ts`.)

**Terminal UX (new, S22):** hardening `parseAnswer`'s piped first-character grammar (`stop`→`[s]`,
`abort`→`[a]` where offered — the 44-pin prompt-text family binds the wording, so this is its own
pass); the live-filter dropdown while typing `/` (a per-keystroke redraw inside readline's line —
a different input mode); provider/model/checkpoint-restore pickers on the select widget; mid-turn
`/expand`; a `'resize'` redraw hook; the stderr tint in the live preview (the stream parameter is
threaded and unused); styled overlay roles for the heartbeat and task table; unifying the approval
prompt's hardcoded `⚠` and the one-shot CLI chrome into the glyph table (piped byte-stability
outranked it this session).

**Memory/init/grants (new, S21):** install-replay and preview-replay durable grants (each
excluded from `[a]` deliberately — revisit with real usage pressure, not by default); a
reviewed `/init` rewrite path for existing AGENT.md files; a one-shot `agent init` Q&A;
workspace-scoping the class grants if machine-wide proves too broad in practice; `/review
dismiss` (the review-finding analog of `/repair dismiss` — design agreed since S14.5, still
pooled); LESSONS.md quality metrics once real project mileage accumulates.

**Local git pack (new, S21.6):** a `diff` view returning hunks is deliberately ABSENT — it would be
an ungated file-content read through a branch that never evaluates `readsPaths`, so if it is ever
wanted it needs the secret-name and containment checks wired in explicitly, not a new flag.
`git_status view=summary` re-probes repository-wide while `changes`/`log` are subtree-scoped (the
wording says so; a scoped `detectGitFacts` option would make the numbers agree). `prepareCommit`
reads whole attributed files to compute drift, so a huge attributed file means a huge allocation on
a model-triggered call — streaming or a size cap is the fix. Checkpoint `n` numbering is shared
across all kinds, so `/checkpoint restore <n>` can address an agent or task-base ref; the subject
labels distinguish them, a kind column in `/checkpoint list` would do it better. (The completion
prompt's plan-less reachability after any mutating turn was RESOLVED in S22: the question moved to
the typed `/quit` for plan-less sessions.)

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
