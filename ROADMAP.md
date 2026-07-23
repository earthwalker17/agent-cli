# ROADMAP

Rolling execution record: the latest one or two sessions in full detail, older sessions
compressed under **Earlier Milestones** (per the rolling-docs policy in `CLAUDE.md`). Newest first.

---

## Session 10 (2026-07-23) — V0.8: repository intelligence and focused exploration

### Objective

Replace the broad file-list map with selective, ranked, task-directed retrieval and
disciplined parallel exploration (the new BLUEPRINT Session 10 direction): a ranked repository
index bounded by a hard context budget, a task-directed `retrieve` tool for the parent and
read-only roles, non-overlapping explorer briefs, and a structured explorer report contract —
preserving every kernel invariant and the flat-map fallback everywhere it still belongs.

### Planning provenance

3 Explore recon lenses (map/search/context surfaces; delegation/report surfaces;
tests/events/REPL conventions) + 1 Plan-agent adversarial critique of the draft design, every
load-bearing claim hand-verified. The critique caught two CRITICAL design flaws before code:
redefining `WorkspaceMap.sha256` as an inventory digest would silently change an existing
evidence field ("exactly what the model saw") — fixed as the additive `inventorySha256`; and
letting the retrieve tool write the index at query time would make a command-less observe
tool mutate durable state (the S6 trap) — fixed as assembly-only index writes with a
read-only in-memory handle. Also from the critique: a NAMED `retrieveTool` deps seam instead
of a generic extra-tools list (depth-1 stays structural), executor children keep the flat
worktree map (parent-index line refs would be wrong-tree), and extraction scoped to ts/js +
python (session-sized; tree-sitter deliberately not adopted — node-gyp Windows hazard, wasm
asset weight — behind the same interface if recall pressure ever demands it).

### What was implemented (commits `3a6bd2d`, `6d10689`, `c704dbe`, `9596ff5`, `9ed0426`, + docs)

1. **`feat(retrieval)` core** — `src/retrieval/`: git-backed inventory (ls-files + stats +
   per-file dirty paths via `-uall`, subdir-aware) with a render-independent path-SET digest;
   charset-constrained regex symbol/import extraction (identifier-class captures ARE the
   injection defense; secret-named/binary/oversize files never read); relative-import
   resolution (NodeNext `.js`→`.ts`) + bounded damped PageRank; a persisted incremental index
   at `<projectDir>/index/retrieval.json` (stat-diff refresh, corrupt/version-mismatch
   rebuilds bounded, wall-budget exhaustion = honest `'partial'` that converges across
   sessions, lock-less by design — idempotent derived cache, single assembly-time writer);
   structural + query ranking where EVERY hit carries signal attributions; a tiered map render
   whose complete directory tree is the recall backstop and which renders NO line numbers.
2. **`feat(workspace,memory,repl,cli)` assembly integration** — `buildRankedMap` (assembly-only
   entry; ANY failure falls back to the flat map with the reason in chrome); additive
   `workspace.mapped.inventorySha256/indexedFiles/indexState`; DUAL CODEBASE stamps
   (`map-digest` + `inventory-digest`; staleness prefers the file-SET compare when both sides
   have one — map-format changes cannot flap staleness; legacy stamps keep exact old
   semantics); `/map` re-renders the session handle (no disk write); first-run/partial states
   surface as chrome notes.
3. **`feat(tools,runtime,roles)` the retrieve tool** — per-session read-only view over the
   handle: ranked hits + signals + symbols + excerpts read LIVE at query time (stale index can
   misrank, never mislead a line reference; vanished hits dropped and counted; secret-named
   omitted); observe/auto-allow via declared readsPaths (ask on out-of-workspace scopes).
   Children get the SAME instance via the named `SubagentDeps.retrieveTool` seam — admitted
   iff the role contract names it AND the instance is structurally command/delegates/planDoc-
   free; executor deliberately excluded; child prompts name it only when admitted.
