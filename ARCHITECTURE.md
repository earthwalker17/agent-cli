# ARCHITECTURE

How Agent CLI V0.3 is actually built. This describes the implemented system, not aspirations —
see `ROADMAP.md` for what is deferred.

## Shape

A modular monolith in TypeScript (strict, ESM, Node 22). One runtime function (`runTurn`) drives
the agent loop; both interfaces — the one-shot CLI and the interactive REPL — are thin consumers
of the same runtime (no parallel execution path). Data is plain JSON-serializable discriminated
unions; classes appear only where state genuinely lives (`EventLog`, `SnapshotStore`). Three
runtime dependencies: `@anthropic-ai/sdk`, `zod` (v4, one schema source per tool), `ignore`
(gitignore), plus `undici` for the proxy transport.

```
src/
  types.ts                 All shared contracts (no logic).
  shared/
    clock.ts, ids.ts       Injectable clock + id generation (determinism levers for tests).
    hash.ts                sha256, the single truncation contract, HMAC secret redaction.
    pathutil.ts            caseFold + isInside (trailing-separator boundary containment).
    text.ts                sanitizeLine — escapes bidi/zero-width/control chars for display.
    errors.ts              Typed error classes (branch on class, never on message).
  policy/
    paths.ts               validatePath — Windows-first boundary/hard-reject gate (+ config-declared
                           extraProtected roots).
    engine.ts              classify + decide + Grants. Pure. The single policy choke point.
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
  tools/
    index.ts               read_file, list_files, search, write_file, edit_file + registry + JSON-Schema derivation.
    run-command.ts         Shell tool on runManaged: PowerShell $LASTEXITCODE wrapper, filtered env,
                           stdin ignored, per-termination model messages, lifecycle evidence.
  net/
    transport.ts           Reusable proxy-aware transport factory (pure resolver + custom fetch).
  provider/
    mock.ts                Scripted, offline provider (backbone of the tests); `hang` turns for abort tests.
    anthropic.ts           Streaming SDK adapter + pure response mapping + coalesceUserMessages.
  runtime/
    session.ts             startSession / runTurn (abortable) / resumeSession / reconstruct /
                           repairDanglingToolUses / endSession.
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
    map.ts                 Bounded, gitignore-aware workspace map + digest.
    system-prompt.ts       System prompt: honesty statement, no-git-unless-asked rule, the map.
  report/report.ts         Pure Event[] → { md, json } evidence report.
  cli/
    index.ts               parseArgs dispatch: REPL / run / resume / undo / report / sessions / map / trust.
    context.ts             buildRunContext — the ONE session-assembly path both interfaces share;
                           mode precedence --no-input > --interactive > isTTY.
    trust-check.ts         The CLI-side trust gate (prompt only on a real TTY).
```

## Startup order (load-bearing)

For every session-starting command (one-shot and REPL), the order is:
workspace realpath → **state-root-inside-workspace refusal** (also checked in `ensureTrusted`,
so a folder cannot plant a `trust.json` that grants itself consent) → **trust gate** → config
load (the workspace file is untrusted bytes until trust passes) → per-project state creation →
workspace map → provider. Read-only commands (`report`/`sessions`/`undo`/`map`) are ungated and
never create state dirs; `map` reads workspace bytes but sends nothing to a model (documented
exception).

## The core loop (`runtime/session.ts`)

`runTurn(session, userText, { signal? })` appends a `user.message`, then loops up to `maxSteps`:

1. Build a `ProviderRequest` (system prompt, full message history, tool schemas derived from the
   tools' zod schemas) and call `provider.complete(req, onText)`. Text deltas stream to `onText`.
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
  it), `onOutput` (render-only live chunks), and `reportCommand` (structured `CommandEvidence`;
  the runtime binds the callId). All optional: plain read tools ignore them.
- `ToolResult` gained additive `termination` (`CommandTermination`) and `killDetail`;
  `ApprovalRequest` gained `kind: 'command'` so the prompt can present the command class as a
  best-effort LABEL (`[shell command — labeled observe]`), never as a verdict.
- `PolicyDecision` = `{ classification, decision: allow|ask|deny, rule, reason, requiresSnapshot,
  noUndo?, redactOutput? }`.
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

- **Shell command** (`tool.command` present) → always `ask` (no allowlist; a best-effort label
  only informs the human). A hardcoded circuit-breaker denies workspace/drive wipes and `format`.
- **Declared write** → validate each target; out-of-workspace or protected (`.git`, the state
  dir, any `.agent-cli` segment, config `protectedPaths`) → `deny`; else `reversible` / `allow`
  with `requiresSnapshot`.
- **Reads** → out-of-workspace or secret-named → `sensitive` / `ask` (secret reads also flag
  redaction); else `observe` / `allow`.

`Grants` are in-memory, session-scoped, keyed `(tool, class)`, and store only grantable classes
(`sensitive`/`external`) — never `run_command`, never `destructive`. They are not persisted or
restored on resume.

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
`trust.verified {source}`, `config.loaded {sources}`) and V0.3 adds two more:
`command.started {callId, pid, shell, cwd, timeoutMs}` (actual spawn — execution evidence,
distinct from `tool.requested`) and `command.ended {callId, termination, exitCode|null,
durationMs, killDetail?, drainTimedOut?}`. Additive types are lenient-reader-safe; bumping the
version would lock old binaries out of new logs, so v stays 1.

## Recovery (`store/snapshots.ts`, `runtime/undo.ts`)

Pre-mutation file bytes are stored content-addressed at `<state>/…/objects/<sha256>` (no git
dependency). `SnapshotStore.restore` verifies the file still holds the recorded post-mutation
hash and **refuses drifted files** rather than clobber them (no force in V0.1). `applyUndo`
reverts the last mutating action or all of them in reverse order, chaining a multiply-edited file
back to its original bytes, and removes directories the mutation created if now empty. Every undo
is appended as `undo.applied`; the log is never rewritten.

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
enrichment only. A log without
`session.ended` renders as "IN PROGRESS or CRASHED/UNKNOWN" (the in-session `/report` is the
in-progress case). The report always states that assistant narrative is not evidence and
restates the undo/sandbox limitations. PowerShell invocations append `; exit $LASTEXITCODE` so a
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
