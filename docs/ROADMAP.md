# Roadmap

How Agent CLI got here, and what is deliberately not built yet. Newest first, one short entry per
session: the objective, what shipped, the decision that outlived the session, and the evidence that
settled it. Contracts live in [`ARCHITECTURE.md`](ARCHITECTURE.md); release notes live in
[`../CHANGELOG.md`](../CHANGELOG.md).

Proof narration and debug detail have been dropped deliberately — they are in the commit history
and in each release's changelog entry. Live end-to-end runs are cited by name (`agent-cli-sNN-live`);
those are **evidence directories on the development machine, not part of this repository**, and
several no longer exist on disk. What survives of them is the transcript in the relevant release
and the summary here.

**Where the project is now.** v1.10.x is functionally complete for V1: a bounded agent kernel with
one policy choke point, append-only evidence, typed verification, crash-safe resume and an explicit
acceptance boundary — plus capability packs for documents/PDF, web research, local git, and remote
GitHub delivery, across five model providers. 2,416 hermetic tests over 151 files gate every change
on Windows and Linux.

---

## Sessions

### Session 22.7 (2026-08-17) — The launch demo, and recording as an engineering problem

No product change. The objective was the one artefact v1.10.x still lacked: a video a stranger can
watch. The previous session's master was 2:42:38 of execution transcript, and **99.6% of it was
terminal** — 39.68 s of 9757.64 s showed anything else. The cause was structural, not editorial: the
video source *was* a browser page (a real ConPTY mirrored into xterm.js, recorded by Playwright), so
nothing outside that page could ever appear, and a DOCX never could.

**The capture path was rebuilt around the final edit.** Four sources instead of one: the terminal
still comes from the ConPTY-to-xterm bridge, now at 1920x1080 native so terminal footage is never
resampled; the application, its generated PDF and the live GitHub pages are recorded at native 1080p
with real input events; and the two scenes that cannot be rendered headlessly — a real browser window
with its URL bar, and Microsoft Word displaying the harness's own DOCX — are verified screen stills,
held rather than animated. The cut itself is a function of one shot list: scenes, anchors,
durations, speeds and captions in a manifest, rendered by a three-pass editor into a 1920x1080 H.264
master plus the scene table that documents it. **Result: 1:59, 30 scenes, 25.0 MiB with the
voice-over, gate 19/19.**

**The take was a real session, and it published.** One bounded request against the existing Shelfmark
workspace (a per-shelf breakdown for its stats page, then a one-page release note as DOCX and PDF):
79 tool calls, 18 file mutations, 11 typed checks with 8 green, 5 delegated tasks with 2 integrated
through disposable worktrees, 3 browser flows all passing against the running preview, 15 recorded
approvals with none denied — two of them answered with real arrow keys — then a session-attributed
commit and exactly 3 remote mutations (push, tag `v0.2.0`, release), each individually approved and
each recorded `VERIFIED against the remote`. The acceptance record names its own caveats: the publish
is outside the harness and cannot be undone here, one review lens never completed, and ten workspace
changes landed after the last review round.

**What the environment actually allows, measured rather than assumed.** `gdigrab -i title=<window>` is
solid black for GPU-composited windows, so per-window capture is unusable and region capture with
deterministic window placement is the only path. Capture rate is load-bound, not area-bound: ~27 fps
idle at full desktop and ~5 fps with other work running, identically for `gdigrab` and `ddagrab` —
which is why window video was implemented and then retired for stills that cannot stutter.
`Application.Activate()` cannot raise a window from a background process, and a Word run once reported
eleven green COM steps while the clip contained only the terminal; the fix is
`SetWindowPos(HWND_TOPMOST)` plus five-point pixel-ownership verification, and a shot that cannot
prove its subject is now deleted rather than shipped. Privacy turned out to be a recording concern
too: a fresh Edge profile implicitly signs in from the Windows account and puts the user's email
address on screen, and Word's chrome carries the signed-in name plus an activation notice — both
suppressed or cropped, and disclosed in the scene manifest.

**Three of this session's own tools were caught lying, each by looking at the artefact.** Feeding
concat-demuxer output into ffmpeg's `xfade` truncated the master to 106 s of an intended 187 s while
every intermediate decoded perfectly, so `xfade` now only ever sees short single-source clips and
assembly uses the concat filter. Worse, the check that should have caught it compared the scene
table's duration against the rendered file — a value written *from* that file — and passed; it now
checks the file against the manifest's arithmetic, and the editor fails loudly on a mismatch. The
window shooter's own window enumeration silently returned nothing, which made a "no dialog was up"
check vacuous. The QA gate also had two detector passes that could report "clean" without decoding a
frame, and it called legible dark-theme terminal footage black (the theme background is luma 14/255,
and a readable frame is >98% background) — both corrected, with the thresholds justified in the code.

