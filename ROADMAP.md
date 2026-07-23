# ROADMAP

Rolling execution record: the latest one or two sessions in full detail, older sessions
compressed under **Earlier Milestones** (per the rolling-docs policy in `CLAUDE.md`). Newest
first. Contracts and mechanisms live in `ARCHITECTURE.md`; this file records what each session
attempted, verified, decided, and left open.

---

## Session 10 (2026-07-23) — V0.8: repository intelligence and focused exploration

### Objective

Replace the broad file-list map with selective, ranked, task-directed retrieval and disciplined
parallel exploration (the BLUEPRINT Session 10 direction), preserving every kernel invariant and
the flat-map fallback everywhere it still belongs.

### Planning provenance

3 Explore recon lenses + 1 Plan-agent adversarial critique, every load-bearing claim
hand-verified. The critique caught two CRITICAL design flaws before code: redefining
`WorkspaceMap.sha256` as an inventory digest would silently change an existing evidence field
("exactly what the model saw") — fixed as the additive `inventorySha256`; and letting the
retrieve tool write the index at query time would make a command-less observe tool mutate
durable state (the S6 trap) — fixed as assembly-only index writes with a read-only in-memory
handle. Also from the critique: a NAMED `retrieveTool` deps seam (not a generic extra-tools
list — depth-1 stays structural); executor children keep the flat worktree map (parent-index
line refs would be wrong-tree); extraction scoped to ts/js + python (tree-sitter deliberately
not adopted — node-gyp Windows hazard, wasm asset weight — same interface if recall pressure
ever demands it).

### What was implemented (commits `3a6bd2d`, `6d10689`, `c704dbe`, `9596ff5`, `9ed0426`, + docs)

Full contracts in ARCHITECTURE ("Repository intelligence" + the roles/briefs additions):

1. **`feat(retrieval)` core** — `src/retrieval/`: inventory + digest, charset-constrained regex
   extraction, import graph + PageRank, the persisted incremental index (honest `partial`,
   converges, lock-less), signal-attributed ranking, and the tiered hard-budget map render.
2. **`feat(workspace,memory,repl,cli)`** — `buildRankedMap` at assembly with flat-map fallback
   (reason surfaced in chrome); additive `workspace.mapped` fields; dual CODEBASE stamps so
   map-format changes cannot flap staleness; `/map` re-renders the session handle.
3. **`feat(tools,runtime,roles)`** — the `retrieve` tool (observe/auto-allow; live-read
   excerpts) for the parent and, via the structurally-checked `retrieveTool` seam, the
   read-only child roles; executor deliberately excluded.
4. **`feat(tools,runtime,prompt)`** — TaskSpec `focus`/`avoid` briefs with sibling coverage and
   pairwise overlap warnings; the six-section explorer report contract with a non-blocking
   presence check; delimiter neutralization of child reports and forwarded context;
   retrieval-first prompt rules.
5. **`fix(retrieval,tools)` review batch** — render budget made genuinely HARD (hostile long
   paths pinned); `..`-escaping focus prefixes never disk-probed (no out-of-workspace existence
   oracle); tmp-file cleanup on failed index writes; fallback reasons in chrome; partial-state
   wording names stale-symbol carryover.

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite 515→**574 passed / 1 skipped
across 50 files (+59)** — hostile-fixture extraction, graph/rank determinism, store
incremental/corrupt/budget/secret/stale-carry paths, hard-budget renders, dual-stamp staleness
matrix, retrieve policy shape + excerpt freshness + admission fail-closed pins, and
briefs/overlap/section/delimiter e2e through the real delegation path. Bounded adversarial
review: 3 read-only lenses over the session diff, findings hand-verified — 2 MEDIUM + 4 LOW
fixed (item 5); every invariant verdict HOLDS (policy choke point, depth-1, executor scoping,
secrets, additive-v1, approval surfaces).

