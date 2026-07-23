# ARCHITECTURE

How Agent CLI V0.8 (post-Session-10 repository intelligence) is actually built. This describes
the implemented system, not aspirations — see `ROADMAP.md` for what is deferred.

## Shape

A modular monolith in TypeScript (strict, ESM, Node 22). One runtime function (`runTurn`) drives
the agent loop; both interfaces — the one-shot CLI and the interactive REPL — are thin consumers
of the same runtime (no parallel execution path). Data is plain JSON-serializable discriminated
unions; classes appear only where state genuinely lives (`EventLog`, `SnapshotStore`). Five
runtime dependencies: `@anthropic-ai/sdk`, `zod` (v4, one schema source per tool), `ignore`
(gitignore fallback walker), `undici` (proxy transport), and `diff` (jsdiff — line diffs for
review evidence).

One orientation line per file; the sections below carry the contracts.

```
src/
  types.ts                 All shared contracts (no logic).
  shared/
    clock.ts, ids.ts       Injectable clock + id generation (determinism levers for tests).
    hash.ts                sha256, the single truncation contract, HMAC secret redaction.
    pathutil.ts            caseFold + isInside (trailing-separator boundary containment).
    text.ts                sanitizeLine — escapes bidi/zero-width/control chars for display.
    diff.ts                jsdiff wrapper: lineDiffStat, unifiedDiff, binary/size guards.
    errors.ts              Typed error classes (branch on class, never on message).
  policy/
    paths.ts               validatePath — Windows-first boundary/hard-reject gate.
    engine.ts              classify + decide + Grants. Pure. The single policy choke point.
    command-review.ts      analyzeCommand — deterministic positive-proof auto-run gate.
  store/
    layout.ts              State-dir resolution + refuse-if-inside-workspace.
    event-log.ts           Append-only JSONL log: lock, tail-repair, corruption/version handling.
    snapshots.ts           Content-addressed pre-image blobs; capture/restore with drift refuse.
  exec/
    env.ts                 buildChildEnv — env hygiene (secret drops, core floor, proxy pass).
    kill.ts                killTree — verified best-effort tree kill + isAlive.
    run.ts                 runManaged — the managed-subprocess runner. Policy- and log-free.
  git/
    types.ts               GitFacts / GitResult / porcelain contracts (harness capability, NOT tools).
    client.ts              runGit over runManaged — hardened on every invocation (see "GitOps").
    facts.ts               detectGitFacts — session-start probe; explicit nulls on every degrade.
    porcelain.ts           Pure `status --porcelain=v2 -z` parser.
    commit.ts              The deliberate-commit flow.
    checkpoint.ts          Hidden-ref checkpoints: create/list/prune + restore flows.
    worktree.ts            Detached task worktrees: version gate, add, honest retrying removal.
  sandbox/
    types.ts               SandboxBackend + EnforcementFacts contracts.
    bootstrap.ts           The versioned PowerShell + inline-C# Low-IL host script.
    windows-lowil.ts       The enforced Windows backend: transform-at-spawn (wrapSpec) + probe.
    none.ts                Honest no-enforcement backend; identity wrap.
    index.ts               selectSandbox — platform → backend.
  tools/
    index.ts               read_file/list_files/search/write_file/edit_file + registry + schemas.
    run-command.ts         Shell tool on runManaged; applies ctx.sandbox.wrap at spawn time.
    delegate.ts            delegate_task — per-session factory; parallel groups, executor
                           orchestration, briefs/report-check/delimiter hardening (V0.8).
    retrieve.ts            retrieve — read-only view over the session index (V0.8).
    update-plan.ts         update_plan — the model's ONLY write path to the plan document.
    apply-changes.ts       apply_task_changes + the captured-changes registry.
  retrieval/               V0.8 — see "Repository intelligence".
    inventory.ts           Git-backed inventory + dirty paths + path-SET digest.
    extract.ts             Regex symbol/import extraction (ts/js + python, declared).
    graph.ts               Relative-import resolution → in-degree + bounded PageRank.
    store.ts               Persisted incremental index; written ONLY at assembly.
    rank.ts                Structural prior + task-directed query ranking with signals.
    render.ts              Tiered ranked-map render under a HARD char budget.
    ranked-map.ts          Assembly-only entry point; any failure → flat-map fallback.
  net/
    transport.ts           Proxy-aware transport factory (pure resolver + custom fetch).
  provider/
    mock.ts                Scripted offline provider (test backbone); `hang` turns for aborts.
    anthropic.ts           Streaming SDK adapter + pure response mapping + coalesceUserMessages.
  memory/
    store.ts               Capped never-throwing doc reads, atomic writes, frontmatter.
    journal.ts             JOURNAL.md parse / entry build / rolling policy. Pure.
    codebase.ts            CODEBASE.md provenance stamps + staleness. Pure.
    load.ts                Session-start load: three docs, caps, banner, crash note.
    update.ts              End-of-session update: gate, narrative call, roll + atomic write.
  plan/
    store.ts               Plan documents: lenient reads, atomic writes, harness-owned status.
  runtime/
    session.ts             startSession / runTurn / resumeSession / reconstruct / endSession.
    subagent.ts            runSubagentTask — ONE bounded child session over the same runTurn;
                           childTools admission; delimiter neutralization.
    roles.ts               Runtime role contracts over the policy fact table in types.ts.
    worktrees.ts           Worktree home, crash registry (owner-stamped, locked), guarded sweep.
    task-changes.ts        Bounded binary-safe executor change capture to blobs.
    approval-forwarder.ts  Serialized child→parent approval queue; signal-linked entries.
    elision.ts             elideHistory — pure, monotone wire-history budget.
    approvals.ts           Approvers + prompt formatting ([s] hidden where no grant would store).
    undo.ts                applyUndo (last / all) over the recorded mutations.
  trust/
    store.ts, gate.ts, commands.ts   trust.json + audit log; consent gate; `agent trust`.
  config/
    config.ts              Layered narrowing-only config.
  repl/
    repl.ts                runRepl — the prompt→runTurn loop, lifecycle, interrupts.
    io.ts                  ONE persistent readline: prompts, approvals, SIGINT, type-ahead.
    render.ts              EventLog.onAppend → live chrome + per-turn summaries.
    format.ts              Glyph/color tables, pure labels.
    commands.ts            Slash commands over the live log.
  workspace/
    map.ts                 The FLAT map + WorkspaceMap type — since V0.8 the fallback form
                           (pre-trust `agent map`, non-repo, executor worktrees, ranked failure).
    system-prompt.ts       System prompt builders (main + per-role), honesty statements, the map.
  report/
    report.ts              Pure Event[] → { md, json } evidence report.
    diff.ts                Attributable session diff (+ sessionMutationState, the single
                           attribution source for /diff and /commit).
  cli/
    index.ts               parseArgs dispatch for all subcommands.
    context.ts             buildRunContext + latestSessionId (skips subagent child logs).
    assemble.ts            assembleSession — the ONE construction path both interfaces consume;
                           trust is a parameter, so assembly is structurally impossible untrusted.
    trust-check.ts         The CLI-side trust gate (prompt only on a real TTY).
```

