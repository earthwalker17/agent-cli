# ROADMAP

Session-by-session evolution of Agent CLI. Newest first.

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

- **Live Anthropic call not verified in this environment.** The `AnthropicProvider` is unit-tested
  (message/block/stop-reason mapping) but a real API call returned `403 forbidden "Request not
  allowed"` from the credential available in this sandbox (the key is not authorized for direct
  Messages API use, or is an OAuth-style token the SDK sends as `x-api-key`). The request was
  built, streamed, and the error surfaced correctly — this is a credential/permission constraint,
  not a code defect, but the live path remains unproven here. Re-run `AGENT_LIVE_TEST=1 npm test`
  with an authorized key.
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
