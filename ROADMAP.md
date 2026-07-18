# ROADMAP

Rolling execution record: the latest one or two sessions in full detail, older sessions
compressed under **Earlier Milestones** (per the rolling-docs policy in `CLAUDE.md`). Newest first.

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

## Session 4 (2026-07-17) — V0.3: execution kernel hardening

### Objective

BLUEPRINT Session 4: make shell execution explicit, controllable, observable, and composable —
real mid-command cancellation, structured termination semantics, environment hygiene, and
lifecycle evidence — without adding an OS sandbox (Session 5) and while preserving the single
runtime, the single policy choke point, and the additive v1 event schema. The design followed a
7-agent recon workflow (3 repo explorers + 4 reference researchers over OpenAI Codex CLI, Claude
Code, OpenCode/Goose, and Node-on-Windows process internals) plus a Plan-agent design pass.

### What was implemented (7 commits, one per verified stage)

1. **`src/exec/` substrate** (policy-free, log-free; reusable for future workflow-pack renderer
   processes): `env.ts` (child-env hygiene: case-insensitive dedupe, default drop of names
   containing key/secret/token/password/credential, non-excludable core floor — never strip
   `SystemRoot`/`windir` (WinError 10106) — proxy passthrough, `AGENT_CLI=1` marker), `kill.ts`
   (verified best-effort tree kill: async `taskkill /T /F`, exit 0|128 both benign, bounded
   liveness probes), `run.ts` (`runManaged` → typed `ExecOutcome`; kill/drain state machine:
   settle on `'exit'`, race `'close'` against a bounded drain, destroy streams — fixes the
   nodejs/node#21960-class hang where a surviving grandchild holding inherited pipes stalls the
   outcome forever; head+tail byte-capped capture; stdin never connected).
2. **`run_command` rebuilt on the substrate**: `CommandTermination` (`exited|timeout|aborted|
   spawn-error`), killed commands have **no exit code** (was: timeout conflated with −1),
   distinct model-facing message per termination path; `ToolContext` gained `signal`/`onOutput`/
   `reportCommand` (all optional, additive).
