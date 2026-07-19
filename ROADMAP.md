# ROADMAP

Rolling execution record: the latest one or two sessions in full detail, older sessions
compressed under **Earlier Milestones** (per the rolling-docs policy in `CLAUDE.md`). Newest first.

---

## Session 6.5 (2026-07-19) — V0.5 capability demo + production-style validation

### Objective

Not a product increment (Session-3 pattern): one truthful, continuous, recorded demonstration of
how complete the V0.5 single-agent kernel is — a realistic project built by Agent CLI under live
human supervision, exercising trust, sandbox, automatic review, approvals, editing, testing,
building, diff/commit/checkpoint/restore/undo, caching, and the evidence report — plus a
foundation review that fixes anything unreliable before the run.

### Foundation review → 2 product-repo fixes (both committed with regression coverage)

- **Sandbox probe flakiness (`763032f`)**: during loaded full-suite runs the enforcement probe
  intermittently reported "not established", silently degrading a genuinely-enforceable session
  to fail-closed ask-everything. Direct measurement: ~4–11 s normally, **~18 s under 6-way
  concurrent spawn load**, vs a 30 s timeout. Fix: 60 s timeout + one bounded retry behind an
  injectable `ProbeRunner` seam; 5 regression tests pin that a retry can recover a transient
  false NEGATIVE but every path to `enforced: true` still requires the positive self-test marker.
- **Low-IL test resolved the MSYS whoami (`21a8c40`)**: under Git Bash, `Git\usr\bin` precedes
  System32, and MSYS binaries crash at Low IL; the test now uses the absolute System32 path as
  the product probe (bootstrap.ts) always did.
- Gate after fixes: `npm run typecheck` + `npm run build` clean; **403 passed, 1 skipped (32
  files)**. (One additional test file failed exactly once in the first loaded run and never
  reproduced across three later full runs — unidentified, noted honestly.)

### Demo environment (rebuilt from scratch; lives OUTSIDE this repo)

