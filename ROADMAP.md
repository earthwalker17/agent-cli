# ROADMAP

Rolling execution record: the latest one or two sessions in full detail, older sessions
compressed under **Earlier Milestones** (per the rolling-docs policy in `CLAUDE.md`). Newest first.

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

## Session 5 (2026-07-18) — V0.4: enforced isolation + automatic command review

### Objective

BLUEPRINT Session 5: move beyond application-level path checks and approvals by (1) establishing a
sandbox architecture and implementing at least one genuinely OS-enforced isolation path, reported
truthfully and failing closed when enforcement cannot be established; and (2) replacing the "every
shell command asks" default with a single automatic-review flow backed by deterministic policy and
enforced sandbox constraints — never the model's opinion. Windows-first; no false cross-platform
parity. Research-first (a bounded 5-agent workflow over Codex CLI, Anthropic sandbox-runtime, the
Windows OS primitives reachable from stock Node, deterministic safe-command classification, and an
adversarial escape catalog), and — critically — **feasibility was proven by direct machine probe
before any code was written**.

### Feasibility evidence gathered first (direct probes on the target machine)

On this Windows 11 box as a standard **non-admin, Medium-integrity** user: a Low-integrity child
spawned via `CreateProcessAsUser` with a duplicated, integrity-lowered copy of our OWN token works
with **no admin and no special privilege**; the OS **denies** that child's writes to the workspace,
`%USERPROFILE%`, and a state-like dir (`UnauthorizedAccessException`); stdout/stderr are captured
through inherited pipe handles; **reads are NOT blocked**; a Low-labeled scratch dir is writable;
and `powershell.exe` itself runs correctly at Low IL. The `WRITE_RESTRICTED` restricted-token path
FAILED (err 1314 — needs a privilege we lack), so **Low IL alone is the mechanism**. Research
corroborated Low-IL + Job Object as the no-admin sweet spot and confirmed a string reviewer must
never be a boundary (obfuscation defeats any regex → auto-allow must be positive-proof, fail closed).

### What was implemented (3 feature commits)