## Startup order (load-bearing)

For every session-starting command (one-shot and REPL), the order is:
workspace realpath → **state-root-inside-workspace refusal** (also checked in `ensureTrusted`,
so a folder cannot plant a `trust.json` that grants itself consent) → **trust gate** → config
load (the workspace file is untrusted bytes until trust passes) → per-project state creation →
then `assembleSession` (the single factored construction path both interfaces consume):
**sandbox select + probe** → **git probe** (post-trust — it executes git against the repo) →
**orphaned-worktree sweep** (registry-driven, path-guarded, never blocks a session; concurrency
rules in "Executor isolation") → **ranked map + retrieval index** (`buildRankedMap`; ANY
failure falls back to the flat map with the reason surfaced as a chrome note; non-repo
workspaces keep the flat walker map) → **project-memory load** (post-trust by construction) →
system prompt → start/resume → post-start records in a fixed order (trust.verified,
config.loaded, sandbox.status, git.context, workspace.mapped, memory.loaded) → per-session
tool attachment (retrieve, delegate_task with the executor bundle + forwarding queue,
update_plan, apply_task_changes with the changes registry rebuilt from events on resume). The
probed truths feed the banner, the events, and the system prompt.
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

## Repository intelligence (`retrieval/`, `tools/retrieve.ts`) — V0.8

Large-repo understanding is selective and ranked, not a broad file dump. One in-memory
**RetrievalHandle** is built per session at assembly and read everywhere else.

- **Inventory** (`inventory.ts`): `git ls-files` (the exact V0.5 listing, refactored here) +
  per-file size/mtime + per-file dirty paths (`status --porcelain=v2 -z -uall`, subdir-prefix
  aware), capped at 20k files. `inventorySha256` digests the sorted path SET — deliberately
  independent of rendering, so map-format changes cannot flap CODEBASE staleness.
- **Extraction** (`extract.ts`): line-anchored regex symbols/imports for the ts/js family +
  python ONLY (declared everywhere; other languages rank via path/git signals). Injection
  defense is structural: symbol captures are bounded identifier classes, import specifiers are
  charset-filtered — repo prose/delimiters cannot enter the system prompt through extraction.
  Secret-named (builtin + config `secretPatterns`), binary, and >256 KiB files are never read.
- **Index** (`store.ts`): `<projectDir>/index/retrieval.json` `{version, head, generatedAt,
  entries}` — a derived, idempotent cache written ONLY at assembly (a command-less observe tool
  must never mutate durable state — the S6 trap, kept closed). Warm loads stat-diff
  (size+mtime) and re-extract only changes; corrupt/missing/version-mismatch rebuilds cold;
  the ~10s wall budget yields an honest `'partial'` that CONVERGES across sessions (measured
  live on a 3k-file monorepo — see ROADMAP S10). Deliberately lock-less: any consistent
  snapshot is valid, atomic tmp+rename prevents torn reads, rebuild is the recovery (contrast
  the worktree registry, whose entries must MERGE). Known limit: same-size+same-mtime edits
  are invisible to stat-diff — a misrank at worst, never a wrong line (excerpts are live).
