# ARCHITECTURE

How Agent CLI V0.5 is actually built. This describes the implemented system, not aspirations —
see `ROADMAP.md` for what is deferred.

## Shape

A modular monolith in TypeScript (strict, ESM, Node 22). One runtime function (`runTurn`) drives
the agent loop; both interfaces — the one-shot CLI and the interactive REPL — are thin consumers
of the same runtime (no parallel execution path). Data is plain JSON-serializable discriminated
unions; classes appear only where state genuinely lives (`EventLog`, `SnapshotStore`). Five
runtime dependencies: `@anthropic-ai/sdk`, `zod` (v4, one schema source per tool), `ignore`
(gitignore fallback walker), `undici` (proxy transport), and `diff` (jsdiff — line diffs for
review evidence).

```
src/
  types.ts                 All shared contracts (no logic).
  shared/
    clock.ts, ids.ts       Injectable clock + id generation (determinism levers for tests).
    hash.ts                sha256, the single truncation contract, HMAC secret redaction.
    pathutil.ts            caseFold + isInside (trailing-separator boundary containment).
    text.ts                sanitizeLine — escapes bidi/zero-width/control chars for display.
    diff.ts                jsdiff wrapper: lineDiffStat, unifiedDiff, shared binary/size guards.
    errors.ts              Typed error classes (branch on class, never on message).
  policy/
    paths.ts               validatePath — Windows-first boundary/hard-reject gate (+ config-declared
                           extraProtected roots).
    engine.ts              classify + decide + Grants. Pure. The single policy choke point.
    command-review.ts      analyzeCommand — deterministic positive-proof auto-run gate (see below).
  store/
    layout.ts              State-dir resolution (resolveStateRoot) + refuse-if-inside-workspace.
    event-log.ts           Append-only JSONL log: lock, tail-repair, corruption/version handling.
                           `events` is LIVE (appends visible immediately) and observable via onAppend.
    snapshots.ts           Content-addressed pre-image blob store; capture/restore with drift refuse.
  exec/
    env.ts                 buildChildEnv — child-process env hygiene: ci dedupe, secret-name drops,
                           non-excludable core floor + proxy passthrough, AGENT_CLI=1 marker.
    kill.ts                killTree — verified best-effort tree kill (taskkill /T /F, 0|128 benign,
                           bounded liveness probes) + isAlive.
    run.ts                 runManaged — the managed-subprocess runner: structured ExecOutcome,
                           kill/drain state machine, head+tail capped capture. Policy- and log-free.
  git/
    types.ts               GitFacts / GitResult / porcelain contracts (harness capability, NOT tools).
    client.ts              runGit over runManaged: absolute-path git, fsmonitor off, optional-locks
                           off, GIT_* scrub, no prompts/stdin, bounded timeouts (see "GitOps").
    facts.ts               detectGitFacts — the session-start probe; explicit nulls on every degrade.
    porcelain.ts           Pure `status --porcelain=v2 -z` parser (NUL records, rename pairs).
    commit.ts              prepareCommit/performCommit/runCommitFlow — the deliberate-commit flow.
    checkpoint.ts          create/list/prune + planRestore/runRestoreFlow — hidden-ref checkpoints.
  sandbox/
    types.ts               SandboxBackend + EnforcementFacts contracts (re-exports ExecSandbox).
    bootstrap.ts           The versioned PowerShell + inline-C# (Add-Type P/Invoke) Low-IL host script.
    windows-lowil.ts       The enforced Windows backend: transform-at-spawn (wrapSpec) + probe.
    none.ts                Honest no-enforcement backend (non-Windows / probe failed); identity wrap.
    index.ts               selectSandbox — platform → backend (no probe; caller runs ensureAvailable).
  tools/
    index.ts               read_file, list_files, search, write_file, edit_file + registry + JSON-Schema derivation.
    run-command.ts         Shell tool on runManaged: PowerShell -EncodedCommand $LASTEXITCODE wrapper,
                           filtered env, stdin ignored, per-termination messages, lifecycle + sandbox
                           evidence; applies ctx.sandbox.wrap at spawn time.
  net/
    transport.ts           Reusable proxy-aware transport factory (pure resolver + custom fetch).
  provider/
    mock.ts                Scripted, offline provider (backbone of the tests); `hang` turns for abort tests.
    anthropic.ts           Streaming SDK adapter + pure response mapping + coalesceUserMessages.
  runtime/
    session.ts             startSession / runTurn (abortable) / resumeSession / reconstruct /
                           repairDanglingToolUses / endSession.
    elision.ts             elideHistory — pure, monotone wire-history budget (see "Context budget").
    approvals.ts           auto-deny, dangerous, and interactive approvers (injectable io).
    undo.ts                applyUndo (last / all) over the recorded mutations.
  trust/
    store.ts               trust.json + trust.log at the state root; hard error on corruption.
    gate.ts                ensureTrusted — the consent gate + honest prompt copy.
    commands.ts            `agent trust [--revoke|--list]`.
  config/
    config.ts              Layered narrowing-only config: user prefs + workspace narrowing knobs.
  repl/
    repl.ts                runRepl — the prompt→runTurn loop, session lifecycle, interrupts.
    io.ts                  ONE persistent readline: prompts, approvals, SIGINT, mute, type-ahead.
    render.ts              EventLog.onAppend → live tool activity + per-turn summaries.
    format.ts              Glyph/color tables (ASCII fallback for legacy consoles), pure labels.
    commands.ts            /help /status /undo /report /map /quit over the live log.
  workspace/
    map.ts                 Bounded workspace map + digest: `git ls-files` in trusted repos (nested
                           gitignore correct), pure walker fallback (and always pre-trust).
    system-prompt.ts       System prompt: honesty statement, git context + VCS-mutation prohibition
                           (in-repo) or the original no-git rule (non-repo), the map.
  report/
    report.ts              Pure Event[] → { md, json } evidence report.
    diff.ts                buildSessionDiff/renderSessionDiff — attributable session change review
                           (+ sessionMutationState, the single attribution source for /diff and /commit).
  cli/
    index.ts               parseArgs dispatch: REPL / run / resume / undo / diff / commit /
                           checkpoint / report / sessions / map / trust.
    context.ts             buildRunContext — the ONE session-assembly path both interfaces share;
                           mode precedence --no-input > --interactive > isTTY.
    trust-check.ts         The CLI-side trust gate (prompt only on a real TTY).
```