1. **`feat(sandbox)`** — `src/sandbox/`: a `SandboxBackend` contract with a `wrapSpec` transform-at-
   spawn seam; an honest `none` backend; and `windows-lowil` — a real boundary that runs a command
   at **Low integrity** (MIC write-up denial) inside a **Job Object** (`KILL_ON_JOB_CLOSE` +
   active-process cap + UI restrictions). `bootstrap.ts` is a small, versioned PowerShell + inline-C#
   Add-Type P/Invoke host that Node spawns in place of the shell; it re-launches the target at Low IL
   forwarding its inherited std handles (= Node's pipes) so `runManaged` capture/kill are unchanged.
   Enforcement is established by a runtime **self-test probe**, never assumed. `EnforcementFacts`
   carry the honest scope (confines writes+lifecycle; NOT reads/network; Low-labeled scratch writable;
   service-reparent escapes). Additive `sandbox.status` event + `command.started.sandbox`.
2. **`feat(policy)`** — `command-review.ts`: `analyzeCommand`, a POSITIVE proof of safety (single
   simple command, zero shell metacharacters/encoding, curated read-only executable allowlist with
   normalization, per-executable arg checks, workspace-escape guard). `decide()` for a shell command:
   circuit-breaker deny (absolute) → auto-review; auto-allow (`execBoundary: 'sandbox'`) requires a
   proof of safety AND an active OS boundary; otherwise `ask` (`unsandboxed`). No enforced sandbox ⇒
   auto-run disabled, every command asks (**fail closed**). `classifyCommand` label hardened so LOLBAS
   (certutil/bitsadmin/mshta/rundll32/regsvr32/wmic/msiexec/schtasks) and encoded/`iex` forms no
   longer read as benign — the label still only informs the human.
3. **`feat(runtime,ux)`** — the sandbox threaded through the ONE runtime: `session.ts` takes the
   backend + probed facts, the base tool ctx carries availability (engine reads `enforced`),
   `runExecution` builds the per-call `ExecSandbox` (active+enforcing wrap for auto-run, identity for
   approved). `run-command.ts` switched to `-EncodedCommand` (immune to quoting AND survives the host
   argv round-trip that `-Command` mangles) and applies `ctx.sandbox.wrap`. CLI + REPL establish and
   PROBE the sandbox before the first turn, report the real mode (banner/stderr/`sandbox.status`), and
   feed the facts into the system prompt. `report.ts` renders a sandbox header block, per-command
   `[sandboxed: windows-lowil]`/`[unsandboxed]` markers, and a mode-aware honesty footer.

### Verification evidence

- **Gate:** `npm run typecheck` + `npm run build` clean; `npm test` **321 passed, 1 skipped** across
  24 files (was 241+1; +80).
- **Real-OS integration** (`test/sandbox.windows.test.ts`, 8 tests, win32-gated, through the actual
  backend + `runManaged`): write to the workspace and to the harness state dir **DENIED**; reads
  **allowed** (honest limitation); exit code relayed; stdout captured; child confirmed at Low
  integrity; and a **detached grandchild reaped on kill** via the Job Object — closing Session 4's
  `taskkill /T` gap with a real fixture.
- **Adversarial corpus** (`test/policy.command-review.test.ts`, 66 assertions): 20 safe commands
  auto-allow; a 40+ item catalog (chaining/redirection/substitution/env-substring/caret/glob/encoded/
  interpreters/LOLBAS/path-escape/non-allowlisted/git-config-injection) **NEVER auto-runs**, even
  under an enforced sandbox; circuit-breaker stays absolute; normalization + label hardening covered.
- **REPL** auto-run vs ask tests with injected backends; **live CLI E2E** (built binary): startup
  probe reports `windows-lowil` ENFORCED, `git status` auto-runs `[sandboxed]`, a piped command asks
  and is auto-denied non-interactively (exit 2), and `agent report` renders the honest evidence.

### Decisions (and why)

- **Low IL + Job Object, not restricted tokens.** The `WRITE_RESTRICTED` path needs a privilege a
  standard user lacks (probe: err 1314); Low IL alone is the enforced write boundary and needs none.
  The Job Object supplies guaranteed reaping (and a fork-bomb cap), closing a known S4 gap.
- **Auto-allow is positive-proof and sandbox-backed.** A string reviewer can be obfuscated, so
  auto-run is granted only to a provably-safe *shape* AND is executed *inside* the boundary as
  defense-in-depth; with no enforcement it is disabled (fail closed). Approved commands run
  UNSANDBOXED — the user accepted the risk (Codex's model).
- **Truth over parity.** The mode is probed, not assumed; reported verbatim everywhere; and the
  honest limits (reads/network/service-reparent NOT confined) are stated in facts, report, prompt,
  and README. Non-Windows gets `none`, not a simulated boundary.
- **`-EncodedCommand` everywhere** for the PowerShell shell: robust quoting and a clean argv
  round-trip through the sandbox host (which `-Command` mangled).

### Open issues / not verified

- **Latency:** each sandboxed command pays a PowerShell start + `Add-Type` compile (~1.2 s observed).
  Acceptable for V0.4; a cached compiled assembly (or a persistent host) is the obvious optimization.
- **`powershell.exe` CLIXML-on-piped-stderr:** when stderr is a pipe, powershell wraps error/progress
  streams as `#< CLIXML` — a pre-existing `run_command` cosmetic, not sandbox-introduced.
- **Enforced gaps (documented, by design):** no read/confidentiality boundary, no network egress
  control, Low-labeled scratch is writable, and service-reparented work (schtasks/sc/wmic/BITS)
  escapes the Job Object. These are the natural Session-6+/future targets.
- The self-test probe + `icacls` scratch-labeling run on every Windows session start (~1–2 s one-time).

### Recommended next step

BLUEPRINT Session 6 (Git-native, reviewable, context-efficient coding) is the standing next
direction. Sandbox follow-ups worth folding in when relevant: a cached/compiled host to cut latency;
a network-egress story (the honest gap most likely to matter); and — once a subagent runtime exists
(Session 7) — deciding which boundary a subagent runs inside, for which the Low-IL backend is the
Windows answer.

---

## Earlier Milestones (Sessions 1–4 — compressed per the rolling-docs policy)

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
visible now that read-only git auto-runs are a hot path); macOS/Linux enforcement backends;
containment of service-reparented work (schtasks/sc/wmic/BITS) that escapes the Job Object.
