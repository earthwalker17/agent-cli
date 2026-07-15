# ROADMAP

Session-by-session evolution of Agent CLI. Newest first.

---

## Session 2 (2026-07-15) — V0.2: interactive REPL, workspace trust, narrowing-only config

### Objective

Evolve the one-shot CLI into a practical interactive REPL (Claude Code-like: launch in any
folder, converse continuously, live tool activity, inline approvals) WITHOUT weakening the
safety model — shipping the workspace-trust gate and policy-config file that V0.1 deliberately
deferred, and keeping trust (consent), approval (human gate), logical policy, and sandboxing
(nonexistent, stated honestly) separated.

The design came from a 3-designer + 3-adversarial-critic workflow (as in Session 1). The
critics — verifying claims against source — caught real pre-implementation defects that shaped
the build: `EventLog.events` was a frozen open-time snapshot (in-session /undo would have
restored a PRIOR session's mutation while claiming success); the `forceDeny` path cannot stop
auto-allowed writes (the planned interrupt wouldn't interrupt — and the same gap existed in
V0.1's deny-&-stop); a mid-stream abort leaves consecutive user-role messages on the wire; and
`--interactive` without a mode override would have paired the REPL with the auto-deny approver.

### What was implemented (9 commits, one per verified stage)

1. **Live, observable EventLog** — `events` getter over a live array + `onAppend` observer
   (fired post-write, throws swallowed): the single point the REPL renders from.
2. **Turn abort** — `runTurn(…, {signal})` / `Provider.complete(…, signal)`; pre-gate skips
   every pending call once aborted or deny-&-stopped (fixes the V0.1 deny-&-stop gap,
   regression-tested); `turn.aborted {phase}` event; `coalesceUserMessages` at the Anthropic
   wire; `repairDanglingToolUses` for turn errors; MockProvider `hang` turns.
3. **CLI split** — `src/cli/{index,context,trust-check}.ts`; ONE `buildRunContext` for both
   interfaces; mode precedence `--no-input` > `--interactive` > isTTY (conflict = error);
   read-only commands stop creating state dirs.
4. **Workspace trust** — `<state>/trust.json` + `trust.log` audit; gate before any workspace
   byte is read; hoisted state-root-inside-workspace refusal (a folder cannot self-grant);
   prompt only on a real TTY; exit 3 fail-safe; `--trust-this-workspace` never persists;
   `agent trust [--revoke|--list]`; `trust.verified` event; bidi-sanitized prompt paths.
5. **Narrowing-only config** — user prefs + workspace narrowing knobs (`protectedPaths`,
   `secretPatterns` as literal substrings); strict schemas that cannot express widening; read
   only post-trust; `.agent-cli/` write-protected from the agent; `config.loaded` provenance.
6. **REPL** — bare `agent` (TTY or `--interactive`) / `--continue` / `resume <id>`; one
   persistent readline shared with approvals (EOF at an approval → deny-&-stop); live render
   from the log; stdout = model text only, chrome on stderr; ASCII glyph fallback for legacy
   consoles; slash commands over the live log; Ctrl+C aborts the turn / twice quits;
   `user-quit` for every human-initiated end; system prompt: never touch git unless asked.
7. **Subprocess smoke tests** for the piped REPL (real approver over pipes, stream purity,
   trust refusal, flag conflict).
8. **Live E2E fixes** (below) and **docs**.

### Verification evidence

- `npm run typecheck` clean; `npm run build` clean; `npm test`: **196 passing, 1 skipped**
  across 18 files (was 143+1). New suites: runtime.abort (8), trust (12), config (9), repl (12),
  store liveness (4), report exclusions, and 7 new CLI smoke tests.
- **Live E2E round 1** (real Opus 4.8 through the system proxy, expect-style driver, isolated
  `Desktop\agent-cli-e2e\ws`): `agent trust` → piped `--interactive` REPL → 3 natural-language
  instructions built a working `wordstats` utility (README + tests). Human-proxy driver DENIED
  the model's first compound shell command; the model adapted and verified with `node --test`
  (3/3 pass, exit 0 — files CHECKED in the report). Verified after the run: the utility works
  (`lines=47 words=161 chars=1021`), no `.git` created, zero writes to the Agent CLI repo,
  state only under the isolated state dir.
- Round 1 surfaced **3 real defects, fixed + tested**: in-session `/report` labeled a running
  session CRASHED/UNKNOWN; "Commands run" listed a denied command as if executed; piped
  transcripts lost the dialogue (no echo of piped input).
- **Live E2E round 2**: `/undo` live (created file restored), the `[[harness note]]` reached
  the model on the next turn (it recreated the file), fixed transcript confirmed.
- **Live E2E round 3**: interactive resume (`agent --continue`) replayed the conversation
  against the real API and extended the file correctly (also exercising coalesceUserMessages
  wire-shape acceptance on a resumed history).

### Decisions (and why)

- **Trust prompt only on a real TTY.** A piped "t" into a prompt nobody read is ambient consent;
  piped runs must use the explicit flag or `agent trust`. `--trust-this-workspace` deliberately
  never persists — a CI flag must not silently pre-authorize future interactive runs.
- **Workspace config carries no preferences.** A folder is attacker-influencable ground; it may
  narrow policy but never choose the model, provider, or budgets. Config schemas structurally
  cannot express widening (no allowlists — the V0.1 always-ask command decision stands).
- **The screen renders from the log** (`EventLog.onAppend`), not from a parallel narrative —
  and stdout stays model-text-only so piped transcripts are clean evidence.
- **`user-quit` for /quit, EOF, and double-Ctrl+C** — human departure is not task completion.
- **Abort at boundaries only.** A running `run_command` is not killable in V0.2; the abort
  lands at the next tool boundary and the limitation is printed and documented.

### Open issues / not verified

- **Ctrl+C on a real console (raw-mode readline SIGINT + echo-mute) is manually unverified** —
  Windows cannot deliver a genuine ^C to a piped child, so the abort path is proven at the
  runtime level (in-process tests) but the end-to-end keypress needs one manual smoke on
  Windows Terminal and conhost: run `agent`, start a long turn, press Ctrl+C (expect "turn
  interrupted" + prompt), press it twice at idle (expect exit).
- Approval-prompt Ctrl+C resolves the pending question via stream close/EOF mapping in piped
  mode; on a real TTY the 'SIGINT' path resolves it as interrupt → abort (unit-covered, same
  manual smoke applies).
- The pre-existing V0.1 flakiness of subprocess tests under heavy parallel load (PowerShell
  spawn latency) was observed once early in the session and not reproduced after; no timeout
  changes were made.
- `agent map` remains ungated pre-trust (reads .gitignore + prints file names locally, nothing
  sent to a model) — documented exception.

### Deferred to V0.3+

Adaptive thinking with block preservation; killing an in-flight run_command on abort; per-action
/ `--to` / `--steps` undo; tree-sitter ranked repo map; network/web tools; MCP and workflow
packs; SQLite index over the JSONL; conversation rewind; session pruning/sanitized export;
prompt-history persistence and line editing niceties in the REPL; OS-level sandboxing research.

### Recommended next step

Two candidates, in order: (1) **first non-coding workflow pack** (documents/PDF per PROJECT.md
§9) to prove the small-kernel/broad-workflow thesis now that the interactive loop exists;
(2) **context management for long REPL sessions** (token budgeting + history compaction with
evidence-faithful summaries), which multi-turn interactive use will hit first in practice.

---

## Session 1b (2026-07-14) — Automatic proxy support + verified live E2E

### Objective

Close the one surface Session 1 left unproven: the live Anthropic path (previously a `403` from a
filtered direct egress). Add clean, automatic proxy support so the harness works behind a system
proxy, then run a real end-to-end of the complete V0.1 loop with the authorized credentials.

### What was implemented

- **Reusable transport factory** (`src/net/transport.ts`). A pure `resolveProxy` that detects
  `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY` (either case) with correct precedence and
  bypass rules, and `createTransport` which returns a per-request-proxied `fetch` (undici
  `ProxyAgent` dispatcher, no global side effects) or nothing at all for direct connections.
  Credentials are redacted from the description and never persisted.
- **Provider decoupled from networking.** `AnthropicProvider` now takes a `Transport` from the
  factory and exposes a redacted `transport` description; it holds no proxy logic, so future
  providers reuse the same infrastructure. The CLI logs the (redacted) network path to stderr.
- **`undici`** added as a dependency for `ProxyAgent`.

### Verification evidence

- `npm run typecheck` clean; `npm run build` clean.
- `npm test`: **143 passing, 1 skipped** (the skipped one is the opt-in live test). The new
  `test/transport.test.ts` covers direct mode, HTTPS/HTTP/ALL_PROXY detection, lowercase vars,
  precedence, all NO_PROXY bypass forms, explicit override, credential redaction, per-request
  dispatcher routing, and provider integration (the SDK routes through the injected fetch to an
  `anthropic.com` URL).
- **Live unit smoke** (`AGENT_LIVE_TEST=1`): the real API call that returned `403` in Session 1
  now **succeeds through the proxy** — 5/5 pass.
- **Live full-loop E2E** through the built CLI against real Opus 4.8:
  - Run 1 (create): the model read `service.yaml` and wrote `SUMMARY.md`; the file was created on
    disk with correct content; the CLI reported `network: proxy http://127.0.0.1:7897/ (via
    https_proxy)` and `1 file(s) changed`.
  - Run 2 (edit + recover): the model used `edit_file` to change `beta`→`BETA` in `data.txt` (edit
    landed on disk); the evidence report showed `modify … [undo-recorded] UNCHECKED`; `agent undo`
    then restored the file to its original bytes.
  - This exercises the complete loop with real credentials: proxy transport → streaming provider →
    agent loop → policy gate (observe allow / reversible auto-allow) → snapshot → tool execution →
    event log → report → undo recovery.

### Decisions

- **Per-request dispatcher, never `setGlobalDispatcher`** — no process-wide side effects, and
  `NO_PROXY` is evaluated per target host so the transport is correct for any provider/host.
- **No custom `fetch` in pure-direct mode** — when no proxy is configured the SDK keeps its own
  default fetch, so nothing changes for users without a proxy.
- **No `--proxy` CLI flag** — proxy config comes from the environment (or the factory API);
  keeping it out of argv avoids any risk of a credential-bearing proxy URL landing in the logged
  `session.started` argv.

---

## Session 1 (2026-07-14) — V0.1 bounded local agent loop

### Objective

Build the first implementation: a clean, trustworthy V0.1 foundation around the bounded local
agent loop — workspace understanding, explicit typed capabilities, one central policy/approval
engine, an append-only evidence log with resume, snapshot/undo recovery, and a deterministic
verification report. Windows-first, TypeScript strict + ESM + Node 22.

The design was chosen after researching six reference agents (OpenAI Codex CLI, CodeWhale, aider,
OpenCode, Goose, Claude Code) and running three independent architecture proposals through
adversarial review. The critiques drove several concrete decisions (below).

### What was implemented

The whole seven-pillar loop, all tested:

- **Kernel & contracts** — `src/types.ts` (all shared discriminated-union contracts), injectable
  clock/id/hash primitives (determinism levers).
- **Event log** — append-only JSONL with an atomic lock (`{pid, startedAt, token}`), partial-tail
  repair before append, strict corruption refusal, and newer-schema-version rejection. A lenient
  reader backs the report and session listing.
- **Policy engine** — one pure choke point classifying every call into
  observe/reversible/external/destructive/sensitive and returning allow/ask/deny, plus a
  Windows-first path validator (device/UNC/reserved/ADS/trailing-dot rejects, junction/symlink
  escape detection, sibling-prefix-safe containment).
- **Tools** — read_file, list_files, search (ReDoS-bounded, secret-file-skipping), write_file,
  edit_file (unique-match), run_command (PowerShell `$LASTEXITCODE` propagation, timeout,
  process-tree kill). One zod schema per tool; the model-facing JSON Schema is derived from it.
- **Snapshots & undo** — content-addressed pre-image store; drift-refusing restore; `undo` /
  `undo --all`.
- **Runtime loop** — gates each tool call, streams assistant text, snapshots mutations (escalating
  to a no-undo ask on capture failure), and records structured evidence. Interactive / auto-deny /
  dangerous approvers.
- **Resume** — faithful conversation reconstruction with crash reconciliation against
  `file.mutated`/postHash.
- **Workspace map & system prompt** — bounded gitignore-aware map fed to the model, with the
  honest no-sandbox statement.
- **Evidence report** — pure `Event[] → { md, json }`, mechanical CHECKED/UNCHECKED, honest
  footers.
- **Providers** — offline scripted `MockProvider`; streaming `AnthropicProvider`.
- **CLI** — run / resume / undo / report / sessions / map, with a `#!/usr/bin/env node` binary.
- **Docs** — this file, `ARCHITECTURE.md`, and `README.md` (with the security-honesty section).

### Verification evidence

- `npm run typecheck` (tsc strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`):
  clean.
- `npm test`: **121 passing, 1 skipped** across 14 files. Coverage targets the spine — path
  boundary table (sibling-prefix, `..`, junction, UNC, ADS, reserved names); event-log
  corruption/lock/version; snapshot capture-failure-blocks-mutation, drift-refuse, binary
  fidelity; policy decision table; runtime e2e (happy path, grants + redaction, deny-stop,
  non-interactive, refusal); resume postHash reconciliation; report goldens; and a **CLI
  subprocess smoke suite** driving the built binary.
- `npm run build`: clean emit to `dist/`.
- **Dogfood** against this repo: `agent map` lists the source tree gitignore-aware; a scripted run
  read `CLAUDE.md` (allowed), was denied an out-of-workspace write, and had a shell command
  auto-denied in non-interactive mode (exit 2); `agent report` rendered the evidence with the
  correct allow/deny classifications and honest footer; `agent sessions` listed it as completed.

### Decisions (and why)

- **No command allowlist — every shell command is `ask`.** The adversarial review showed any
  allowlist is trivially smuggled (`;`, `|`, `$()`, backtick, `iex`, `-EncodedCommand`) and that a
  shell can write files (bypassing snapshot/undo). Auto-allowing commands is the single biggest
  hole, so V0.1 gates all of them. The class label only informs the human prompt.
- **In-workspace writes auto-allow but are snapshotted; commands gate.** "Reversible → auto,
  undeclarable side effects → gate" is the clean, defensible mapping. Undo + the report are the
  safety net.
- **Sandbox vs approval kept separate; V0.1 ships only approval.** Documented as logical policy,
  never implied as OS isolation (constitution principles 4 & 5).
- **Secret redaction vs faithful resume.** Secret-file read *contents* are redacted in the log
  (HMAC + per-session salt); the model still sees the real bytes. The deliberate consequence: a
  resumed session cannot replay a redacted secret. Every other tool result replays byte-faithfully.
- **One path validator for policy and tools** eliminates the "two resolvers diverge" defect.
- **`thinking` omitted in the Anthropic provider** to avoid the thinking-block round-trip a
  tool-use loop must otherwise preserve. Adaptive thinking with block preservation is a V0.2 item.
- **State lives outside the workspace**, and startup refuses if it resolves inside — with the
  honest caveat that an approved shell command can still reach it.

### Open issues / not verified

- **Live Anthropic call — RESOLVED in Session 1b.** The `403` was a filtered direct egress: the
  authorized path is a system proxy. Session 1b added automatic proxy support and verified the
  full live loop end-to-end. (The original speculation that the key might be unauthorized was
  wrong; the request simply needed to go through `HTTPS_PROXY`.)
- **Not a git repository yet.** `git init` was intentionally not run (the constitution says commit
  only when asked). `.gitignore` is in place.
- **Known honest limitations** (documented in README): no OS sandbox; `run_command` output is not
  scrubbed for secrets; path checks are TOCTOU-racy; undo is file-only; the two-process lock refuse
  is unit-tested via a foreign pid but same-process reopen steals the lock (single-user assumption).

### Deferred to V0.2+ (the next increment)

Interactive REPL and in-place status rendering; adaptive thinking with thinking-block
preservation; per-action / `--to` / `--steps` undo and `--force` (with clobbered-byte capture); a
policy config file **plus** the workspace-trust gate that must precede it; tree-sitter ranked repo
map; network/web tools; MCP and workflow packs; a SQLite index over the JSONL; conversation
rewind; a model-based approval reviewer; git-aware features; session pruning / sanitized export.
The event schema carries `v`, so an index or new event types are mechanical.

### Recommended next step

Re-run the live Anthropic path with an authorized key to close the one unverified surface, then
build the **interactive REPL** on top of the existing `runTurn` (the runtime already supports
multiple turns per session) — it is the highest-value UX gap and needs no kernel changes. In
parallel, the **policy config file + workspace-trust gate** is the most valuable safety increment,
since it was deliberately cut from V0.1 for lacking a trust story.