- **Ranking** (`rank.ts`): a task-agnostic structural prior (bounded PageRank over resolved
  relative imports, entry-point/manifest heuristics, uncommitted-change boost, depth and
  test/vendor penalties) plus `rankForQuery` (path/symbol term matches + graph-neighbor boost
  + the prior). Deterministic (sorted iteration, relPath tie-break), and every hit carries
  human-readable `signals` — traceable selection is a contract, not a debug feature.
- **Rendered map** (`render.ts`): tiers under a HARD 16k-char budget (every tier charged as
  appended, footer reserved, per-line clipping; any cut sets `truncated`): coverage-honesty
  header → uncommitted files (≤20) → the COMPLETE directory tree with per-dir counts (the
  recall backstop — ranking orders detail but never hides that a directory exists; collapse is
  depth-wise and announced) → ranked key files with top exported symbols and **no line
  numbers** (line numbers only ever come from live reads) → footer pointing at
  retrieve/search/list_files. `WorkspaceMap.sha256` remains `sha256(text)` — "exactly what the
  model saw" — with the additive `inventorySha256` beside it.
- **The `retrieve` tool** (`tools/retrieve.ts`): per-session factory over the handle. Input
  `{query, max_results≤50, scope_paths?}`; output = ranked hits with signals + symbols +
  excerpt lines read LIVE at query time (≤64 files/≤500ms; secret/binary skipped; vanished
  files dropped and counted) + a coverage footer (`indexed at <generatedAt> (head …); excerpts
  read live`). Policy: no command/delegates/planDoc facts, empty mutation plan, declared
  `readsPaths` → observe/auto-allow in-workspace, ask on out-of-workspace scopes (the search
  precedent). Excerpt exposure is exact parity with the existing search tool.
- **Consumers:** the parent session (tool + retrieval-first prompt rule, ranked sessions only);
  read-only child roles (admission rules under "Tasks, roles"); `/map` (re-renders the session
  handle, no disk write); `workspace.mapped` additive fields; CODEBASE staleness. Executor
  children and pre-trust `agent map` deliberately stay on the flat map.

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
  these facts; tools contain no policy logic. Optional `approvalContext(input)` (V0.7.1) is
  DISPLAY-ONLY: extra lines folded into the approval request's `detail` (inheriting the
  prompt renderer's sanitize + line cap) inside try/catch — never consulted by policy, and a
  throw never blocks the ask.
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

## Project memory (`memory/`) — three documents, context not authority

Cross-session continuity as three markdown documents with hard caps and honest degrades (a
broken or oversize doc can NEVER block a session — it loads truncated or is skipped with a
status recorded in the `memory.loaded` event):

- **`AGENT.md`** (workspace root, USER-owned, never harness-written; cap 24 KiB): the project
  constitution, injected into the system prompt of every session — and of every subagent — as a
  labeled section. Read post-trust only.
- **`<projectDir>/memory/JOURNAL.md`** (harness-managed, rolling; inject cap 12 KiB): one
  `## Session <id>` entry per productive session, newest first. Each entry couples model-written
  Summary/Decisions/Open-issues/Next-steps sections (explicitly labeled "model-written") with a
  deterministic **Evidence** section derived from the session's event log via `buildReport`
  (files/commands/commits/usage/log path — PROJECT.md §8 rules 5+8: grounded in events, with
  provenance, never recollection). Rolling policy: insert-or-replace by session id (resume-safe),
  newest 2 entries full, older compressed to stubs that keep the evidence pointer, 24 KiB budget
  enforced by dropping the oldest stubs behind a leading marker. User edits (a preamble, notes
  inside an entry) survive byte-verbatim until their entry is compressed.
- **`<projectDir>/memory/CODEBASE.md`** (harness-managed; cap 16 KiB): a model-written
  architecture summary, provenance-stamped with the writing session's id + workspace-map digest
  + HEAD. At load, a digest mismatch labels it "(may be stale)" in the prompt. V0.8: stamps are
  DUAL — legacy `map-digest` (sha of the rendered map text) plus additive `inventory-digest`
  (sha of the file SET); staleness compares inventory digests when both sides have one (immune
  to map-format changes) and falls back to the legacy exact-text compare otherwise. Known soft
  spot: a ranked→flat map-mode transition (transient git failure) over-marks stale for a
  session or two — the safe direction, accepted and documented.