**Three defects survived every still-frame check and appeared only in playback**, which is its own
lesson about what a frame-by-frame pass can and cannot see. A slow `zoompan` on a still walks the image
one whole input pixel at a time — perfect in every frame, visibly juddering in motion; the stills are
now held frames, proven bit-identical. A white caption face on a 33%-opaque plate is legible over a
terminal and invisible over a white document page; the plate is now near-opaque. And the first cut ran
2:41, which read as slow; retiming to 1:59 came from shortening windows rather than speeding realtime
footage, plus raising the four already-badged montages. Retiming also surfaced that two beats were out
of source order — the cut showed executors writing files before the delegation that spawned them — so
the manifest now requires source in-points to increase within every beat.

**The product was observed, not just filmed.** One take was lost to a genuine v1.10.2 behaviour: a
command invoked through the `/` command menu prints its output and then does not repaint the idle
prompt, while the same command typed directly does; the same wart appears after a consent menu, where
the prompt lands on the same line as the echoed answer. That is now pinned in the recording rehearsal,
worked around in the driver, and covered during a take by a watchdog that sends one bare Enter only on
that exact signature and logs every nudge. It fired once. The wart itself belongs in the deferred pool.

**The narration was mixed to the finished picture, and every audio decision was measured.** The
deliverable now carries the user's own voice recording; the editor keeps ownership of the picture and
writes a silent master, while the mixer copies that video stream rather than re-encoding it, so
re-cutting can never clobber the voiced file and the voiced file is never a second generation.
Alignment was measured before it was trusted (median 0.17 s from each scene change to the nearest
pause; a best-fit search moved it 0.2 s, so nothing was shifted), the trim to picture length was
proven to land in silence, and a denoise sweep is why there is no denoiser: `afftdn` bought 0.7 dB of
noise floor for 1.0 dB of the >4 kHz band and then saturated, because the floor is breath and room
rather than hiss. Three audio measurements had to be corrected first — a like-for-like channel count
before comparing loudness, a speech gate relative to the file's own loudness instead of an absolute
one, and a high-band baseline that includes the downmix. **The QA gate grew five audio checks**
(format, loudness, true peak, speech duty cycle, speech-to-room), a silent deliverable is now a
failure rather than a note, and the gate's own true-peak check was caught reading the last progress
line instead of the running maximum — it reported -20 dBTP for a -1.4 dBTP master, so a clipping file
would have passed. Its self-test now pins that with an anti-narration fixture. What the chain still
cannot do is hear the words: whether the narration says what the picture shows is stated as a human
check, not asserted as verified.

Evidence lives in `agent-cli-s227-launch/` on the development machine — the master, the scene
manifest, the QA stills, the session's own event log, and the whole capture chain, runnable
standalone. The failed take is kept beside it rather than deleted. The video is not hosted anywhere
yet, so the README carries no embed.

### Session 22.6 (2026-08-16) — Public release surface and repository polish (v1.10.2)

Zero capability change; the target was everything a first-time visitor or installer meets.

**The release gate was red, and the diagnosis mattered more than the fix.** The CI run for the
v1.10.1 commit — the one the tag and the latest Release both point at — failed six tests across
four files on Windows. None was a defect: the runner was starved, measured at `Duration 347s` wall
against `tests 972s` summed. Vitest sizes its pool from the CPU count, and a large share of these
files spawn real subprocesses, so a 4-vCPU runner was carrying far more concurrent processes than
cores. CI now caps the pool at 2 workers; fixture-side git gets a fixture-sized bound; temp
teardown retries the error class Node already retries; the browser print gets the loosest backstop
in its suite rather than one *below* the global. **The product's own bounds were not touched** —
loosening a shipped constant to make CI pass is hiding a failure, not fixing one.

**The Linux leg became a real gate.** Advisory-red since 2026-07-28 under the label "suite not yet
ported", with ten failures on record. Measured, it was three, all asserting Windows case-folding on
a case-sensitive filesystem — and `caseFold` was already correct, the tests having encoded only
half its contract. Each now pins both answers, which is a real invariant rather than a formality:
folding a re-cased path on Linux would silently widen one workspace's standing grants onto a
different directory. What remains between the platforms is coverage, not correctness.

**Packaging stopped implying a registry release.** The metadata was fully dressed to publish, but
the npm name has belonged to an unrelated package since 2019, so `private: true` now makes that
explicit. `exports` closes the deep-import surface — without it all 188 emitted modules were public
API, which is a poor fit for a project whose thesis is one choke point. And the Node floor guard,
whose comment claimed it ran "before anything else", was the thirty-first thing to execute, because
ESM evaluates every import before the importing module's body; it moved to its own dependency-free
module imported first, pinned by a structural test.