3. **Runtime cancellation + evidence**: per-call context binds the turn AbortSignal and
   callId-bound evidence channels (a tool cannot forge another call's evidence); new additive
   events `command.started {pid,…}` (actual spawn — execution ground truth) and `command.ended
   {termination, exitCode|null, killDetail, drainTimedOut}`. The V0.2 limitation "a running
   run_command is not interruptible" is gone.
4. **Ctrl+C end-to-end**: REPL Ctrl+C now kills the running command (same signal path); the
   one-shot CLI gained SIGINT wiring (`installSigintAbort`: first press aborts, second
   force-exits). Live render-only command-output preview in the REPL (sanitized, rate-limited,
   8 KiB display cap, `(pid N)` marker, honest kill lines).
5. **Termination-aware report/resume**: killed commands render `killed: … no exit code`; a
   `command.ended` kill vetoes CHECKED even against a stray exit-0; `command.started` without
   completion renders `STARTED but never completed … effects unknown` (+ honesty footer); resume
   replays an executing-at-crash command with an unknown-effects message.
6. **Config + policy UX**: narrowing-only `envExcludePatterns` (both layers, lowercased union;
   core floor structurally non-excludable); approval prompts present command class as a label —
   `[shell command — labeled observe]` — closing Session 3's UX finding; system prompt + tool
   description teach the model the new semantics (no stdin; secret-name env filtering; a killed
   command is never evidence a check passed).

### Verification evidence

- Gate: `npm run typecheck` + `npm run build` clean; `npm test` **240 passed, 1 skipped** across
  24 files (was 205+1; +35, including the tree-kill fixture with a *detached* grandchild — proving
  our `taskkill /T` did the work, not libuv's job object — and the pipe-holding-grandchild drain
  regression).
- **Live E2E** (real `claude-opus-4-8` through the system proxy; isolated
  `Desktop\agent-cli-e2e-s4` workspace + state):
  - Run 1 (env hygiene): the model's approved command echoed the child env — output `K=;A=1;`
    (API key stripped, harness marker present) while the agent itself still reached the API; the
    approval prompt showed the new `[shell command — labeled observe]` header on camera.
  - Run 2 (real interrupt): agent launched in its own hidden console; after `command.started`
    (pid recorded in evidence) a **genuine console CTRL_C** was delivered via a sacrificial
    `AttachConsole`+`GenerateConsoleCtrlEvent` helper. Observed: `interrupt: stopping the turn` →
    `command.ended {termination:'aborted', exitCode:null, killDetail:'taskkill exit 0; probe:
    dead'}` → spawned shell verified dead → `turn.aborted` → `session.ended user-quit`, exit 2;
    the report renders `killed: aborted by user (1902 ms); no exit code` with the honesty footer.
    This closes the one-shot half of Session 2's open Ctrl+C smoke with a real keystroke-level
    signal.
- Adversarial review: 4 finder lenses (safety / correctness / windows-io / test-honesty) →
  19 findings, verified **by hand** against the source (the per-finding agent verifier fan-out was
  aborted for cost and is now prohibited — see the cost lesson below and the new CLAUDE.md rule).
  Five real defects fixed + regression-tested in commit `fix(exec,...)`:
  1. **[high] drain-window relabel race** — a timeout/abort landing in the post-`exit`/pre-`close`
     drain window (largest exactly in the pipe-holding-grandchild case) relabeled a genuinely
     exited command as killed and nulled its real exit code; now `initiateKill` is guarded on
     `exitFired` and the timeout/abort are disarmed at exit. New deterministic regression test.
  2. **[med] POSIX env dedupe** dropped genuinely distinct vars (`http_proxy` vs `HTTP_PROXY`);
     case-insensitive folding is now Windows-only.
  3. **[med] multibyte seam** — `CappedCapture.text` decoded head/tail separately even when nothing
     was truncated, corrupting a rune split across the seam; now decodes one contiguous buffer.
  4. **[med] kill-honesty** — the model-facing message said "process tree force-killed" even when
     the liveness probe reported STILL ALIVE; it now surfaces the actual `killDetail`.
  5. **[low] never-spawned pre-abort** claimed a tree kill for a command that never spawned; the
     message is now conditional on a kill having been attempted.
  Remaining low findings (append-inside-spawn-listener robustness; live-preview per-chunk decode;
  one-shot approval-prompt Ctrl+C) are noted below as not-yet-addressed.
- Mid-session live validation of the premise: the session's own recon workflow hung for ~36
  minutes on an in-flight API call with no timeout behind a `parallel()` barrier — precisely the
  unkillable-in-flight-work failure class this session removed from `run_command`.

### Decisions (and why)

- **Force-kill only, labeled best-effort.** Research consensus (Codex, OpenCode, Node/libuv
  internals): no graceful kill exists for console children from stock Node on Windows;
  `taskkill /T` cannot reach grandchildren orphaned by a dead intermediate parent (Windows never
  reparents); Job Objects are the only race-free tree kill but have no maintained Node binding.
  So the code, messages, and docs say "best effort" — never "tree terminated".
- **Never await `'close'` after a kill** — settle on `'exit'`, bounded drain (1500ms), destroy
  streams, record `drainTimedOut` honestly (Goose's 500ms / Codex's 2s pattern).
- **Killed commands have no exit code, everywhere.** The report additionally vetoes CHECKED on
  kill evidence — defense in depth against a stray exit-0.
- **Env hygiene is default-on** (stronger than Claude Code's opt-in scrub, mirroring Codex's
  default excludes) with a structurally non-excludable functional floor; proxy variables pass
  through (documented honest limitation, not a boundary claim).
- **Evidence channels are callId-bound by the runtime**, so the capability contract grew without
  creating a forgeable evidence path; live output is render-only (`onText`-parallel), the
  persisted truth stays `tool.completed`.
- **`'interrupted by user'` stays reserved for never-spawned calls**; `turn.aborted` (turn) and
  `command.ended {termination:'aborted'}` (process) remain distinct facts.

### Open issues / not verified

- The REPL raw-mode **interactive** Ctrl+C keypress (readline 'SIGINT' on a real console) still
  wants one quick manual smoke on Windows Terminal/conhost; the one-shot path is now proven with
  a genuine CTRL_C, and io.ts's SIGINT path is unit-covered.
- Grandchild survival when an intermediate parent dies first is structural (documented); a Job
  Objects native helper would close it (deliberately out of scope this session).
- Three low-severity review findings left unaddressed (small, non-load-bearing): `command.started`
  append happens inside the child `'spawn'` listener (an append throw would surface as an
  uncaughtException rather than a handled turn error); the live-output preview and `onOutput`
  decode each pipe chunk independently (cosmetic U+FFFD on a multibyte split — render-only, the
  persisted capture is now seam-safe); a one-shot Ctrl+C *during an interactive approval prompt*
  is handled by the approver's own readline, not `installSigintAbort` (one-shot is normally
  non-interactive/auto-deny, so this path is rare).
- **Cost lesson (now a CLAUDE.md rule):** the adversarial-review workflow was authored with a
  per-finding 3-verifier fan-out on top of 4 finders — 19 findings turned into ~57 verifier
  agents and blew the session token budget before completing. The finders had already produced
  all 19 findings and were salvaged from the workflow journal; verification was then done by hand.
  Rule added: cap review workflows at ~a dozen agents, no per-finding verifier panels, verify by
  hand by default, salvage journals before relaunching.

### Recommended next step

BLUEPRINT Session 5: **enforced isolation and honest safety modes**, research-first and
Windows-first. Codex's native Windows sandbox (restricted tokens, ACLs, WFP; honest failure
modes) and Anthropic's open-sourced sandbox-runtime are the reference points. V0.3's exec
substrate is the natural seam: a sandbox backend would transform the `ExecSpec` (argv/env) at
spawn time, and the mode must be reported truthfully (policy-and-approval-only where no
enforcement exists).

---

## Earlier Milestones (Sessions 1–3 — compressed per the rolling-docs policy)

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
ranked repo map; network/web tools; MCP and workflow packs; SQLite index over the JSONL;
conversation rewind; session pruning/sanitized export; prompt-history persistence + line-editing
niceties; background/long-running process sessions; PTY support; output spill-to-file for huge
command output. **Sandbox follow-ups (post-S5):** network-egress control and a read/confidentiality
boundary (the two enforced gaps that most matter); a cached/compiled sandbox host to cut per-command
Add-Type latency; macOS/Linux enforcement backends; containment of service-reparented work
(schtasks/sc/wmic/BITS) that escapes the Job Object.