**Write path** (`update.ts`): runs BEFORE `endSession`, on clean ends only (never error, never
`aborted` — a Ctrl+C'd session must not fire a model call), gated on real activity. The
narrative is ONE provider call reusing the exact cached prefix; every failure mode degrades to
a deterministic skeleton entry marked "narrative unavailable". The call bypasses `runTurn` and
is recorded as its own `memory.narrative` event — never as fake message events (they would
replay into a resumed conversation). The journal is RE-READ from disk at quit (two-terminal
safety), rolled, and written atomically; an unreadable existing journal is refused, never
overwritten. Failures append `memory.updated {status:'failed'}` and never block the quit.
User-layer-only toggle `memoryUpdates` (workspace config stays narrowing-only —
attacker-influencable ground must not steer harness memory writes).

**Sovereignty wording is load-bearing:** the injected memory section states verbatim that the
generated docs are "CONTEXT, NOT AUTHORITY … the current user request and the observable
repository state outrank it". Crash notes derive from LOG evidence (the newest non-child
sibling log without `session.ended`, via bounded `readFirstEvent`/`readLastEvent`), never from
journal absence — child task sessions and legitimately-skipped sessions can never read as
crashes. The system prompt is outside elision's `rawChars`, so memory injection can never
trigger or oscillate elision; it is cache-hot after the first request of a session.

## Tasks, roles, and parallel groups (`runtime/subagent.ts`, `runtime/roles.ts`, `tools/delegate.ts`)

The main agent keeps user interaction, authority, coordination, integration, and final claims;
a delegated task is a bounded, attributable unit beneath it. V0.7 makes roles EXPLICIT
CONTRACTS (not prompt aliases) and lets one delegate call run a bounded parallel group.

- **Roles, split by layer.** `types.ts` `SUBAGENT_ROLES` is the POLICY fact table — explorer /
  planner / reviewer are `read-only`, executor is `mutating-worktree`; `decide()` consults only
  this and fails closed on anything else. `runtime/roles.ts` `ROLE_CONTRACTS` is the RUNTIME
  contract per role: tool registry (a subset of TOOLS; never the delegate/update_plan/apply
  tools ⇒ depth 1 and no self-integration, structurally), role prompt builder, harness-fixed
  budget (read-only roles 15 steps / 5 min / 30k out; executor 30 / 12 min / 50k — approval
  wait counts against its wall clock), and approval mode (`auto-deny` | `forward`). A load-time
  check pins the two tables consistent. V0.8: read-only roles also name `retrieve`; the
  per-session instance reaches children ONLY through the named `SubagentDeps.retrieveTool`
  seam — `childTools()` admits it iff the contract names it AND the instance is structurally
  free of command/delegates/planDoc (fail closed by dropping; deliberately not a generic
  extra-tools list, so depth-1 stays a property of construction). The executor list omits
  retrieve: the parent index describes the parent workspace, not the worktree. Child prompts
  name retrieve only when actually admitted.