4. **`feat(tools,runtime,prompt)` briefs + report contract + hardening** — TaskSpec
   `focus`/`avoid` path prefixes; deterministic per-task brief lines (focus/avoid/hints +
   sibling coverage) in each child's first message; pairwise focus-overlap warnings
   (guidance + measurement, not enforcement); the explorer six-section report contract
   (Scope inspected/skipped, Findings, Change sites and risks, Tests, Open questions +
   confidence) with a non-blocking harness presence check ("treat as UNEXAMINED");
   delimiter neutralization of child reports and forwarded context (mimicry visibly marked,
   never hidden); retrieval-first + non-overlapping-focus prompt rules.
5. **`fix(retrieval,tools)` review batch** — the render budget made genuinely HARD (every
   tier charged, footer reserved, per-line clipping; budget-cut ranked tier always sets
   truncated); `..`-escaping focus prefixes are never disk-probed (isInside guard — no
   out-of-workspace existence oracle); tmp-file cleanup on failed index writes; fallback
   reasons in chrome; partial-state wording names stale-symbol carryover.

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite 515→**574 passed / 1 skipped
across 50 files (+59)**: extraction matrix incl. hostile fixtures (injection text, delimiter
strings, 3000-char identifiers), graph/rank determinism, store incremental/corrupt/budget/
secret/stale-carry paths, hard-budget renders under hostile long paths, dual-stamp staleness
matrix, retrieve policy shape + live-excerpt freshness + vanished-drop + admission fail-closed
pins, explorer-child retrieve e2e, briefs/overlap/section/delimiter e2e. Bounded adversarial
review: 3 read-only lenses over the session diff, findings hand-verified — 2 MEDIUM (render
budget) + 4 LOW fixed (above); invariant verdicts all HOLD (policy choke point, depth-1,
executor scoping, secrets, additive-v1, approval surfaces).