**The documentation became a hierarchy.** The README went from 855 lines to 317 and now leads with
the argument rather than a feature list. The three reference documents moved to `docs/`, joined by
`USAGE.md` and `SAFETY.md` extracted from the README so nothing honest was lost; `ARCHITECTURE.md`
was compressed 2,287 → 1,252 lines by removing session archaeology and keeping every contract, and
this file 1,064 → 462. `BLUEPRINT.md` was deleted, its programme fully executed.

**The GitHub surface caught up too.** Discussions was enabled — which mattered because the Code of
Conduct had been routing conduct reports to a Discussions channel that did not exist, alongside the
security-advisory form, which is the wrong tool used silently. Both channels are now named with
their limitations. About and topics were refreshed against the new README, and a branch ruleset
makes both CI checks genuinely required on `main`, with force-push and deletion blocked. That
ruleset ends direct pushes to `main`: from here, changes go through a pull request, which is how
this record itself landed.

**Verified:** typecheck clean; the full suite green locally (**2,405 passed, 11 skipped, 0 failed**
over 151 files); a green Actions run on **both** jobs for the tagged commit; and a clean-clone
smoke — `git clone` → `npm install` → `agent --version` reporting 1.10.2, `agent providers` and
`agent help` working, `npm audit` reporting zero with and without `--omit=dev`.

**Still open.** The two-worker CI cap trades wall time for a gate that means something; if the
runner ever gets faster the cap is worth revisiting. macOS remains unexercised by CI. Dependabot
#10 (TypeScript 7, `@types/node` 26) and #11 (undici 8) stay open deliberately. The social-preview
image and the Discussions categories are GitHub-UI-only and were not set.

### Session 22.5 (2026-08-15/16) — Production release hardening (v1.10.1)

A consolidation-and-proof session with zero capability expansion. A bounded six-lens audit produced
~21 findings, every actionable one hand-verified against source before any fix; eleven
typecheck-and-suite-gated commits followed. The sharpest: approval scope keys `[s]`/`[a]` were
matched by first character and not gated on what the prompt actually offered, so `stop` typed at a
remote-write prompt parsed as a session grant — and since the engine executes on any allow, it
executed the push. Also fixed: read-only git *subcommand names* got read-only *argument* proofs
(`git tag v1` was creating a ref via auto-run); the worktree sweep's age hatch was removed, because
approval wait is excluded from the executor clock so a live task's age is unbounded; crash replay
learned to consult recorded completion evidence rather than replaying a verified push as an unknown;
and `[c]` stopped minting an acceptance for a commit that had been declined. Packaging gained a
Node-version floor guard, map-less release builds, and a lockfile version pinned by test.

**Proven by** a full-system live E2E — an empty folder to a public GitHub release in one session
against Kimi K3, validated 37/37 from persisted evidence plus the live remote, including a
recording-infrastructure kill 22 minutes in and an on-camera `agent resume` that finished the build.

### Session 22 (2026-08-14) — Terminal UX consolidation (v1.10.0)

Made the interactive surface match what the harness had become, without changing runtime truth and
without moving a byte of the piped contract. Every prompt became an arrow-key menu layered *over*
the existing line grammar: the widget owns no cursor code (the status area draws it) and no answer
grammar (picks route through the parsers that already existed), and the initial highlight is always
the decline row, so **Enter never grants**. Long command output folds honestly with a tail, and
`/expand` reprints it from the *record* — the spill blob or the recorded head and tail — so it
survives resume by construction. A bare `/` opens a command menu backed by a table that is
drift-pinned against the dispatch switch in both directions.

**The decision that lasted:** detach readline's own keypress listener for a capture's lifetime
rather than coexist with it. Arrow-up is history recall and Enter emits a line into type-ahead, so
coexisting meant a stale buffered command could answer a security prompt.

**Verified** by a piped control: the same scripted session driven through the v1.9.0 build and the
new one produced byte-identical stdout *and* stderr. A four-lens review found 16 findings, all
hand-verified; the sharpest was that engaging a menu mid-line handed the *suffix* of an invisible
typed line to the widget, where a fragment could answer an approval by its first character.

### Session 21.6 (2026-08-13) — The git capability pack (v1.9.0)

Let natural-language git intent reach the safe machinery that already existed, checkpoint-first,
without widening the invariant that the model cannot publish content a human did not commit. The
model got the half of git that changes nothing the user can see: `git_status` (a view name and a
bounded integer, nothing else — that constraint *is* the argument for allowing the reads
unprompted) and `git_checkpoint` (create-only, bounded rather than prompted, refusing to capture
secret-named files `.gitignore` does not already exclude, because a git blob cannot be redacted).
Committing became a *choice at the acceptance boundary* rather than a remembered command.