- **Briefs and reports (V0.8).** TaskSpec carries optional `focus`/`avoid` path-prefix lists;
  the delegate tool composes deterministic per-task brief lines (focus, avoid, missing-path
  hints — `..`-escaping prefixes are never disk-probed — and sibling coverage: "task 2 owns
  src/x, do not spend budget there") rendered into the child's first message, and warns the
  group on pairwise focus overlap. Guidance + measurement, not enforcement. Explorer reports
  have a REQUIRED section contract (Scope inspected / Scope skipped / Findings / Change sites
  and risks / Tests / Open questions + confidence); a non-blocking harness check lists missing
  sections in the tool_result ("treat those areas as UNEXAMINED") — informational, never a
  manufactured failure. Child report text and forwarded context are delimiter-hardened
  (`neutralizeHarnessDelimiters`): a line mimicking the harness report/context delimiters is
  visibly neutralized with a middle dot, never hidden.
- **One runtime, parallelism in the TOOL.** A child task = another `Session` driven by the SAME
  `runTurn`, in-process; a task is exactly ONE turn. `delegate_task` takes `tasks: [1..3]`; the
  tasks of one call run concurrently via `Promise.all` (the schema max IS the concurrency cap)
  — `runTurn`'s sequential tool loop is untouched. One call = one parallel group = one evidence
  unit = ONE approval for a group containing a mutating role (the strictest member governs).
- **Policy step-0 (fail closed, batched):** `Tool.delegates(input) → {roles}` is evaluated
  FIRST, inside try/catch (a throwing fact denies as `task.invalid-contract`, never escapes
  into the fall-throughs); `delegates`+`command`/`planDoc` → deny; empty group → deny; any
  unknown role → the WHOLE group denies; any mutating role → `ask` (class `reversible`, rule
  `task.mutating-role` — deliberately NOT session-grantable, so every executor spawn is a human
  decision); all read-only → allow/`observe` (`task.readonly-role`).
- **Inherited-or-narrower authority, structurally:** role registry ⊆ TOOLS, the parent's
  narrowing `rules`, the parent's PROBED-and-shared sandbox instance, fresh empty `Grants` per
  child, AGENT.md injected (generated memory docs deliberately not). Read-only roles get
  `autoDenyApprover`; the executor's asks FORWARD to the parent's approver (below).
- **Caps (harness-fixed, never model-controlled):** per-role budgets; group ≤ 3; 12 tasks per
  session, group-atomic (a group that does not fully fit is refused whole, spawning nothing);
  a cumulative 150k child-output-token lid per session; no automatic retries. Cause-tracked
  cancellation maps parent-abort / wall-clock / token-cap / forwarded deny-stop onto distinct
  `TaskStatus` values (`aborted`/`timeout`/`budget-tokens`/`user-stopped`) and child end
  reasons; a silent child gets a render-only "no activity" chrome line (the wall clock is the
  enforcement). Progress lines carry `role·childId` identity because group members interleave
  on one chrome stream.
- **Approval forwarding (`runtime/approval-forwarder.ts`):** a serialized FIFO queue wrapping
  the parent SESSION approver — never io directly — so non-interactive parents fail closed
  structurally, REPL EOF cascades deny-stop, and `--dangerously-allow-all` keeps its meaning.
  Every forwarded request carries `taskContext {childSessionId, role}` (rendered as a labeled
  header; for commands the prompt states the worktree cwd AND that approval runs it
  unsandboxed); entries are signal-linked — a task that dies while its ask is QUEUED resolves
  deny (`approval.resolved.source: 'task-aborted'`) without ever displaying; a task that dies
  while its ask is DISPLAYED unblocks immediately and the eventual stale answer is discarded
  with an honest chrome line. Answering `q` (deny-stop) ends THAT child only
  (`user-stopped`); Ctrl+C still aborts the whole turn. `s` grants land in the asking child's
  own Grants and die with it.
- **Evidence lineage:** unchanged joins, now batch-correct — one callId spans a group, so
  `/tasks`, the report, and `reconstruct` join `task.started`↔`task.ended` by
  `childSessionId`; `reconstruct` keeps EVERY `task.started` per callId and a crash replay
  points at ALL surviving child logs (plus captured changes, when a `task.changes` exists).
  Session ids are structurally fresh: `EventLog.open(expectFresh)` creates the log file with
  an atomic exclusive open BEFORE any lock interaction — a collision throws
  (`FreshLogCollisionError`, regenerated) instead of reclaiming a live sibling's same-pid lock
  and merging evidence; id entropy is 32 bits/second.
- **Surfaces:** `/tasks`; task lifecycle chrome (`task.started`/`task.ended` lines, task count
  in the turn summary); `agent sessions` child labels; `agent report <childId>`; the parent
  report's "Delegated tasks" + "Task changes and integration" sections; `latestSessionId`
  still skips lineage-bearing logs.
- **Boundaries (deliberate):** depth 1; no inter-child messaging (siblings are blind to each
  other; the parent integrates); no task resume; per-task cancellation exists as forwarded
  deny-stop + harness causes only (a full mid-turn task-management UI is deferred);
  `--provider mock --script` still shares one script (tests use the per-task provider seam).

## Executor isolation and integration (`git/worktree.ts`, `runtime/worktrees.ts`, `runtime/task-changes.ts`, `tools/apply-changes.ts`)

The mutating role never touches the user's workspace. The chain is: base → worktree → capture
→ review → apply, every link evidenced.

- **Base = one hidden-ref checkpoint per GROUP**, created sequentially before fan-out (the
  existing checkpoint machinery, so the parent's CURRENT working tree — dirty state included —
  is the base; unborn repos work). Every group member starts from the same attributable oid.
  The base REF lives only as long as the session (V0.7.1): it stays listed/restorable as a
  whole-workspace recovery point until quit, then the clean end paths delete this session's
  task-base refs (best-effort `update-ref -d`), announce it in chrome, and record the
  additive `git.checkpoint.pruned` provenance event — integration never needs the ref (apply
  reads captured blobs), the baseOid stays in `task.changes`, and a crash leaks the refs to
  manual `agent checkpoint prune`.
- **Worktree per task:** `git worktree add --detach` at the base oid, under
  `<os-tmp>/agent-cli-worktrees/<projectSlug>/` — placement DICTATED by `validatePath` (the
  state dir and any `.agent-cli` segment are write-denied, and the workspace must not contain
  derived checkouts), ephemeral by design. A version gate refuses git < 2.20 / unparseable
  (fail closed); non-repo workspaces refuse honestly; an unapproved draft plan blocks executor
  groups at the tool. The child session is scoped to the worktree (validatePath then confines
  its writes there), with FRESH `detectGitFacts` + map probed against the worktree; the parent
  layout is retained, so child logs stay joined to the project. TRUST: children never pass the
  CLI trust gate (it lives at the interface, not `startSession`) — a harness-created worktree
  of a trusted workspace is trusted BY DERIVATION and never written to `trust.json`. HONESTY:
  the worktree materializes WITHOUT gitignored files (no node_modules/.env — stated in the
  executor prompt: unverified means unverified), and `git worktree list` shows it while a task
  runs (low-pollution, not zero — like hidden refs).
- **Capture (`task-changes.ts`):** at task end — for ANY status; partial work is evidence —
  `git status --porcelain=v2 -z` in the worktree (detached HEAD IS the base, so status
  enumerates exactly changed-vs-base, untracked included), workspace-prefix filtered (subdir
  workspaces), base bytes materialized BINARY-SAFELY via read-tree + `checkout-index --prefix`
  staging (worktree form under the repo's filters — never string-stdout `git show`), after +
  base bytes stored as content-addressed blobs, bounded (200 files / 5 MiB per file; every
  omission counted, oversize entries recorded but never integrable). Recorded as callId-bound
  `task.changes {childSessionId, baseOid, files[], omittedCount}` — the diff OUTLIVES the
  worktree. Overlapping write-sets between group members are warned at capture time.
- **Cleanup is deterministic:** the worktree is ALWAYS removed in `finally` (EBUSY retries →
  rm fallback → `git worktree prune`); failure is honest `worktree.removed {ok:false}`
  evidence. A registry under `projectDir` records every worktree at creation; the
  assembly-time sweep removes crash orphans and is PATH-GUARDED — entries outside this
  project's worktree home are dropped from the registry but never touched on disk.
- **The registry is concurrency-safe (V0.7.1):** two parent sessions in one project are
  supported. Entries are OWNER-STAMPED (`ownerSessionId` + `pid`); the sweep skips live-pid
  entries (a recycled pid delays a sweep, never destroys live work) with a 2h age hatch
  grounded in the fixed executor budget. Every mutation runs under an in-process async mutex
  (fan-out members share the process) PLUS a token `O_EXCL` lock file for cross-process
  callers — a live same-pid holder is NEVER reclaimed (group members share the pid; the
  event-log's same-pid rule must not be copied here); staleness is dead-pid or over-age only.
  The lock is held only at registry read/write edges — never across git removals — and the
  sweep's save is a MERGE, so a sibling's concurrent registration always survives. Contention
  fails an executor setup honestly / skips that startup's sweep; legacy entries stay sweepable.
- **Integration (`apply_task_changes`, parent-only):** `mutates()` declares the concrete
  apply-ELIGIBLE workspace paths from the captured evidence (never null — the S6 observe-trap;
  conflicted files are not declared, so they are never snapshotted and never pollute
  attribution), and the EXISTING snapshot-first / `file.mutated` / undo / diff+commit
  attribution machinery does all the writing. Per-file drift-refuse rule: the workspace file
  must still hold the task's base bytes (or already hold the target, or be absent for a
  create); anything else refuses THAT file. Partial applies are reported per-file
  (`task.applied`), one undoable unit. The registry is rebuilt from `task.changes` events on
  resume, so a crash between capture and apply strands nothing.

## Plan mode (`plan/store.ts`, `tools/update-plan.ts`, REPL `/plan`, `@plan`)

Plans are explicit temporary local state — one markdown document per session at
`<projectDir>/plans/<sessionId>.md` — never disposable narration, and never authority.

- **The file's current bytes are truth.** The user may edit it with any editor at any time;
  the harness re-reads it before every use. Reads never throw (a malformed plan degrades to
  status `unknown`, content intact); writes are atomic; prior bytes are blob-archived
  (`prevSha256`) so plan history stays reviewable.
- **The model writes it ONLY through `update_plan`**, gated by the first-class `Tool.planDoc`
  policy fact with its own fail-closed engine branch (`plan.update`, allow/`reversible`;
  planDoc+command/delegates deny; a throwing fact denies) — without it, a mutation-less
  command-less tool writing harness state would auto-classify observe (the S6 trap, pinned
  again). The harness owns the frontmatter: model writes can NEVER change `status` (a
  body-smuggled frontmatter block is stripped); only `/plan approve|discard` do.
- **Approval is consent evidence:** `/plan approve` records `plan.approved {planId, sha256}` —
  binding the EXACT approved bytes. Later divergence (model progress updates keep status
  `approved`; user edits too) is SURFACED on every injection and in the report, never hidden;
  the enforcement point stays the per-spawn executor `ask`, which since V0.7.1 genuinely
  DISPLAYS the plan-approval state at the consent moment: the delegate tool's
  `approvalContext` renders "APPROVED (sha …, matches the user-approved bytes)" /
  "APPROVED but DIVERGED after approval (approved …, current …)" / none / DRAFT /
  SUPERSEDED / approved-with-no-recorded-approval (hand-edited frontmatter), derived from
  `planApprovalSha(events)` — the ONE approval-state derivation shared with the injection
  note. While a draft/unknown plan exists, the delegate tool refuses executor groups.
  `/plan discard` records `plan.discarded` and stops injection.
- **Injection is a standing per-turn harness note** (never the cached system prompt): full
  plan content only when its sha is NEW to the model (not last-injected, not one the model
  itself wrote — `plan.updated` events carry the shas), a one-line pointer otherwise; capped
  at 12 KiB; labeled with the verbatim context-not-authority sovereignty wording. `@plan
  <request>` forces plan mode via an explicit harness note (investigate → update_plan →
  present → wait for approval).
- **Surfaces:** `/plan [show|approve|discard]`; read-only `agent plan [<id>]`; the report's
  "## Plan" section (writes, approval sha, post-approval divergence, discard) derived purely
  from events; `plan.updated` flows through the callId-bound `ToolContext.reportPlan` channel.

## The REPL (`repl/`)

A consumer of the same runtime: one session, `runTurn` per user line. `io.ts` owns the ONE
persistent readline — idle prompt and approval questions share it; echo is muted during turns
(Ctrl+C still arrives); typed-ahead lines are buffered; EOF at a pending approval resolves
null → deny-&-stop. `render.ts` subscribes to `EventLog.onAppend`, so the screen is a live
view of the persisted evidence. Exactly two render-only incremental channels exist alongside
it: `onText` (model deltas) and the live command-output preview (sanitized dim lines, 100ms
cadence, 8 KiB/command cap, stateful per-stream UTF-8 decode); for both, the persisted truth
remains the events. Stream split: **stdout = model text + requested artifacts only; stderr =
all chrome** (piped transcripts stay clean; non-TTY chrome uses ASCII glyphs and echoes
accepted input). Slash commands operate on the session's own live log (`/undo` → `applyUndo`
on the same open log; the model learns of it via a delimited `[[harness note: …]]` in the next
`user.message`). Turn errors repair and re-prompt; `/quit`, EOF, and double-Ctrl+C end as
`user-quit` — never `completed`.

## Policy model (`policy/`)

Two independent ideas, honestly separated: **path validation** and **action classification**.

`validatePath` (Windows-first) hard-rejects NUL, `\\?\`/`\\.\` device prefixes, UNC, reserved
device names, NTFS ADS, and trailing dot/space; resolves via `realpathSync.native` of the deepest
existing ancestor + tail; and containment-checks against `realpath(workspace) + separator` so a
sibling prefix (`C:\ws` vs `C:\ws-evil`) cannot escape. It returns `{ resolved, inWorkspace,
protectedPath }`; the engine decides.

`decide(tool, input, ctx, grants)` — deny-first, first match wins:

- **Delegation** (`tool.delegates` present) → the explicit STEP-0 branch (V0.6; batched V0.7):
  the fact names EVERY role in the group and is called inside try/catch (throw → deny
  `task.invalid-contract`); `delegates`+`command`/`planDoc` → deny (`task.conflicting-contract`);
  empty group → deny; any role outside `SUBAGENT_ROLES` → the whole group denies
  (`task.unknown-role`); any `mutating-worktree` role → `ask`/`reversible`
  (`task.mutating-role`, deliberately non-grantable); all read-only → allow/`observe`
  (`task.readonly-role`). First on purpose: a delegating tool must never reach the command
  auto-run path or the observe fall-through (the S6 command-less-tool trap, pinned).
- **Plan-document write** (`tool.planDoc` present) → the explicit V0.7 branch right after:
  allow/`reversible` (`plan.update` — the store archives prior bytes; the write cannot touch
  workspace files); planDoc+command → deny; a throwing fact → deny. Same trap-avoidance
  rationale, same pinning tests.
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
(`sensitive`/`external`) — never `destructive`, never `reversible` (an executor spawn must ask
every time), and NEVER any command-bearing tool (V0.7.1): a command's classification is a
best-effort label over untrusted model text, so a session grant keyed on it would be standing
shell permission won by a label — the runtime stores a grant only when `tool.command` is
undefined (the `run_command` name check in `Grants.add` stays as defense in depth), and the
prompt hides `[s]` for command asks to match. Grants are not persisted or restored on resume.
The approval prompt hides `[s]` whenever no grant would actually be stored (offering a no-op
option would misrepresent what pressing it does — observed live in the S9 E2E and fixed).

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
  confirms *both* Low integrity *and* an actual write-deny; only then is `enforced: true`. The
  probe allows 60 s and one bounded retry (measured ~4–11 s normally, ~18 s under heavy spawn
  contention): a retry can recover a transient false negative but every path to `enforced: true`
  still requires the positive marker (injectable `ProbeRunner` seam, regression-tested). On any
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

**Deliberate commits** (`commit.ts`): default scope stages ONLY session-attributed paths
(`sessionMutationState` over `file.mutated` events, undo folded in, intersected with git
status so every pathspec provably exists in git's view). Blockers where attribution would
corrupt (missing identity — never set for the user; pre-staged index in session scope);
warnings for externally-modified session files and unattributable `run_command` effects.
Ordinary `add` + `commit -F`: hooks run, failures are honest. Message carries a `Session:`
line + `Co-authored-by: Agent CLI <agent-cli@localhost>` (disableable).

**Checkpoints** (`checkpoint.ts`): plumbing against a temp `GIT_INDEX_FILE` under the state
dir → `refs/agent-cli/checkpoints/<session>/<n>`; the user-visible git state is byte-identical
before/after (tested), unborn repos use the empty tree, gitignored files are never swept, a
large untracked set requires confirmation. Honesty: **low-pollution, not zero** — loose
objects + hidden refs are written; `prune` frees them. **Restore**: affected set from
diff-tree filtered to the workspace prefix (files a moved HEAD changed outside the subtree
are never touched), including deleting files the checkpoint predates; content materializes
binary-safely via a second temp index + `checkout-index --prefix` staging; all current bytes
snapshot FIRST under one synthetic callId, so the whole restore is a single
`applyUndo('last')` unit. `git restore`/`git checkout` are never run against the user's
worktree. Everything is repoRoot-scoped with no globals — a task worktree is just another
`GitClient`/`CheckpointContext` instance over its own path.

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

Event schema stays v1; every extension has been ADDITIVE (new event types or optional fields —
lenient-reader-safe; bumping `v` would lock old binaries out of new logs). The accumulated
additive surface, by area (full shapes in `src/types.ts`):

- **turn/consent/config:** `turn.aborted {phase}`, `trust.verified {source}`,
  `config.loaded {sources}` (V0.2).
- **execution:** `command.started`/`command.ended` (actual spawn + typed termination — execution
  evidence distinct from `tool.requested`; V0.3), `sandbox.status` + `command.started.sandbox`
  (V0.4).
- **git/context:** `git.context`, `git.commit`, `git.checkpoint`, `git.restore` (user-commanded
  provenance), `context.compacted`, `file.mutated.linesAdded/Removed`, cache-usage fields on
  `assistant.message` (V0.5); `git.checkpoint.pruned {kind:'task-base'}` — session-end task-base
  ref deletion is evidence, never silent (V0.7.1).
- **memory:** `memory.loaded` / `memory.narrative` / `memory.updated` (V0.6).
- **tasks/plans:** `task.started`/`task.ended` (callId-bound), `session.started.lineage`,
  `session.ended.reason` values `aborted`/`budget` (V0.6); `task.changes` (the durable executor
  diff that outlives the worktree), `task.applied`, `worktree.created`/`worktree.removed`
  (`ok:false` = sweep evidence), `plan.updated`/`plan.approved`/`plan.discarded` (approval binds
  the sha), `TaskStatus` `user-stopped`, `approval.resolved.source` `task-aborted` (V0.7),
  `task.changes.omittedCount` passthrough (V0.7.1).
- **retrieval:** `workspace.mapped.inventorySha256/indexedFiles/indexState` — the file-SET
  digest is the CODEBASE staleness basis; `sha256` keeps meaning "exactly the map text the
  model saw" (V0.8).

Bounded static readers `readFirstEvent`/`readLastEvent` (first/last committed line only, never
throw) support the child-log skip and crash detection without full parses.

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
`tool.requested` is a true **orphan** — unless `command.started` shows the command had spawned
(the replay says the command was executing at the crash and its effects are unknown) or
`task.started` shows delegated tasks were running (the replay points at EVERY surviving child
evidence log — one delegate call can start a parallel group — and, when a `task.changes`
exists, notes that the captured changes can still be integrated via apply_task_changes).
Grants and the system prompt/map are regenerated fresh — current state outranks stale context.

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
`[unsandboxed]`), and a header block renders the session's `sandbox.status` — mode, whether it
was ENFORCED, and the verbatim `confines`/`doesNotConfine` scope — plus the probed
`git.context` line ("at session start", never live state).

Accumulated sections (all derived purely from events): per-file `+n/−m` churn from write-time
diffstat; "Commits (user-commanded)" / "Checkpoints" / "Checkpoint restores" from git
provenance; "Delegated tasks (subagents)" joined `task.started`↔`task.ended` by childSessionId
(orphans render "STARTED but never completed") with footer lines that child usage is NOT in
the parent totals and subagent reports are narration — plus ONE labeled
"combined tokens (parent + children)" roll-up line (matching `/tasks`; session totals
everywhere else stay parent-only); "## Plan" (writes, approval sha, post-approval divergence,
discard); "## Task changes and integration" (captures, applies, per-file refusals, the honest
"NOT applied" case) and the executor honesty footer. The reviewable CONTENT lives in a
separate surface: `report/diff.ts` builds the attributable session diff (first pre-image blob
→ current disk bytes, undo folded in, external edits flagged DRIFTED), rendered by `/diff` and
`agent diff` with per-line sanitization. A log without `session.ended` renders as
"IN PROGRESS or CRASHED/UNKNOWN" (the in-session `/report` is the in-progress case). The
report always states that assistant narrative is not evidence; the footer is mode-aware
(sandboxed vs unsandboxed semantics). PowerShell invocations run via `-EncodedCommand` and
append `; exit $LASTEXITCODE` so a failing inner command cannot masquerade as exit 0 → a
false CHECKED.

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
