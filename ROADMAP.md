# ROADMAP

Rolling execution record: the latest one or two sessions in full detail, older sessions
compressed under **Earlier Milestones** (per the rolling-docs policy in `CLAUDE.md`). Newest first.

---

## Session 9 (2026-07-22/23) — pre-expansion consolidation, hardening, and the live V0.7 proof

### Objective

Prepare the kernel for the workflow-pack phase: audit the repository against the recorded
open issues, fix the verified session-sized gaps that matter before expansion, produce the
missing LIVE-API proof of the complete V0.7 loop, and reconcile the docs — without starting
the pack or any speculative abstraction.

### Audit provenance

3 bounded Explore lenses (recorded-issue verification against code; adversarial
concurrency/recovery/policy audit; hygiene + docs-drift + live-run recon) + 1 Plan-agent
adversarial critique of the fix design, every load-bearing claim hand-verified (CLAUDE.md
review discipline — 4 agents total). The audit CONFIRMED two real V0.7 defects (below),
verified most of the teams layer SOUND (forwarder signal-links, expectFresh, capture
correctness, apply idempotency, role tables, budgets), and found two recorded items already
CLOSED (the S6.5 auto-run command-shape hint ships at system-prompt.ts:30; the executor
gitignored-files gap is disclosed in the executor prompt + report footer). The critique
caught three design flaws before code: a naive registry lock would break the in-process
serialization that Promise.all fan-out relies on (and a same-pid stale-reclaim would let
group members steal each other's lock); base-ref deletion after capture would remove a
user-visible recovery point (moved to session end); approvalContext needed a render
contract (folded into `detail` to inherit sanitize + cap).

### What was implemented (commits `4e630ef`, `0255f8b`, `a8df0a8`, `7ba0fb8`, `0e8d376`, + docs)

1. **`fix(worktrees)` concurrent-session worktree safety [audit HIGH]** — the startup sweep
   removed ANY registered existing dir with no ownership/liveness check (two parent sessions
   in one project are supported; session B's sweep would destroy session A's LIVE executor
   worktree), and registry mutations were unlocked cross-process RMW (lost entries = never-
   swept orphans). Now: entries are owner-stamped (`ownerSessionId` + `pid`); every mutation
   runs under an in-process async mutex PLUS a token-based `O_EXCL` lock file (a live
   same-pid holder is NEVER reclaimed — group members share the pid; staleness = dead pid or
   over-age only; stale break = delete-then-retry-create, one winner); the lock is held only
   at registry read/write edges — never across git removals — and the sweep's save is a
   MERGE (re-read, drop only what it disposed of). The sweep skips live-pid entries, with a
   2h age hatch (executor wall clock is 12 min, so no live task's worktree is hours old —
   frees pid-recycled orphans). Legacy entries stay sweepable; the path guard is unchanged.
2. **`fix(plan,runtime,tools)` plan consent at the executor spawn ask [audit MED-HIGH]** —
   ARCHITECTURE documented the per-spawn ask as the enforcement point "which displays plan
   status", but `describeCall` showed only roles+tasks: a model can rewrite an approved plan
   (status is preserved by design) and the human approving the spawn could not see it. Now:
   `planApprovalSha(events)` is the ONE approval-state derivation (shared with injection);
   `ExecutorDeps.planContext()` returns {status, currentSha, approvedSha, diverged}; a new
   display-only `Tool.approvalContext?(input)` seam folds lines into the request's `detail`
   (inheriting sanitizeLine + the 12-line cap; a throw never blocks the ask; POLICY
   UNTOUCHED); the delegate tool renders APPROVED+matching / APPROVED-but-DIVERGED (both
   shas) / none / DRAFT / SUPERSEDED / approved-but-no-recorded-approval. The gate still
   blocks only draft/unknown (S8's decision: surface divergence, don't block).
3. **`fix(git,tools,cli)` task-base checkpoint ref hygiene [audit LOW-MED]** — one hidden
   ref per executor group accumulated forever. Now pruned at SESSION END (not after capture:
   the ref is a legitimate whole-workspace recovery point until quit; integration never
   needs it — apply reads blobs, asserted by test), announced in chrome and recorded as the
   additive `git.checkpoint.pruned` provenance event; `splice(0)` makes double-pruning
   impossible; a crash leaks refs to manual `agent checkpoint prune` (unchanged).
4. **`fix(exec,repl,cli,tools,report)` robustness batch [audit LOW]** — guarded
   `spec.onSpawn` (an evidence-append throw inside the 'spawn' listener was an unhandled
   crash); stateful StringDecoder live-preview decode (split runes rendered ��); one-shot
   approval prompts take the turn-abort signal (Ctrl+C → deny-stop instead of a hung
   readline); capture-cap `omittedCount` now travels into the changes registry (and its
   event-rebuild) and is re-stated at apply; cost roll-up — the report's Delegated-tasks
   section and `/tasks` print a labeled parent+children combined token line (session totals
   stay parent-only); dead `toolFingerprint` removed; three stale docblocks fixed.
5. **`fix(runtime,policy)` command grants — the live-E2E finding** — see below.

### The live-API E2E (the session centerpiece)

One scripted expect-style run (driver + pattern table + lockstep rule preserved in
`C:\Users\A\Desktop\agent-cli-s9-live\VALIDATION.md`; artifacts: transcript, decisions log,
all 5 session reports, plan document) against real claude-opus-4-8 in a fresh git workspace:
`@plan` → `update_plan` → `/plan approve` (sha-bound) → ONE delegate call → TWO parallel
worktree executors (group wall 17.7s) each running a real `node` assert-suite in its
worktree → both verifications FORWARDED (task-identity header + worktree/unsandboxed
honesty text) → capture (same base oid) → `apply_task_changes` ×2 through the snapshot
path → `/undo` → honest recovery → a 16-assertion parent-written check, real exit 0 → a
2-lens reviewer panel whose `run_command` attempts were all AUTO-DENIED (read-only contract
held live) with the parent re-running the load-bearing probe ITSELF → `/report` + `/diff`
→ `/quit` → task-base ref pruned live (`refs/agent-cli/` EMPTY after quit) → memory
narrative + journal + codebase written. 42 uncached input tokens (caching intact under the
teams layer); every child lineage-labeled; AGENT.md steering held (5/5 marker lines);
the Session 9 consent fix observed live (`plan: APPROVED (sha e91fc968…, matches the
user-approved bytes)` inside the spawn ask). Sovereignty behavior observed unprompted: told
(wrongly) that applied files were gone, the model checked the workspace, reported them
present, and proceeded from observable state.

**Live finding → fix `0e8d376`:** a forwarded command labeled `external` displayed
`[s] allow for the rest of this session` — a silent no-op (grants refuse command tools),
plus a latent enforcement hole: `applyGrant` upgrades any matching ask, so a session grant
on any FUTURE non-`run_command` command tool would have become standing shell permission
keyed on a text label. Both sides now key on the command FACT: the runtime stores a grant
only when `tool.command` is undefined (name check kept as defense in depth) and the prompt
hides [s] for command asks; forwarded asks always carry the THIS-TASK deny-stop wording and
a forwarded [s] reads "for the rest of THIS TASK". Pinned by the full options-line matrix +
an e2e proving a custom `external`-labeled command tool re-asks after a session-scope allow.

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite 498→**515 passed / 1 skipped
across 44 files (+17)**: lock protocol (same-pid never stolen, dead-pid/over-age/corrupt
breaks, fan-out atomicity, merge-on-save under concurrent registration), live/dead/aged
sweep discrimination against real git worktrees, all four consent-display cases on the
captured ApprovalRequest, throwing-approvalContext containment, session-end ref prune with
provenance + apply-after-prune, onSpawn-throw containment, split-rune preview decode,
omittedCount at apply, combined roll-up rendering, the options-line matrix, and the
command-grant e2e pin. Plus the recorded live run above (driver exit 0, 11/11 steps,
8 approvals all answered post-display).

### Decisions (and why)

- **The registry lock never copies the event-log's same-pid reclaim** — group members share
  one pid, so "same pid ⇒ stale" is exactly wrong there; staleness is dead-pid or over-age,
  and the age rule also frees a lock whose dead holder's pid was recycled onto US.
- **Sweep liveness errs toward keeping** (a recycled pid delays a sweep, never destroys
  live work), bounded by the age hatch grounded in the harness-fixed executor budget.
- **Base refs die at session end, not capture** — they are user-visible recovery points
  until quit; and their deletion is EVIDENCE (`git.checkpoint.pruned`), never silent.
- **Display mirrors enforcement for grants**: what the prompt offers must be exactly what
  the runtime would store; both now derive from the command FACT, not the tool name or the
  label.
- **The live driver never pre-supplies approval answers** — every prompt is answered after
  display (queue semantics on pipes exist for drivers, but consent evidence should show the
  prompt preceding the answer).

### Open issues / boundaries (deliberate, documented)

- The apply-as-one-undo-unit path is still mock-proven only: in the live run the model had
  already written the check script (per AGENT.md), so `/undo` correctly reverted that write
  instead of the apply (last-mutation semantics working as designed).
- Command labels stay noisy (the literal word "format" in a filename labeled a command
  `destructive`; `-e` labels node ESM one-liners `external`) — labels only inform the human
  and never grant; recorded as a known cosmetic with the CLIXML stderr noise.
- The stale-forwarded-prompt wart stands as documented: the discard is LOUD but the typed
  line is still consumed (io redesign, deferred pool).

### Recommended next step

Session 10 per BLUEPRINT: begin the documents/PDF workflow pack on the now live-proven
kernel — structured intermediate representation, renderer processes through `runManaged`,
domain verification beyond exit codes, no renderer logic inside runTurn/policy/REPL.

---

## Session 8 (2026-07-22) — V0.7: coordinated parallelism + the minimal agent-teams layer

### Objective

Build outward from the proven V0.6 single-task primitives into a minimal, bounded agent-teams
system — real plan mode (planner role + persistent user-editable plan document + explicit user
approval gate), parallel task groups, a mutating executor role isolated in git worktrees with
approval forwarding and reviewed integration, and a reviewer role for bounded adversarial
review — with roles as explicit contracts, no second runtime, no policy side door, and no
unbounded swarm.

### Planning provenance

3 Explore-agent recon passes (runtime/task/policy; git/trust/state layout; REPL/report/tests)
+ targeted external research (worktree-per-agent as the industry isolation primitive; plan mode
as enforced read-only + persistent plan file + approval gate) + a Plan-agent adversarial
critique, every load-bearing claim hand-verified. The critique caught one CRITICAL design flaw
before code — the draft placed worktrees under the state dir, where `validatePath` denies every
child write (`.agent-cli` segment + stateDir protection ⇒ tmpdir home + path-guarded registry
sweep instead) — plus: the same-pid lock RECLAIM would let a colliding child silently merge a
live sibling's evidence (fixed structurally, not by the TOCTOU guard); a sessionId suffix
cannot fix same-session concurrent checkpoint temp indexes (per-op randomness + one base per
group); deny-stop mapped to task status 'error' (would misrecord the new per-task user-stop);
`reconstruct` kept only the LAST task.started per callId (a crash mid-group would orphan
siblings' evidence); forwarded approvals could deadlock a dead child (signal-linked queue
entries); group approval prompts were unanswerable (delegates-aware describeCall +
taskContext); shared MockProvider cursors are nondeterministic under Promise.all (per-task
provider seam); pendingNotes clear after one turn (standing plan injection).

### What was implemented (commits `d0abbb1`, `15a1f93`, `58f06ed`, `2cfe2ca`, + docs; stage order A→B→D→C→E)

1. **Stage A `feat(store,git,ids)` concurrency foundations** — 32-bit session-id suffixes;
   `EventLog.open(expectFresh)`: atomic exclusive log creation BEFORE any lock interaction
   (collision ⇒ `FreshLogCollisionError` + regenerate — refusal is structural; the old
   existsSync check was TOCTOU and the same-pid reclaim made collisions silent); atomic
   snapshot-blob writes (temp+rename; losing the rename race to identical content is success)
   + additive `putBlob`; checkpoint/restore/commit temp names gain per-operation randomness
   (pid alone collides once ONE process runs concurrent sessions).
2. **Stage B `feat(policy,runtime,tools)` role contracts + parallel groups** — `SUBAGENT_ROLES`
   policy-fact table in types.ts (explorer/planner/reviewer read-only; executor
   mutating-worktree) + `runtime/roles.ts` RoleContract rows (registry, prompt builder, budget,
   approval mode; load-time consistency check); step-0 rewritten for batches (try/catch around
   the fact, empty/unknown/conflicting deny, strictest member governs); `delegate_task` takes
   `tasks[1..3]` run via `Promise.all` INSIDE the tool — `runTurn` byte-identical, one call =
   one group = one evidence unit; caps: 12 tasks/session group-atomic + 150k cumulative child
   output tokens; planner/reviewer prompt builders over the shared read-only scaffold;
   consumers batch-corrected (childSessionId joins, reconstruct keeps all task.started per
   callId, task chrome + turn-summary counts, delegates-aware approval descriptions).
3. **Stage D `feat(plan,policy,repl,cli)` plan mode** — plan documents at
   `<projectDir>/plans/<sessionId>.md`: lenient never-throwing reads, atomic writes,
   blob-archived priors, harness-owned frontmatter (model writes NEVER change status; smuggled
   frontmatter stripped); `update_plan` behind the new fail-closed `planDoc` policy branch
   (the S6 observe-trap pinned a third time); `plan.updated` via the callId-bound `reportPlan`
   channel; `/plan show|approve|discard` with approval binding the exact sha (consent
   evidence; later divergence surfaced, never hidden); `@plan` forced routing; standing
   per-turn injection (full content only when the sha is new to the model, pointer otherwise,
   sovereignty wording verbatim); executor gate on unapproved plans; `agent plan` CLI; report
   "## Plan" section; system-prompt Planning rule.
4. **Stage C `feat(git,runtime,tools)` executor role** — policy flip to ask/`reversible`
   (`task.mutating-role`, deliberately non-grantable — every spawn is a human decision); ONE
   base checkpoint per group (dirty parent state included) → detached worktree per task under
   `<os-tmp>/agent-cli-worktrees/<slug>/` (placement dictated by validatePath) → child scoped
   to the worktree with fresh git facts/map → bounded binary-safe capture (porcelain
   enumerate, read-tree+checkout-index base staging, content-addressed blobs, 200 files/5 MiB
   caps, overlap warnings) recorded as `task.changes` → worktree ALWAYS removed (EBUSY retries
   + rm fallback + prune; failures are `worktree.removed ok:false` evidence; crash orphans
   swept at assembly from a path-guarded registry). Approval forwarding: serialized queue
   wrapping the SESSION approver (non-interactive fail-closes structurally, EOF cascades
   deny-stop), taskContext-labeled prompts, signal-linked entries ('task-aborted' auto-deny,
   loud stale-answer discard), forwarded deny-stop ends THAT task only (`user-stopped`).
   Integration: `apply_task_changes` declares apply-eligible paths via `mutates()` (never
   null) so the existing snapshot/file.mutated/undo/attribution machinery does the writing;
   per-file drift-refuse; registry rebuilt from events on resume. Trust decision: worktrees of
   a trusted workspace are trusted BY DERIVATION, never written to trust.json.
5. **Stage E `feat/docs`** — review-stage prompt rule (ONE bounded panel of 2–3 reviewer
   lenses, parent hand-verifies findings — the CLAUDE.md cost discipline encoded in the
   product prompt); report "Task changes and integration" section + executor honesty footer;
   render-only stall chrome ("no activity for Ns"); USAGE bump; ARCHITECTURE/ROADMAP/BLUEPRINT
   updates.

### Verification evidence

- **Gate:** `npm run typecheck` + `npm run build` clean per commit; suite grew 450→**498
  passed / 1 skipped across 42 files (+48)**: expectFresh refusal leaves a live sibling's lock
  byte-identical and its log writable; startSession regenerate/exhaustion; atomic blobs;
  concurrent same-pid checkpoints (distinct refs, correct trees, clean state dir); policy
  pinning-table extensions (batch unknown/empty/throwing/conflicting; executor ask/reversible
  + reversible-grant no-op; planDoc trap pins); 3-child parallel e2e (per-child providers, one
  callId, three lineage-stamped logs, ordered labeled reports, context passthrough); abort
  mid-group ends every child `aborted` with a complete parent log; group-atomic cap refusal
  spawns nothing; plan store roundtrip/status-preservation/frontmatter-smuggle/leniency/
  user-edits-win; REPL plan e2e (update_plan → /plan approve → labeled injection → divergence
  → discard stops injection; @plan routing); forwarder units (FIFO, abort-while-queued never
  displays, loud late-answer discard, throwing base fails closed); real-git executor e2e
  (dirty base reached the child, isolation proven from both logs, capture shapes incl.
  delete, cleanup + empty registry, apply through the snapshot path with one-unit undo, drift
  refusal declares nothing and touches nothing, forwarded deny-stop → `user-stopped` with the
  parent turn surviving, draft-plan block, path-guarded sweep leaves foreign dirs untouched,
  honest no-repo refusal); report plan/integration sections.
- No live-API E2E this session (mock-driven e2e coverage is dense; a live plan→approve→
  executor→apply→review run is the recommended first act of Session 9).

### Decisions (and why)

- **Parallelism lives in the delegate tool, not runTurn** — one call = one parallel group = one
  attributable evidence unit = one approval for a mutating group; the kernel loop stays
  byte-identical (the strongest form of the one-runtime invariant); the schema max (3) IS the
  concurrency cap.
- **Roles are two-layer contracts:** the policy fact table (types.ts, data-only — decide()
  fails closed on anything outside it) and the runtime contract table (roles.ts). Adding a
  role is a deliberate two-table act, pinned by a load-time consistency check.
- **Stage order A→B→D→C** (BLUEPRINT said worktrees before parallel groups): D-before-C lands
  the plan-approval gate BEFORE the capability it gates and makes the coherent fallback
  increment (plan mode + parallel read-only teams) if C overran.
- **Worktrees live in the OS temp dir** — dictated by verified policy behavior, not taste:
  under the state root every executor write would deny (`.agent-cli` segment rule); under the
  project dir likewise (stateDir protection). The registry+sweep owns the crash story and can
  never touch a path it did not create.
- **The diff outlives the worktree:** capture-to-blobs + `task.changes` events make the
  worktree disposable (removed in finally, every time) and integration replayable across
  crashes/resume — no long-lived checkout to leak, reconcile, or trust.
- **Integration rides the existing write path** — apply declares real paths via `mutates()`,
  so snapshot/undo//diff//commit attribution came for free and the S6 observe-trap stayed
  closed. Per-file drift-refuse mirrors the snapshot-restore philosophy.
- **Plan approval binds bytes, not vibes:** `plan.approved {sha256}` is the consent record;
  the file's current bytes stay truth; divergence is surfaced at every injection and executor
  spawn rather than silently blocking (the per-spawn ask is the enforcement point).
- **Executor spawns are never grantable** (`reversible` excluded from GRANTABLE, pinned): a
  session grant would let later groups mutate with no human in the loop.

### Open issues / boundaries (deliberate, documented)

- Per-task cancellation = forwarded deny-stop + harness causes (timeout/tokens/parent-abort);
  a mid-turn task-management UI (list/cancel while running) remains deferred. Ctrl+C still
  aborts the whole turn.
- A stale forwarded prompt left displayed after its task dies consumes the user's next typed
  line as its answer; the discard is LOUD (chrome line) but the line is still consumed —
  bounded, documented, fixable only with a deeper io redesign.
- Executor worktrees lack gitignored files (no node_modules): builds/tests may need installs
  (forwarded approval) or the executor honestly reports UNVERIFIED. Sandbox scratch TEMP is
  still shared across concurrent sandboxed auto-run commands (read-only commands; collision
  risk accepted). Task-base checkpoints accumulate as hidden refs until `checkpoint prune`.
- The reviewer stage is prompt-shaped (role contract + review rule), not structurally forced;
  the parent may skip review — the report's CHECKED/diff surfaces stay the backstop.
- `--provider mock --script` still shares one script between parent and children (tests use
  the per-task provider seam); no cross-log cost roll-up view yet; task resume, inter-agent
  messaging, and deeper child-report instruction-scanning remain out (delimiters + provenance
  labels stand).

### Recommended next step

Live-API E2E of the full V0.7 loop (@plan → approve → parallel executors with a forwarded
approval → apply → review panel → /undo), then per BLUEPRINT: the first non-coding workflow
pack (documents/PDF) on the now-complete kernel, or the deferred-pool UX debts (per-task
cancel UI, cross-log cost roll-up) if live usage surfaces friction first.

---

## Earlier Milestones (Sessions 1–7 — compressed per the rolling-docs policy)

### Session 7 (2026-07-20/21) — V0.6: main-agent control layer — memory + subagent tasks

The three-document project memory (user-owned `AGENT.md` injected every session; harness-
generated rolling `JOURNAL.md` + `CODEBASE.md` at the state root — model-written sections
always paired with a deterministic event-derived Evidence section, provenance stamps,
rolling caps, the verbatim "CONTEXT, NOT AUTHORITY" framing; ONE cache-prefix-reusing
narrative call at clean session end, every failure degrading to a deterministic skeleton,
recorded as `memory.narrative` — never fake message events, which would replay into
resumes) + the first task/subagent primitives (read-only `explorer`: ONE child session over
the SAME `runTurn` — a task = one turn, so turn cancellation IS task cancellation; the
fail-closed step-0 `delegates` policy branch; harness-fixed budgets with cause-tracked
cancellation; callId+childSessionId evidence lineage; autoDeny approver;
`latestSessionId` child-skip so `--continue`/undo/diff can never silently target a child
log) + `assembleSession` (the ONE construction path both interfaces consume; trust is a
parameter, so assembly is structurally impossible untrusted). 450+1 tests (+47). Live
two-session E2E: delegation with unprompted parent re-verification of child narration,
AGENT.md steering, cross-session journal recall with the context-not-authority caveat
volunteered, 6 uncached input tokens. Lasting decisions: memory is context-not-authority
STRUCTURALLY (evidence from events, crash notes from log tails — absence of memory never
accuses a session); `aborted ≠ user-quit` (`endReasonForTurn` — post-session work must
never fire after Ctrl+C); delegation budgets are harness-fixed, never model-controlled.
Still-relevant: memory docs are lock-less (a seconds-wide last-writer-wins window at
simultaneous quits, documented; the log stays the evidence); the journal inject cap slices
the newest-first top.

### Session 6.5 (2026-07-19) — V0.5 capability demo + production-style validation

One continuous ~68-min recorded run (real ConPTY → xterm.js → Playwright, byte-truthful,
supervisor-driven, live claude-opus-4-8): Agent CLI built **LedgerLite** (personal finance
tracker; 20 files, 51 unit tests, esbuild build) from a natural-language brief with 13 live
approvals, then demonstrated status/diff/attributed commits (`package-lock.json` honestly
excluded as unattributable)/checkpoint/restore/undo/report, sandboxed auto-run `git status`,
deny-adapt (the fallback summary labeled itself "not a live diff read"), harness-note
coherence after /undo, and **124 uncached input tokens** for the whole session (cache 2.07M
read). Two product fixes with regression coverage from the pre-run foundation review: sandbox
probe 60s+retry behind an injectable ProbeRunner (`763032f` — a loaded probe took ~18s vs the
old 30s timeout, silently degrading to fail-closed) and the Low-IL test's absolute-System32
whoami (`21a8c40`). Suite 403+1. Evidence: `C:\Users\A\Desktop\ledgerlite\validation\` (MP4,
raw PTY transcript, deterministic session report, VALIDATION.md). Lasting decisions: validation
sessions live OUTSIDE the product repo; the bridge identifies itself truthfully
(`TERM_PROGRAM`); demo briefs state git authority explicitly. Standing findings: the
positive-proof auto-run gate rarely fires for the model's natural chained/flagged command
style (system-prompt hint in the deferred pool); probe cost ~4–11s on this machine.

### Session 6 (2026-07-18) — V0.5: Git-native, reviewable, context-efficient

GitOps as a **harness-only capability** — a policy regression test pins why it must never be a
model tool (a command-less, mutation-less tool auto-allows as observe; a "git_commit tool"
would commit with NO approval): hardened substrate (absolute-path git resolved by scanning
PATH — a workspace-planted git.exe must never execute; `core.fsmonitor=false`;
`GIT_OPTIONAL_LOCKS=0`; GIT_* scrub; no prompts; bounded timeouts), probed `git.context`,
attributable `/diff` + `agent diff` (first pre-image blob → disk, undo folded, DRIFTED
flagged), session-scoped `/commit` (stages ONLY status∩attribution; blockers where attribution
would corrupt; Session line + Co-authored-by trailer), hidden-ref checkpoints
(`refs/agent-cli/checkpoints/<session>/<n>`, user git state byte-identical, "low-pollution
not zero") with snapshot-first restore that is ONE applyUndo unit — git is never the undo
mechanism (the Codex ghost-commit data-loss lesson). Context efficiency: two-breakpoint prompt
caching (live: ~6 uncached input tokens/session), deterministic monotone elision (boundary a
function of raw only-growing size ⇒ no oscillation, no stored state, identical on resume;
tool outputs only), git-backed workspace map (nested gitignore correct; pre-trust keeps the
pure walker). Editing: replace_all + line paging. **Consent contract made explicit:**
user-typed commands ARE consent under three conditions — preview+confirm on every mutating
flow, a provenance event per operation, GitClient structurally unreachable from the model.
398+1 tests; scripted REPL + CLI round-trip + live-API E2E. Still-open from S6: approved
run_command file effects structurally under-claimed by attribution; restore materializes the
git-native worktree form (same lossy round-trip as git itself); `agent commit`/`checkpoint`
need the session lock (a live session blocks them by design).

### Session 5 (2026-07-18) — V0.4: enforced isolation + automatic command review

An OS-enforced Windows boundary plus deterministic automatic command review, **feasibility proven
by direct machine probe before any code**: as a standard non-admin user, a Low-integrity child
(duplicated, lowered copy of our own token via `CreateProcessAsUser`) is write-DENIED by MIC to
the workspace/profile/state dirs while stdout flows through inherited pipes; `WRITE_RESTRICTED`
restricted tokens FAILED (err 1314) — so Low IL + Job Object (KILL_ON_JOB_CLOSE, process cap) is
the mechanism. `src/sandbox/`: `SandboxBackend` with a `wrapSpec` transform-at-spawn seam, honest
`none` backend, and `windows-lowil` — a versioned PowerShell + inline-C# (Add-Type P/Invoke) host
that re-launches the target at Low IL forwarding inherited std handles, so `runManaged`
capture/kill are unchanged; enforcement is established by a runtime **self-test probe**, never
assumed, and degrades fail-closed. `policy/command-review.ts`: `analyzeCommand` is a POSITIVE
proof of safety (single simple command, zero metacharacters/encoding, curated read-only
allowlist, per-executable arg checks, escape guard); auto-run requires proof AND an active
boundary and executes INSIDE it; otherwise ask; no enforcement ⇒ every command asks. Approved
commands deliberately run unsandboxed (the user accepted the risk — Codex's model). Labels
hardened (LOLBAS/encoded no longer read benign) but only ever inform the human. `run_command`
moved to `-EncodedCommand`; report gained the sandbox header + per-command boundary markers +
mode-aware honesty footer. **Evidence:** 321 passed/1 skipped (+80); 8 real-OS win32 tests
(write DENIED to workspace+state, reads allowed and stated, child at Low IL, detached grandchild
reaped on kill — closing the S4 taskkill gap); 66-assertion adversarial corpus (40+ escape forms
NEVER auto-run); live CLI E2E with sandboxed auto-run + non-interactive auto-deny. **Honest
scope (unchanged since):** confines writes + lifecycle on Windows only; reads, network,
Low-labeled locations, and service-reparented work are NOT confined. **Still open from S5:**
per-command Add-Type host latency (S6.5 measured the probe at ~4–11 s on this machine); CLIXML
stderr cosmetics.

### Session 4 (2026-07-17) — V0.3: execution kernel hardening

Managed exec substrate (`src/exec/`: env hygiene with a non-excludable core floor, verified
best-effort tree kill, `runManaged` kill/drain state machine that never awaits `'close'`
unconditionally — the nodejs/node#21960 grandchild-pipe hang class, regression-tested); real
mid-command cancellation end-to-end (REPL + one-shot, proven with a genuine delivered console
CTRL_C against the live API); typed termination — **a killed command has no exit code,
everywhere**, and the report vetoes CHECKED on kill evidence; additive `command.started/ended`
lifecycle events; Ctrl+C wiring + live render-only output preview. **Lasting decisions:**
force-kill only, labeled best-effort (no graceful console kill from stock Node on Windows;
`taskkill /T` cannot reach re-orphaned grandchildren — later closed by the S5 Job Object for
sandboxed runs); `'interrupted by user'` reserved for never-spawned calls; env hygiene
default-on with proxy passthrough documented as an honest limitation, not a boundary; evidence
channels are callId-bound by the runtime so tools cannot forge another call's evidence.
**Evidence:** 240 passed/1 skipped (+35); two live E2E runs (env-hygiene echo; keystroke-level
CTRL_C interrupt with full evidence chain). **Cost lesson (now a CLAUDE.md rule):** a
per-finding 3-verifier fan-out exploded (19 findings → ~57 agents) and was aborted; findings
were salvaged from the workflow journal and verified BY HAND — review workflows stay bounded
(~a dozen agents), no per-finding verifier panels. Three low-severity review findings remain
open (append-inside-spawn-listener robustness; live-preview per-chunk decode; one-shot
approval-prompt Ctrl+C path).

### Session 3 (2026-07-16) — Recorded live E2E demo + two defects it surfaced

Not a product increment: a truthful, continuous **11m20s Playwright-recorded** demonstration of
the V0.2 loop (empty-folder launch, on-camera trust consent, natural-language build of a complete
web app with inline approvals, in-session `/report`, quit, interactive resume with a follow-up
change, starting the generated server, driving it in the browser). Artifacts live OUTSIDE this repo
(`C:\Users\A\Desktop\agent-cli-demo-20260716\`). The agent (real `claude-opus-4-8`) built
**FlowBoard** (7 files, ~865 lines, 15 unit tests) in one 128s turn + a 35s resumed turn, 2
approvals, all files CHECKED. **Product yield (2 fixes, both regression-tested):** the CLI entry
guard now realpaths `argv[1]` so the `npm link` shim no longer exits 0 silently (Node realpaths the
main module URL); vitest `testTimeout` raised to a 60s hang backstop (bare Node spawns can take
seconds under load). **Lasting decision:** record a browser-hosted real terminal (xterm.js ↔ ConPTY
bridge) since the CLI needs a real TTY; every displayed byte comes from the PTY, injected setup
lines disclosed. **Evidence:** 205 passed/1 skipped; the recorded session's evidence chain was
independently audited by a 4-agent workflow (report ↔ raw JSONL consistent, snapshots re-hash,
isolation clean). **Still-relevant nuance:** the report's "Files changed" uses last-mutation-per-path
semantics, so a create-then-edit renders as `modify`.

### Session 2 (2026-07-15) — V0.2: interactive REPL, workspace trust, narrowing-only config

One-shot CLI evolved into a practical interactive REPL sharing the exact same runtime (one
`runTurn`, no parallel loop), with turn abort at tool boundaries, a live `EventLog.onAppend`
renderer, and subprocess smoke tests. **Lasting decisions:** workspace trust is recorded consent
(never a sandbox) — prompt only on a real TTY, `--trust-this-workspace` never persists, a folder
cannot self-grant (state-root-inside-workspace refusal), corrupt trust store is a hard error;
workspace config narrows only (strict schemas structurally cannot widen; no allowlists) and
carries no preferences; the screen renders from the persisted log, stdout stays model-text-only;
`user-quit` for every human-initiated end; approval questions accept only lines typed after the
prompt is visible (type-ahead cannot answer a security prompt); approval prompts sanitize
model-controlled text (ANSI/bidi). **Evidence:** 204 passed/1 skipped; three live E2E rounds
(build + deny-adapt + `/undo` + interactive resume) with three real defects found and
regression-tested (in-session `/report` status, denied command listed as run, piped transcripts
losing dialogue); post-E2E adversarial review found four more real defects, all fixed + tested
(type-ahead approval, unsanitized approval prompt, abort-skipped commands under "Commands run",
trust-consent Ctrl+D exiting 0). **Still relevant:** `agent map` stays ungated pre-trust
(documented exception); V0.2's "abort lands at the next tool boundary" limitation was removed in
Session 4.

### Session 1b (2026-07-14) — Automatic proxy support + verified live E2E

Reusable proxy-aware transport (`net/transport.ts`): pure `resolveProxy` over standard env vars
with correct precedence/`NO_PROXY` bypass; per-request undici `ProxyAgent` dispatcher (never
`setGlobalDispatcher`); credentials redacted from descriptions and never persisted; no `--proxy`
flag (argv is logged — a credential-bearing URL must not land in `session.started`). Closed
Session 1's one unverified surface: the full live loop (create + edit + undo) verified against
the real API through the system proxy; 143 passed/1 skipped.

### Session 1 (2026-07-14) — V0.1: the bounded local agent loop

The seven-pillar foundation, all tested (121 passed/1 skipped + dogfood run): typed contracts
(`types.ts`), append-only JSONL event log (atomic lock, tail repair, corruption refusal,
versioned schema), one pure policy choke point + Windows-first path validator (device/UNC/ADS/
reserved rejects, junction escape, sibling-prefix containment), five file tools + `run_command`
(PowerShell `$LASTEXITCODE` propagation), content-addressed snapshots with drift-refusing
restore + undo, resume with postHash crash reconciliation, bounded gitignore-aware workspace map,
deterministic evidence report (mechanical CHECKED/UNCHECKED), Mock + streaming Anthropic
providers. **Lasting decisions:** no *widenable* allowlist config — the label only informs the
human (V0.1 asked on every command; **superseded in S5** by deterministic automatic review, where
a positive-proof-safe command auto-runs *inside* the enforced sandbox); in-workspace writes
auto-allow but snapshot first; sandbox vs approval kept separate — V0.1 shipped approval only and
said so, **and S5 added the enforced Windows sandbox axis**; one path validator for policy and
tools; secret reads redacted in the log via salted HMAC (model still sees real bytes; redacted
reads deliberately cannot replay on resume); state lives outside the workspace; `thinking` omitted
pending block-preservation work. **Still-true limitations:** command output not scrubbed for
secrets; path checks TOCTOU-racy; undo is file-only; single-user lock assumption. (V0.1's "no OS
sandbox" limitation is closed on Windows in S5 — writes only; reads/network remain unconfined.)

---

## Deferred pool (accumulated, still open)

Adaptive thinking with block preservation (`pause_turn` is mapped but the loop would end the
turn — latent until thinking ships); per-action / `--to` / `--steps` undo; tree-sitter
ranked repo map with selective retrieval (S6 shipped the git-backed file LIST only); network/web
tools; MCP and workflow packs; SQLite index over the JSONL; conversation rewind; session
pruning/sanitized export; prompt-history persistence + line-editing niceties; background/
long-running process sessions; PTY support; output spill-to-file for huge command output;
`--max-turns` flag vs internal `maxSteps` naming alignment; plan-file pruning (one doc per
session accumulates in the state dir).
**Task/subagent follow-ups (post-S8/S9):** a mid-turn per-task management UI (list/cancel
while running — today: forwarded deny-stop + harness causes); task resume/continue
(SendMessage-style); deeper scanning of child reports for instruction-shaped content (v1
ships delimiters + provenance labels); the stale-displayed-forwarded-prompt line-consumption
wart (the discard is LOUD since S8, but the typed line is still consumed — needs an io
redesign); per-child sandbox scratch TEMP isolation; a per-child `--script` seam for the
mock provider (tests use the providerForTask seam; production children share one script);
a structural (not prompt-shaped) review gate. **Memory follow-ups (post-S7):** journal
topic files / retrieval beyond the newest-first inject window; a memory relocation/config
knob; a cross-process memory-doc lock (today: a seconds-wide last-writer-wins window at
simultaneous quits); model-generated compaction of assistant/user text (deterministic
tool-output elision shipped; loud warning when even full elision exceeds the target).
**Git follow-ups (post-S6):** patch/multi-edit editing; model-generated commit messages;
attribution of approved run_command file effects (structurally under-claimed today);
push/PR flows; submodule + multi-repo workspaces. **Sandbox follow-ups (post-S5):**
network-egress control and a read/confidentiality boundary (the two enforced gaps that most
matter); a cached/compiled sandbox host to cut per-command Add-Type latency (~1.2 s; probe
~4–11 s on this machine); macOS/Linux enforcement backends; containment of
service-reparented work (schtasks/sc/wmic/BITS) that escapes the Job Object.
**Cosmetics (recorded, informational-only):** command-label noise — word-boundary matches
can mislabel (the literal "format" in `format.js` → destructive; `-e` ESM one-liners →
external); labels never grant and never gate, they only inform the human. PowerShell CLIXML
progress-stream noise on some chained commands' stderr.