**Live-proven on Kimi**, 29/29 post-hoc checks: three git reads with zero approvals spent, a capture
refused by name over a non-gitignored `.env`, and a scripted human denying the model's
`git commit -am wip`.

### Session 21.5 (2026-08-12) — Command and interaction surface (v1.8.0)

Opened with a code-traced inventory of every user-reachable surface — 24 slash commands, 4 sigils,
17 subcommands, 23 flags, 13 prompt families, 4 incompatible answer grammars, 41 doc/code conflicts
— then acted on it. **Contextual consent** replaced remembered lifecycle commands for the four
decisions that matter, because a printed reminder is a broadcast with no channel while a question
has an answer. Prompts are TTY-gated (off a TTY the question would eat a driver's next scripted
line, which is why `/accept` and `/plan approve` were demoted rather than removed), at most one per
boundary, and every affirmative answer calls the same body the slash command calls — pinned by
running one fixture twice and comparing event arrays. `@review` became a real `inspector` role
rather than an alias for the review gate, because a `reviewer` finding blocks `/accept` regardless
of requirement and burns one of only two rounds.

**An honest correction recorded at the time:** the audit's headline claim — six read-only commands
re-implementing ~400 lines of report folding — was an overestimate, and acting on it proved so. Four
of them carry live state a fold over events structurally cannot have. Reverted.

### Session 21 (2026-08-11) — Bounded memory, initialization, durable approvals (v1.7.0)

Project memory went from three documents to six, every cap pinned, including one worst-case *total*
injection ceiling so a new document must trip a deliberate decision rather than quietly grow the
cached prefix. `LESSONS.md` rides the existing end-of-session narrative as an optional leniently
parsed key, so a missed value costs the lessons and never the journal. `RESEARCH.md` is perishable
by design — a deterministic fold with no model call, entries past 30 days dropped with an honest
count — because a stale research note is exactly the overconfidence research exists to prevent.

**Durable machine grants** were designed against a studied failure in the ecosystem: a vague "don't
ask again" that mints a machine-wide program-name allow. The answer is exact identity or no durable
grant at all — either an approved check batch's body-sha-bound replay keys, or one `(tool, class)`
pair from a closed eligible set of read-only-external consents whose blast radius per-session
budgets already bound. No prefixes, no patterns.

**Live E2E on a fresh state root**, 31/31: `/init` from genuinely fresh machine state, a durable
grant minted with one keystroke, *consumed by an unattended `--no-input` run*, then revoked and
honestly denied.

### Session 20.5 (2026-08-09/10) — Full-system review and a zero-to-remote proof (v1.6.1)

A five-lens review of the whole system fixed 18 hand-verified defects, the largest class being
accounting and honesty seams that only bite hours into a real run. The context budget stopped being
a flat 100k and became a per-model derivation (window fit plus provider billing clamps), so a
1M-window model no longer elided at a tenth of its real window. Module boundaries became a **test**,
which immediately found and cut a fifth import cycle.

**The live proof:** an empty folder to a real GitHub release in one Kimi K3 session — 1,006 events,
three lives across two terminal deaths, three parallel worktree executors, two real test failures
found and fixed live, and a first release attempt *denied* by policy for citing a stale observation.
Validated 62/62.

**The finding that shaped the next session:** an escalation targeted at the session had no closure
path, pinning a fully-green session at PARTIAL.

### Session 20 (2026-08-08) — Remote Git and GitHub delivery (v1.6.0)

Carried a verified, committed local result across the machine boundary. The failure it prevents is
**authority creep** — reading a remote and changing one arriving as one capability, so consent to
look becomes consent to publish.

**Two policy facts, not one capability with a mode.** `remoteRead` and `remoteWrite`, each
fail-closed, so the existing conflicting-contract rule makes a tool that could do both an automatic
deny. A read is session-grantable within a real counter; a write asks every time and offers no `[s]`
at any of the three consent surfaces. A mutation must cite a live observation of its ref within a
kernel-owned age bound no pack can widen. Looking never writes — the only network verb is
`git ls-remote` — at the honest cost of a genuinely `unknown` relation, which refuses a force push
*even with `force`*.

**Live-proven** against the real repository with a scripted human who was deliberately not
always-yes: 3 mutations all verified, and the first publish **denied**, with `/remote` immediately
after still reporting zero mutations. The review found two overclaims only the live run could catch.

### Session 19 (2026-08-07/08) — Source-backed web research (v1.5.0)