## Startup order (load-bearing)

For every session-starting command (one-shot and REPL), the order is:
workspace realpath → **state-root-inside-workspace refusal** (also checked in `ensureTrusted`,
so a folder cannot plant a `trust.json` that grants itself consent) → **trust gate** → config
load (the workspace file is untrusted bytes until trust passes) → per-project state creation →
**sandbox select + probe** → **git probe** (`detectGitFacts`, post-trust — it executes git
against the repo) → workspace map (git-backed in a repo, walker otherwise) → provider. The
probed truths feed the banner, the `sandbox.status`/`git.context` events, and the system prompt.
Read-only commands (`report`/`sessions`/`undo`/`diff`/`map`) are ungated, never create state
dirs, and never run git; `agent commit`/`agent checkpoint` ARE trust-gated (they execute repo
hooks / write `.git`); `map` reads workspace bytes but sends nothing to a model (documented
exception) and deliberately keeps the pure walker pre-trust.

## The core loop (`runtime/session.ts`)

`runTurn(session, userText, { signal? })` appends a `user.message`, then loops up to `maxSteps`:

1. Build a `ProviderRequest` — system prompt, the **elided view** of the message history (see
   "Context budget"), tool schemas derived from the tools' zod schemas — and call
   `provider.complete(req, onText)`. Text deltas stream to `onText`.
2. Record `assistant.message` with **structured** content (text + each tool_use's id/name/input)
   so resume is faithful. Push the assistant turn onto the history.
3. If the model stopped for tool use, process each tool_use block **sequentially** through
   `executeCall`, collect all `tool_result` blocks, and push them as one user message. Repeat.
4. Any other stop reason (`end_turn`, `refusal`, `max_tokens`, …) ends the loop.

`executeCall` is the gate: record `tool.requested` (verbatim, untrusted) → parse input against the
tool's zod schema (parse failure → recorded deny) → `decide(...)` → record `policy.decision`. On
`deny`, return a terminal error result (with a `tool.completed` so resume never mistakes it for a
crash). On `ask`, call the approver and record `approval.resolved`; a `session`-scope allow adds a
grant. On `allow`/approved, run `runExecution`.

`runExecution` captures a pre-mutation snapshot when required (a capture failure escalates to a
no-undo ask — never a silent proceed), then executes the tool with a **per-call context**: the
turn's AbortSignal plus two callId-bound channels — `reportCommand` (structured lifecycle facts,
persisted as `command.started`/`command.ended` under the runtime-chosen callId, so a tool can
never forge another call's evidence) and `onOutput` (live chunks to `Session.onCommandOutput`,
render-only). It records `file.mutated` (kind, before/after hashes, created dirs) for snapshotted
paths, and `tool.completed`. The **model sees the real tool output**; the **persisted log
redacts** secret-classified reads.