**Live proof** (`C:\Users\A\Desktop\agent-cli-s10-live\` — AB-EVIDENCE.md, VALIDATION.md,
live-transcript.txt, driver): on a 3,064-file vitest clone, the OLD flat map showed 272 paths
with **0 of 14 packages visible**; the ranked map shows **14/14** in ≤16k chars with honest
PARTIAL disclosure and measured cross-session convergence (689→1,071 files indexed over two
10s loads). Live REPL run (real claude-opus-4-8, exit 0, zero approval prompts): the parent
called retrieve twice, delegated TWO explorers with disjoint focus (one never left
`packages/snapshot/src`, the other `packages/vitest/src` — zero shared reads, no overlap
warning), a child's chained grep auto-denied and it adapted read-only, both children finished
in budget (7/11 steps), the report contract held (all six sections present in the child log),
and the parent re-verified every load-bearing claim itself before answering with the exact
change site (`inlineSnapshot.ts:123`) and its full plumbing chain. Parent session: 16 uncached
input tokens (cache 182.7k read) — caching intact under the ranked map.

### Decisions (and why)

- **The map digest split in two**: `sha256` stays "exactly the text the model saw" (evidence
  contract, unchangeable); `inventorySha256` digests the file SET for staleness (render-
  independent). One-time stamp churn accepted and documented.
- **Index writes are assembly-only**; the model-facing tool holds a read-only handle — the S6
  observe-trap closed structurally, and child concurrency needs no lock.
- **Excerpts and line numbers ALWAYS come from live reads** — a stale index may misrank but
  can never fabricate a line reference; `indexed at <generatedAt>` disclosure on every
  retrieve output.
- **Recall backstop over ranking confidence**: the complete directory tree renders in every
  map; ranking orders detail but never hides existence; retrieve/search/list_files span the
  full inventory.
- **Regex extraction over tree-sitter** for v1 (Windows-first, no native deps, declared
  ts/js+py support, honest coverage footers); the interface leaves tree-sitter as a later
  drop-in under demonstrated recall pressure.
- **Briefs are guidance + measurement, not enforcement** — read-only overlap is a cost
  problem; pretending a policy boundary would be dishonest.

### Open issues / boundaries (deliberate, documented)

- CODEBASE staleness over-marks (safe direction) for a session or two across ranked→flat→
  ranked map-mode transitions (transient git failure); stat-diff cannot see same-size
  same-mtime edits (misrank at worst — excerpts live).
- Partial-index sessions may carry stale symbols for budget-deferred changed files (disclosed
  in the coverage wording); convergence measured but multi-session on cold Windows FS.
- `/map`'s ranked/fallback REPL branches and the mapNote chrome line have no dedicated REPL
  test (recorded coverage gap); the retrieve excerpt surface keeps exact search-tool parity
  (raw lines into tool_results, documented).
- Delimiter neutralization is a soft defense (exact-prefix match; approximate mimicry
  survives) — layered with the provenance framing, not a boundary.

### Recommended next step

Session 11 per BLUEPRINT: iterative planning, task graphs, and parallel-first execution —
one canonical plan state with user/agent projections, approval-invalidating amendments, and
a bounded dependency-aware scheduler over the now retrieval-informed exploration layer.

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

## Earlier Milestones (Sessions 1–8 — compressed per the rolling-docs policy)

### Session 8 (2026-07-22) — V0.7: coordinated parallelism + the minimal agent-teams layer

The bounded agent-teams system on the proven single-task primitives (commits `d0abbb1`,
`15a1f93`, `58f06ed`, `2cfe2ca`, `a67cd94`; 450→498+1 tests). Roles became two-layer explicit
contracts — the `SUBAGENT_ROLES` policy fact table (types.ts; `decide()` fails closed outside
it) + `ROLE_CONTRACTS` runtime rows (registry/prompt/budget/approval mode), pinned consistent
at load. Parallelism lives in the delegate TOOL, not runTurn: one call = 1–3 tasks via
Promise.all = one evidence unit = ONE approval for a mutating group (schema max IS the
concurrency cap; runTurn stayed byte-identical). Plan mode: harness-owned plan documents at
`<projectDir>/plans/<sessionId>.md` (model writes ONLY via `update_plan` behind the fail-closed
`planDoc` branch; status is user-only; smuggled frontmatter stripped), `/plan approve` binding
the exact sha as consent evidence, standing per-turn injection with sovereignty wording, `@plan`
forced routing. Executor role: policy ask/`reversible` (`task.mutating-role`, deliberately
non-grantable) → ONE base checkpoint per group (dirty state included) → detached worktree per
task under the OS temp dir (placement DICTATED by validatePath) → bounded binary-safe capture
to content-addressed blobs recorded as `task.changes` (the diff OUTLIVES the worktree; removal
always in `finally`) → integration via `apply_task_changes` declaring real paths through
`mutates()` so the existing snapshot/undo/attribution machinery does the writing, per-file
drift-refuse. Approval forwarding: a serialized queue wrapping the SESSION approver
(non-interactive fails closed structurally), signal-linked entries, loud stale-answer discard,
forwarded deny-stop ends THAT task only. Concurrency foundations: `EventLog.open(expectFresh)`
atomic exclusive creation (id collision = structural refusal), atomic snapshot blobs,
per-operation temp randomness. Lasting decisions: worktrees of a trusted workspace are trusted
BY DERIVATION (never written to trust.json); stage order landed the plan-approval gate BEFORE
the capability it gates; executor spawns are never grantable. Still-relevant boundaries:
Ctrl+C aborts the whole turn (per-task cancel = forwarded deny-stop only); worktrees lack
gitignored files (honest UNVERIFIED reporting); the stale-forwarded-prompt line-consumption
wart (io redesign, deferred).

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
turn — latent until thinking ships); per-action / `--to` / `--steps` undo; network/web
tools; MCP and workflow packs; SQLite index over the JSONL; conversation rewind; session
pruning/sanitized export; prompt-history persistence + line-editing niceties; background/
long-running process sessions; PTY support; output spill-to-file for huge command output;
`--max-turns` flag vs internal `maxSteps` naming alignment; plan-file pruning (one doc per
session accumulates in the state dir).
**Retrieval follow-ups (post-S10):** tree-sitter (or richer) extraction behind the same
extract interface, more languages (go/rust/java/c#) as data-shaped table additions; a user
config knob for the map budget; /map REPL-branch + mapNote chrome tests; a post-group child
read-set overlap metric (child logs already carry the evidence); retrieval-aware journal
topics; ranked→flat staleness over-marking (transient, safe direction) if it ever bites.
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