The first deliberate connection to the external web, as a bounded read-only capability that hands
the main agent short **source-backed claims** rather than raw pages. The failure it prevents is
stale confidence: writing code against an API that moved, from recall, sure of itself.

A seventh policy fact, because a command-less mutation-less research call would otherwise auto-allow
as "read-only workspace access" — false in the only direction that matters, since *sending* is the
consequence. **The budget is the consent**: `[s]` authorizes a bounded capability against a real
shared counter, and an exhausted budget is an engine-owned deny no held grant rescues. The parent
holds `web_search` only, so "the main agent never receives raw web pages" is a registry property
rather than a hope.

**Evidence — a control-versus-proof experiment:** two live runs, same fixture, same provider, one
variable (whether the research credential was in the child environment), on a task with a known
stale-prior trap. The control implemented from recall and typechecked clean while flagging the auth
drift as its own top risk; the proof recorded seven corroborated findings with real sources,
including that exact trap and an honest "could not establish an authoritative date". The honest
reading: research converted a plausible answer into a supported one.

### Session 18 (2026-08-07) — Polyglot repository intelligence (v1.4.0)

Extended retrieval and verification beyond the Node/TS bias, with support defined as *language plus
build system plus layout plus available toolchain* rather than file-extension recognition. The audit
finding that shaped it: an unrecognized ecosystem resolved every check to `no-recipe`, and
`no-recipe` **waives** declared gates — so a Rust session reached `/accept` COMPLETE having verified
nothing, over a workspace holding a `Cargo.toml`.

Machine toolchain availability became a first-class stat-only fact, with absence never cached. A
missing toolchain is `toolchain-unavailable`: it waives, because an absence the harness will never
install must not strand acceptance, but it is tracked apart through every fold so the caveat names
the toolchain and its cure. `cargo test` under a cross target refuses *permanently* — cross binaries
cannot execute on the host and the harness manages no hardware.

**Three validated live runs:** the before-capture of the defect itself, a proof on the
pre-install machine (six explicit `toolchain-unavailable` states with zero spawns), and a proof
after installing Go and Rust (a seeded `go test` failure and a seeded rustc type error each found,
classified, fixed and re-proven).

### Session 16.5 (2026-08-01/03) — Proving Session 16 end to end (v1.2.1)

Two bounded adversarial reviews plus the live E2E Session 16 had owed. The lasting fixes were all
one shape — a degraded state reading as a good one: a compat stream ending with neither `[DONE]`
nor a finish reason was committing a truncated sentence as the model's final answer; a cached
browser-probe *failure* silently converted "the machine was busy" into "this session cannot produce
browser evidence", and that conversion waived gates; reasoning blocks were double-weighed by their
display copy. Plus the "working" heartbeat for always-thinking models, and a tolerant one-level
decode for double-encoded tool arguments, after a model spent twelve minutes cycling serialization
formats without ever un-stringifying its own argument.

**Live proof:** one 84-minute session, validated 38/38 — one request through two installs, migrate,
seed, per-project checks, a parallel executor wave, two simultaneous dev servers, three passing
browser flows, a three-lens review that recorded a seeded XSS, a kill and resume on camera, and
`/accept` COMPLETE with no override.

### Session 16 (2026-07-31) — Real local software engineering (v1.2.0)

Before it, a repository holding `web/` and `api/` with no root manifest detected **nothing** — every
check kind unsupported, every gate unrunnable. The workflow went inert rather than loud. Landed
project **units** (a unit exists only where a manifest exists; unglossed globs are refused with a
reason), deterministic ordering because unit ids qualify recipe ids and recipe ids are what consent
binds to, `selectUnit` that refuses ambiguity rather than picking, and `project_setup` — the model
names an intent and a unit, the harness names the command from the lockfile.

Its four-lens review found four critical holes, each one an S16 change re-opening an earlier
session's closed hole one axis over: an install `[s]` becoming standing shell consent via a
`package.json` rewrite; a monorepo root silently waiving gates; a repair proven by another
project's green; a plan strandable on a nonexistent project.

### Session 15 (2026-07-29/30) — The multi-provider runtime (v1.1.0)

Five providers over two genuinely different protocols behind one runtime. The enabling idea is an
opaque `reasoning` content block carrying the provider-native artifact verbatim, tagged with
provider *and* model, persisted additively and replayed only within each provider's documented
scope — which is what makes always-thinking models and reasoning tool loops legal at all.
Capabilities became shipped **data** with a verified date, and OpenAI got its own Responses adapter
rather than being folded into the chat-compatible one, because Chat Completions cannot tool-call
with reasoning off and "OpenAI-compatible" would have been a false equivalence at exactly the point
that matters.

