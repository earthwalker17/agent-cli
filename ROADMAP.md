# ROADMAP

Rolling execution record: the latest one or two sessions in full detail, older sessions
compressed under **Earlier Milestones** (per the rolling-docs policy in `CLAUDE.md`). Newest
first. Contracts and mechanisms live in `ARCHITECTURE.md`; this file records what each session
attempted, verified, decided, and left open.

---

## Session 11 (2026-07-23/24) — V0.9: iterative planning, task graphs, parallel-first execution

### Objective

Complete the planning/orchestration lifecycle (the BLUEPRINT Session 11 direction): one
canonical structured plan with sha-bound REapproval and user/agent projections, observable
complexity routing, a dependency-aware task DAG with a bounded scheduler gate, live task/agent
visibility with a sticky status area, harness supervision with model-side decisions, and
task-scoped cancellation — all as system contracts, every kernel invariant preserved.

### Planning provenance

3 Explore recon lenses + 1 Plan-agent design pass, load-bearing claims hand-verified; three
user decisions asked and answered up front (JSON canonical plan + generated views; TTY sticky
status area; typed mid-turn commands). Load-bearing design choices: approval binds a CONTENT
sha (`sha256(canonicalJson(plan))`) so status flips are sha-neutral BY CONSTRUCTION — the V0.7
approve-rewrites-the-file quirk died structurally (the `repl.test.ts:439` pin deliberately
INVERTED); no per-task status field in the plan (execution state is a pure event fold — one
writable truth); the scheduler is a GATE in the delegate tool + the fold + guidance, not an
in-tool wave engine (the parent integrates between waves, so dependents' base checkpoints
naturally include applied deps); mid-turn interception is TTY-only (piped drivers pre-supply
lines — determinism is a contract); the status area is safe because the parent is BLOCKED
during delegate flight (stderr cursor movement can never interleave with stdout model text).

### What was implemented (commits `d8f7587`, `c841fa9`, `ddab676`, `dffb745`, `aa1f8d8`, `8c3f922`, `5250aca`, + docs)

Full contracts in ARCHITECTURE (Planning lifecycle / Task DAG / Supervision / Live surface):

1. **`feat(plan)` canonical core** — `plan/schema.ts` (zod graph, semantic validation with
   cycle paths, canonicalJson + planContentSha), `canonical.ts` (amendment contract,
   approve-refuses-invalid, `readPlanState` with legacy fallback), `views.ts` (projections,
   generated-view marker, legacy-md archiving), `graph-state.ts` (the pure fold).
2. **`feat(plan,repl,prompt,report)` lifecycle** — structured `update_plan` (validation errors
   verbatim, nothing written), `/plan` on the canonical store, `@direct` + `plan.route`
   events, the agent-view injection note (pointer keeps the LIVE execution summary),
   routing rules in the system prompt, report routing/graph lines.
3. **`feat(tools,runtime,cli)` the DAG gate** — `plan_task` bindings → `task.started.planTaskId`;
   `checkDagRules` R1–R9 before the base checkpoint (group-atomic); the strict status gate
   (diverged/superseded/hand-edited-approved now BLOCK); plan-informed briefs; DelegateCaps
   rebuilt from events (the resume-reset gap closed).
4. **`feat(runtime,tools,repl)` supervision + cancellation** — loop detect (annotate 3 /
   cancel 5 → `stalled`), single-shot budget-pressure (80% tokens/wall), stall observation;
   ≤6 `task.supervision` events/task + `SubagentResult.supervision`; the HEAD-of-result group
   digest (survives 70/30 truncation); the idempotent `registerCancel` seam → `cancelled`.
5. **`feat(repl,runtime,cli)` the live surface** — `status.ts` (the ONLY cursor-moving code;
   all chrome through one status-aware writer; zero escapes off-TTY), `live-tasks.ts` (table +
   cancel registry), the structured `ChildStatusUpdate` channel, mid-turn `/tasks` +
   `/cancel` via `io.setMidTurnHandler` (TTY-only; displayed approvals always win).
6. **`fix` review batch** — capture-loss no longer folds to a false `completed` (R5 could
   strand lost work); a VANISHED approved plan refuses executors; `/plan show` approval line
   honest beside draft; double-`/cancel` deduped; the id-reuse amendment boundary stated to
   the model; status-area clip/resize docs made honest.

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite 574→**645 passed / 1 skipped
across 55 files (+71)** — schema/canonical/fold matrices, the R1–R9 gate matrix, caps-rebuild pins,
supervision (loop annotate→cancel, pressure single-shot, stall, /cancel evidence + cleanup,
digest-survives-truncation), exact escape-byte status-area assertions (zero ESC off-TTY), the
mid-turn interception matrix (displayed-approval-wins, piped immunity), the real-git wave flow
(parallel disjoint pair → early dependent refused → integrate → hand-edit DIVERGED → byte-
restore re-enables → dependent builds on the integrated base → completed re-run refused), and
the crash-mid-group replay/fold case. Bounded adversarial review: 3 read-only lenses over the
session diff, findings hand-verified — kernel-invariant lens **zero findings across all 8
invariants**; 1 MEDIUM + 5 LOW fixed (item 6); accepted limitations recorded below.