**Live proof** (`C:\Users\A\Desktop\agent-cli-s10-live\` — AB-EVIDENCE.md, VALIDATION.md,
transcript, drivers): on a 3,064-file vitest clone the OLD flat map showed 272 paths, **0 of 14
packages visible**; the ranked map shows **14/14** in ≤16k chars with honest PARTIAL disclosure
and measured convergence (689→1,071 files over two 10s loads). Live REPL run (real
claude-opus-4-8, exit 0, zero approval prompts): parent used retrieve first, ran TWO explorers
with disjoint focus (zero shared reads), a child's chained grep auto-denied and it adapted,
both finished in budget, all six report sections present, and the parent re-verified every
load-bearing claim before naming the exact change site (`inlineSnapshot.ts:123`) with its
plumbing chain. 16 uncached parent input tokens (cache 182.7k read) — caching intact.

### Decisions (and why)

- **The map digest split in two**: `sha256` stays the evidence contract; `inventorySha256`
  (file SET) drives staleness. One-time stamp churn accepted.
- **Index writes are assembly-only**; the tool holds a read-only handle — the S6 observe-trap
  closed structurally, and child concurrency needs no lock.
- **Excerpts/line numbers ALWAYS come from live reads** — a stale index may misrank, never
  fabricate a line reference (`indexed at …` disclosed on every output).
- **Recall backstop over ranking confidence** — the complete directory tree renders in every
  map; ranking orders detail, never hides existence.
- **Regex extraction over tree-sitter** for v1 — Windows-first, no native deps, declared
  coverage; tree-sitter remains a drop-in under demonstrated recall pressure.
- **Briefs are guidance + measurement, not enforcement** — read-only overlap is a cost problem;
  pretending a policy boundary would be dishonest.

### Open issues / boundaries (deliberate, documented)

- CODEBASE staleness over-marks (safe direction) for a session or two across ranked→flat→ranked
  map-mode transitions; stat-diff cannot see same-size same-mtime edits (misrank at worst).
- Partial-index sessions may carry stale symbols for budget-deferred files (disclosed);
  convergence is multi-session on a cold Windows FS.
- `/map`'s REPL branches + mapNote chrome untested (recorded gap); retrieve excerpts keep exact
  search-tool exposure parity; delimiter neutralization is a soft defense layered with the
  provenance framing, not a boundary.

### Recommended next step

Session 11 per BLUEPRINT: iterative planning, task graphs, and parallel-first execution — one
canonical plan state with user/agent projections, approval-invalidating amendments, and a
bounded dependency-aware scheduler over the now retrieval-informed exploration layer.

---

## Session 9 (2026-07-22/23) — pre-expansion consolidation, hardening, and the live V0.7 proof

### Objective

Audit the repository against the recorded open issues, fix the verified session-sized gaps that
matter before expansion, produce the missing LIVE-API proof of the complete V0.7 loop, and
reconcile the docs — no new capability, no speculative abstraction.

### Audit provenance

3 bounded Explore lenses + 1 Plan-agent critique, hand-verified. The audit CONFIRMED two real
V0.7 defects (items 1–2), verified the teams layer otherwise SOUND, and found two recorded
items already closed. The critique caught three design flaws before code: a naive registry lock
would break the in-process serialization Promise.all relies on; base-ref deletion after capture
would remove a user-visible recovery point (moved to session end); approvalContext needed a
render contract (folded into `detail` to inherit sanitize + cap).

### What was implemented (commits `4e630ef`, `0255f8b`, `a8df0a8`, `7ba0fb8`, `0e8d376`, + docs)

Mechanisms in ARCHITECTURE (worktree registry concurrency; approvalContext; grants):

1. **`fix(worktrees)` concurrent-session worktree safety [HIGH]** — the startup sweep could
   destroy a live sibling session's executor worktree and registry RMW was unlocked. Now:
   owner-stamped entries, in-process mutex + token `O_EXCL` lock file, live-pid sweep skip with
   a 2h age hatch, merge-on-save. A live same-pid holder is NEVER reclaimed (group members
   share the pid — the event-log's same-pid rule must not be copied here).
2. **`fix(plan,runtime,tools)` plan consent at the executor spawn ask [MED-HIGH]** — the human
   approving a spawn could not see plan-approval state. Now the display-only
   `Tool.approvalContext` seam renders APPROVED / DIVERGED (both shas) / DRAFT / SUPERSEDED at
   the consent moment; policy untouched; the gate still blocks only draft/unknown.
3. **`fix(git,tools,cli)` task-base ref hygiene [LOW-MED]** — refs accumulated forever; now
   pruned at SESSION END (they are recovery points until quit), announced and recorded as
   `git.checkpoint.pruned`; a crash leaks refs to manual `agent checkpoint prune`.
4. **`fix(exec,repl,cli,tools,report)` robustness batch [LOW]** — onSpawn-throw containment;
   stateful preview decode (split runes); one-shot approval Ctrl+C; `omittedCount` at apply;
   combined parent+children token roll-up; dead code + stale docblocks removed.
5. **`fix(runtime,policy)` command grants — the live-E2E finding** — a forwarded command
   offered a session grant that was a silent no-op, atop a latent hole where a grant on a
   future command-bearing tool would become standing shell permission keyed on a label. Both
   display and enforcement now key on the command FACT (grant stored only when `tool.command`
   is undefined; `[s]` hidden for command asks; forwarded `[s]` reads "THIS TASK").

### The live-API E2E

One scripted expect-style run (driver + pattern table preserved in
`C:\Users\A\Desktop\agent-cli-s9-live\VALIDATION.md`, with transcript, decisions log, all 5
session reports, plan document) against real claude-opus-4-8: `@plan` → approve (sha-bound) →
ONE delegate call → TWO parallel worktree executors (group wall 17.7s) each running a real
node assert-suite → forwarded verifications → capture → `apply_task_changes` ×2 → `/undo` →
honest recovery → a 16-assertion parent-written check (exit 0) → a 2-lens reviewer panel whose
`run_command` attempts all AUTO-DENIED, the parent re-running the load-bearing probe itself →
`/report`/`/diff`/`/quit` → task-base refs pruned live (`refs/agent-cli/` empty). 42 uncached
input tokens; AGENT.md steering held; the consent fix observed live in the spawn ask.
Sovereignty observed unprompted: told (wrongly) that applied files were gone, the model checked
the workspace and proceeded from observable state.

### Verification evidence

Typecheck + build clean per commit; suite 498→**515 passed / 1 skipped across 44 files (+17)**:
full lock-protocol matrix, live/dead/aged sweep discrimination against real worktrees, all four
consent-display cases, ref-prune provenance + apply-after-prune, the approval options-line
matrix, and the command-grant e2e pin. Plus the recorded live run (driver exit 0, 11/11 steps,
8 approvals all answered post-display).

### Decisions (and why)

- **The registry lock never copies the event-log's same-pid reclaim** — group members share one
  pid; staleness is dead-pid or over-age only.
- **Sweep liveness errs toward keeping** (a recycled pid delays a sweep, never destroys live
  work), bounded by the age hatch grounded in the fixed executor budget.
- **Base refs die at session end, not capture** — recovery points until quit; deletion is
  EVIDENCE, never silent.
- **Display mirrors enforcement for grants** — what the prompt offers must be exactly what the
  runtime would store; both derive from the command FACT.
- **The live driver never pre-supplies approval answers** — consent evidence must show the
  prompt preceding the answer.

### Open issues / boundaries (deliberate, documented)

- The apply-as-one-undo-unit path is mock-proven only (in the live run `/undo` correctly hit a
  later write — last-mutation semantics as designed).
- Command labels stay noisy (cosmetic; labels never grant or gate). The stale-forwarded-prompt
  wart stands: the discard is LOUD but the typed line is consumed (io redesign, deferred pool).

---

## Earlier Milestones (Sessions 1–8 — compressed per the rolling-docs policy)

Contract detail for everything below lives in `ARCHITECTURE.md`; entries here keep the
objective, the lasting decisions (with why), the evidence, and what stayed open.

### Session 8 (2026-07-22) — V0.7: coordinated parallelism + the minimal agent-teams layer

Roles as two-layer explicit contracts (policy fact table + runtime contract rows, pinned
consistent at load); parallel groups living in the delegate TOOL (one call = 1–3 tasks =
one evidence unit = ONE approval for a mutating group; `runTurn` byte-identical); plan mode
(harness-owned documents, `update_plan` behind the fail-closed `planDoc` branch, `/plan
approve` binding the exact sha); the executor role (base checkpoint → detached worktree →
bounded binary-safe capture that OUTLIVES the worktree → reviewed drift-refusing apply through
the existing snapshot/undo machinery); serialized approval forwarding that fails closed for
non-interactive parents. Commits `d0abbb1`…`a67cd94`; 450→498+1 tests. Lasting decisions:
worktrees of a trusted workspace are trusted BY DERIVATION (never written to trust.json); the
plan-approval gate landed BEFORE the capability it gates; executor spawns are never grantable;
worktrees live in the OS temp dir because validatePath DICTATES it. Still relevant: Ctrl+C
aborts the whole turn (per-task cancel = forwarded deny-stop only); worktrees lack gitignored
files (honest UNVERIFIED reporting); the stale-forwarded-prompt line-consumption wart.

### Session 7 (2026-07-20/21) — V0.6: main-agent control layer — memory + subagent tasks

Three-document project memory (AGENT.md user constitution; harness-generated rolling
JOURNAL/CODEBASE with deterministic event-derived Evidence sections and the verbatim
"CONTEXT, NOT AUTHORITY" framing) + the first read-only explorer tasks over the SAME `runTurn`
(a task = one turn) + `assembleSession` as the ONE construction path (trust is a parameter —
assembly is structurally impossible untrusted). 450+1 tests (+47); live two-session E2E with
unprompted parent re-verification of child narration and 6 uncached input tokens. Lasting
decisions: memory is context-not-authority STRUCTURALLY (evidence from events; crash notes
from log tails — absence of memory never accuses a session); `aborted ≠ user-quit`
(post-session work must never fire after Ctrl+C); delegation budgets are harness-fixed, never
model-controlled. Still relevant: memory docs are lock-less (seconds-wide last-writer-wins
window at simultaneous quits; the log stays the evidence).

### Session 6.5 (2026-07-19) — V0.5 capability demo + production-style validation

One continuous ~68-min recorded run (real ConPTY → xterm.js → Playwright, byte-truthful, live
claude-opus-4-8): built **LedgerLite** (20 files, 51 unit tests) from a natural-language brief
with 13 live approvals, then demonstrated diff/attributed-commit/checkpoint/restore/undo/report
and deny-adapt honesty; **124 uncached input tokens** total (cache 2.07M read). Two product
fixes with regression coverage (probe 60s+retry behind an injectable ProbeRunner; absolute-
System32 whoami in the Low-IL test). Suite 403+1. Evidence:
`C:\Users\A\Desktop\ledgerlite\validation\`. Lasting decisions: validation sessions live
OUTSIDE the product repo; the bridge identifies itself truthfully; demo briefs state git
authority explicitly. Standing finding: the positive-proof auto-run gate rarely fires for the
model's natural chained command style; probe ~4–11s on this machine.

### Session 6 (2026-07-18) — V0.5: Git-native, reviewable, context-efficient

GitOps as a harness-only capability (a policy regression test PINS why it must never be a model
tool — a command-less, mutation-less "git_commit tool" would auto-allow as observe), with the
hardened git substrate, attributable `/diff`, session-scoped `/commit`, and hidden-ref
checkpoints whose restore is ONE applyUndo unit — git is never the undo mechanism (the Codex
ghost-commit data-loss lesson). Context efficiency: two-breakpoint prompt caching (live ~6
uncached input tokens/session) + deterministic monotone elision + the git-backed map. The
consent contract made explicit: user-typed commands ARE consent under preview+confirm, a
provenance event per operation, and GitClient structurally unreachable from the model. 398+1
tests; scripted + live E2E. Still open from S6: approved run_command file effects are
structurally under-claimed by attribution; `agent commit`/`checkpoint` need the session lock.

### Session 5 (2026-07-18) — V0.4: enforced isolation + automatic command review

The OS-enforced Windows boundary (Low IL + Job Object; `WRITE_RESTRICTED` tokens FAILED in the
machine probe, which ran BEFORE any code) + deterministic automatic command review
(`analyzeCommand` as a POSITIVE proof of safety; auto-run requires proof AND an active probed
boundary, else ask; approved commands deliberately run unsandboxed — the user accepted the
risk, Codex's model). Enforcement is probed per session, never assumed, and degrades
fail-closed. 321+1 tests (+80) incl. 8 real-OS win32 tests and a 66-assertion adversarial
corpus (40+ escape forms never auto-run); live E2E. Honest scope (unchanged since): confines
writes + lifecycle on Windows only — reads, network, Low-labeled locations, and
service-reparented work are NOT confined. Still open: per-command Add-Type host latency
(~1.2s; probe ~4–11s); CLIXML stderr cosmetics.

### Session 4 (2026-07-17) — V0.3: execution kernel hardening

The managed exec substrate (typed termination — a killed command has NO exit code, everywhere,
and the report vetoes CHECKED on kill evidence; the kill/drain state machine that never awaits
`'close'` unconditionally — the nodejs/node#21960 grandchild-pipe hang class) + real
mid-command cancellation proven with a genuine console CTRL_C against the live API. 240+1
tests (+35). Lasting decisions: force-kill only, labeled best-effort; evidence channels are
callId-bound by the runtime so tools cannot forge another call's evidence. **Cost lesson (now
a CLAUDE.md rule):** a per-finding 3-verifier fan-out exploded (19 findings → ~57 agents) and
was aborted; findings were salvaged from the journal and verified BY HAND — review workflows
stay bounded, no per-finding verifier panels.

### Session 3 (2026-07-16) — Recorded live E2E demo + two defects it surfaced

Not a product increment: an 11m20s Playwright-recorded, byte-truthful demonstration of the
V0.2 loop (trust consent on camera, a complete web app built with inline approvals, resume,
browser verification). Artifacts outside the repo (`C:\Users\A\Desktop\agent-cli-demo-20260716\`);
the evidence chain independently audited. Product yield: the CLI entry guard realpaths
`argv[1]` (npm-link shim exited 0 silently); vitest 60s hang backstop. Lasting decision:
record a browser-hosted real terminal (xterm.js ↔ ConPTY) since the CLI needs a real TTY.
Nuance that still matters: the report's "Files changed" uses last-mutation-per-path semantics.

### Session 2 (2026-07-15) — V0.2: interactive REPL, workspace trust, narrowing-only config

The REPL on the exact same runtime (no parallel loop), turn abort, the live event-log renderer.
Lasting decisions: workspace trust is recorded consent, never a sandbox (TTY-only prompt, no
self-granting folders, corrupt store = hard error); workspace config narrows only; the screen
renders from the persisted log with stdout reserved for model text; type-ahead cannot answer a
security prompt; approval prompts sanitize model-controlled text. 204+1 tests; three live E2E
rounds + post-E2E adversarial review — seven real defects total found, fixed, and
regression-tested. Still relevant: `agent map` stays ungated pre-trust (documented exception).

### Session 1b (2026-07-14) — Automatic proxy support + verified live E2E

Reusable proxy-aware transport (pure `resolveProxy`, per-request undici ProxyAgent, no global
dispatcher; credentials never persisted; deliberately no `--proxy` flag — argv is logged).
Closed Session 1's one unverified surface: the full live loop through the system proxy. 143+1.

### Session 1 (2026-07-14) — V0.1: the bounded local agent loop

The seven-pillar foundation (typed contracts, append-only JSONL log with tail repair, one pure
policy choke point + Windows-first path validator, five file tools + run_command, snapshots
with drift-refusing undo, resume with crash reconciliation, deterministic evidence report).
121+1 tests + dogfood run. Lasting decisions: no widenable allowlist config — labels only
inform the human; in-workspace writes auto-allow but snapshot first; sandbox vs approval kept
separate and stated honestly (V0.1 shipped approval only; S5 added the enforced axis); secret
reads redacted via salted HMAC and deliberately non-replayable on resume; state lives outside
the workspace. Still-true limitations: command output not scrubbed for secrets; path checks
TOCTOU-racy; undo is file-only; single-user lock assumption.

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