**All five providers live-smoked.** The session's most valuable find was live: key validation used
a bare global fetch, so on a proxied machine it returned 401 for a key that works — `/provider`
would have refused a valid credential.

### Session 14.5 (2026-07-28) — V1.0 consolidation and live proof (v1.0.0)

Not a feature session. The top live-found gap was the executor-capture EOL pin: with system
`core.autocrlf=true` over an LF tree, `worktree add` and `checkout-index` re-applied the smudge
filter, so *every* captured file refused at apply as base drift. The decision that generalized:
**a display cap must never be a consent identity** — script text is truncated for prompts, but the
consent sha covers the untruncated value, because an append past character 200 had ridden an
earlier approval.

**Live proof:** one continuous session on a fixture with three seeded defects each reachable by a
different capability, 48/48 post-hoc checks, `/accept` refusing twice with honest lists, and zero
commits added to the user's branch.

### Session 14 (2026-07-27/28) — The delivery boundary

Git, review and acceptance became one coherent boundary. The `onRefReady` seam puts the **event
before the ref**, so the creation-instant leak is structurally closed and a failed ref write leaves
an honest self-converging phantom. `src/review/` landed: typed findings recorded at the source, a
pure fold deriving requirement and qualification and triage worth, and open critical findings
blocking `/accept`. All four review lenses independently found the phantom-delivery defect, and the
first fix for it was itself wrong until a regression pin caught it.

### Session 13 (2026-07-26) — Managed previews and browser verification

Locally built apps became verifiable as a user experiences them. **A preview is a resource, not a
check kind** — a check is a bounded process that ends; a preview deliberately does not. Browser
evidence rides the check channel with `exitCode: null`, which satisfies gates while staying
structurally outside the file-CHECKED exit-zero rule. Kills need positive identity; deletions do
not.

### Session 12 (2026-07-25/26) — Verification gate and typed recovery

Verification became a typed capability whose results are durable evidence: a declarative recipe
table where a project's own script beats a guessed tool, and normalization whose one rule is **the
exit code is the verdict**, with named signals keeping later classification derivable from the log
alone. Recovery became a policy with failure classes as a data catalogue and classification
happening *before* any repair is planned. The trust argument in one line: **the model names kinds,
the harness names commands** — and consent had to bind the script *body*, because rewriting
`package.json` otherwise turned one `[s]` into standing execution consent.

### Session 11.5 (2026-07-24) — The durable session

A session became a durable self-contained unit of work: crash-covered task-base ref lifecycle,
truncation spill blobs ("captured", never "full"), definition-bound completed state with per-attempt
history, a retry ceiling that crashes and user stops never count against, and the `/accept`
boundary — recorded consent, plan retirement via supersede rather than archive-by-delete, which
would have added the system's only un-undoable act.

### Session 11 (2026-07-23/24) — Planning, task graphs, parallel-first execution

One canonical plan graph with two deterministic projections, and approval binding a content sha so
status flips are sha-neutral by construction while any semantic amendment invalidates. Execution
status is a **pure event fold, never a field in the plan** — two writable status sources would be
the double-truth trap. The scheduler is a gate plus guidance, not an in-tool wave engine.

### Session 10 (2026-07-23) — Repository intelligence

Selective, ranked, task-directed retrieval replaced the broad file list. A pre-code critique caught
two critical flaws: never redefine the workspace-map digest (an additive one was added instead), and
never let an observe tool write the index at query time. Excerpts and line numbers **always** come
from live reads, so a stale index may misrank but can never fabricate. Proven on a 3,064-file
repository: 0 of 14 packages visible under the flat map, 14 of 14 under the ranked one, in the same
16k characters.

### Session 9 (2026-07-22/23) — Pre-expansion consolidation

Audit-driven fixes with no new capability: concurrent-session worktree safety (owner-stamped
entries, an in-process mutex plus a token lock file, merge-on-save), plan-approval state displayed
at the executor spawn ask, and command grants keyed on the command *fact* — `[s]` is hidden wherever
no grant would actually be stored, which was found live.

### Session 8 (2026-07-22) — Agent teams

Roles as two-layer explicit contracts, pinned consistent at load. Parallelism lives in the delegate
**tool**, so `runTurn` stayed byte-identical: one call is one group, one evidence unit, and one
approval when a mutating role is present. The executor role landed with its full chain — base
checkpoint, detached worktree, bounded binary-safe capture that outlives the worktree, and a
reviewed drift-refusing apply. Worktrees of a trusted workspace are trusted *by derivation*, and
they live in the OS temp directory because the path validator dictates it.

### Session 7 (2026-07-20/21) — Memory and subagent tasks

