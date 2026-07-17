# ROADMAP

Rolling execution record: the latest one or two sessions in full detail, older sessions
compressed under **Earlier Milestones** (per the rolling-docs policy in `CLAUDE.md`). Newest first.

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

## Session 3 (2026-07-16) — Recorded live E2E demo + two defects it surfaced

### Objective

Not a product increment: produce a truthful, continuous, Playwright-recorded demonstration of
the V0.2 loop — launch in an empty folder, on-camera trust consent, natural-language build of a
complete web app with inline approvals, in-session `/report`, quit, interactive resume
(`agent --continue`) with a follow-up change, starting the generated server, and driving the
finished app in the browser. Fix Agent CLI only where the E2E genuinely exposed a defect.

### Demo result (artifacts live OUTSIDE this repo)

`C:\Users\A\Desktop\agent-cli-demo-20260716\` — isolated demo root: `ws/` (agent workspace),
`state/` (isolated `AGENT_CLI_STATE_DIR`), `video/agent-cli-live-demo.webm` (**11m20s**, one
continuous recording), `artifacts/` (full PTY byte log, stripped transcript, keystroke +
approval log, screenshots, export download, `agent report` md+json, `verification.md`),
`harness/` (the transparent companion: xterm.js page bridged to a real ConPTY running
PowerShell; Playwright drives keystrokes through the page and records it — documented
honesty notes in the demo README).

The agent (real `claude-opus-4-8` through the proxy) built **FlowBoard** — a dark-themed
Kanban board (7 files, ~865 lines: pure-logic `store.mjs` + 15 `node --test` unit tests, DOM
wiring, static `server.mjs` with root-containment, README) — in one 128s turn plus one 35s
resumed follow-up turn (Export-JSON feature + test), 2 approvals (both `node --test`), zero
denials, zero budget hits, all 7 files CHECKED in the evidence report.

### Agent CLI changes (the E2E's product yield — both committed pre-recording)

1. **fix(cli): entry guard never ran under npm link** — Node realpaths the main module's
   `import.meta.url`, but the guard compared it to `pathToFileURL(argv[1])` verbatim, so the
   README-documented `npm link` shim exited 0 silently with no output. Now realpaths argv[1];
   regression test spawns the built CLI through a junction (`test/cli.smoke.test.ts`).
2. **test: vitest `testTimeout` raised to a 60s hang backstop** — the 5s default kept
   producing the spurious subprocess-test timeouts already noted twice in this file (measured:
   one bare Node spawn can take multiple seconds under real machine load).

### Verification evidence

- Post-fix gate: typecheck/build clean; **205 passed, 1 skipped** (was 204+1; +1 regression).
- Live API smoke (`AGENT_LIVE_TEST=1`, anthropic.test.ts): 5/5 through the system proxy.
- The recorded session's own evidence chain was independently audited by a 4-agent
  verification workflow (app / evidence-log / isolation / completeness-critic lenses): report
  ↔ raw JSONL consistent (85 events; trust `prompt-remember` then `store` on resume; exactly
  2 `approval.resolved`, both allow-by-user; every mutation snapshot re-hashes to its content
  address; final files re-hash to the report's after-hashes); app 15/15 tests + live HTTP
  checks + traversal probes safe + browser console clean; isolation: no `.git` in the demo ws,
  repo tree clean with zero demo references, real `%USERPROFILE%\.agent-cli` untouched.
  Full detail: `artifacts/verification.md` in the demo folder.

### Decisions (and why)

- **Record a browser-hosted real terminal (xterm.js ↔ ConPTY bridge)** instead of faking
  terminal output in a page: Playwright can only record pages, but the CLI must run in a real
  TTY to exercise the true interactive surface (raw-mode readline, on-camera trust prompt,
  Unicode glyphs). Every displayed byte comes from the PTY; the one injected setup line
  (UTF-8 codepage + PSReadLine hygiene) is logged and disclosed.
- **PSReadLine predictions disabled for recordings** — ghost-text renders the developer's
  private global command history into the video (observed live before the fix).
- **Approvals answered by an explicit, logged human-proxy policy** in the driver (deny-list
  regex, else allow), so the recording's approval answers are auditable rather than ad hoc.

### Open issues / findings for V0.3

- ~~Approval-prompt labeling UX nit~~ — **closed in Session 4** (`[shell command — labeled …]`).
- The report's "Files changed" uses last-mutation-per-path semantics, so a file created then
  edited in one session renders as `modify` — correct but can read as if the file pre-existed;
  presentation nuance noted by the audit.
- ~~Session 2's manual Ctrl+C console smoke~~ — **one-shot half closed in Session 4** with a
  genuine delivered CTRL_C; the interactive-REPL keypress smoke remains open.

---

## Earlier Milestones (Sessions 1, 1b, 2 — compressed 2026-07-17 per the rolling-docs policy)

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
providers. **Lasting decisions:** no command allowlist — every shell command asks (allowlists are
trivially smuggled; the class label only informs the human); in-workspace writes auto-allow but
snapshot first; sandbox vs approval kept separate and only approval shipped (documented
honestly); one path validator for policy and tools; secret reads redacted in the log via
salted HMAC (model still sees real bytes; redacted reads deliberately cannot replay on resume);
state lives outside the workspace; `thinking` omitted pending block-preservation work.
**Still-true limitations:** no OS sandbox; command output not scrubbed for secrets; path checks
TOCTOU-racy; undo is file-only; single-user lock assumption.

---

## Deferred pool (accumulated, still open)

Adaptive thinking with block preservation; per-action / `--to` / `--steps` undo; tree-sitter
ranked repo map; network/web tools; MCP and workflow packs; SQLite index over the JSONL;
conversation rewind; session pruning/sanitized export; prompt-history persistence + line-editing
niceties; OS-level sandboxing (Session 5 next); background/long-running process sessions; PTY
support; Job Objects tree-kill helper; output spill-to-file for huge command output.
