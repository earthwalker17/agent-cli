# ARCHITECTURE

How Agent CLI V0.1 is actually built. This describes the implemented system, not aspirations —
see `ROADMAP.md` for what is deferred.

## Shape

A modular monolith in TypeScript (strict, ESM, Node 22). One runtime function (`runTurn`) drives
the agent loop; the CLI is a thin consumer. Data is plain JSON-serializable discriminated unions;
classes appear only where state genuinely lives (`EventLog`, `SnapshotStore`). Three runtime
dependencies: `@anthropic-ai/sdk`, `zod` (v4, one schema source per tool), `ignore` (gitignore).

```
src/
  types.ts                 All shared contracts (no logic).
  shared/
    clock.ts, ids.ts       Injectable clock + id generation (determinism levers for tests).
    hash.ts                sha256, the single truncation contract, HMAC secret redaction.
    pathutil.ts            caseFold + isInside (trailing-separator boundary containment).
    errors.ts              Typed error classes (branch on class, never on message).
  policy/
    paths.ts               validatePath — the Windows-first boundary/hard-reject gate.
    engine.ts              classify + decide + Grants. Pure. The single policy choke point.
  store/
    layout.ts              State-dir resolution + refuse-if-inside-workspace.
    event-log.ts           Append-only JSONL log: lock, tail-repair, corruption/version handling.
    snapshots.ts           Content-addressed pre-image blob store; capture/restore with drift refuse.
  tools/
    index.ts               read_file, list_files, search, write_file, edit_file + registry + JSON-Schema derivation.
    run-command.ts         Shell exec: PowerShell $LASTEXITCODE propagation, timeout, tree-kill.
  net/
    transport.ts           Reusable proxy-aware transport factory (pure resolver + custom fetch).
  provider/
    types.ts (in types.ts) Provider interface + wire types (Mock needs no SDK).
    mock.ts                Scripted, offline provider (backbone of the tests).
    anthropic.ts           Streaming SDK adapter + pure response mapping (delegates networking to net/).
  runtime/
    session.ts             startSession / runTurn / resumeSession / reconstruct / endSession.
    approvals.ts           auto-deny, dangerous, and interactive approvers.
    undo.ts                applyUndo (last / all) over the recorded mutations.
  workspace/
    map.ts                 Bounded, gitignore-aware workspace map + digest.
    system-prompt.ts       System prompt with the honesty statement + the map.
  report/report.ts         Pure Event[] → { md, json } evidence report.
  cli.ts                   parseArgs dispatch: run / resume / undo / report / sessions / map.
```

## The core loop (`runtime/session.ts`)

`runTurn(session, userText)` appends a `user.message`, then loops up to `maxSteps`:

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
no-undo ask — never a silent proceed), executes the tool, records `file.mutated` (kind, before/
after hashes, created dirs) for snapshotted paths, and records `tool.completed`. The **model sees
the real tool output**; the **persisted log redacts** secret-classified reads.

## Contracts

The load-bearing types (`src/types.ts`):

- `Tool<I>` declares `schema` (one zod source), `mutates(input, ctx)` (write paths, or `null` =
  undeclarable side effects), optional `readsPaths` and `command`, and `execute`. Policy reads
  these facts; tools contain no policy logic.
- `PolicyDecision` = `{ classification, decision: allow|ask|deny, rule, reason, requiresSnapshot,
  noUndo?, redactOutput? }`.
- `SessionEvent` = `{ v, seq, ts } & EventBody`, a discriminated union of every event type. `v`
  is the schema version; the log is a versioned public contract.
- `Provider.complete(req, onText?)` returns `{ blocks, stopReason, usage }`.

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
- **Declared write** → validate each target; out-of-workspace or protected → `deny`; else
  `reversible` / `allow` with `requiresSnapshot`.
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
and newer schema versions (`SchemaVersionError`), and exposes the committed events. `readLenient`
is a lock-free, never-throwing reader for the report and session listing.

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
`tool.requested` is a true **orphan**. Grants and the system prompt/map are regenerated fresh —
current state outranks stale context.

## Verification (`report/report.ts`)

`buildReport` is a pure function `Event[] → { json, md }` (golden-testable). A changed file is
labeled **CHECKED** only if a `run_command` exited zero *after* its last mutation — and the report
prints *which command* — with the exact wording "check ran, exit 0" and **no correctness claim**.
Everything else is **UNCHECKED**. The report always states that assistant narrative is not
evidence and restates the undo/sandbox limitations. PowerShell invocations append
`; exit $LASTEXITCODE` so a failing inner command cannot masquerade as exit 0 → a false CHECKED.

## Providers

`MockProvider` replays scripted turns offline and throws if exhausted — the entire loop, policy,
snapshot, resume, and report behavior are proven through it. `AnthropicProvider` streams via the
SDK, maps messages/blocks/stop-reasons, and (in V0.1) omits the `thinking` parameter to avoid the
thinking-block round-trip a tool-use loop would otherwise have to preserve. It contains no
networking logic — it obtains a `fetch` from the transport factory and passes it to the SDK client.

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