Three-document project memory and the first read-only explorer tasks, over the *same* `runTurn` and
one construction path. Memory is context-not-authority **structurally**: evidence comes from events
and crash notes from log tails, so the absence of memory never accuses a session.

### Session 6.5 (2026-07-19) — The V0.5 capability demo

One continuous 68-minute recorded run built a 20-file application with 51 unit tests from a
natural-language brief, then demonstrated diff, attributed commit, checkpoint, restore, undo and
report — on 124 uncached input tokens total. Validation sessions live outside the product
repository, and the bridge identifies itself truthfully.

### Session 6 (2026-07-18) — Git-native and context-efficient

GitOps as a harness-only capability, with a policy regression test pinning *why* it must never be a
model tool: a command-less, mutation-less "git_commit tool" would auto-allow as observe. Checkpoint
restore is one `applyUndo` unit, so git never becomes the undo mechanism. Two-breakpoint prompt
caching brought a session down to roughly six uncached input tokens.

### Session 5 (2026-07-18) — Enforced isolation and automatic command review

The OS-enforced Windows boundary (Low integrity plus a Job Object), chosen by a machine probe run
*before* any code was written — `WRITE_RESTRICTED` tokens failed it. Auto-run requires a positive
proof of safety **and** an active probed boundary, else it asks; approved commands deliberately run
unsandboxed, because the user accepted that risk. A 66-assertion adversarial corpus covers 40+
escape forms that must never auto-run.

### Session 4 (2026-07-17) — Execution kernel hardening

Typed termination — a killed command has no exit code, everywhere — and a kill/drain state machine
that never awaits `'close'` unconditionally, closing the detached-grandchild pipe-hang class.
**Cost lesson, now a rule in `CLAUDE.md`:** a per-finding three-verifier review fan-out exploded
(19 findings became ~57 agents) and was aborted; the findings were salvaged and verified by hand.
Review workflows stay bounded.

### Sessions 1–3 (2026-07-14/16) — The bounded local agent loop

The seven pillars: typed contracts, append-only JSONL with tail repair, one pure policy choke point
plus a Windows-first path validator, the file tools and `run_command`, snapshots with drift-refusing
undo, resume with crash reconciliation, and a deterministic evidence report. Then the REPL on the
exact same runtime (no parallel loop), workspace trust as recorded consent, and narrowing-only
config. The first recorded end-to-end run's product yield was two real defects: an npm-link shim
exiting 0 silently, and a missing test hang backstop.

---

## Deferred pool

Accumulated and still open. These are documented choices, not oversights.

**Design agreed, not yet built.** `/review dismiss <id> <reason>` — the review-finding analogue of
`/repair dismiss`, refused at the tool so consent stays the user's, marked ineffective in the fold
when not user-sourced, always a caveat. A static-server preview recipe for plain-HTML workspaces.
`agent accept <id>`, so one-shot sessions can reach the acceptance boundary. `agent gc` — a
dry-run-by-default blob and plan-file collector over a conservative reference walk, refusing to
delete anything when any log is corrupt or locked.

**Cross-platform.** Resolved in Session 22.6: the Linux CI leg is a real gate rather than an
advisory one. What remains is a genuine **coverage** difference rather than a portability debt —
the Low-integrity/Job Object sandbox, taskkill tree-kill and the win32 path rules have no Linux
counterpart, so 30 tests skip there against 11 on Windows. macOS is unexercised by CI.