`C:\Users\A\Desktop\agent-cli-demo-20260719\harness\`: a real ConPTY (`@lydell/node-pty` →
`powershell.exe`) mirrored byte-for-byte into an xterm.js page recorded continuously by
Playwright (single page = single unedited video), with an HTTP control API (type/keys/wait/
navigate/click/stop) driven by the supervisor. Truthfulness contract: every displayed byte comes
from the PTY (raw stream independently saved as a transcript); the page accepts NO local
keyboard input; the PTY env is normalized (MSYS paths stripped; `TERM_PROGRAM=xterm-web-bridge`
identifies the bridge, enabling Unicode chrome). Harness lessons: Playwright context.close hung
on a long recording until page.close-first ordering; undici's ~300 s fetch cap requires chunked
long-polls; MSYS argv path-mangling requires stdin-passed text + `MSYS2_ARG_CONV_EXCL`.

### The recorded run (session `20260719-054206-9ecc`, live claude-opus-4-8 via proxy)

The supervisor seeded `C:\Users\A\Desktop\ledgerlite` (git repo, one commit: `BRIEF.md` product
brief granting explicit user-owned git delivery authority) and gave natural-language tasks only.
On camera, continuously (~68 min): trust consent (`t`) → banner (sandbox ENFORCED, `git: branch
main @ c7be96a, clean`) → `/map` → **the agent built LedgerLite** (personal finance tracker:
dashboard, SVG donut + trend charts, CSV import with dedup, localStorage, dark amber UI) — 20
files, 51 unit tests, esbuild production build, in one 37-step turn with 13 approvals granted
live; it recovered from PowerShell 5.1 rejecting `&&`, self-caught an HTML/JS id inconsistency,
and verified its own dist output. Then: `/status` → `/diff` → `/commit` (preview staged ONLY
session-attributed paths; `package-lock.json` honestly excluded as an unattributable install
side effect, swept by an explicit `/commit --all`) → `/checkpoint v1-complete` → amber restyle
turn (targeted `edit_file`s incl. contrast fixes) → deny-adapt beat (2 denials of chained/
flagged git; the model's fallback summary explicitly labeled itself "not a live diff read") →
plain `git status` **auto-ran `[sandboxed: windows-lowil]` with no approval** → `/checkpoint
restore 1` (previewed, snapshot-first, confirmed) → `/undo` (restore reverted; amber back,
verified out-of-band on disk) → the next turn KNEW about the undo via the harness note and
re-read before acting → final green verification (51/51, build, dist amber confirmed) →
`/commit` → `/report` (full evidence chain + honesty footer) → `/quit` → supervisor `npm start`
→ the recorded page navigated to the app: add-transaction updated balance/charts live, search
filter isolated the new row. Session totals: **124 uncached input tokens** / 42.1k out,
cache 2.07M read / 225k written; three commits each carrying `Session:` +
`Co-authored-by: Agent CLI`.

### Evidence artifacts

`C:\Users\A\Desktop\ledgerlite\validation\`: the continuous MP4, the raw PTY transcript, the
deterministic `session-report.md` (every file CHECKED with the exact verifying command; the one
failed pipeline kept as exit 1; per-command boundary markers), and `VALIDATION.md` mapping every
claim to its evidence — deliberately left uncommitted in the target repo (the deliverable is the
four clean commits; validation is meta-evidence).

### Decisions

- Validation sessions live outside the product repo; the target repo stays a clean deliverable.
- The bridge truthfully identifies itself via `TERM_PROGRAM` rather than impersonating Windows
  Terminal (`WT_SESSION`).
- The demo task states git authority in the brief ("I handle git myself") so the
  no-git-unless-asked rule is preserved observably: the agent's only git execution was the
  sandboxed read-only `git status`.

### Open issues / UX findings (not defects)

- The positive-proof auto-run gate rarely fires for the model's NATURAL command style (chained
  `;`, extra flags like `--no-pager`) — nearly every command asked. A system-prompt hint
  describing the auto-runnable shape would raise the hit rate without weakening the gate
  (added to the deferred pool).
- Probe cost at session start measured ~4–11 s on this machine (S5 recorded ~1–2 s) — the
  cached-host optimization grows more attractive.
- `/diff` is whole-session by design; the "changes since last commit" question is git's job —
  the demo showed the model answering it via sandboxed `git status` after two denials.
- `powershell.exe` CLIXML stderr noise remains a visible cosmetic wart in live output.

### Recommended next step

Session 7 (task/subagent runtime primitives) unchanged — the kernel demonstrated end-to-end is
the stable base it needs. Fold in the auto-run system-prompt hint and consider the cached
sandbox host when touching that area.

---

## Session 6 (2026-07-18) — V0.5: Git-native, reviewable, context-efficient

### Objective

BLUEPRINT Session 6: make Agent CLI Git-native, reviewable, and context-efficient without
replacing the snapshot system, polluting user history, or breaking the no-git-unless-asked rule.
Planned via a 3-Explore + 1-Plan-agent recon (repo seams, state/evidence, tests/gaps) plus
targeted external research; the Plan-agent critique caught two critical design flaws before any
code (a workspace-planted `git.exe` would have executed unsandboxed at startup; the elision
trigger as first specified oscillated between requests). Key negative reference: **Codex ghost
commits were removed upstream (Apr 2026)** after untracked-file sweeps, session bloat, and a
`git restore` data-loss incident — so git here is a review/delivery/recovery layer, never the
undo mechanism, and nothing auto-commits.

### What was implemented (10 feature commits + 1 fix)

1. **`feat(git)` substrate** — `src/git/{client,facts,porcelain,types}.ts`: every harness git
   invocation runs through `runManaged` with an ABSOLUTE git path (PATH scanned directly; bare
   names resolve against child cwd on Windows — a planted `git.exe` must never execute; `.cmd`
   shims rejected), `-c core.fsmonitor=false` (malicious-repo config RCE), `GIT_OPTIONAL_LOCKS=0`
   (probes never rewrite the user index), `GIT_TERMINAL_PROMPT=0` + no stdin, scrubbed
   repo-targeting `GIT_*` inheritance, bounded timeouts. `detectGitFacts` degrades honestly
   (git absent / not a repo / probe timeout ⇒ explicit nulls). Porcelain-v2 `-z` parser (pure).
2. **`feat(runtime,ux)` session git context** — both interfaces probe at assembly → additive
   `git.context` event; REPL banner + `/status` ("at session start"); report header; system
   prompt states the repo context in-repo and KEEPS the mutation prohibition (non-repo keeps the
   old rule verbatim). Policy: `git restore`/`checkout --`/`stash drop|clear`/`push --force*`
   now label destructive; a REGRESSION test documents that a command-less mutation-less tool
   auto-allows as observe — why GitClient must never be tool-wrapped (registry guard test).
3. **`feat(provider)` prompt caching** — pure `buildApiParams`: `cache_control` on the system
   block + a MOVING breakpoint on the final wire block, attached AFTER coalescing; additive
   `Usage.cacheRead/CreationInputTokens` (SDK null → 0) through events, `/status`, report.
4. **`feat(runtime)` deterministic elision** — pure per-request `elideHistory`: boundary is a
   function of the RAW (only-growing) size ⇒ monotone, no oscillation, no stored state,
   identical re-derivation on resume; oldest tool_result contents → marker (count+sha+log
   pointer); last 4 steps protected; pairing preserved; `session.messages`/log never mutated;
   additive `context.compacted` event (+ live render, exhausted warning).
5. **`feat(workspace)` git-backed map** — `git ls-files --cached --others --exclude-standard -z`
   in trusted repos (nested .gitignore correct — walker regression-proven wrong; deleted-tracked
   subtracted; builtin excludes kept; subtree scoping); walker fallback unchanged. Pre-trust
   `agent map` deliberately stays on the pure walker (running git against an untrusted `.git`
   is an attack surface the read-only exception must not take on).
6. **`feat(tools)` editing precision** — `edit_file.replace_all` (+ occurrence-count refusal
   naming the flag; empty old_string rejected); `read_file.offset/limit` line paging with a
   labeled window.
7. **`feat(review)` attributable session diff** — runtime dep #5 `diff` (jsdiff) wrapped once
   (binary NUL-8KiB + 1 MiB guards); additive `file.mutated.linesAdded/Removed` computed at
   write time (report stays pure; +n/−m churn column); `buildSessionDiff`: first pre-image blob
   → current disk per attributed path, undo folded in (net-unchanged), external edits flagged
   DRIFTED; surfaced as `/diff` + `agent diff` (sanitized untrusted bytes).
8. **`feat(git)` deliberate commits** — `/commit [-m] [--all] [--no-trailer]` + trust-gated
   `agent commit [--yes]`. Session scope stages ONLY attributed paths (status∩attribution with
   `--untracked-files=all` — collapsed new dirs could never match otherwise); blockers where
   attribution would corrupt (missing identity — never set for the user; pre-staged index in
   session scope); drift + unattributable-command-effects warnings; ordinary add + `commit -F
   <state file>` (hooks run; failures honest, staged state stated); Session line +
   `Co-authored-by: Agent CLI` trailer; unborn-HEAD + nested-workspace proven; `git.commit`
   event → render/report/harness-note.
9. **`feat(git)` checkpoints + restore** — `/checkpoint [label|list|restore <n>]` + trust-gated
   CLI. Create: temp `GIT_INDEX_FILE` plumbing (read-tree HEAD → add -A → write-tree →
   commit-tree → `refs/agent-cli/checkpoints/<sessionId>/<n>`), user-visible git state proven
   BYTE-IDENTICAL before/after; unborn = empty-tree base, no parent; explicit plumbing identity
   env (user identity never required); gitignored files never swept (regression); >200 untracked
   requires confirmation; "low-pollution, not zero" wording + prune. Restore: affected set =
   `diff-tree(current-temp-tree, checkpoint)` filtered to the workspace prefix (moved-HEAD
   outside-subtree files proven untouched), DELETES checkpoint-postdating files, content via
   second temp index + `checkout-index --prefix` staging (binary-safe, filter-correct worktree
   form), snapshot-first under ONE synthetic callId ⇒ one `applyUndo('last')` unit (round-trip
   proven), `git.restore` event, never invokes `git restore`/`checkout` on the user worktree.

### Verification evidence

- **Gate:** `npm run typecheck` + `npm run build` clean per stage; `npm test` **398 passed,
  1 skipped** across 31 files (was 321+1; **+77**), including 40+ real-temp-repo git tests with
  host git config isolated (a global `core.autocrlf=true` legitimately canonicalizes LF
  fixtures — machine-dependent assertions removed).
- **Scripted REPL E2E** (built binary, piped `--interactive`, mock provider, real temp repo):
  banner shows `git: branch main @ …`; task writes a file; `/diff` prints the unified diff;
  `/commit -m …` previews `?? hello.txt [session]`, confirms, commits; `git log` shows the
  message + `Session:` line + trailer; `/report` renders the git header, `+1/−0` diffstat, and
  the Commits section; working tree clean after.
- **CLI round trip** (built binary): `agent diff` → `agent checkpoint pre-change` → external
  user edit → `agent checkpoint restore 1 --yes` (file back to checkpoint content) →
  `agent undo` (file back to the user's edit). Recovery layering works end to end.
- **Live API E2E** (real `claude-opus-4-8` through the system proxy, temp repo): the model saw
  the git context line, created `greet.js`, adapted when its verification command auto-denied
  (`--no-input`, exit 2 by design); `agent commit --yes` delivered it; report correct.
  **Prompt caching live:** the session's tokens line reads `6 in / 292 out (cache: 5481 read /
  2904 written)` — the whole multi-step conversation re-read from cache, ~6 uncached input
  tokens total.

### Decisions (and why)

- **Git is a harness capability, never a model tool.** A command-less, mutation-less tool would
  auto-allow as `observe` (the engine has no branch for it) — a "git_commit tool" would commit
  with NO approval. The model keeps run_command (read-only git auto-runs sandboxed; mutations
  ask); users get deliberate `/commit`, `/diff`, `/checkpoint`.
- **The /undo consent precedent, made explicit:** user-typed commands ARE the consent, under
  three recorded contract conditions — preview+confirm on every mutating flow (`--yes` for
  non-TTY), a provenance event per operation, GitClient structurally unreachable from the model.
- **Snapshots stay the undo substrate; git layers on top.** Checkpoint restore goes THROUGH
  SnapshotStore (snapshot-first, one callId) so it is undoable by the existing machinery — git
  never becomes the undo mechanism (the Codex lesson).
- **Elision boundary on RAW size** — monotone because raw only grows; recompute-per-request
  stays deterministic across resume with zero stored state; hysteresis makes each advance the
  only cache invalidation.
- **Session-scope commit staging from status∩attribution** — every stage pathspec provably
  exists in git's view (deleted-tracked appear as D entries; ignored/vanished never appear), so
  the pathspec-error class is structurally gone.

### Open issues / not verified

- The attribution set structurally UNDER-claims: approved `run_command` file effects are not
  attributable (by design) — the /commit preview says so and `--all` exists; a future
  worktree/FS-watch layer could close it.
- Restore materializes the git-native worktree form: a file stored in non-canonical form (LF on
  disk under `autocrlf=true`) comes back canonicalized — the same lossy round-trip git itself
  has (documented in the contract comment).
- Elision bounds tool outputs only; assistant/user text grows unbounded (loud warning when even
  full elision exceeds the target). Model-generated compaction remains future work.
- Auto-run sandboxed `git status/diff` still pays the ~1.2 s Add-Type host start (S5 issue) —
  the git-native workflow makes the cached-host optimization more valuable.
- `agent commit`/`checkpoint` need the session log lock — a session running elsewhere blocks
  them (by design; commit from inside that REPL). Multi-repo workspaces and submodules are out
  of scope (facts probe reports the containing repo only).

### Recommended next step

BLUEPRINT Session 7: task/subagent runtime primitives. The prerequisites this session added:
repo-scoped GitClient (a worktree = another instance), per-session checkpoint namespaces,
attributable evidence lineage, and wire-history budgeting for parallel contexts. Fold in the
cached sandbox host if command latency starts to matter.

---

## Earlier Milestones (Sessions 1–5 — compressed per the rolling-docs policy)

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

Adaptive thinking with block preservation; per-action / `--to` / `--steps` undo; tree-sitter
ranked repo map with selective retrieval (S6 shipped the git-backed file LIST only); network/web
tools; MCP and workflow packs; SQLite index over the JSONL; conversation rewind; session
pruning/sanitized export; prompt-history persistence + line-editing niceties; background/
long-running process sessions; PTY support; output spill-to-file for huge command output.
**Git follow-ups (post-S6):** patch/multi-edit editing (replace_all + paging shipped; a
diff/hunk apply format did not); model-generated commit messages; attribution of approved
run_command file effects (structurally under-claimed today); isolated worktrees (S7 dependency);
push/PR flows; submodule + multi-repo workspaces. **Context follow-ups (post-S6):** model-
generated compaction of assistant/user text (deterministic tool-output elision shipped; loud
warning when even full elision exceeds the target). **Sandbox follow-ups (post-S5):**
network-egress control and a read/confidentiality boundary (the two enforced gaps that most
matter); a cached/compiled sandbox host to cut per-command Add-Type latency (~1.2 s — more
visible now that read-only git auto-runs are a hot path, and S6.5 measured the startup probe at
~4–11 s on this machine); macOS/Linux enforcement backends; containment of service-reparented
work (schtasks/sc/wmic/BITS) that escapes the Job Object. **Command-review follow-up (S6.5
finding):** a system-prompt hint describing the auto-runnable command shape (single unchained
read-only command, no extra global flags) — the model's natural chained/flagged style meant
nearly every command asked during the demo; the hint raises the auto-run hit rate without
weakening the positive-proof gate.