### Abort and repair

The tool loop has a **pre-gate**: once `signal.aborted` or deny-&-stop is seen, no further call
executes — including auto-allowed in-workspace writes, which never reach an approver. Skipped
calls get synthesized `tool.requested`/`tool.completed` events and error `tool_result` blocks so
the wire history stays API-valid; the turn records `turn.aborted {phase}`. An abort during model
streaming appends nothing partial (the history ends at the trailing user message; the Anthropic
provider's `coalesceUserMessages` merges consecutive same-role messages at the wire). An
**executing `run_command` IS interruptible** (V0.3): the signal reaches the child through the
exec substrate, which tree-kills, verifies, drains bounded, and reports `termination: 'aborted'`
— distinct evidence from `turn.aborted` (process vs turn). `'interrupted by user'` remains
reserved for calls that never spawned. The one-shot CLI path wires SIGINT to the same signal
(`installSigintAbort`: first press aborts, second force-exits).

## Context budget (`runtime/elision.ts`)

The full conversation is resent every step; old tool outputs are the bulk. `elideHistory` is a
PURE function recomputed per request: when the RAW history size crosses ~400k chars, the oldest
tool_result contents are replaced with a marker (char count + sha256 + a pointer to the evidence
log) until the sent size is ≤ ~200k. The boundary is a function of the raw size — which only
grows — so the elided set only advances (no oscillation, no stored state, identical
re-derivation on resume, up to secret-redaction differences in replayed outputs). Only
tool_result CONTENT is replaced: tool_use/result pairing (API validity), assistant text, user
messages, and the last 4 assistant steps are untouched; outputs smaller than their marker are
skipped. `session.messages` and the log are NEVER mutated; an additive `context.compacted`
event records exactly which outputs the model can no longer see (rendered live, with a warning
when even full elision exceeds the target — assistant/user text is deliberately not compacted).

## Managed execution (`exec/`)

`runManaged(spec) → ExecOutcome` is the substrate every shell execution goes through (and future
workflow-pack renderer processes will reuse). It is policy-free and log-free: policy stays in the
engine, evidence stays in the runtime.

- **Termination is typed**: `exited | timeout | aborted | spawn-error`. Only `exited` carries an
  exit code — a killed command has `exitCode: null` by contract and can never read as a passing
  check anywhere downstream (report, model message, renderer).
- **Kill/drain state machine**: timeout or abort → `killTree` (async `taskkill /PID /T /F`; exit
  0 and 128 both mean "gone"; bounded liveness probes; result recorded in `killDetail`, honest
  when unverified) → settle on `'exit'` with a bounded wait → race `'close'` against a drain
  timeout, then destroy streams. Never awaits `'close'` unconditionally: a detached grandchild
  holding inherited pipe handles cannot hang the outcome (nodejs/node#21960 class; regression-
  tested with a real surviving-grandchild fixture). Settling awaits an in-flight `killTree` so
  kill evidence is never lost to the child's own exit racing ahead. Tree kill is BEST EFFORT and
  says so: grandchildren orphaned by a dead intermediate parent are structurally unreachable
  without Job Objects (no maintained Node binding; documented gap).
- **Capture**: stdin `'ignore'` (interactive children fail fast, never hang the turn); stdout and
  stderr captured separately and interleaved, head+tail under byte caps (stderr-prioritized 1/3–
  2/3 split of 512 KiB default) from raw buffers, decoded once. `truncateForModel` remains the
  final model-facing truncation contract on top.
- **Env hygiene** (`env.ts`): children get the parent env minus names containing
  `key/secret/token/password/credential` (case-insensitive; config `envExcludePatterns` may add
  more), deduped case-insensitively (lexicographically-first, Node's own child rule), with a
  non-excludable floor (`SystemRoot`/`windir` etc. — WinError 10106) and proxy variables passed
  through (children need the proxy for network; embedded proxy credentials remain visible — an
  honest, documented limitation, NOT a security boundary). `AGENT_CLI=1` marks harness children.

`repairDanglingToolUses(session)` is the REPL's recovery after a mid-turn throw: unanswered
`tool_use` blocks in the in-memory history are answered from their recorded completions (or an
error result), so one failed turn cannot poison every later request with a 400.

## Contracts

The load-bearing types (`src/types.ts`):

- `Tool<I>` declares `schema` (one zod source), `mutates(input, ctx)` (write paths, or `null` =
  undeclarable side effects), optional `readsPaths` and `command`, and `execute`. Policy reads
  these facts; tools contain no policy logic.
- `ToolContext` optionally carries `signal` (turn cancellation — a long-running tool must observe
  it), `onOutput` (render-only live chunks), `reportCommand` (structured `CommandEvidence`; the
  runtime binds the callId), and `sandbox` (`ExecSandbox`). All optional: plain read tools ignore them.
- `ExecSandbox` = `{ mode, enforced, active, wrap(spec) }`: `enforced` (availability) is read by
  the engine to gate auto-run; `active` marks a call actually confined; `wrap` is the enforcing
  transform for an auto-run call and identity otherwise. `CommandEvidence.started` gained `sandbox`.
- `ToolResult` gained additive `termination` (`CommandTermination`) and `killDetail`;
  `ApprovalRequest` gained `kind: 'command'` so the prompt can present the command class as a
  best-effort LABEL (`[shell command — labeled observe]`), never as a verdict.
- `PolicyDecision` = `{ classification, decision: allow|ask|deny, rule, reason, requiresSnapshot,
  noUndo?, redactOutput?, execBoundary? }`. `execBoundary` (`'sandbox' | 'unsandboxed'`) records
  where a shell command must run — the runtime uses it to pick the per-call `ExecSandbox.wrap`.
- `SessionEvent` = `{ v, seq, ts } & EventBody`, a discriminated union of every event type. `v`
  is the schema version; the log is a versioned public contract.
- `Provider.complete(req, onText?, signal?)` returns `{ blocks, stopReason, usage }`; abort is
  detected via `signal.aborted` after a throw, never via provider-specific error classes.
- `ToolContext` optionally carries `PolicyRules` (config narrowing), read by the engine and the
  search tool's secret skip-list.

## Trust (`trust/`)

Recorded consent — explicitly NOT a sandbox. `trust.json` (keyed by case-folded real path) and
an append-only `trust.log` audit live at the **state root**, outside every workspace. A corrupt
store is a hard error, never read as "trusted" and never silently rewritten. The consent prompt
is offered only on a real TTY (a piped answer nobody read is not consent); non-interactive
untrusted runs refuse with exit 3; `--trust-this-workspace` consents for one invocation and is
never persisted; `agent trust` records a deliberate grant. Displayed paths pass through
`sanitizeLine` (bidi/zero-width spoofing). Every session appends `trust.verified {source}`.

## Configuration (`config/config.ts`)

Two strict-schema layers merged narrowing-only: user `<state>/config.json` (prefs `model`,
`maxSteps` + narrowing) and workspace `<ws>/.agent-cli/config.json` (narrowing ONLY — no prefs,
since a workspace is attacker-influencable). Narrowing knobs: `protectedPaths` (extra write-deny
roots into `validatePath`), `secretPatterns` (literal lowercase basename substrings extending
`isSecretName` for both the policy gate and the search tool's skip-list), and `envExcludePatterns`
(literal name substrings dropped from command-child environments; the exec core floor and proxy
variables are structurally non-excludable, so the knob can narrow but never break or widen). The schemas cannot
express widening; unknown keys/bad JSON are hard `ConfigError`s. Rules travel on `ToolContext`;
provenance is recorded as `config.loaded {sources: [{path, sha256}]}`. The `.agent-cli/`
directory is write-protected from the agent's file tools by the path validator.

## The REPL (`repl/`)

A consumer of the same runtime: one session, `runTurn` per user line. `io.ts` owns the ONE
persistent readline — the idle prompt and every approval question share it (via the approver's
injectable `question` seam); readline echo is muted during turns (input keeps flowing so Ctrl+C
still arrives as the 'SIGINT' event); typed-ahead lines are buffered; EOF at a pending approval
resolves null → deny-&-stop. `render.ts` subscribes to `EventLog.onAppend`, so the screen is a
live view of the persisted evidence (tool lines, approval outcomes, `(pid N)` on spawn, honest
kill lines for killed commands, per-turn files/commands/steps/token summaries). Two — and only
two — render-only incremental channels exist alongside the event view: `onText` (model deltas)
and the V0.3 live command-output preview (`Session.onCommandOutput` → sanitized dim lines,
100ms cadence, 8 KiB/command display cap); for both, the persisted truth remains the recorded
events. Stream split: **stdout = model text + requested artifacts
only; stderr = all chrome** (piped transcripts stay clean; non-TTY chrome uses ASCII glyphs and
echoes accepted input lines for readable transcripts). Slash commands operate on the session's
own live log (`/undo` → `applyUndo` + `undo.applied` on the same open log; the model learns of
it via a delimited `[[harness note: …]]` in the next `user.message`). Turn errors repair and
re-prompt; `/quit`, EOF, and double-Ctrl+C end as `user-quit` — never `completed`.

## Policy model (`policy/`)

Two independent ideas, honestly separated: **path validation** and **action classification**.

`validatePath` (Windows-first) hard-rejects NUL, `\\?\`/`\\.\` device prefixes, UNC, reserved
device names, NTFS ADS, and trailing dot/space; resolves via `realpathSync.native` of the deepest
existing ancestor + tail; and containment-checks against `realpath(workspace) + separator` so a
sibling prefix (`C:\ws` vs `C:\ws-evil`) cannot escape. It returns `{ resolved, inWorkspace,
protectedPath }`; the engine decides.

`decide(tool, input, ctx, grants)` — deny-first, first match wins:

- **Shell command** (`tool.command` present) → **automatic review** (the single default; not a
  selectable "mode"). A hardcoded circuit-breaker denies workspace/drive wipes and `format`
  (absolute). Otherwise `analyzeCommand` decides: a command it PROVES safe **and** an active OS
  boundary (`ctx.sandbox.enforced`) together yield `allow` with `execBoundary: 'sandbox'` (auto-run
  *inside* the boundary); anything else is `ask` with `execBoundary: 'unsandboxed'`. With no
  enforced sandbox, a provably-safe command still asks — auto-run is disabled (**fail closed**). A
  best-effort label (hardened to stop mislabeling LOLBAS/encoded forms as benign) only informs the
  human; it never grants.
- **Declared write** → validate each target; out-of-workspace or protected (`.git`, the state
  dir, any `.agent-cli` segment, config `protectedPaths`) → `deny`; else `reversible` / `allow`
  with `requiresSnapshot`.
- **Reads** → out-of-workspace or secret-named → `sensitive` / `ask` (secret reads also flag
  redaction); else `observe` / `allow`.

**`analyzeCommand` (`policy/command-review.ts`)** is a POSITIVE proof of safety, deterministic over
the command string alone (the model's opinion is never consulted). `autoAllowable` requires all of:
(1) a single simple command with NO shell metacharacters/encoding/control chars — chaining,
redirection, substitution, expansion sigils (`$ % @` backtick), quotes, and the `--%` stop-parse
token all disqualify; (2) an executable on a small curated read-only allowlist (basename,
`.exe/.cmd/.bat/.com/.ps1` stripped, NFKC-normalized, casefolded); (3) per-executable arg checks
(e.g. only read-only `git` subcommands) with no argument that escapes the workspace. Everything else
returns false → `ask`. This mirrors Codex's structural exec policy: obfuscation defeats any string
reviewer, so safety is *proven*, not pattern-matched — and the reviewer is a prompt-skip gate, never
the boundary (the sandbox is).

`Grants` are in-memory, session-scoped, keyed `(tool, class)`, and store only grantable classes
(`sensitive`/`external`) — never `run_command`, never `destructive`. They are not persisted or
restored on resume.

## Sandbox and enforced isolation (`sandbox/`)

Sandbox (what a process *can technically do*) is a separate axis from approval (when the agent must
ask) — constitution principle 4. A `SandboxBackend` is selected once per session, PROBED, and
reported truthfully; the runtime never assumes enforcement from the platform name.

- **`windows-lowil`** is a genuinely OS-enforced boundary. `wrapSpec` is a *transform at spawn time*
  (Codex's `SandboxManager::transform` seam on the V0.3 `ExecSpec`): it rewrites the spec so
  `runManaged` spawns a versioned PowerShell + inline-C# (`Add-Type` P/Invoke) **host** instead of
  the shell. The host duplicates the caller's own token, lowers it to **Low integrity**
  (`SetTokenInformation` with the `S-1-16-4096` label — no admin, no privilege needed for a lowered
  copy of your own token), creates a **Job Object** (`KILL_ON_JOB_CLOSE` + active-process cap + UI
  restrictions), and `CreateProcessAsUser`-launches the real command **forwarding its inherited std
  handles** (= Node's pipes), so output capture and the kill/drain state machine are unchanged. The
  child's `TEMP`/`TMP` point at a Low-labeled scratch dir under the state root.
- **What it enforces** (verified against the live OS, `test/sandbox.windows.test.ts`): Mandatory
  Integrity Control **denies the child's writes** to Medium+ objects — the workspace, the user
  profile, system dirs, and the **harness state dir** — at the kernel; and the Job Object's
  kill-on-close **reaps the whole tree on kill**, including a detached grandchild that `taskkill /T`
  cannot reach (closing the Session-4 gap). **What it does NOT enforce** (stated verbatim in
  `EnforcementFacts.doesNotConfine`): reads (a sandboxed command can still read secrets), network,
  writes to Low-labeled locations, and service-reparented work (schtasks/sc/wmic/BITS).
- **Probe + fail-closed.** `ensureAvailable()` runs a self-test that spawns a Low-IL child and
  confirms *both* Low integrity *and* an actual write-deny; only then is `enforced: true`. On any
  non-Windows platform, or on probe failure, the backend degrades to `none` semantics
  (`enforced: false`), and the engine disables auto-run — every command asks. The host itself never
  falls back to unsandboxed: it either runs the child at Low IL or exits with a fail marker.
- **Boundary selection per call.** `PolicyDecision.execBoundary` (from `decide`) drives which wrap
  the runtime hands the tool: `runExecution` builds an ACTIVE `ExecSandbox` (the enforcing wrap) for
  an auto-run command and an identity wrap for an approved one. `run_command` applies
  `ctx.sandbox.wrap` unconditionally and records the actual boundary in `command.started.sandbox`.

## GitOps (`git/`) — a harness capability, never a model tool

Git serves review, delivery, recovery, and context — it does not replace the snapshot system,
and the model cannot reach it. **Why it must not be a tool:** `decide()` classifies a tool with
no `command()`, a null `mutates()`, and no reads as `observe`/auto-allow — a "git_commit" tool
of that shape would commit with NO approval (pinned by a policy regression test + a TOOLS
registry guard). The model keeps `run_command`: read-only git auto-runs inside the sandbox,
mutations ask, and work-discarding forms (`restore`, `checkout --`, `reset --hard`, `clean`,
`stash drop|clear`, `push --force*`) are labeled destructive.

**Consent contract** (the `/undo` precedent, explicit): user-typed commands ARE the consent,
under three conditions — (a) every mutating flow previews and interactively confirms
(non-interactive requires `--yes`); (b) every operation appends a provenance event
(`git.commit` / `git.checkpoint` / `git.restore`); (c) `GitClient` is structurally unreachable
from the model.

**Hardening on every invocation** (`client.ts`): git resolved to an ABSOLUTE path by scanning
PATH directly — a bare name resolves against the child cwd on Windows, so a `git.exe` planted in
a workspace must never execute (relative PATH entries skipped; `.cmd`/`.bat` shims rejected);
`-c core.fsmonitor=false` (a repo's own config must not start a daemon — the malicious-repo RCE
vector); `GIT_OPTIONAL_LOCKS=0` (a probe never rewrites the user's index); `GIT_TERMINAL_PROMPT=0`
and no stdin; repo-targeting `GIT_*` env scrubbed; bounded timeouts (a probe degrades honestly,
never hangs a session). Parsed output is always `-z`/porcelain-v2.

**Deliberate commits** (`commit.ts`): default scope stages ONLY session-attributed paths —
`sessionMutationState` over `file.mutated` events (undo folded in) intersected with
`git status --untracked-files=all`, so every stage pathspec provably exists in git's view.
Blockers where attribution would corrupt: missing identity (never set for the user), pre-staged
index in session scope. Warnings: externally-modified session files; unattributable
`run_command` effects (`--all` includes everything deliberately). Ordinary `add` + `commit -F
<state-dir file>`: hooks run, failures are honest, staged state is stated. Message carries a
`Session:` line + `Co-authored-by: Agent CLI <agent-cli@localhost>` (disableable).

**Checkpoints** (`checkpoint.ts`): plumbing against a temp `GIT_INDEX_FILE` under the state dir
(read-tree HEAD → add -A → write-tree → commit-tree → `refs/agent-cli/checkpoints/<session>/<n>`);
the user-visible git state is byte-identical before/after (tested), unborn repos use the empty
tree with no parent, plumbing identity is explicit env, gitignored files are never swept, and a
large untracked set requires confirmation. Honesty: **low-pollution, not zero** — loose objects
+ hidden refs are written; `prune` deletes refs so gc can collect. **Restore**: affected set =
`diff-tree(current-temp-tree, checkpoint)` filtered to the workspace prefix (a moved HEAD makes
outside-subtree files differ — those are never touched), INCLUDING deleting files the checkpoint
predates; content materializes via a second temp index + `checkout-index --prefix` staging
(binary-safe, git-native worktree form under the repo's filters); all current bytes snapshot
FIRST under one synthetic callId, so the whole restore is a single `applyUndo('last')` unit.
`git restore`/`git checkout` are never run against the user's worktree.

**Future isolation seam:** everything is repoRoot/workspace-scoped with no globals — a worktree
(Session 7+) is just another `GitClient`/`CheckpointContext` instance over its own path.

## Event log (`store/event-log.ts`)

One JSON object per line at `<state>/projects/<slug>/sessions/<id>.jsonl`, written synchronously.
`EventLog.open` acquires an atomic exclusive lock (`{pid, startedAt, token}` — refuses a live
foreign holder, reclaims a stale one), repairs a partial trailing line **before** the first
append (so a crash can't corrupt the next line), refuses mid-file corruption (`CorruptLogError`)
and newer schema versions (`SchemaVersionError`), and exposes the committed events. `events` is
**live** — appends through the instance appear immediately (the in-session `/undo`, `/report`,
and `/status` depend on this) — and observable via `onAppend`, fired after the synchronous write
with observer throws swallowed (the single point the REPL renders from). `readLenient` is a
lock-free, never-throwing reader for the report and session listing.

Event schema stays v1; V0.2 added three additive event types (`turn.aborted {phase}`,
`trust.verified {source}`, `config.loaded {sources}`), V0.3 added `command.started {callId, pid,
shell, cwd, timeoutMs}` (actual spawn — execution evidence, distinct from `tool.requested`) and
`command.ended {callId, termination, exitCode|null, durationMs, killDetail?, drainTimedOut?}`,
V0.4 adds `sandbox.status {mode, enforced, summary, confines, doesNotConfine, detail}` plus an
additive `sandbox` field on `command.started`, and V0.5 adds `git.context` (the probed repo
state), `git.commit`, `git.checkpoint`, `git.restore` (user-commanded git provenance),
`context.compacted` (which tool outputs the wire history elided), additive
`file.mutated.linesAdded/linesRemoved` (write-time diffstat), and additive
`usage.cacheRead/CreationInputTokens` on `assistant.message`. Additive types/fields are
lenient-reader-safe; bumping the version would lock old binaries out of new logs, so v stays 1.

## Recovery (`store/snapshots.ts`, `runtime/undo.ts`)

Pre-mutation file bytes are stored content-addressed at `<state>/…/objects/<sha256>` (no git
dependency — undo works with no repository present). `SnapshotStore.restore` verifies the file
still holds the recorded post-mutation hash and **refuses drifted files** rather than clobber
them (no force in V0.1). `applyUndo` reverts the last mutating action or all of them in reverse
order, chaining a multiply-edited file back to its original bytes, and removes directories the
mutation created if now empty. Every undo is appended as `undo.applied`; the log is never
rewritten. Git checkpoints LAYER ON TOP: a checkpoint restore snapshots current bytes first and
records ordinary `file.mutated` events under one synthetic callId, so it is itself one undoable
unit of this same machinery — git never becomes the undo mechanism.

## Resume (`runtime/session.ts` → `reconstruct`)

`reconstruct` rebuilds the provider conversation from the committed log. It is faithful for every
tool result except redacted secret reads (which, by design, are not persisted and cannot be
replayed). Crash recovery reconciles against `file.mutated`/postHash: a completed edit whose
`tool.completed` was lost to a truncated tail is recognized as **applied** (post-hash matches
disk), a snapshot without a matching mutation is flagged **unknown post-state**, and a bare
`tool.requested` is a true **orphan** — unless `command.started` shows the command had spawned,
in which case the replay says the command was executing at the crash and its effects are unknown. Grants and the system prompt/map are regenerated fresh —
current state outranks stale context.

## Verification (`report/report.ts`)

`buildReport` is a pure function `Event[] → { json, md }` (golden-testable). A changed file is
labeled **CHECKED** only if a `run_command` genuinely **exited** zero *after* its last mutation —
and the report prints *which command* — with the exact wording "check ran, exit 0" and **no
correctness claim**. A `command.ended` recording a kill vetoes CHECKED even against a stray
exit-0 completion; old logs without command events fall back to the exit-code rule. Everything
else is **UNCHECKED**. "Commands run" lists only commands that actually executed
(calls denied by policy or by the human stay visible under Actions/Approvals); killed commands
render as `killed: timed out/aborted by user … no exit code`, and a `command.started` with no
completion renders `STARTED but never completed … effects unknown` (plus honesty-footer lines) —
the derivation stays anchored on `tool.requested`+`tool.completed`, with command events as
enrichment only. Each command carries its actual boundary marker (`[sandboxed: windows-lowil]` /
`[unsandboxed]`), and a header block renders the session's `sandbox.status` — mode, whether it was
ENFORCED, and the verbatim `confines`/`doesNotConfine` scope — plus the probed `git.context`
line ("at session start", never live state). V0.5 adds a `+n/−m` churn column per changed file
(summed from write-time `file.mutated` diffstat evidence, so the report stays a pure event
function) and, when present, "Commits (user-commanded)", "Checkpoints", and "Checkpoint
restores" sections from the git provenance events. The reviewable CONTENT lives in a separate
surface: `report/diff.ts` builds the attributable session diff (first pre-image blob → current
disk bytes per session-mutated path, undo folded in, external edits flagged DRIFTED), rendered
by `/diff` and `agent diff` with per-line sanitization. A log without
`session.ended` renders as "IN PROGRESS or CRASHED/UNKNOWN" (the in-session `/report` is the
in-progress case). The report always states that assistant narrative is not evidence and the
footer is mode-aware: it explains what a `[sandboxed]` command was OS-prevented from doing (and
what it was not — reads/network) and that an `[unsandboxed]` command ran at full privilege.
PowerShell invocations are passed via `-EncodedCommand` and append `; exit $LASTEXITCODE` so a
failing inner command cannot masquerade as exit 0 → a false CHECKED.

## Providers

`MockProvider` replays scripted turns offline and throws if exhausted — the entire loop, policy,
snapshot, resume, and report behavior are proven through it. `hang: true` turns (in-process only;
`parseScript` rejects them in `--script` files) resolve only when the abort signal fires — the
deterministic way to test mid-stream aborts. `AnthropicProvider` streams via the SDK (passing the
abort signal through as the SDK request signal), maps messages/blocks/stop-reasons, applies
`coalesceUserMessages` at the wire (aborted turns and crash-resumes legitimately leave
consecutive user messages), and omits the `thinking` parameter to avoid the thinking-block
round-trip a tool-use loop would otherwise have to preserve. It contains no networking logic —
it obtains a `fetch` from the transport factory and passes it to the SDK client.

**Prompt caching (V0.5):** `buildApiParams` is a pure, unit-tested request builder with two
ephemeral `cache_control` breakpoints — the system block (tools+system = the stable prefix) and
a MOVING one on the final content block of the final wire message, attached AFTER coalescing (a
pre-attached marker could land mid-merged-message and silently cache a shorter prefix). Each
step re-reads the prior conversation from cache; the pipeline order is fixed as elide →
coalesce → cache-mark. Cache accounting flows as additive Usage fields into events, `/status`,
and the report (live evidence: a 3-step session billing 6 uncached input tokens).

## Networking (`net/transport.ts`)

A reusable transport factory, deliberately decoupled from any provider so future providers share
it. `resolveProxy(targetUrl, env, explicit?)` is a pure function that detects standard system
proxy settings (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, in either case) and decides,
per target URL, whether to proxy or go direct. Precedence: an explicit override wins; otherwise
the protocol-specific variable beats `ALL_PROXY`; and `NO_PROXY` (exact host, domain-suffix, `*`,
or `host:port`) overrides an environment-derived proxy but not an explicit override.

`createTransport(opts)` returns `{ fetch?, describe() }`. When no proxy could ever apply it returns
no custom `fetch`, so the client uses its own default (an ordinary direct connection). Otherwise
`fetch` resolves the proxy **per request URL** (so `NO_PROXY` is honored for any host) and attaches
an undici `ProxyAgent` **dispatcher for that request only** — there are no global side effects
(`setGlobalDispatcher` is never called); ProxyAgent instances are cached per proxy URL. `describe()`
returns a credential-redacted summary for logging. Proxy URLs (and any embedded credentials) are
never written to the event log, report, or any persisted state.