**Provider and model.** Surface `reasoningTokens` in the report and `/status` (it is recorded; no
reader folds it). A live reasoning render channel — the heartbeat covers the frozen-screen half, the
streaming-content half is open. Strict-schema transformation for OpenAI/Kimi strict tool mode.
Resume identity stickiness (a bare `agent resume` of a Kimi session resumes on the default provider
— recorded honestly, but the session's own identity is the least-surprising default). Per-role model
tiers. Per-provider reviewer and executor budget scale, since a slow always-thinking model may
deserve a scaled wall. The `undici` 8 and `diff` 9 majors are deferred deliberately: the proxy
dispatcher and patch API need live verification, not a green unit suite.

**Kernel and runtime.** `pause_turn` is mapped but the loop would end the turn. Per-action, `--to`
and `--steps` undo; conversation rewind; session pruning and sanitized export; prompt-history
persistence; PTY support (the supervised preview substrate deliberately stops at non-interactive
servers); SQLite indexing of events and long-term memory topic retrieval.

**Verification and recovery.** Multi-kind `run_check` batches re-probe drift once, before the first
spawn — a workspace-authored script run by an earlier kind could rewrite a later kind's body within
one approved batch. `run_check`'s plan-touches lookup reads the plan document at decide time and the
plan file sits outside the drift stamps (the documented purity exception). Per-task gates are
unit-tested only, since a plan of all-`main` tasks cannot declare them. Executors cannot self-verify,
because a worktree lacks gitignored dependencies. More ecosystems as data-shaped recipe rows; an
incremental check cache keyed by file hashes and tool versions. Preview recipes for `cargo run` and
`go run` have no representation.

**Retrieval.** Tree-sitter (or richer) extraction behind the same extract interface; more languages
as table additions; a user config knob for the map budget; retrieval-aware journal topics.

**Preview and browser.** Socket-ownership verification for readiness. Deterministic screenshot
baseline comparison where stable baselines exist. Executor-side preview (blocked on the same
worktree-lacks-dependencies seam as `run_check`). Headed and multi-context browser flows. macOS/BSD
process-age parsing for the sweep (the current shape is Linux-flavoured and fails safe).

**Planning and orchestration.** Sibling-task chrome over a *displayed* forwarded-approval prompt —
the select path handles it, the line-question fallback keeps the old wart. Plan-file pruning (folded
into `agent gc`). A `/cancel` surface for non-TTY sessions.

**Terminal UX.** A command invoked through the `/` **menu** — and an answered consent menu — leaves the
next prompt on the same line as the echoed answer instead of repainting it on its own line; a typed
command does repaint. Harmless to a human (the next keystroke fixes it) but it defeats any anchor that
requires a newline before `›`, which cost a recorded take in Session 22.7. Hardening the piped
first-character grammar (`stop` still reads as `[s]` and `abort` as `[a]` where offered; the frozen
prompt-text family binds the wording, so this is its own pass). A live-filter dropdown while typing `/`. Provider, model and checkpoint-restore pickers on
the select widget. Mid-turn `/expand`. A resize redraw hook. The stderr tint in the live preview
(the stream parameter is threaded and unused).

**Memory, init, grants.** Install-replay and preview-replay durable grants, each excluded from `[a]`
deliberately — revisit under real usage pressure, not by default. A reviewed `/init` rewrite path
for existing `AGENT.md` files. Workspace-scoping the class grants if machine-wide proves too broad
in practice. `LESSONS.md` quality metrics once real project mileage accumulates.

**Local git.** A `diff` view returning hunks is deliberately **absent** — it would be an ungated
file-content read through a branch that never evaluates `readsPaths`, so if it is ever wanted it
needs the secret-name and containment checks wired in explicitly, not a new flag. `git_status
view=summary` re-probes repository-wide while `changes` and `log` are subtree-scoped. `prepareCommit`
reads whole attributed files to compute drift, so a huge attributed file means a huge allocation on
a model-triggered call. Checkpoint numbering is shared across kinds, so `/checkpoint restore <n>`
can address either an agent or a task-base ref.

**Tasks, sandbox, delivery.** Task resume and continue. Deeper scanning of child reports for
instruction-shaped content (v1 ships delimiters plus provenance labels). Per-child sandbox scratch
isolation. A cross-process memory-document lock (today: a seconds-wide last-writer-wins window at
simultaneous quits). Patch and multi-edit editing. Model-generated commit messages. Attribution of
approved `run_command` file effects, which is structurally under-claimed today. PR flows; submodule
and multi-repository workspaces. **Network-egress control and a read/confidentiality boundary — the
two enforced gaps that most matter.** A cached or compiled sandbox host to cut per-command latency;
macOS and Linux enforcement backends; containment of service-reparented work that escapes the Job
Object.

**Cosmetics, informational only.** Command-label noise: word-boundary matches can mislabel (the
literal "format" in `format.js` reads as destructive). Labels never grant and never gate.

---

## Beyond the current horizon

Folded in from `BLUEPRINT.md`, deleted in Session 22.6 once its near-term programme was fully
executed. Keep these visible, but do not pull them forward without direct implementation pressure:

- broad SaaS deployment orchestration and autonomous production operations;
- network-egress enforcement and a true read/confidentiality sandbox;
- macOS and Linux sandbox parity;
- unrestricted computer use, deep inter-agent messaging, or remote distributed execution;
- MCP or plugin marketplaces, and many shallow integrations;
- multi-repository orchestration and hardware-in-the-loop embedded execution;
- a database-backed memory and index layer, before Markdown plus bounded retrieval stops being adequate;
- simultaneous first-class development of several non-coding workflow packs.

**The next direction with real accumulated pressure** is the second non-coding pack. Documents and
PDF proved the contracts generalize once; slides would prove the *pattern* — spec, deterministic
render, visual verification loop — rather than the instance, reusing the same substrate.

The objective remains quality before capability count: broaden Agent CLI only when each new surface
inherits the same explicit authority, evidence, reversibility, recovery and completion semantics
that made v1.0 credible.