**Live proof** (`C:\Users\A\Desktop\agent-cli-s11-live\` — driver-s11.mjs, VALIDATION.md,
per-phase artifacts, validate.mjs): a two-phase piped run against real claude-opus-4-8,
**18/18 post-hoc checks over the persisted evidence**. Phase A: a simple typo request stayed
DIRECT (no plan events); the complex linkkit request auto-routed to planning
(`plan.route {plan, model}`); `/plan show` → approve → a feedback amendment INVALIDATED the
approval live (both shas surfaced) → re-approve bound the amended content sha; one parallel
group of two executors spawned BOUND (`plan bindings: task 1 → 'url-module', task 2 →
'slug-module'` displayed at the consent ask) — then a deliberate SIGKILL mid-wave. Phase B:
`agent resume` → `/tasks` folded both tasks as `interrupted` with child-log pointers and the
parent-owned check task labeled unverifiable → the model re-ran BOTH as one parallel group
(same bindings, `attempt 2` visible), integrated with zero refusals, wrote and ran the check
(real exit 0), `/report`, clean quit — 40 uncached parent input tokens (cache 216k read), the
crash orphans swept, worktree registry empty.

### Decisions (and why)

- **Content-sha approval identity** — consent must survive harness bookkeeping and die on
  semantic change; hashing a normalized projection of the graph gives exactly that boundary.
- **Execution state is derived, never written** — a second writable status would be the
  double-truth trap; the fold re-derives identically on resume.
- **Group rules before per-task state in the gate** — otherwise R4 "blocked" shadows the
  actionable "sequence them across calls" for the group-a-dependent-with-its-dep mistake.
- **A completed executor without a capture event folds FAILED** — capture loss must reopen
  the retry path, not read as done (review F1).
- **No harness complexity classifier** — routing is model judgment + user sigils + recorded
  evidence; the hard floor stays structural (gates), not linguistic.
- **The status area is TTY-only and chrome-only** — piped byte-identity is a contract the
  drivers depend on; zero escapes off-TTY is asserted, not assumed.

### Open issues / boundaries (deliberate, documented)

- Sibling-task chrome can print over a DISPLAYED forwarded-approval prompt (pre-existing
  stderr behavior; the io-redesign pool item). `/cancel` typed at a displayed approval answers
  it as a deny (fail-safe, documented).
- The status-area clip counts code units, not display columns — safe while status lines stay
  structurally ASCII (slug ids, enum roles); a width-aware clip is required before free-form
  text lands there. A terminal SHRUNK after a draw can leave a cosmetic stale fragment above
  the region.
- A completed plan-task id stays completed across amendments (id-stability boundary) — the
  model is told to give materially changed work a NEW id.
- Deleting only the canonical JSON (generated view surviving) blocks executors via the legacy
  `unknown` fallback, while deleting both files degrades to ask-only-with-refusal-on-approval
  — asymmetric but both fail-safe.
- The sticky area + mid-turn commands have no piped-driver proof (TTY-gated by design):
  covered by exact escape-byte tests + the manual Windows Terminal smoke in VALIDATION.md.

### Recommended next step

Session 12 per BLUEPRINT: the unified verification gate and typed recovery — typed check
adapters with normalized results feeding the plan tasks' `verify` criteria, a failure
classifier, and the bounded repair policy over the now-complete task graph.

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

## Earlier Milestones (Sessions 1–9 — compressed per the rolling-docs policy)

Contract detail for everything below lives in `ARCHITECTURE.md`; entries here keep the
objective, the lasting decisions (with why), the evidence, and what stayed open.

### Session 9 (2026-07-22/23) — pre-expansion consolidation + the live V0.7 proof

Audit-driven fixes (3 Explore lenses + 1 Plan critique, hand-verified), no new capability.
Landed: concurrent-session worktree safety (owner-stamped registry entries, in-process mutex +
token `O_EXCL` lock, live-pid sweep skip with a 2h age hatch, merge-on-save — a live same-pid
holder is NEVER reclaimed, group members share the pid); plan-approval state displayed at the
executor spawn ask (the display-only `approvalContext` seam); task-base refs pruned at session
end with `git.checkpoint.pruned` provenance; command grants keyed on the command FACT (a
session grant is stored only when `tool.command` is undefined; `[s]` hidden where no grant
would store — found live). Suite 498→515+1. The live V0.7 proof (evidence:
`C:\Users\A\Desktop\agent-cli-s9-live\`): `@plan` → sha-bound approve → ONE call → TWO
parallel worktree executors with real node assert-suites → forwarded approvals → capture →
apply ×2 → `/undo` → honest recovery → reviewer panel auto-denied its shell attempts and the
parent re-ran the probe itself → refs pruned live; 42 uncached input tokens; sovereignty
observed unprompted (told applied files were gone, the model checked the workspace instead).
Lasting decisions: sweep liveness errs toward keeping; display mirrors enforcement for grants;
live drivers never pre-supply approval answers. Still relevant: the stale-forwarded-prompt
line-consumption wart (io redesign, deferred pool); command labels stay cosmetic-noisy.

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
**Planning/orchestration follow-ups (post-S11):** a width-aware status-area clip before any
free-form text may land in status lines (today: structurally ASCII + a 2-column margin);
sibling-task chrome printing over a DISPLAYED forwarded-approval prompt (pre-existing, part
of the io redesign); the completed-id-across-amendments boundary (prompt-mitigated — a
structural "content hash per task" variant if it bites); plan-file pruning (one canonical
JSON + generated md per session accumulate); a `/cancel` surface for non-TTY sessions;
richer wave guidance (the model still chooses group composition; the gate only refuses).
**Task/subagent follow-ups (post-S8/S9):** task resume/continue (SendMessage-style); deeper
scanning of child reports for instruction-shaped content (v1 ships delimiters + provenance
labels); the stale-displayed-forwarded-prompt line-consumption wart (the discard is LOUD
since S8, but the typed line is still consumed — needs an io redesign); per-child sandbox
scratch TEMP isolation; a per-child `--script` seam for the mock provider (tests use the
providerForTask seam; production children share one script); a structural (not
prompt-shaped) review gate. **Memory follow-ups (post-S7):** journal
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
