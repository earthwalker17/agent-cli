# ARCHITECTURE

How Agent CLI **v1.2.1** is actually built. This describes the implemented system — its modules,
contracts, orderings, and honest limits. `ROADMAP.md` records how it got here and what is
deferred; this file avoids session narration except where a decision's *reason* is the contract.

## Shape

A modular monolith in TypeScript (strict, ESM, Node 22). One runtime function (`runTurn`) drives
the agent loop; both interfaces — the one-shot CLI and the interactive REPL — are thin consumers
of it (no parallel execution path). Data is plain JSON-serializable discriminated unions; classes
appear only where state genuinely lives (`EventLog`, `SnapshotStore`). Six runtime dependencies:
`@anthropic-ai/sdk`, `zod` (v4, one schema source per tool), `ignore` (gitignore fallback walker),
`undici` (proxy transport), `diff` (jsdiff line diffs), and `playwright-core` (browser
verification; no install scripts, no bundled binaries — it drives the *system* browser).

```
src/
  types.ts                 All shared contracts (no logic).
  shared/
    clock.ts, ids.ts       Injectable clock + id generation (determinism levers for tests).
    hash.ts                sha256, the single truncation contract, HMAC secret redaction.
    pathutil.ts            caseFold + isInside + normalizeRelPrefix (containment, never probed).
    text.ts                sanitizeLine + neutralizeHarnessDelimiters (display/fence spoofing).
    diff.ts                jsdiff wrapper: lineDiffStat, unifiedDiff, binary/size guards.
    errors.ts              Typed error classes (branch on class, never on message).
    registry-lock.ts       The ONE file-registry lock (O_EXCL token + in-process chain).
  policy/
    paths.ts               validatePath — Windows-first boundary/hard-reject gate.
    engine.ts              classify + decide + Grants. Pure. The single policy choke point.
    command-review.ts      analyzeCommand — deterministic positive-proof auto-run gate.
  store/
    layout.ts              State-dir resolution + refuse-if-inside-workspace.
    event-log.ts           Append-only JSONL: lock, tail-repair, corruption/version handling.
    snapshots.ts           Content-addressed pre-image blobs; capture/restore with drift refuse.
  exec/
    env.ts                 buildChildEnv — env hygiene (secret drops, core floor, proxy pass).
    kill.ts                killTree — verified best-effort tree kill + isAlive.
    run.ts                 runManaged — the managed-subprocess runner. Policy- and log-free.
    shell.ts               shellInvocation — the ONE exit-code-fidelity shell wrapper.
  checks/                  Typed verification.
    types.ts               CheckRecipe / DetectedProject / CheckResult contracts.
    detect.ts              Bounded never-throwing manifest detection + stat fingerprint.
    toolchain.ts           Stat-only machine-toolchain probe + drift pseudo-stamps (S18).
    recipes.ts             The declarative recipe table + toCommand (the single composer).
    normalize.ts           Exit-code-is-the-verdict normalization + named signal extraction.
  preview/                 Managed preview processes.
    types.ts               SupervisedSpec/Handle + PreviewRegistryEntry contracts.
    process.ts             startSupervised — the long-running runner (fd logging, TTL, log cap).
    recipes.ts             Preview script resolution (dev>preview>serve>start) + previewFact.
    ready.ts               Announced-port HTTP readiness (bounded, abortable, honest).
    registry.ts            previews.json + the identity-verified crash sweep.
    identity.ts            Process identity (encoded-CommandLine + creation-time tolerance).
  browser/                 Browser verification.
    types.ts               The zod FlowSpec (typed steps/asserts) + FlowRunResult contracts.
    probe.ts               Real launch probe (msedge→chrome→cache) + cheap plan-time guess.
    flow.ts                The deterministic flow executor (origin lock, typed taxonomy).
  artifacts/               The documents workflow pack (Session 17) — bounded zip/XML substrate,
                           format identification, DOCX/PPTX/PDF readers, the DocSpec model, the
                           deterministic DOCX renderer, the self-contained HTML + browser PDF
                           path, deterministic validators, and page rasterization.
  recovery/                Typed recovery. (FailureClass lives in types.ts.)
    catalogue.ts           The eleven-class recovery matrix, as DATA.
    classify.ts            Deterministic classification from persisted evidence.
    ledger.ts              Pure fold: repair attempts with DERIVED outcomes.
    policy.ts              Bounded-repair eligibility + typed stop reasons.
  review/
    ledger.ts              Pure fold: derived requirement, round qualification, finding
                           statuses with derived triage worth, blockers + caveats.
  git/
    types.ts               GitFacts / GitResult / porcelain contracts (harness capability).
    client.ts              runGit over runManaged — hardened on every invocation.
    facts.ts               detectGitFacts — session-start probe; explicit nulls on every degrade.
    porcelain.ts           Pure `status --porcelain=v2 -z` parser.
    commit.ts              The deliberate-commit flow.
    checkpoint.ts          Hidden-ref checkpoints: create/list/prune + restore flows.
    worktree.ts            Detached task worktrees: version gate, add, EOL pin, honest removal.
  sandbox/
    types.ts               SandboxBackend + EnforcementFacts contracts.
    bootstrap.ts           The versioned PowerShell + inline-C# Low-IL host script.
    windows-lowil.ts       The enforced Windows backend: transform-at-spawn (wrapSpec) + probe.
    none.ts                Honest no-enforcement backend; identity wrap.
    index.ts               selectSandbox — platform → backend.
  tools/
    index.ts               read_file/list_files/search/write_file/edit_file + registry + schemas.
    run-command.ts         Shell tool on runManaged; applies ctx.sandbox.wrap at spawn time.
    run-check.ts           run_check — typed verification (parent-only).
    preview.ts             preview — the managed preview-server tool (parent-only).
    browser-flow.ts        browser_flow — typed browser verification (parent-only).
    view-image.ts          view_image — session-artifact image reads (screenshots + pages).
    artifact-read.ts       read_document — bounded document reads with a coverage verdict.
    artifact-render.ts     render_document — spec → DOCX/PDF + deterministic validation.
    artifact-inspect.ts    inspect_pages — PDF pages → pixels the model can judge.
    recover.ts             recover — the bounded repair ledger tool (parent-only).
    report-finding.ts      report_finding — the reviewer child's ONLY findings channel.
    review.ts              review — parent triage over recorded findings.
    delegate.ts            delegate_task — parallel groups, executor orchestration, briefs,
                           the DAG gate (checkDagRules R1–R12), caps, group digest.
    retrieve.ts            retrieve — read-only view over the session index.
    update-plan.ts         update_plan — the model's ONLY plan write path.
    apply-changes.ts       apply_task_changes + the captured-changes registry.
  retrieval/               Git-backed inventory (+ path-SET digest) → regex symbol/import
                           extraction (ts/js, python, rust, go, c/c++) → import-graph PageRank → a persisted
                           incremental index written ONLY at assembly → ranking with traceable
                           signals → tiered render under a HARD char budget; any failure falls
                           back to the flat map.
  net/transport.ts         Proxy-aware transport factory (pure resolver + custom fetch).
  provider/
    catalog.ts             The capability model as DATA (models, caps, provider metadata).
    profiles.ts            Per-provider chat-compat wire deviations (deepseek/kimi/glm).
    errors.ts              ProviderError taxonomy + bounded connection-phase retry.
    sse.ts                 One incremental SSE parser for the fetch-based adapters.
    registry.ts            The ONE construction seam: env-only keys + bounded key validation.
    mock.ts                Scripted offline provider (test backbone); `hang` turns for aborts.
    anthropic.ts           Streaming SDK adapter + pure mapping + thinking round-trip.
    openai-responses.ts    OpenAI Responses API adapter (stateless, reasoning items replayed).
    openai-compat.ts       ONE Chat-Completions adapter, profile-parameterized.
  memory/                  Capped never-throwing doc IO + JOURNAL rolling policy + CODEBASE
                           provenance/staleness + the session-start load and end-of-session
                           update (all pure except the IO edges).
  plan/
    store.ts               LEGACY markdown plan store — resumed pre-canonical sessions only.
    schema.ts              Canonical plan graph: zod shape, semantic validation, canonicalJson +
                           planContentSha — the approval-binding CONTENT identity.
    canonical.ts           <id>.plan.json store: amendment contract, approve-refuses-invalid,
                           readPlanState (the ONE reader) + approvedCurrentGraph (the ONE gate
                           filter every consumer shares).
    views.ts               Deterministic user/agent projections + the generated-view writer.
    graph-state.ts         Pure event fold → per-task execution states (the DAG's truth).
  runtime/
    session.ts             startSession / runTurn / resumeSession / reconstruct / endSession.
    subagent.ts            runSubagentTask — ONE bounded child session over the same runTurn.
    roles.ts               Runtime role contracts over the policy fact table in types.ts.
    worktrees.ts           Worktree home, crash registry (owner-stamped, locked), guarded sweep.
    task-changes.ts        Bounded binary-safe executor change capture to blobs.
    approval-forwarder.ts  Serialized child→parent approval queue; signal-linked entries.
    elision.ts             elideHistory — pure, monotone wire-history budget.
    approvals.ts           Approvers + prompt formatting ([s] hidden where no grant would store).
    acceptance.ts          The session completion fold: complete/unfinished + /accept state.
    undo.ts                applyUndo (last / all) over the recorded mutations.
  trust/                   trust.json + audit log; consent gate; `agent trust`.
  config/config.ts         Layered narrowing-only config.
  repl/                    runRepl + the ONE persistent readline (io) + the EventLog.onAppend
                           renderer + the sticky status area (the ONLY cursor-moving code,
                           TTY-only) + the live task table/cancel registry + slash commands.
  workspace/               The FLAT map (fallback form) + the system-prompt builders.
  report/                  report.ts (pure Event[] → {md, json}) + diff.ts (attributable diff).
  cli/                     parseArgs dispatch; buildRunContext; assembleSession (the ONE
                           construction path both interfaces consume); the TTY trust gate.
```

## Startup order (load-bearing)

For every session-starting command: workspace realpath → **state-root-inside-workspace refusal**
(also checked in `ensureTrusted`, so a folder cannot plant a `trust.json` granting itself
consent) → **trust gate** → config load (the workspace file is untrusted bytes until trust
passes) → per-project state creation → then `assembleSession`: **sandbox select + probe** →
**git probe** (post-trust — it executes git against the repo) → **orphaned-worktree sweep**
(registry-driven, path-guarded, never blocks) → **orphaned-preview sweep** (identity-verified
kills, wall-budgeted) → **ranked map + retrieval index** (any failure falls back to the flat map
with the reason surfaced) → **project-memory load** → system prompt → start/resume → post-start
records in a fixed order (trust.verified, config.loaded, sandbox.status, git.context,
workspace.mapped, memory.loaded) → per-session tool attachment (retrieve, delegate_task with the
executor bundle + forwarding queue, update_plan, run_check, preview, browser_flow, recover,
review, apply_task_changes with the changes registry rebuilt from events on resume).

Read-only commands (`report`/`sessions`/`undo`/`diff`/`map`/`plan`/`memory`/`providers`/`version`/
`help`) are ungated, never create state dirs, and never run git (`providers` also makes no network
call); `agent commit`/`agent checkpoint` ARE
trust-gated (they execute repo hooks / write `.git`); `map` reads workspace bytes but sends
nothing to a model (documented exception) and keeps the pure walker pre-trust.

## The core loop (`runtime/session.ts`)

`runTurn(session, userText, { signal? })` appends a `user.message`, then loops up to `maxSteps`:

1. Build a `ProviderRequest` — system prompt, the **elided view** of history, tool schemas
   derived from the tools' zod schemas — and call `provider.complete(req, onText)`.
2. Record `assistant.message` with **structured** content (text + each tool_use's id/name/input)
   so resume is faithful. Push the assistant turn onto the history.
3. If tool_use blocks exist, process each sequentially through `executeCall`, collect all
   `tool_result` blocks, push them as one user message, repeat.
4. Otherwise end the loop — but **any unanswered tool_use blocks are still answered first**:
   blocks and stopReason can diverge (a `max_tokens` cut mid-tool-call yields tool_use blocks
   with stopReason `max_tokens`), and leaving them unanswered made every later request 400 for
   the life of the session.

`executeCall` is the gate: record `tool.requested` (verbatim, untrusted) → parse input against
the tool's zod schema → `decide(...)` → record `policy.decision`. A parse FAILURE first passes
through `input-coerce.ts` (S16.5b, found live): when an `invalid_type` issue expected
object/array and a STRING sits at that path, and that string itself `JSON.parse`s to a
structure, it is decoded and the input re-validated ONCE — kimi-k3 double-encodes nested
arguments, and fed only the schema error it cycled serialization formats for twelve minutes
without ever un-stringifying the value. Anything else keeps the original error plus a
plain-language hint naming the stringified path. `tool.requested` and the wire history keep the
model's ORIGINAL bytes; policy and execution both see the decoded input (the same thing an
approval prompt shows). A still-failing parse is a recorded deny. On `deny`, return a terminal error result (with a `tool.completed` so resume
never mistakes it for a crash). On `ask`, call the approver and record `approval.resolved`; a
`session`-scope allow adds a grant. On `allow`/approved, run `runExecution`.

`runExecution` captures a pre-mutation snapshot when required (a capture failure escalates to a
no-undo ask — never a silent proceed), then executes the tool with a **per-call context**: the
turn's AbortSignal plus callId-bound evidence channels (`reportCommand`, `reportCheck`,
`reportTask`, `reportPreview`, `reportBrowser`, `reportRepair`, `reportReview`, and render-only
`onOutput`) — the runtime binds the callId, so a tool can never forge another call's evidence.
It records `file.mutated` for snapshotted paths and `tool.completed`. The **model sees the real
tool output**; the **persisted log redacts** secret-classified reads.

Post-write readback never escapes: if reading back a just-written file fails (transient AV/index
locks, EISDIR), the mutation is still recorded with `postStateUnverified` — losing the event
would leave `/undo` blind to bytes already on disk while the log claimed nothing ran.

`tool.completed` is also the SPILL choke point: when a tool attached transient
`ToolResult.fullOutput` (only `run_command`, `run_check`, and `delegate_task` do) and the output
was truncated, the runtime stores the full pre-truncation bytes as `objects/<sha>` and marks the
event `fullOutputSaved` — skipped under ANY redaction, capped at 2 MiB, never turn-failing, and
flagged only when the stored blob's hash verifiably equals the recorded sha. `reconstruct`
deliberately does NOT read blobs back (the model never saw the full bytes live). The report says
"captured output preserved", never "full" — the exec capture cap may itself have dropped bytes.

### Abort and repair

The tool loop has a **pre-gate**: once `signal.aborted` or deny-&-stop is seen, no further call
executes — including auto-allowed in-workspace writes. Skipped calls get synthesized
`tool.requested`/`tool.completed` events and error `tool_result` blocks so the wire history stays
API-valid; the turn records `turn.aborted {phase}`. An abort during model streaming appends
nothing partial. An **executing `run_command` IS interruptible**: the signal reaches the child
through the exec substrate, which tree-kills, verifies, drains bounded, and reports
`termination: 'aborted'` — distinct evidence from `turn.aborted` (process vs turn).
`'interrupted by user'` remains reserved for calls that never spawned. The one-shot CLI wires
SIGINT to the same signal (first press aborts, second force-exits).

`repairDanglingToolUses(session)` is the REPL's recovery after a mid-turn throw: unanswered
`tool_use` blocks are answered from their recorded completions (or an error result), so one
failed turn cannot poison every later request with a 400.

## Context budget (`runtime/elision.ts`)

The full conversation is resent every step; old tool outputs are the bulk. `elideHistory` is a
PURE function recomputed per request:

- **Image pass (unconditional):** image parts older than `IMAGE_KEEP_LAST_STEPS = 2` assistant
  steps become `[screenshot <label>: viewed live…; preserved at objects/<sha>]` markers even
  below the char trigger — a deliberately separate window from `keepLastSteps = 4`.
- **Char pass:** when RAW history crosses `DEFAULT_TRIGGER_CHARS = 400_000`, the oldest
  tool_result contents are replaced with a marker (char count + sha256 + evidence-log pointer)
  until the sent size is ≤ `DEFAULT_TARGET_CHARS = 200_000`.
- **Monotonicity is enforced, not assumed:** the runtime passes its live `alreadyElided` set and
  those results STAY elided. Without it, an aging screenshot could free enough budget that the
  char pass restored older outputs verbatim — invalidating the moving cache breakpoint (the whole
  suffix re-billed) and contradicting the `context.compacted` record.
- **Reasoning blocks weigh their PAYLOAD only** (plus `text` when no payload exists): `text` is a
  display copy that is never re-sent, and the compat adapters set it equal to the payload —
  charging both double-weighed every kimi/deepseek block and could fire the exhausted warning at
  half the real reasoning volume (S16.5b).

Only tool_result CONTENT is replaced: tool_use/result pairing (API validity), assistant text,
user messages, and the last 4 assistant steps are untouched; outputs smaller than their marker
are skipped. `session.messages` and the log are NEVER mutated; `context.compacted` records
exactly which outputs the model can no longer see (with a warning when even full elision exceeds
the target — assistant/user text is deliberately not compacted).

## Repository intelligence (`retrieval/`, `tools/retrieve.ts`)

Large-repo understanding is selective and ranked, not a broad file dump. One in-memory
**RetrievalHandle** is built per session at assembly and read everywhere else.

- **Inventory:** `git ls-files` + per-file size/mtime + dirty paths (`status --porcelain=v2 -z
  -uall`, subdir-prefix aware), capped at 20k files. `inventorySha256` digests the sorted path
  SET — deliberately independent of rendering, so map-format changes cannot flap staleness.
- **Extraction:** line-anchored regex symbols/imports for the ts/js family, Python, Rust, Go,
  and C/C++ (S18; one `c-cpp` id — a `.h` is not attributable to either language; every other
  language ranks via path/git signals, declared everywhere). Pattern TABLES per language, all
  column-0 anchored (module-level items only — Rust `impl` methods and Python nested defs stay
  invisible by design): Rust items with `pub` as the exported surface plus `mod x;` emitted as
  `mod::x` pseudo-specifiers; Go funcs/types/consts with the language's own case rule for
  exported, single AND block import forms; C/C++ aggregates, `#define` macros, one conservative
  function pattern, `#include` edges, a header's declarations reading as its public surface.
  Resolution (graph.ts): Rust through sibling/`mod.rs` and the nearest `lib.rs`/`main.rs` crate
  root (`super::`/`self::` dirname arithmetic; external crates drop); Go by DIRECTORY-SUFFIX
  matching onto one deterministic representative file (module paths are unknowable without
  go.mod in a per-file resolver — wrong only toward missing edges; single-segment specs drop as
  stdlib); C/C++ includer-relative then `include/`/`src/` roots. `SymbolKind` gained
  struct/trait/mod/macro with NO index version bump (strings in JSON; newly eligible files
  extract on the next warm load — the pinned convergence). `LangId` (per-file extraction) and
  `ProjectKind` (per-unit build system) are deliberately SEPARATE vocabularies: a lone `.rs`
  scratch file indexes without any cargo unit existing. Injection defense is
  structural: symbol captures are bounded identifier classes, import specifiers are
  charset-filtered — repo prose cannot enter the system prompt through extraction. Secret-named,
  binary, and >256 KiB files are never read.
- **Index:** `<projectDir>/index/retrieval.json` — a derived, idempotent cache written ONLY at
  assembly (a command-less observe tool must never mutate durable state). Warm loads stat-diff
  and re-extract only changes; corrupt/missing/version-mismatch rebuilds cold; a ~10s wall budget
  yields an honest `'partial'` that CONVERGES across sessions. Deliberately lock-less: any
  consistent snapshot is valid, atomic tmp+rename prevents torn reads, rebuild is the recovery.
  Known limit: same-size+same-mtime edits are invisible to stat-diff — a misrank at worst, never
  a wrong line (excerpts are live).
- **Ranking:** a task-agnostic structural prior (bounded PageRank over resolved relative imports,
  entry-point/manifest heuristics, uncommitted-change boost, depth and test/vendor penalties)
  plus `rankForQuery` (path/symbol term matches + graph-neighbor boost + the prior).
  Deterministic, and every hit carries human-readable `signals` — traceable selection is a
  contract, not a debug feature.
- **Rendered map:** tiers under a HARD 16k-char budget (every tier charged as appended, footer
  reserved, per-line clipping): coverage-honesty header → uncommitted files (≤20) → the COMPLETE
  directory tree with per-dir counts (the recall backstop — ranking orders detail but never hides
  that a directory exists) → ranked key files with top exported symbols and **no line numbers**
  (line numbers only ever come from live reads) → footer pointing at retrieve/search/list_files.
  `WorkspaceMap.sha256` remains `sha256(text)` — "exactly what the model saw".
- **The `retrieve` tool:** `{query, max_results≤50, scope_paths?}` → ranked hits with signals +
  symbols + excerpt lines read LIVE at query time (≤64 files/≤500ms; secret/binary skipped;
  vanished files dropped and counted). Policy: no command/delegates/planDoc facts, empty mutation
  plan, declared `readsPaths` → observe/auto-allow in-workspace, ask on out-of-workspace scopes.
- **Consumers:** the parent session; read-only child roles (through the named admission seam);
  `/map`; `workspace.mapped` fields; CODEBASE staleness. Executor children and pre-trust
  `agent map` deliberately stay on the flat map.

## Project units (`checks/workspace.ts`)

A workspace holds one or more project UNITS, not one project at its root (before S16, a
`web/`+`api/` repository with no root manifest went silently inert — nothing detected, every
gate unrunnable).

- **Discovery** is bounded, stat-first and NEVER throwing (the `detect.ts` discipline): the root
  when it has a manifest, whatever the root `package.json` `workspaces` / `pnpm-workspace.yaml`
  `packages:` / root `Cargo.toml` `[workspace] members` / `go.work` `use` directives declare
  (S18 — cargo members and go.work uses are hand-extracted bounded scans, the pnpm-YAML
  precedent), every depth-1 directory holding a manifest, and the children of conventional
  containers (`apps`/`packages`/`services`/`libs`/`modules`). Unit manifests:
  `package.json`, `pyproject.toml`, `setup.cfg`, `Cargo.toml`, `go.mod`, `CMakeLists.txt` —
  a cmake unit is NAMED without recipe rows so refusals say what the project is. Depth 1 is
  scanned GENERALLY rather than against a name list — a Python service in `svc/` is a real
  project; `target/` and `vendor/` join the scan skip set.
  Caps: `MAX_PROJECT_UNITS = 12`, `MAX_UNIT_DEPTH = 2`, 200 directories per listing.
- **Two rules are load-bearing.** A unit exists only where a MANIFEST exists (directory names are
  candidates, never units). And everything NOT interpreted is RECORDED as a `note`: the glob
  vocabulary is "a literal directory" or "a single trailing `/*`", and anything richer is refused
  with a reason, because half-interpreting a glob silently yields a different unit set than the
  package manager itself uses.
- **Ordering is deterministic** (root first, then lexicographic; listings are filtered, then
  sorted, then capped) because unit ids qualify recipe ids, and recipe ids are what consent binds
  to. Ids are case-folded on case-insensitive filesystems, and a unit whose real path escapes the
  workspace (a symlinked workspace entry) is dropped.
- **`selectUnit` refuses ambiguity; it never picks.** With more than one unit a call must name its
  `project` — deliberately including the workspaces-monorepo case where a root unit exists, since
  a container root resolves most kinds to `unsupported`, and that reason WAIVES a declared gate.
  A workspace with NO project resolves to its root, so "this project cannot run a build" stays a
  capability answer rather than becoming a call refusal that could never be waived.
- **Per-unit resolution:** `resolveChecks`/`resolvePreview`/`resolveSetup` all take a unit; the
  command spawns with the unit's cwd; recipe ids are unit-qualified (`node.script.test@api`) —
  but NOT for the root unit, so single-project workspaces keep byte-identical ids, grants,
  evidence and tests. `check.started`/`check.completed` carry an additive `projectId`.
- **`DetectedProject`** gains `id`, `lockfile` (name + content sha), `manifestSha256`,
  `npmrcSha256`, `packageManagerSpec`, and `envFiles` (NAMES only — `.env` contents are a
  secret-classified read, but "ships `.env.example`, has no `.env`" is a fact worth surfacing
  rather than a dev server that dies during startup for no visible reason). The stamp union
  qualifies every `relPath` by unit, so the TOCTOU guard notices a manifest appearing in ANY unit.
  S18 adds optional per-ecosystem sub-records — `rust` (workspace root, Cargo.lock, edition, the
  `[build].target` cross triple from `.cargo/config.toml`, rust-toolchain file), `go` (module
  path, go directive, go.sum, vendor/), `cmake` (project name) — and `ProjectKind` widens to
  `node | python | rust | go | cmake`. The stat-candidate list covers the new manifests plus
  `.cargo/config.toml` and `rust-toolchain*`, so a Cargo.toml edit is drift the guard can see;
  `target/` is deliberately NOT stamped (its mtime moves per build while nothing resolution-
  relevant depends on it).
- **Toolchain facts (S18, `checks/toolchain.ts`)** — machine availability as a first-class fact,
  stat-only and never spawning: cargo/rustc/go probed on PATH (PATHEXT-aware, bounded), rustup
  components and installed targets probed under the TOOLCHAIN dirs — never `~/.cargo/bin`, whose
  proxy shims exist for every component name whether or not the component does (union across
  installed toolchains, an approximation the module states). One probe per `detectWorkspace`,
  shared by reference across units. Freshness rides the existing TOCTOU seam instead of a second
  cache: present toolchains become pseudo-stamps under the reserved `~toolchain/` prefix,
  appended identically by `detectWorkspace` and `probeWorkspaceStamps` — installing Go (or
  `rustup target add`) mid-session flips staleness and the shared holder re-detects; absence is
  never cached across a session (the S16.5 probe lesson). A presence probe is not a health
  check: a findable-but-broken toolchain still fails at run with a real signal.
- **One detection per session, one LIVE holder.** Assembly detects once, before the system prompt,
  and `checks/session-workspace.ts` publishes that snapshot to `run_check`, `preview` and
  `project_setup` through a single `SharedWorkspace`. Per-tool copies protected a window that does
  not exist — tool calls execute strictly one at a time, so `decide()` and `execute()` for one call
  are back-to-back — and cost a real defect: after `project_setup install` created `node_modules`,
  the next check resolved against a snapshot where nothing could run, was allowed as "nothing to
  run", then refused at execute with *"the project changed after this call was approved"* for a
  call nobody approved. `project_setup` refreshes the holder after a run; the drift guard is
  unchanged, and the never-gated case now has its own honest message.
- **The prompt block is a photograph.** It is built before the first turn and lives in the cached
  stable prefix, so it is labelled AS OBSERVED AT SESSION START and points at the tools that
  resolve against current state. A multi-project workspace also gets ONE startup chrome line naming
  its projects and which are uninstalled — the model had those facts since S16; the human did not.

## Project setup (`setup/`, `tools/project-setup.ts`) — install, migrate, seed

The check inversion applied to the one operation the harness refused to perform until now. There
is still no dependency-install CHECK KIND: setup has its own tool, its own consent, its own event
stream, and no path to satisfying a verification gate. A check still means "we verified"; it never
means "we fetched".

- **The model names an INTENT and a UNIT; the harness names the command.** `install` resolves from
  the LOCKFILE (`package-lock.json`→`npm ci`; `pnpm-lock.yaml`→`pnpm install --frozen-lockfile`;
  `yarn.lock`→ v1 `--frozen-lockfile` or Berry `--immutable`, read from `packageManager`). When
  yarn.lock exists and nothing declares the major, it REFUSES rather than guessing between two
  incompatible flags. The lockfile chosen follows the DETECTED package manager, so a stale
  `package-lock.json` in a migrated repo does not compose `npm ci` for a pnpm project; every other
  lockfile present is named in the evidence. No lockfile still installs, saying the versions are
  NOT pinned. Python is `unsupported` with the reason. `migrate`/`seed` resolve the project's OWN
  script from a fixed per-intent allowlist, so neither can become "run any script" — and when the
  only blocker is missing `node_modules`, the recorded reason is `precondition-curable`, not a
  false `no-recipe` capability claim for a project that declares the script (S16.5b).
- **Consent, two different answers for two different consequences.** An install is `external` and
  MAY replay under `[s]`, bound to `sha(lockfile + package.json + every install-affecting config
  file)` — never the lockfile alone, because
  every package manager executes package.json's lifecycle scripts during an install, and `.npmrc`,
  `.yarnrc.yml` (`yarnPath`) and `.pnpmfile.cjs` (a `readPackage` hook) each choose what code runs
  and where it comes from — all of them ordinary auto-allowed writes. Binding the lockfile alone let an ordinary
  auto-allowed package.json write turn one `[s]` into standing arbitrary-shell consent (found by
  the S16 review; the S14.5 body-binding lesson, one file over). `migrate`/`seed` are
  `destructive` and ask EVERY time: a migration is not idempotent, so "you approved this once"
  cannot honestly mean "you approved it again". They issue no replay keys, and `destructive` is
  structurally non-grantable — two independent reasons for the same answer. Installs deliberately
  DO run lifecycle scripts; `--ignore-scripts` would break esbuild/playwright/prebuilds and make
  the capability a lie, so the prompt says so instead.
- **Evidence:** `setup.started` (from `onSpawn` only) / `setup.completed` are NEW event types,
  additive, schema still v1. Reusing `check.*` would have taught every existing reader a
  falsehood — `collectPassingEvidence` marks a file CHECKED on a zero exit, gates count a passing
  kind as verification, and the repair ledger accepts one as proof. The exit code is the verdict
  (`ok`, never `pass`); `reconstruct` replays an interrupted setup as "dependency or local data
  state is UNKNOWN — re-run it"; `setup.started` joins `WORK_EVENT_TYPES` and the pre-integration
  spawn set. `SETUPS_PER_SESSION = 12`, events-rebuilt.
- **Parent-only**, for a sharper reason than `run_check`'s: an executor worktree is disposable, so
  an install there populates a directory about to be deleted, and a migration there writes the
  REAL local database from what the user believes is isolation.
- **Recovery:** `dependency-setup` finally has a path forward — its catalogue entry names
  `project_setup install`, still human-gated and still `autoEligible: false`. A failed setup
  classifies as that class by construction; a TIMED-OUT one is `timeout-resource` and an ABORTED
  one is `unknown`, because a Ctrl+C on a slow `npm ci` produced no verdict. A repair proof must
  come from the project that failed.

## Typed verification (`checks/`, `tools/run-check.ts`)

**The model names KINDS; the harness names COMMANDS.** That inversion is the whole trust
argument, and everything else follows from it.

- **Kinds:** `build | test | test-targeted | typecheck | lint | format | static-analysis`
  (+ `browser`, produced only by flows). There is deliberately NO dependency-install kind —
  installing runs third-party code with network access, which is not "verify what we just
  built"; a missing toolchain is an honest `unsupported` precondition the user resolves.
- **Detection:** bounded, never-throwing manifest reads over a FIXED candidate list (so a newly
  ADDED manifest is noticed too), plus a stat-only fingerprint. Everything taken from workspace
  bytes is charset-filtered AT INGESTION, because it is later composed into a command line.
  Script text is capped at 200 chars for display — and `scriptShas` carries the sha of the
  **untruncated** value, because consent binds the body (below).
- **Recipes:** declarative rows with `applies` / `unmetPrecondition` / `argv` / `bodyScript` /
  timeout / effects. A project's OWN script always beats a guessed tool invocation, and the first
  applicable row wins — resolution is deterministic, which is what consent can bind to.
  `toCommand` is the single composer: bare-safe tokens pass through, everything else is
  single-quoted, and an unrepresentable argument throws rather than being hand-escaped. Node/TS
  is first-class, Python minimal, **Rust/Cargo and Go modules first-class (S18)**, CMake
  detected-but-unsupported, everything else `unsupported` **with the reason**. A script
  recipe requires `node_modules` only when the project actually DECLARES dependencies.
  The cargo rows: `cargo build`/`cargo test`/`cargo check` (typecheck)/`cargo clippy -- -D
  warnings` (lint; clippy's plain exit ignores lint findings, so the strict CI form IS the
  recipe)/`cargo fmt --check` — compile rows carry `workspaceAuthored: true` because build.rs
  and proc-macros execute workspace code at build time. The go rows: `go build ./...` (build AND
  typecheck — Go's compiler is its typechecker, and the deliberate duplication keeps a typecheck
  gate honest instead of no-recipe-waived), `go test ./...`, `go vet ./...`
  (static-analysis), and a `test-targeted` row that maps path scopes onto `./pkg/...` package
  patterns (Go selection is path-shaped; the unit prefix is stripped, `.go` files fold to their
  package dir). Holes are DECISIONS with stated reasons via `ECOSYSTEM_KIND_NOTES`: no rust
  test-targeted (cargo selects tests by NAME), no go format (`gofmt -l` exits 0 either way, and
  an output-parsed verdict would break the contract below). Preconditions are ROW-OWNED
  (`UnmetPrecondition {reason, why}`, S18): whether a blocker is an uninstalled project
  (curable), a missing machine toolchain (waives loudly), or a host incapability (waives
  quietly) is a fact only the row can state — the old central curable rule was Node's answer
  (`hasDependencies && !hasNodeModules`) hard-coded into generic control flow, and the node rows
  still give byte-identical answers, test-pinned. Cross-target crates (a `[build].target` triple
  in `.cargo/config.toml`) split honestly: `cargo fmt` stays host-verifiable, compiles gate on
  the installed rustup target (else `toolchain-unavailable` naming `rustup target add <triple>`),
  and `cargo test` refuses permanently as `precondition` — cross-compiled test binaries cannot
  execute on this host, and the harness manages no hardware or emulators.
- **Normalization:** **THE EXIT CODE IS THE VERDICT.** `exited`+0 ⇒ pass, `exited`+non-zero ⇒
  fail, every non-exit termination ⇒ `error` — never `pass`. Parsers only enrich
  `summary`/`findings`/`signals`. The named **signals** are the durable half: full output is
  truncated and only spilled to a blob, so failure classification later reads the signal ids
  persisted on the event, not text that has left the context. S18 appended `rust-error` and
  `go-error` (order pinned — SIGNAL_RULES is append-only), widened `syntax-error` (Go's
  lowercase spelling) and `assertion-failed` (Rust ≥1.73's backticked form), and added rustc
  two-line / Go one-line finding extractors. Known hazard, documented not fixed: gcc/clang's
  `fatal error: foo.h: No such file or directory` would false-fire `command-not-found` →
  dependency-setup — unreachable today because no C/C++ recipe exists to emit such output, and
  narrowing the generic rule would break real not-found detection for zero current benefit.
- **`run_check`** (per-session factory, PARENT-ONLY): holds the detected project SNAPSHOT,
  because the policy `check()` fact must be pure and because the command the human approved must
  be the command that runs. Executors are deliberately excluded — a worktree materializes without
  gitignored dependencies, so a check there would refuse on a precondition almost every time.
  A bound `test-targeted` run with no explicit scope defaults to its plan task's declared
  `touches` (substituted before the policy fact resolves, so the human approves what runs).
- **Three refusals that spawn nothing:** the resolved command (or the script BODY it invokes)
  changed since the gate; a malformed request (`test-targeted` with no usable scope) — refused as
  a CALL, with no event, so a caller mistake can never become gate evidence; and the session
  check budget (`CHECKS_PER_SESSION = 80`, events-rebuilt).
- **Evidence:** `check.started` is emitted from `onSpawn` ONLY, so it means exactly what
  `command.started` means — a process really started. An `unsupported` kind records a completed
  event alone carrying `unsupportedReason` (`no-recipe` | `precondition` | `precondition-curable`
  | `bad-request` | `toolchain-unavailable` (S18)), which is what lets a gate distinguish "this
  project cannot" from "you asked wrong" — and, since v1.2.1, from "this project is not
  installed yet". `toolchain-unavailable` is the MACHINE-capability answer (no cargo/go on PATH,
  a rustup component or target missing), produced before anything spawns and naming the exact
  user cure; it waives a gate — the browser-unavailable precedent: an absence the harness will
  never install on its own must not strand acceptance — but LOUDLY: the gate folds track these
  waivers apart (`toolchainUnavailable`/`toolchainUnavailableIn`) and the acceptance caveat says
  "TOOLCHAIN IS NOT INSTALLED on this machine" instead of the generic "unsupported".
  `precondition-curable` is
  produced when the project DECLARES dependencies and has no `node_modules`: a transient state with
  a named cure (`project_setup install`), decided by the node rows themselves (row-owned `why`,
  S18) exactly as the old central rule did. It does NOT waive a gate. Waiving it let a session that
  installed `api` and forgot `web` be accepted as COMPLETE with its own caveat claiming a project
  shipping a build and a test suite *cannot* run them — an uninstalled project is unverified, not
  unverifiable. `reconstruct` replays an interrupted check as "produced no verdict; effects
  unknown — re-run".

### Consent for checks — replay, bound to what actually runs

A check runs project code at full user privilege: it is `reversible` + `noUndo`, always
`execBoundary: 'unsandboxed'` (the Low-IL boundary denies workspace writes, so a build could not
run inside it — the mode is recorded, never implied), and it ASKS. Repeated checks would be
unaffordable at one approval each, so a `session`-scope answer stores **replay consent**:

- keyed by `sha256(recipeId + command + bodySha)` in a SEPARATE store with no `ActionClass`. The
  **body** is load-bearing: `npm run test` is a stable string whose behavior lives in
  package.json, which the agent can rewrite through an ordinary auto-allowed in-workspace write.
  `bodySha` hashes the **untruncated** script value — hashing the display-capped text let an
  append past character 200 ride the earlier approval.
- `GRANTABLE` / `isGrantable` / `Grants.add` are UNTOUCHED. Widening the class table would
  silently break an unrelated consent: the executor-spawn ask is classified `reversible` and is
  deliberately non-grantable, yet the prompt offers `[s]` whenever `isGrantable(classification)`
  holds — a widened class would render an `[s]` storing a grant the delegates branch never reads.
- the prompt shows every resolved command verbatim and counts what `[s]` grants.

## Managed preview processes (`preview/`, `tools/preview.ts`)

The one process class whose lifetime is not bounded by a tool call: a preview server is an
explicit SESSION resource with recorded start, readiness, health, logs, and deterministic end.

- **`startSupervised`** is `runManaged`'s deliberate inverse: it returns a live handle
  (`pid, exited, isAlive, stop, tail`) instead of awaiting an outcome. Output goes to a
  per-preview LOG FILE via an inherited fd — no pipes, so an orphan surviving harness death can
  never wedge on a full pipe buffer half-serving requests — and the parent's fd copy closes at
  spawn. The child is `unref()`ed. Lifetime bounds are typed stop reasons: TTL (60 min), log cap
  (16 MiB → `log-overflow`), explicit stop, session end. `stop()` bounds BOTH the kill helper and
  the wait for death, and re-checks OS liveness first so a crash coinciding with a timer is never
  relabeled. POSIX children get their own process group; on Windows detaching is NOT viable
  (DETACHED_PROCESS kills the PowerShell wrapper instantly — verified), so a one-shot console
  Ctrl+C also reaches the preview: documented, not silent.
- **Consent reuses the check inversion**: the model names a SCRIPT from a fixed allowlist
  (dev > preview > serve > start — "preview" must never euphemize "run any script"); the harness
  composes `<pm> run <name>`; the engine's check branch splits on kind `'preview'` with its own
  rule ids so the PERSISTED decision says "KEEPS RUNNING, binds a local port". `[s]` stores
  body-bound replay keys (`preview.`-prefixed recipeIds keep them disjoint from check consent); a
  DECLARED port folds into the consent identity and the prompt. Grants stay in-memory: a resumed
  session re-asks. A TOCTOU re-probe refuses at execute if the resolved command/body changed.
- **Readiness is honest**: the harness probes HTTP only on a port the server's own output
  ANNOUNCED (declared ports included — an unannounced answer is somebody else's socket), caps
  candidates, honors the deadline and the turn abort, re-checks liveness after a successful
  probe, and records "socket ownership not verified". The tail is ANSI-stripped before parsing
  (a dev server writing to a log file can still colourise: picocolors forces colour on win32
  regardless of TTY, which would put the port behind an escape sequence). Each candidate port is
  probed on BOTH loopback literals, `127.0.0.1` then `[::1]`, and **the address that ANSWERED is
  what gets recorded** — Node 22 resolves `localhost` verbatim, so a server told to listen on that
  name binds `::1` here and refuses IPv4 entirely; the recorded URL is also the origin a browser
  flow is locked to, so it must be an address proven to answer rather than the first one tried. An HTTP answer means A server is up;
  APPLICATION state is judged only by browser flows. An aborted wait leaves the process running
  and says so; a readiness timeout stops it with `start-failed`, never a user-shaped `stopped`.
- **Events + ordering (load-bearing)**: registry entry BEFORE `preview.started`; `preview.ended`
  has exactly ONE writer (the exit listener, installed at spawn: stop-reason first-cause,
  closed-log tolerant) and lands BEFORE unregistration. The spawn→register window is covered by
  REPORTING: the sweep scans for recent logs with no registry record and no ended marker — and
  the sweep now STAMPS that marker on every log it disposes of (after the registry write
  succeeds), so a reaped orphan is not re-reported as a lost start for 48h.
- **The crash sweep kills only on POSITIVE identity**: dead pid → drop; live sibling owner →
  skip; live orphan → the recorded command's re-derived `-EncodedCommand` token must appear in
  Win32_Process.CommandLine AND creation time must sit within ±15s of `createdAt`, else the kill
  is SKIPPED and reported. There is deliberately NO age hatch on kills (delayed removal is safe;
  killing a recycled pid is not); >24h unverifiable records are deregistered WITHOUT a kill; a
  20s identity wall budget bounds startup. Stop-all runs on every session-end path.
  `/accept` deliberately does NOT stop previews (the user may browse the accepted app).
- **Honest answers when a preview is GONE (S16.5b):** the tool keeps an in-memory
  `endedReason(previewId)` so the browser layer can tell a harness lifecycle stop apart from a
  crash; `status` surfaces a PREVIOUS-life registry survivor of the SAME session id (an
  unverifiable orphan used to be in neither the live nor the another-session list — invisible
  exactly while it held the port Vite strictPort needs), and the resume note names the
  stop-it-first way out; the nothing-was-gated drift refusal says "nothing was approved and
  nothing started" instead of claiming a nonexistent approval was invalidated.

## Browser verification (`browser/`, `tools/browser-flow.ts`, `tools/view-image.ts`)

The check inversion applied to UI: the model declares a TYPED FLOW; the harness owns execution,
waits, and the failure taxonomy. `playwright-core` drives the SYSTEM browser — probe order
msedge → chrome → Playwright-cache Chromium, cached per session **SUCCESS-only**
(`cacheSuccessfulProbe`, S16.5b: a transiently failed probe cached for the session turned every
later flow into the gate-WAIVING unsupported/precondition — acceptance could reach COMPLETE
without the UI ever driven; a failed probe re-probes on the next flow, which costs seconds and
never honesty); a machine with none degrades to the gate-waiving `unsupported/precondition`.
A flow bound to a preview the HARNESS stopped (TTL / log cap / explicit stop) between approval
and execution reports `preview-stopped-lifecycle` (routed to `timeout-resource` — a resource
bound expired, nothing about the app failed), keeping `preview-died` → runtime-process for real
crashes. Over-budget or store-failing SCREENSHOTS are counted (`screenshotsOmitted` on the event
and a do-not-cite output line), matching the trace-omission honesty.

- **FlowSpec (zod, strict)**: `goto{path (relative-only), ready_when{selector|text} REQUIRED}`,
  `click/fill/select/press/wait_for`, typed `expect{text|visible|hidden|value|url|count}`,
  `screenshot{label}`. Readiness honesty is structural: goto waits for 'commit' only and then the
  DECLARED condition — a load event, networkidle, or a quiet spinner never count; expect/
  screenshot steps cannot precede the first goto (schema) and steps run strictly in order,
  stopping at the first failure. Caps: ≤20 steps, ≤4 declared screenshots, per-step timeouts
  clamped to the 90s flow wall, bounded error/request records.
- **Typed taxonomy**: `timeout` / `assertion` (last observed state recorded) / `navigation` (the
  origin lock: any off-origin TOP-LEVEL navigation aborts the flow; a REAL URL-origin comparison,
  not a string prefix) / `runtime` (uncaught page error) / `protocol` (browser/driver died — the
  app was never judged). Console errors are findings, not verdicts, unless
  `fail_on_console_error`; off-origin SUBRESOURCE requests are recorded, never blocked. A failing
  step gets a best-effort failure screenshot. A preview dying mid-flow is `preview-died` (status
  error), never a timeout blamed on the app.
- **Evidence rides the check channel**: `check.started` (the browser genuinely launched) and
  `check.completed {check:'browser'}` with `exitCode: null` and NO termination, ALWAYS — which is
  exactly what keeps a browser pass out of the report's file-CHECKED correlation (exit-0 rule)
  while gates, waivers, acceptance caveats, classification, and the repair ledger all work
  unchanged. A `browser.flow` event carries the detail. Flows share the session check budget plus
  a 64 MiB events-rebuilt artifact byte budget; dropped artifacts are recorded, never silent.
- **Policy**: the `browser` fact's whole decision is `previewBound` — a flow bound to a RUNNING
  managed preview auto-allows, anything else DENIES (no ask path for arbitrary origins). Execute
  re-verifies; a died-in-between preview is a typed error, never a silent pass. The fact also
  carries the READY SET and the requested id, so a denial names what is running and asks for a
  `preview_id` instead of telling a session with two live servers to start a third.
- **Project attribution**: both check events carry the bound preview's `projectId`. Without it a
  project-scoped `browser` gate was permanently unsatisfiable AND unwaivable — every gate consumer
  folds a missing `projectId` to the root, and `run_check` cannot produce kind `browser` at all.
  An unbound flow still binds to whatever single preview is ready, which in a full-stack session
  can legitimately be the API, so the RESULT states which preview, project and URL it drove.
- **Visual judgment is judgment**: `view_image` returns real pixels for a sha ONLY if this
  session's `browser.flow` artifacts recorded it — enforced at the GATE (an un-admitted sha
  DENIES, because the shared blob store also holds spilled output and snapshot pre-images) and
  re-checked at execute. Visual impressions can add findings but never discharge a gate or
  override a failed deterministic assertion.

## The documents workflow pack (`artifacts/`, `tools/artifact-*.ts`)

The first NON-CODING workflow, built to test whether the kernel's contracts generalize. It adds
no orchestration layer, no plugin system and no second agent loop: three per-session tools, one
policy fact, two additive event types, and a module of pure format logic outside the kernel.

**The loop is spec-centred:** `request → read sources → author a *.docspec.json → render →
deterministic validation → SEE the pages → revise THE SPEC → re-render → deliver`. The spec is an
ordinary workspace file written with the ordinary file tools, which is what makes revision
snapshot-backed, undoable, diffable and attributable for free — no incremental-artifact-patching
machinery exists or is needed.

- **Substrate.** `zip.ts` opens OOXML containers IN MEMORY ONLY (nothing is ever extracted to
  disk, so zip-slip is structurally impossible rather than defended against), validating every
  entry name and capping entries/bytes on `max(size, originalSize)` — a STORED entry is
  materialized by its COMPRESSED size, and gating only the uncompressed field let a forged
  central directory pull 300 KB past a 1 KB cap before the after-inflate check fired (S17
  review). Writing is deterministic: sorted entries, FIXED mtime (fflate would stamp the live
  clock into 2-second-resolution DOS fields), fixed level. `xml.ts` is a size- AND depth-bounded
  strict parse (a 546-byte part nesting 5000 elements parsed fine and then overflowed the stack
  in the recursive walk — an untyped RangeError that killed the turn instead of refusing the
  file), plus the escapers every generated string must pass through, which also drop code points
  XML 1.0 cannot carry.
- **Identification is by MAGIC BYTES + the content-types part, never the extension**, and
  `identifyDocument` NEVER throws: every failure is an `unsupported` verdict with a reason that
  echoes no file content (a `.env` renamed `report.docx` must fail the sniff without leaking a
  byte). OLE containers refuse honestly as the one thing this pack cannot disambiguate without
  an OLE reader: legacy binary Office vs an encrypted OOXML document.
- **Readers** (`docx-read` / `pptx-read` / `pdf-read` / `xlsx-read`) return ONE summary shape
  whose first field is a **coverage verdict** — `full | partial | structural` with reasons — so
  "we read it" can never quietly mean three different depths. PPTX slide ORDER comes from the
  declared `sldIdLst` resolved through the relationship map (file numbering is a convention, not
  the order), with a warned numeric fallback. PDF reading uses `unpdf` with `isEvalSupported`
  off; password-protected and unopenable files degrade structurally rather than throwing.
- **The DocSpec** (`model.ts`) is one strict zod schema with hard caps and a parse function that
  returns the COMPLETE issue list with nothing written — the `update_plan` revision-loop pattern.
  Image paths are spec-file-relative BY SCHEMA and re-validated at execute; font names are
  charset-constrained because they are interpolated into a CSS block, and HTML rawtext ends at
  the first `</style` regardless of CSS quoting.
- **`docx-render.ts` is byte-deterministic**: fixed rIds, no `w:rsid`, FIXED docProps timestamps
  (an artifact's identity is its content, not its render time), `{date}`/`{pageNumber}`/
  `{totalPages}` as real `fldChar` field runs, real named styles carrying `outlineLvl`, ONE
  numbering instance per list block (shared numIds are the classic restart bug), rPr children in
  CT_RPr schema sequence, transitional `ST_Jc` values. Same spec + same image bytes ⇒ same
  sha256, test-pinned by rendering twice. `html-render.ts` emits ONE self-contained page (no
  script, no link, no external src — images are data: URIs) plus Playwright header/footer
  templates, and `pdf-render.ts` prints it through the SHARED cached browser probe on an
  `offline` context with http(s) route-abort. PDF bytes are NOT claimed deterministic (Chromium
  embeds dates and ids); DOCX bytes are.
- **Validation is deterministic and model-free** — the half a non-vision session still gets in
  full. `validate.ts` parses each artifact BACK: outline equality, table shapes, dangling
  `r:embed`/`r:id`/style/numId references, header/footer presence, a PAGE field whenever
  `{pageNumber}` was asked for, printed page count, headings findable in the printed text.
  Two severities, deliberately separate: structural mismatches are FAILURES; layout heuristics
  (blank page, stranded heading) are NOTES that can never block, because the first false
  positive would turn a guess into a gate. Validation reads with validation-scale bounds and
  normalizes both sides the way the renderer does — comparing an artifact against the READER's
  display bounds manufactured "does not match its spec" failures on correct renders (S17 review).
- **`inspect_pages` closes the visual loop**: `pdf-pages.ts` injects unpdf's bundled pdf.js into
  a blank page of the probed browser (the same zero-dep library that reads PDFs in Node renders
  them where a real DOM exists — native-free by construction), enforcing a per-image byte
  ceiling by re-rendering at reduced scale and DROPPING a page that still will not fit. Pages
  become content-addressed blobs, ride the existing wire-image channel (so the vision choke and
  image aging apply unchanged), and join `view_image`'s admission set in lockstep.

**Policy: one new fact, two consequence shapes** (`tool.artifact`, engine branch 0f):

- `render` writes workspace artifacts and may launch the browser. The generic mutation branch
  would have described it as an "in-workspace file change" and — decisively — the engine NEVER
  evaluates `readsPaths` on a tool with a non-empty mutation plan, so a render's claimed read
  coverage was structurally void. The rule cross-checks the fact's outputs against `mutates()`
  RESOLVED (the snapshot machinery follows `mutates()`; divergence denies) and says in the
  recorded reason that spec-referenced reads are enforced AT EXECUTE — where the spec path
  itself and every image path are validated for containment and secret names, refusing into the
  error list with nothing written.
- `inspect` is command-less and mutation-less: the S6 trap with a browser behind it. Admission
  splits on provenance — an artifact THIS SESSION rendered from a spec that embedded no
  workspace images inherits the render's consent (execute re-verifies CONTENT identity, and a
  drifted file refuses naming cures that actually exist); anything else ASKS as grantable
  `sensitive`; secret-named paths DENY outright, because pixels cannot be redacted the way text
  can. The embedded-images clause is the anti-laundering rule: a spec may name any in-workspace
  image, so without it a render+inspect pair showed the model arbitrary workspace pixels with no
  approval at all.

**Evidence: `artifact.rendered` / `artifact.inspected`** are additive event types on the S16
setup pattern — they can NEVER satisfy a verification gate, and the report's asymmetry test pins
it (a render exiting clean after a mutation leaves the file UNCHECKED). They are deliberately NOT
in `WORK_EVENT_TYPES`: every render already emits snapshot-covered `file.mutated` events, which
are what acceptance staleness counts. A failing LATEST validation per path is a loud acceptance
CAVEAT, not unfinished work (blocker semantics need delete/undo resolution rules that do not
exist yet; the caveat retires when the artifact is deleted or undone). Budgets are events-rebuilt
like every other: `RENDERS_PER_SESSION = 20` counted over calls that produced an artifact or
completed (a browserless PDF-only render legitimately emits no artifact event),
`INSPECTED_PAGES_PER_SESSION = 40` over UNIQUE image shas with a 32 MiB blob budget.

**Honest limits, stated in the product, not only here:** DOCX visual fidelity belongs to Word, so
DOCX claims are structural and parse-back verified while visual judgment happens on the PDF twin
rendered from the same spec; no browser ⇒ DOCX still renders and the PDF is skipped with a
recorded reason (a print that FAILS is a different, `ok:false` answer); no image input ⇒
inspection refuses and says the deterministic verdict is what remains. Editing pre-existing DOCX
files, PPTX generation, footnotes, TOC fields, tracked changes, cell merges and RTL fidelity are
out of scope rather than partially supported.

## Wire images

`tool_result.content` widens to `string | (text|image)[]`; `ToolResult.images` is a TRANSIENT
channel whose pixels are already content-addressed blobs. The persisted `tool.completed` records
METADATA + the `objects/<sha>` pointer — a log line never contains base64 (pinned against raw log
bytes) — and `reconstruct` rebuilds from `outputPreview`, so a resumed conversation degrades to
pointers BY CONSTRUCTION. The provider maps parts to SDK blocks, dropping harness-internal
sha/label enrichment; the moving cache breakpoint verifiably lands on the top-level tool_result
block, never a nested part.

## Managed execution (`exec/`)

`runManaged(spec) → ExecOutcome` is the substrate every shell execution goes through. It is
policy-free and log-free: policy stays in the engine, evidence stays in the runtime.

- **Termination is typed**: `exited | timeout | aborted | spawn-error`. Only `exited` carries an
  exit code — a killed command has `exitCode: null` by contract and can never read as a passing
  check anywhere downstream.
- **Kill/drain state machine**: timeout or abort → `killTree` (async `taskkill /PID /T /F`; exit
  0 and 128 both mean "gone"; bounded liveness probes; result recorded in `killDetail`, honest
  when unverified) → settle on `'exit'` with a bounded wait → race `'close'` against a drain
  timeout, then destroy streams. Never awaits `'close'` unconditionally: a detached grandchild
  holding inherited pipe handles cannot hang the outcome (nodejs/node#21960 class;
  regression-tested with a real surviving-grandchild fixture). Settling awaits an in-flight
  `killTree` so kill evidence is never lost to the child's own exit racing ahead. Tree kill is
  BEST EFFORT and says so: grandchildren orphaned by a dead intermediate parent are structurally
  unreachable without Job Objects (documented gap).
- **Capture**: stdin `'ignore'` (interactive children fail fast, never hang the turn); stdout and
  stderr captured separately and interleaved, head+tail under byte caps (stderr-prioritized
  1/3–2/3 split of 512 KiB default) from raw buffers, decoded once. `truncateForModel` remains
  the final model-facing truncation contract on top.
- **Env hygiene**: children get the parent env minus names containing
  `key/secret/token/password/credential` (case-insensitive; config `envExcludePatterns` may add
  more), deduped case-insensitively, with a non-excludable floor (`SystemRoot`/`windir` etc. —
  WinError 10106) and proxy variables passed through (embedded proxy credentials remain visible —
  an honest, documented limitation, NOT a security boundary). `AGENT_CLI=1` marks harness children.

## Contracts (`src/types.ts`)

- `Tool<I>` declares `schema` (one zod source), `mutates(input, ctx)` (write paths, or `null` =
  undeclarable side effects), optional `readsPaths`, `command`, `check`, `browser`,
  `evidenceRead`, `delegates`, `planDoc`, and `execute`. Policy reads these facts; tools contain
  no policy logic. Optional `approvalContext(input)` is DISPLAY-ONLY: extra lines folded into the
  approval request's `detail` inside try/catch — never consulted by policy.
- `ToolContext` optionally carries `signal` (turn cancellation), `onOutput` (render-only), the
  callId-bound evidence reporters, `sandbox` (`ExecSandbox`), and `rules` (config narrowing).
- `ExecSandbox` = `{ mode, enforced, active, wrap(spec) }`: `enforced` (availability) gates
  auto-run; `active` marks a call actually confined — and is true only when a backend exists to
  confine it, so the recorded boundary can never over-claim; `wrap` is the enforcing transform
  for an auto-run call and identity otherwise.
- `PolicyDecision` = `{ classification, decision, rule, reason, requiresSnapshot, noUndo?,
  redactOutput?, execBoundary? }`.
- `SessionEvent` = `{ v, seq, ts } & EventBody`, a discriminated union. `v` is the schema version;
  the log is a versioned public contract.
- `Provider.complete(req, onText?, signal?)` returns `{ blocks, stopReason, usage }`; abort is
  detected via `signal.aborted` after a throw, never via provider-specific error classes.

## Trust (`trust/`)

Recorded consent — explicitly NOT a sandbox. `trust.json` (keyed by case-folded real path) and an
append-only `trust.log` audit live at the **state root**, outside every workspace. A corrupt store
is a hard error, never read as "trusted" and never silently rewritten. The consent prompt is
offered only on a real TTY (a piped answer nobody read is not consent); non-interactive untrusted
runs refuse with exit 3; `--trust-this-workspace` consents for one invocation and is never
persisted. Displayed paths pass through `sanitizeLine`. Every session appends
`trust.verified {source}`.

## Configuration (`config/config.ts`)

Two strict-schema layers merged narrowing-only: user `<state>/config.json` (prefs `model`,
`maxSteps`, `memoryUpdates` + narrowing) and workspace `<ws>/.agent-cli/config.json` (narrowing
ONLY — no prefs, since a workspace is attacker-influencable). Narrowing knobs: `protectedPaths`,
`secretPatterns`, `envExcludePatterns`. The schemas cannot express widening; unknown keys/bad JSON
are hard `ConfigError`s. Rules travel on `ToolContext`; provenance is recorded as
`config.loaded {sources: [{path, sha256}]}`. The `.agent-cli/` directory is write-protected from
the agent's file tools by the path validator.

## Project memory (`memory/`) — three documents, context not authority

Cross-session continuity with hard caps and honest degrades (a broken or oversize doc can NEVER
block a session — it loads truncated or is skipped with a status recorded in `memory.loaded`):

- **`AGENT.md`** (workspace root, USER-owned, never harness-written; cap 24 KiB): the project
  constitution, injected into every session's system prompt — and every subagent's — as a labeled
  section. Read post-trust only.
- **`<projectDir>/memory/JOURNAL.md`** (harness-managed, rolling; inject cap 12 KiB): one
  `## Session <id>` entry per productive session, newest first. Each couples model-written
  Summary/Decisions/Open-issues/Next-steps (explicitly labeled "model-written") with a
  deterministic **Evidence** section derived from the event log via `buildReport`, and a
  deterministic **Handoff** block (acceptance state incl. staleness, the LIVE unfinished list,
  the `agent resume <id>` pointer when work remains). The delivery line names the ref the
  ACCEPTANCE consumed, never the newest creation event (a phantom could hold that). Rolling
  policy: insert-or-replace by session id (resume-safe), newest 2 entries full, older compressed
  to stubs that keep the evidence pointer, 24 KiB budget enforced by dropping oldest stubs behind
  a leading marker. User edits survive byte-verbatim until their entry is compressed.
- **`<projectDir>/memory/CODEBASE.md`** (harness-managed; cap 16 KiB): a model-written
  architecture summary, provenance-stamped with the writing session's id + workspace-map digest +
  HEAD. Stamps are DUAL — legacy `map-digest` plus additive `inventory-digest`; staleness compares
  inventory digests when both sides have one (immune to map-format changes). Known soft spot: a
  ranked→flat map-mode transition over-marks stale for a session or two — the safe direction.

**Injection safety:** every injected memory doc passes through `neutralizeHarnessDelimiters`.
AGENT.md is workspace bytes a cloned repo controls, and JOURNAL/CODEBASE carry model-authored
text from earlier sessions; a line mimicking a harness fence would close the region early and let
the rest occupy space the model is told is harness-authored.

**Write path** (`update.ts`): runs BEFORE `endSession`, on clean ends only (never error, never
`aborted` — a Ctrl+C'd session must not fire a model call), gated on real activity. The narrative
is ONE provider call reusing the exact cached prefix; every failure mode degrades to a
deterministic skeleton entry marked "narrative unavailable". The call bypasses `runTurn` and is
recorded as its own `memory.narrative` event — never as fake message events (they would replay
into a resumed conversation). The journal is RE-READ from disk at quit (two-terminal safety),
rolled, and written atomically; an unreadable existing journal is refused, never overwritten.

**Sovereignty wording is load-bearing:** the injected section states verbatim that generated docs
are "CONTEXT, NOT AUTHORITY … the current user request and the observable repository state
outrank it". Crash notes derive from LOG evidence — the newest non-child sibling log whose newest
LIFECYCLE event is not `session.ended` (post-hoc CLI appends after a clean end must not read as a
crash) — never from journal absence. The system prompt is outside elision's `rawChars`, so memory
injection can never trigger or oscillate elision.

## Tasks, roles, and parallel groups (`runtime/subagent.ts`, `runtime/roles.ts`, `tools/delegate.ts`)

The main agent keeps user interaction, authority, coordination, integration, and final claims; a
delegated task is a bounded, attributable unit beneath it.

- **Roles, split by layer.** `types.ts` `SUBAGENT_ROLES` is the POLICY fact table — explorer /
  planner / reviewer are `read-only`, executor is `mutating-worktree`; `decide()` consults only
  this and fails closed on anything else. `runtime/roles.ts` `ROLE_CONTRACTS` is the RUNTIME
  contract per role: tool registry (a subset of TOOLS; never the delegate/update_plan/apply tools
  ⇒ depth 1 and no self-integration, structurally), role prompt builder, harness-fixed budget,
  and approval mode (`auto-deny` | `forward`). A load-time check pins the two tables consistent.
  Budgets: read-only 15 steps / 5 min / 30k out; **reviewer 24 steps / 8 min / 30k out** (its
  brief demands interleaved read→record work, and 15 starved exactly the diligent lenses into
  `budget-steps`, which cannot qualify a round); executor 40 / 20 min / 50k (approval wait counts
  against its wall clock).
- **Named admission seams.** `retrieve` and `report_finding` exist only as per-session instances
  and reach children ONLY through named `SubagentDeps` fields; `childTools()` admits one iff the
  role contract names it AND the instance is structurally free of command/delegates/planDoc facts
  (fail closed by dropping). Deliberately not a generic extra-tools list, so depth-1 stays a
  property of construction. The executor list omits retrieve: the parent index describes the
  parent workspace, not the worktree.
- **Briefs and reports.** TaskSpec carries optional `focus`/`avoid` path-prefix lists; the
  delegate tool composes deterministic per-task brief lines (focus, avoid, missing-path hints —
  `..`-escaping prefixes are never disk-probed — and sibling coverage) rendered into the child's
  first message, and warns the group on pairwise focus overlap. Guidance + measurement, not
  enforcement. Explorer reports have a REQUIRED section contract with a non-blocking harness check
  ("treat those areas as UNEXAMINED"). Child report text and forwarded context are
  delimiter-hardened: a line mimicking a harness fence is visibly neutralized, never hidden.
- **One runtime, parallelism in the TOOL.** A child task = another `Session` driven by the SAME
  `runTurn`, in-process; a task is exactly ONE turn. `delegate_task` takes `tasks: [1..3]`; the
  tasks of one call run concurrently via `Promise.all` (the schema max IS the concurrency cap).
  One call = one parallel group = one evidence unit = ONE approval for a group containing a
  mutating role (the strictest member governs).
- **Policy step-0 (fail closed, batched):** `Tool.delegates(input) → {roles}` is evaluated FIRST,
  inside try/catch (a throwing fact denies); `delegates`+`command`/`planDoc` → deny; empty group →
  deny; any unknown role → the WHOLE group denies; any mutating role → `ask` (class `reversible`,
  deliberately NOT session-grantable, so every executor spawn is a human decision); all read-only
  → allow/`observe`.
- **Inherited-or-narrower authority, structurally:** role registry ⊆ TOOLS, the parent's narrowing
  `rules`, the parent's PROBED-and-shared sandbox instance, fresh empty `Grants` per child,
  AGENT.md injected (generated memory docs deliberately not). Read-only roles get
  `autoDenyApprover`; the executor's asks FORWARD to the parent's approver.
- **Caps (harness-fixed, never model-controlled):** per-role budgets; group ≤ 3; `TASKS_PER_SESSION
  = 16`, group-atomic (a group that does not fully fit is refused whole, spawning nothing); a
  cumulative `SESSION_CHILD_OUTPUT_TOKEN_CAP = 200_000`; `MAX_REVIEW_ROUNDS = 2` (a third reviewer
  group refuses, naming the real exits — triage, or `/accept confirm`); no automatic retries.
  Cause-tracked cancellation maps parent-abort / wall-clock / token-cap / forwarded deny-stop onto
  distinct `TaskStatus` values and child end reasons. Progress lines carry `role·childId` identity
  because group members interleave on one chrome stream.
- **Approval forwarding:** a serialized FIFO queue wrapping the parent SESSION approver — never io
  directly — so non-interactive parents fail closed structurally, REPL EOF cascades deny-stop, and
  `--dangerously-allow-all` keeps its meaning. Every forwarded request carries `taskContext`
  (rendered as a labeled header; for commands the prompt states the worktree cwd AND that approval
  runs it unsandboxed); entries are signal-linked — a task that dies while its ask is QUEUED
  resolves deny without ever displaying; a task that dies while its ask is DISPLAYED unblocks
  immediately and the eventual stale answer is discarded with an honest chrome line. Answering `q`
  ends THAT child only; Ctrl+C still aborts the whole turn.
- **Evidence lineage:** one callId spans a group, so `/tasks`, the report, and `reconstruct` join
  `task.started`↔`task.ended` by `childSessionId`; a crash replay points at ALL surviving child
  logs. Session ids are structurally fresh: `EventLog.open(expectFresh)` creates the log file with
  an atomic exclusive open BEFORE any lock interaction — a collision throws (regenerated) instead
  of reclaiming a live sibling's lock and merging evidence.
- **Boundaries (deliberate):** depth 1; no inter-child messaging (siblings are blind to each
  other; the parent integrates); no task resume.

## Executor isolation and integration

The mutating role never touches the user's workspace. The chain is: base → worktree → capture →
review → apply, every link evidenced.

- **Base = one hidden-ref checkpoint per GROUP**, created sequentially before fan-out, so the
  parent's CURRENT working tree (dirty state included) is the base and every member starts from
  the same attributable oid. Creation appends `task.base-checkpoint` through the callId-bound
  channel; assembly seeds the owed prune list FROM EVENTS, so a SIGKILLed session's leaked refs
  are pruned at the resumed life's clean quit or `/accept`. `deleteCheckpointRefs` counts an
  already-missing ref as deleted, so retries converge.
- **EOL pin.** Before creating the worktree the harness probes whether checkout normalization
  would differ from the parent's on-disk bytes (`core.autocrlf=true` over a uniformly-LF tree).
  If so, BOTH `worktree add` and the capture's `checkout-index` run with
  `-c core.autocrlf=false -c core.eol=lf`, so worktree bytes equal parent bytes. Without it every
  captured file refused at apply as base drift, and a matching base would have written CRLF over
  LF. Deliberately the uniform-LF case only: a mixed tree keeps the refusal, with a diagnosis that
  names EOL normalization (not generic "drift") and names exits that actually work — the
  scheduler refuses re-running a task that holds captured changes.
- **Worktree per task:** `git worktree add --detach` at the base oid, under
  `<os-tmp>/agent-cli-worktrees/<projectSlug>/` — placement DICTATED by `validatePath`, ephemeral
  by design. A version gate refuses git < 2.20 (fail closed); non-repo workspaces refuse honestly;
  an unapproved draft plan blocks executor groups at the tool. The child session is scoped to the
  worktree with FRESH `detectGitFacts` + map. TRUST: children never pass the CLI trust gate — a
  harness-created worktree of a trusted workspace is trusted BY DERIVATION and never written to
  `trust.json`. HONESTY: the worktree materializes WITHOUT gitignored files (stated in the
  executor prompt: unverified means unverified). A FAILED `worktree add` removes the directory and
  prunes the admin entry BEFORE unregistering — dropping the registry entry first made the leak
  unreachable by any sweep.
- **Capture:** at task end — for ANY status; partial work is evidence — `git status --porcelain=v2
  -z` in the worktree (detached HEAD IS the base), workspace-prefix filtered, base bytes
  materialized BINARY-SAFELY via read-tree + `checkout-index --prefix` staging, after + base bytes
  stored as content-addressed blobs, bounded (`MAX_TASK_CHANGE_FILES = 400` /
  `MAX_TASK_CHANGE_FILE_BYTES = 5 MiB`; every omission counted). Rename PAIRS survive the cap
  atomically — keeping a delete whose partner create was dropped would half-apply a move. Recorded
  as callId-bound `task.changes`; the diff OUTLIVES the worktree. Overlapping write-sets between
  group members are warned at capture time.
- **Cleanup is deterministic:** the worktree is ALWAYS removed in `finally` (EBUSY retries → rm
  fallback → `git worktree prune`); failure is honest `worktree.removed {ok:false}` evidence. A
  registry under `projectDir` records every worktree at creation; the assembly-time sweep removes
  crash orphans and is PATH-GUARDED — entries outside this project's worktree home are dropped
  from the registry but never touched on disk.
- **The registry is concurrency-safe:** entries are OWNER-STAMPED (`ownerSessionId` + `pid`); the
  sweep skips live-pid entries with a 2h age hatch. Every mutation runs under an in-process async
  mutex PLUS a token `O_EXCL` lock file — a live same-pid holder is NEVER reclaimed (group members
  share the pid). The lock is held only at registry read/write edges, and the sweep's save is a
  MERGE, so a sibling's concurrent registration always survives.
- **Integration (`apply_task_changes`, parent-only):** `mutates()` declares the concrete
  apply-ELIGIBLE workspace paths from the captured evidence (never null; conflicted files are not
  declared, so they are never snapshotted and never pollute attribution), and the EXISTING
  snapshot-first / `file.mutated` / undo / diff+commit attribution machinery does all the writing.
  Per-file drift-refuse rule: the workspace file must still hold the task's base bytes (or already
  hold the target, or be absent for a create); anything else refuses THAT file. Partial applies
  are reported per-file (`task.applied`), one undoable unit. The registry is rebuilt from
  `task.changes` events on resume, so a crash between capture and apply strands nothing.

## The research pack (`research/`, `tools/web-*.ts`, `tools/record-source.ts`) — Session 19

The one capability that sends anything off this machine. Same pack shape as `artifacts/`: a pure
module with no kernel imports (`tools`/`runtime`/`policy`/`repl`), its own failure vocabulary
(`ResearchError`), and thin tool wrappers above it.

**Egress.** `research/tavily.ts` is the only code here that opens a connection, and it opens exactly
one: `api.tavily.com`. Page retrieval happens on the provider's infrastructure, so the pack owns no
redirect policy, no response size limiter and no SSRF guard — it never fetches a model-named URL
itself. The claim is scoped: *the research tools'* egress is one host, **not** the harness's
(`npm view` is on the auto-run allowlist; the sandbox does not confine network). A configured proxy
still carries the connection, and the approval prompt says so.

**The policy fact** (`Tool.research()`, engine branch 0g). Needed for a sharper version of the S6
trap than the six facts before it: a research call is command-less and mutation-less, so it would
auto-allow as `observe` with the reason "read-only workspace access" — false in the one direction
that matters. Reading is not the consequence; **sending** is. Deny rules: invalid/conflicting
contract, non-empty mutation plan, empty request, an unusable target (any single bad URL denies the
whole call), a config-denylisted domain, and an exhausted bound.

**Consent is the budget.** First call asks (`external`, grantable) with the query verbatim, the
per-call bounds and the remaining allowance in the reason. One `ResearchBudget` object — 24
searches / 12 extracts / 80 credits / 800k chars — is shared by reference between the parent's
instance and every researcher child's, and rebuilt from parent events on resume
(`researchSpendFromEvents`) so a restart cannot refill it. The credit ceiling is checked against the
*estimate* before the wire, so a call that would overshoot is refused whole rather than half-spent,
and charged from the provider's real reported figure (clamped) afterwards. Every bound is
re-enforced at execute: `decide()` is a claim about what will happen, and a sibling can drain the
remainder while a human reads the prompt.

**The `researcher` role** (`read-only-external`) runs on the ordinary `delegate_task` path — no new
orchestration, no second loop. Spawning one asks as `external`, placed **after** the mutating check
so a mixed group is still governed by `task.mutating-role`. Inside the child there is no approver
(read-only roles auto-deny), so admission comes from `ctx.lineage.role`, which `startSession` stamps
from the same value that lands on `session.started` — runtime state, not tool state, not model
input. The rule says *"whose spawn this engine allowed"*, never *"the human approved"*.

**Registry split.** The parent holds `web_search` only. `web_extract` (full page text) and
`record_source` are researcher-only, which is what makes "the main agent never receives raw
webpages" a property of construction. `childTools`' admissibility is an exhaustive
`satisfies Record<FactKind, boolean>` table, so the next policy fact breaks the typecheck rather
than silently passing into a child registry.

**Per-task vs per-session state.** `researchToolsFor(acc)` runs once per task and creates the
task's own page counter and spend counter there; the budget stays shared. The spend must be
per-task because the group fans out under one `Promise.all` — a diff of the shared budget would
give every sibling the whole group's usage. `research.usage` carries that per-task figure into the
**parent** log, because the child's own `research.*` events live in a log the parent's fold never
reads.

**Untrusted content, three mechanisms, honestly ranked.** (1) `sanitizeBlock` at ingestion — like
`sanitizeLine` but preserving newlines, because a page is a block; (2) `neutralizeHarnessDelimiters`,
shared with the memory docs; (3) the UNTRUSTED fence plus the prompt contract, which is a
**mitigation, not a boundary** — a persuasive page can still influence a model. What it cannot do is
act: a researcher holds no tool that writes, runs, or delegates. URLs are identifiers: a value
sanitization would alter is refused, not escaped; loopback/private/link-local/single-label hosts and
bare IP literals are refused (leak prevention and honest early failure, *not* an SSRF guard); IDN
hosts are flagged.

**Findings, not summaries.** `record_source` takes one falsifiable claim, its source URLs and a
corroboration verdict, and refuses `corroborated` backed by a single distinct source. `retrievedAt`
comes from the harness clock. Notes reach the parent as one `research.findings` capture at task end.

**Never verification.** Research events are absent from `WORK_EVENT_TYPES`, never mark a file
CHECKED and never satisfy a plan gate. Acceptance carries two caveats instead: that the web was
consulted at all, and that some findings rest on a single source or on sources that disagreed.

## The remote-delivery pack (`remote/`, `tools/remote-*.ts`) — Session 20

The one capability that changes state on a machine the user does not own. Same pack shape as
`artifacts/` and `research/`: a pure module with no kernel imports beyond the shared type
vocabulary, its own failure vocabulary (`RemoteError`), and thin tool wrappers above it.

**Two facts, not one capability with a mode.** `FACT_KINDS` gains **`remoteRead` AND
`remoteWrite`**, each with its own fail-closed branch ahead of the command branch. That is the
session's thesis made structural rather than documentary: the engine's existing
conflicting-contract rule then makes a tool that could both read and publish an automatic deny, so
"the read tool cannot publish" is a property a reviewer verifies by grepping for a second fact and
finding none. Consent follows the split — a read asks `external` and is session-grantable within a
real counter (the S19 budget-as-consent shape, worded `[s] allow further remote READS this session
(never a push, tag or release)`); a write asks **every time**, is never passed through
`applyGrant`, offers no `[s]` in `formatApprovalPrompt`, and stores nothing at the grant-storage
site in `session.ts`. The same sentence is written in three places on purpose: a consent surface
that disagrees with itself is how standing authority gets won by accident.

**Observation binding.** A mutation must carry the live look at the remote its effect was computed
from; absent, or older than the kernel-owned `REMOTE_OBSERVATION_MAX_AGE_MS`, is a **deny** (the
`browser.no-preview` precedent). Only `remote_status view=refs` produces observations, so
"understand the remote before you change it" is enforced by the engine rather than requested in a
prompt. The bound lives in `src/types.ts`, not in the pack, so a workflow pack cannot widen its own
leash. Observations and the gh identity are **in memory only** and do not survive a resume, while
the read/write spend IS rebuilt from events — authority is not durable, spending is.

**Looking never writes.** The only network verb is `git ls-remote`: no fetch, no remote-tracking
refs, no FETCH_HEAD. The cost is honest — a commit the remote holds and this repository has never
seen is genuinely outside our object database, so the relation is reported `unknown` and a force
push over it is **refused even with `force`**, because the harness cannot say what would be
discarded.

**What the human approved is what executes.** The refspec source is the observed OID, not a branch
name, so a local branch that moves while a human reads the prompt cannot change what is sent.
Execute then re-reads the local rev AND the remote ref, runs `git push --dry-run --porcelain` and
compares its flag column against what the observed relation permits, pushes, and re-reads the
remote to set `verified`. A force push additionally carries
`--force-with-lease=<ref>:<observed-oid>` so the **server** enforces the same binding.
`--force-if-includes` is deliberately absent: it is a no-op without a lease and its real check
reads a remote-tracking reflog this pack never writes.

**gh is managed like git.** `remote/gh.ts` mirrors `git/client.ts`: absolute-path resolution
(`gh.exe` only on Windows, no `.cmd` shims, relative PATH entries skipped), `GH_REPO` scrubbed
because it retargets every command the way `GIT_DIR` does, `GH_DEBUG`/`DEBUG` scrubbed because gh's
debug mode prints the Authorization header, `GH_PROMPT_DISABLED` + no stdin + bounded timeouts.
`GH_HOST`/`GH_CONFIG_DIR` deliberately pass through — an enterprise host or a relocated config is
legitimate — and are RECORDED in `remote.context` so an override is auditable. Remote-bearing git
calls carry `-c credential.interactive=false`, and ssh remotes get `GIT_SSH_COMMAND="ssh -o
BatchMode=yes"`; neither is a guarantee (a non-conforming helper exists), which is why every call
is time-bounded.

**The harness never holds a credential.** Authentication is entirely gh's own stored credential and
git's credential helper. `buildChildEnv` drops every `*token*` name, so a `GH_TOKEN` in the user's
shell is not forwarded and *cannot* be — recorded as a fact (`tokenEnvNotForwarded`) rather than
worked around. `shared/secrets.ts` scrubs credential shapes from all gh/git output at the pack
boundary and again at the event emit site: the installed gh 2.96.0 predates the
GHSA-cg6r-mpgc-h9mm fix in which `gh auth status` printed part of the token, remote URLs embed
credentials in the standard CI form, and git echoes those URLs inside auth failures.

**Everything is harness-composed.** `remote/argv.ts` builds every argv from typed inputs in
`--flag=value` form, so model text lands only in value positions and a value beginning with `-`
cannot become a flag. There is no `gh api` passthrough and no generic escape. `gh release create`
always carries `--verify-tag`: without it gh silently creates the named tag from the default branch
— a publish nobody asked for, at a commit nobody named.

**Stops rather than guesses.** No remote; several remotes with no upstream; a push URL that differs
from the fetch URL; a detached or unresolvable local rev; a non-GitHub host for a gh-backed
operation; gh absent or unauthenticated; a GitHub destination whose publishing account has not been
established by an `auth` read; a relation a normal push cannot satisfy.

**Never a gate, in either direction.** `remote.*` is absent from `WORK_EVENT_TYPES` (accept →
commit → push is the ordinary order, so a publish must not stale the acceptance it delivers), and a
publish is an acceptance **caveat**, never a blocker — including when it failed, and including when
it succeeded but could not be verified. Symmetrically, the local verification state is *shown* in
the publish prompt and is deliberately **not** a precondition: making a green gate a requirement
would make a green gate an authorization, the exact inversion this capability exists to prevent.

**The compound invariant.** The model cannot commit (`/commit` is still user-typed, `GitOps` above)
and a push transmits committed refs only. Together: *the model cannot publish content a human did
not commit.*

## Planning lifecycle (`plan/`, `tools/update-plan.ts`, `/plan`, `@plan`/`@direct`)

One CANONICAL structured plan per session at `<projectDir>/plans/<sessionId>.plan.json` —
`{version, planId, status, updated, plan}` wrapping a schema-validated task graph — with two
deterministic projections: the concise user view (regenerated to `<sessionId>.md`, marked
`<!-- GENERATED VIEW -->`) and the detailed agent view. Never authority. The legacy markdown store
remains readable for resumed old sessions via `readPlanState`, the ONE reader every consumer uses;
`approvedCurrentGraph(state)` is the ONE filter that decides whether a graph may drive the review
requirement — three call sites previously spelled the same triple predicate independently.

- **The plan graph:** tasks carry id (slug, stable across amendments), title, intent, role
  (executor/explorer/reviewer/main), dependsOn, touches (workspace-relative prefixes), verify
  (required for executor/main), checks, risk, serial; the graph carries optional `gates`
  {integration, completion} and `review` {mode, reason}. Semantic validation — unique ids,
  resolvable acyclic deps (the cycle PATH is reported), contained touch prefixes, size cap —
  refuses with the COMPLETE error list; `update_plan` returns it verbatim with nothing written
  (the revision loop is the design). Warnings (non-dep-ordered touch overlap, unrunnable check
  kinds) surface without blocking.
- **Approval binds the CONTENT sha**: `planContentSha = sha256(canonicalJson(plan))` — sorted
  keys, no whitespace, the `plan` sub-object only. Status/timestamp flips are sha-neutral BY
  CONSTRUCTION; whitespace/key-order hand-edits are approval-neutral; any semantic change
  invalidates. Optional fields with NO zod default (checks/gates/review) are dropped by
  `canonicalJson`, so every pre-existing plan keeps its exact sha; an EMPTY list normalizes to
  absent (`[]` and "no gate" are the same gate).
- **Projections carry the project axis.** Both views show each task's `project` and the gates'
  `in EACH of: …` / `in ANY project (unscoped)` clause — the user view had omitted both, so the
  document whose sha the approval binds could not distinguish "tests must pass in both halves"
  from "a green test anywhere ends the session". Projection-only, so sha-neutral.
- **Validation warns at the consent boundary** when a multi-project workspace declares gates or
  task checks with no project (the unscoped reading is the one that produces a false green), and
  compares project ids NORMALIZED — a correct `./api` had been scolded for naming a project that
  does not exist, which pushes a model toward dropping scoping altogether. It also warns when
  gate kind `browser` rides multi-project `gates.projects` (S16.5b): EACH-of semantics demand a
  browser_flow bound to EACH named project's OWN preview — including non-UI projects — and the
  only exits after approval are an api-bound flow or a gates amendment that resets approval.
  And `update_plan` names the COMPLETED tasks an amendment RE-OPENS (definition identity: prose
  participates in the sha; a full-graph resubmit rewriting a done task's title silently
  re-queues it, and the model used to learn that only from `/accept` refusals).
- **The amendment contract:** a model write keeps `approved` only for a semantic no-op; otherwise
  → `draft`, including over `superseded`. An amendment therefore blocks every executor spawn, and
  because only the USER can clear that, the REPL prints one undimmed end-of-turn line naming the
  blocked tasks and the command — but only when an approval EXISTED and no longer covers the plan
  (a never-approved draft is the ordinary post-planning state, and a warning that fires in the
  ordinary case stops being read). `update_plan` tells the model to stop and ask rather than
  absorb the delegated work. `/plan approve` REFUSES a file that does not parse and
  validate (no consent to garbage bytes); an unparseable hand-edit reads as status `unknown` with
  `contentSha` null → gated. `plan.approved {sha256}` is the consent record; `approvedAndCurrent`
  is THE executor precondition — divergence BLOCKS.
- **Routing** (`plan.route`, additive): model-judged per prompt rules, forced by `@plan` /
  `@direct` sigils (recorded `source: 'user-sigil'`). Absence of plan events is the honest
  evidence of a direct turn. No harness classifier — the hard floor stays structural (executor
  gates), not linguistic.
- **Injection:** the standing per-turn note carries the AGENT view when the content sha is new to
  the model, a pointer otherwise — and the pointer ALWAYS carries the live execution summary (task
  states change without changing the content sha). 12 KiB cap; verbatim sovereignty wording;
  unreadable plans inject an honest header. The note is composed into a `[[harness note: …]]`
  wrapper whose `]]` sequence is broken in the note text, so plan strings cannot close the wrapper
  and forge user-attributed words.

## The task DAG and the scheduler gate

Execution state is a PURE FOLD over (approved graph, events) — no new store. Per-task states:
queued / blocked / running / awaiting-approval (live-only) / integrating (captured, not fully
applied) / completed (ended-completed AND the applied union covers every applicable captured file;
a completed EXECUTOR with NO capture event folds to `failed` — capture loss must stay re-runnable)
/ failed / cancelled / parent-owned (role `main`: auto-satisfies dependents with a surfaced
warning — asserted, unverifiable) / interrupted (started, never ended, not live — crash evidence).

**Definition identity: `completed` belongs to the definition that RAN, not the id.** Every bound
spawn records `task.started.planTaskSha` (sha256 of the task's canonical form, `dependsOn` sorted
— reorder-neutral), and the fold re-opens a completed task whose current definition no longer
matches the completing binding (dependents re-block — the conservative direction). Legacy sha-less
bindings keep the id-sticky reading; an `integrating` task integrates its captured old-definition
work before the reopen can apply. `PlanTaskState` carries the full `attemptHistory`,
`attemptsForCurrentDefinition`, and `definitionSha`.

`delegate_task` gains `plan_task` (recorded as `task.started.planTaskId` — the DAG join key). The
gate runs BEFORE the base checkpoint, group-atomic (a refusal spawns nothing):

- **Status gate (strict):** while any plan document exists, executor groups require
  `approvedAndCurrent` — draft/unknown, superseded, DIVERGED, and approved-without-recorded-consent
  all refuse; a plan APPROVED this session whose document vanished also refuses. No plan at all
  does not block: the per-spawn human ask stays the consent floor. A throwing planContext fails
  closed.
- **DAG rules** (active iff an approved-and-current graph exists): R1 unbound executors refuse
  (ready ids + escape hatches named); R2 unknown id; R3 role mismatch; then group composition
  BEFORE per-task state (so "sequence them across calls" is never shadowed): R6 duplicate binding,
  R9 intra-group dependency, R8 serial/high-risk must run alone, R7 overlapping declared touches
  between executors; then per-task state: R5 completed re-runs refuse (failed/cancelled/interrupted
  stay re-spawnable), integrating refuses until applied, **R10** refuses a task with
  `MAX_TASK_ATTEMPTS = 3` genuine failure outcomes under its CURRENT definition (crash-interrupted
  and user-terminated attempts never count; a definition change resets the ceiling), then R4 unmet
  deps refuse naming the dep's state. **R11/R12** add the recovery gates (below).
- **Plan-informed briefs:** bound tasks inherit plan `touches` as the focus brief when focus is
  absent, plus plan-task identity and verification-criteria lines; group notes carry the live
  execution summary and parent-owned-dep warnings.
- **DelegateCaps** (tasks, child-output tokens, review rounds) are an injected object REBUILT FROM
  EVENTS at assembly — a resumed session keeps counting.
- **Waves are parent-serialized by construction:** one delegate call = one parallel group (≤3);
  the parent integrates between calls, so the next group's base checkpoint includes applied
  dependencies. The scheduler is the gate + the fold + guidance notes, deliberately NOT an in-tool
  wave engine.

## Supervision and task-scoped cancellation

Harness-side in-flight detection on the child onAppend chain + a scaled ticker (production: 60s
stall, 30s cadence; thresholds scale down with narrowed test budgets): loop detection over
identical consecutive (tool, input) calls — annotate at 3, auto-cancel at 5 (status `stalled`);
ONE budget-pressure observation at ≥80% of output tokens or wall clock; ONE stall observation. All
observations are bounded (≤6/task), never-throwing, and dual-surfaced: persisted `task.supervision`
events AND notes rendered into the delegate result's **group digest** — placed at the HEAD so
head-biased truncation can never hide a failed status, an intervention, or declared-vs-actual
touch divergence behind a long child report. The parent stays blocked on the group await
mid-flight.

Task-scoped cancellation is the `registerCancel` seam: once the child exists, the runner registers
ONE narrow idempotent handle (cause `user-cancelled` → status `cancelled` — THIS child only, the
group and turn continue), unregistered in finally. The REPL's task table owns the registry; a
forwarded ask queued for a cancelled child resolves `task-aborted` without display.

## The verification gate

A plan task declares the typed checks that gate it, and **dependents unblock only when that gate
is green**. The mechanism is one predicate, not a new state.

- **Validation:** `checks` on a `role: 'main'` task is an ERROR (a per-task gate is anchored on
  that task's own integration evidence, which parent-owned work never produces). A kind this
  project cannot run is a WARNING fed back through `update_plan`'s revision loop, so an
  unsatisfiable gate is caught at the consent boundary.
- **`PlanTaskState.verification`** is a FIELD on a `completed` task, deliberately not a state name.
  A separate "unverified" state would have taken a fully-integrated task out of R5's
  duplicated-mutation refusal while R10's ceiling could not bound the resulting re-runs.
- **`depSatisfied` = `(completed && verification.status !== 'pending') || parent-owned`.** That
  single change propagates to queued/blocked resolution, R4's refusal, and acceptance. A task with
  no declared checks has status `none` and behaves exactly as before — simple tasks stay cheap.
- **What a green gate PROVES, exactly:** the declared kinds passed on the workspace at a point
  AFTER this task's own work was integrated. The anchor is the max over ALL of the task's bindings
  (capture happens for failed children too, and an earlier attempt's files can be applied later).
  Satisfaction is harness-derived from event seq, not attested by the model's `plan_task` label.
  For `test-targeted` the SCOPE is the check: the run's recorded `scopePaths` must overlap the
  task's `touches`.
- **Waivers, honestly:** an `unsupported` result waives the kind — but ONLY when the reason is a
  capability one. Neither a `bad-request` nor a `precondition-curable` may (the latter
  means the project simply has not been installed yet, and `project_setup install` is the named
  cure — waiving it let a session that installed half a stack be accepted as COMPLETE claiming the
  other half *cannot* be tested). `toolchain-unavailable` (S18) waives DELIBERATELY — a machine
  without the compiler is the browser-unavailable case one toolchain over — but the folds track
  it apart and its caveat names the missing toolchain and points at the recorded cure, so "the
  machine lacks cargo" can never read as "this project cannot be tested". A waiver is recorded
  as a caveat in the fold note, both plan
  views, `/tasks`, and `AcceptanceState.caveats`, so a recorded "complete" can never quietly mean
  "the declared check never ran".
- **A boundary gate keeps its per-scope detail.** With `gates.projects`, a kind is satisfied only
  when it passed (or was honestly waived) in EVERY named project, and `byKind` records which
  projects passed, waived and are missing — so a blocker names the project that is missing and the
  guidance names it too. Collapsed to a bare kind, `/accept` suggested a `run_check` that a
  multi-project workspace refuses as ambiguous: a repair loop that could not converge.
- **Boundaries:** `integrationGateState` refuses a NEW executor wave while `gates.integration` is
  unsatisfied since the last apply (R12). `completionGateState` blocks `/accept` until
  `gates.completion` passed after the LAST change — and "change" includes `undo.applied` and
  `git.restore`, because `applyUndo` writes files back to disk while recording only its own event.
  The asymmetry is deliberate: a per-task gate is NOT invalidated by unrelated later changes; the
  completion gate covers the combined state.

## Typed recovery (`recovery/`, `tools/recover.ts`)

Recovery is a POLICY, not "try again": **classification happens before any repair is planned**, and
every automatic repair needs a supported class, sufficient evidence, a recovery point, a materially
different hypothesis, and budget it has not spent.

- **Eleven classes**: dependency-setup, compile-type, test-assertion, lint-format, runtime-process,
  integration-conflict, policy-approval, timeout-resource, preview-startup, browser-verification,
  and **unknown** — a real answer with real consequences (stop and escalate), never a shrug.
- **`catalogue.ts` is DATA**, one entry per class: likely signals, required evidence, diagnostics,
  eligible actions, regression checks, auto-eligibility, what always needs the user, and stop
  conditions. It is rendered into failing `run_check` results and gate refusals, so guidance
  arrives where it is needed instead of living in prompt prose.
- **`classify.ts`** is deterministic and derivable FROM EVENTS ALONE. Ordering is load-bearing:
  non-verdict terminations win FIRST (`timeout`, then `aborted` — a user interruption produced no
  verdict and must not become a repairable defect; below the per-kind branches that test was
  unreachable), then a missing toolchain outranks every downstream diagnostic. Browser evidence
  routes ONLY by its own disjoint signal namespace. A delegated task that merely ended `error`
  stays **unknown** and points at the child log — "a task failed" is not a diagnosis.
- **`ledger.ts` derives outcomes; it never records them.** There is no `repair.ended` to lose in a
  crash: an attempt is `succeeded` only when every regression check it declared actually passed
  after it, `superseded` by a newer attempt for the same signature, else `open`. The repair proof
  must include the kind that actually failed — and for scope-bearing kinds the passing run's
  `scopePaths` must cover the attempt's, or a green check over unrelated paths could "prove" it.
  Scope expansion is measured from `file.mutated` plus this target's own applies.
- **`policy.ts` bounds it:** unknown classification, a class needing a human decision, spent
  attempts, in-session wall time (idle gaps excluded), session and token budgets, an expanded diff,
  and a repeated identical hypothesis each STOP with a typed reason. What is enforced vs. merely
  detected vs. not verified at all is stated in the module: scope is MEASURED, not prevented.
- **`recover`** (parent-only, actions `attempt` / `escalate`) writes only events, so it classifies
  as `observe` and confers no authority. It creates no checkpoint because the recovery POINT
  already exists in both paths: parent edits are snapshot-backed by construction, and an executor
  re-run creates a fresh group base checkpoint.
- **R11 at the scheduler gate:** once a mutating task has failed under its current definition,
  re-spawning it is a repair and needs a plan for THAT failure. One free re-spawn stands for stop
  reasons no model effort can clear, so a transient blip does not cost a plan amendment plus a
  human re-approval; R10's ceiling still bounds it.
- **Acceptance:** an open escalation or an unproven repair is honest unfinished work. An escalation
  resolves BY EVIDENCE when its plan task completes with a satisfied gate. A `session`-targeted
  escalation clears only via a proven attempt; `/accept confirm` remains the user's override.

## Harness checkpoint lineage

Recovery points at the workflow transitions the coding flow actually has, all as hidden refs under
`refs/agent-cli/checkpoints/` — never the user's branch history, never a commit as a side effect
of running Agent CLI.

- **Event BEFORE ref (`opts.onRefReady`)**: `createCheckpoint` invokes the seam between
  `commit-tree` and `update-ref`, and every harness call site appends its creation event there
  (`EventLog.append` is synchronous). A crash between the two leaves an OWED ref that does not
  exist, and `deleteCheckpointRefs` counts a missing ref as deleted — so the creation-instant leak
  is structurally closed. The inverse is handled honestly: an `update-ref` that FAILS after the
  append leaves a **phantom** creation, so every reader treats `agent checkpoint list` as live
  truth, the owed fold is latest-creation-per-ref-wins, and a throwing callback aborts as
  `ok:false` BEFORE the ref exists. The user-commanded CLI/REPL checkpoint path is deliberately NOT
  reordered: its ref-scan-based backstop converges without event coupling.
- **Three kinds, one lifecycle rule** (`HarnessRefKind`): `task-base` (per executor group) and
  `pre-integration` are session-scoped recovery points pruned at clean end; `delivery` survives as
  the durable audit anchor. `harness.checkpoint` is a NEW event type on purpose — widening
  `task.base-checkpoint` would make an old reader's owed fold prune the delivery anchor.
- **`owedHarnessRefsFromEvents`** is seq- and kind-aware, re-folded from LIVE events at prune time.
  Delivery survival keys on the ref the latest acceptance actually CONSUMED
  (`session.accepted.deliveryRef`) — NOT on the newest creation event, which a phantom could hold;
  an acceptance that captured no ref leaves the previous anchor alone rather than destroying one it
  cannot replace.
- **Pre-integration** fires only under the **covered-change rule**: an un-snapshot-covered writer
  must have SPAWNED since the last harness checkpoint (`command.started` / `check.started` /
  `preview.started`). `file.mutated`/`undo.applied`/`git.restore` are deliberately excluded: they
  are snapshot-backed by construction, and counting them made every apply after the first pay a
  whole-tree capture. Decline or failure SKIPS with a recorded note and NEVER refuses the apply.
- **Delivery** (`/accept`, COMPLETE path, git repo only) is captured before the consent event and
  referenced by it. Idempotent across the crash window: a recorded-but-unconsumed checkpoint is
  REUSED only when nothing work-shaped happened since AND the ref genuinely exists.
  `harness.checkpoint` is pinned OUT of `WORK_EVENT_TYPES` — the accept's own cleanup must never
  stale the accept. Failure caveats and the acceptance still records: consent is never hostage to
  git. The boundary prints one `/commit` suggestion — commits stay user-typed. `agent checkpoint
  prune` (the documented backstop) KEEPS delivery anchors unless `--include-delivery`.

## The structural review gate (`review/ledger.ts`, `report_finding`, `review`)

**The reviewers record TYPED findings, the harness derives what the records are worth, and the
parent's judgment annotates but never erases.**

- **`MAX_REVIEW_ROUNDS` (2) lives in the FOLD's module** (delegate re-exports it), because the
  fold's blocker text must adapt once the cap is spent: with no qualifying round left to buy,
  "run ONE bounded reviewer group" prescribed a call delegate REFUSES — the S16.5 refusable-cure
  class. The cap-spent blocker hands the exits to the USER (amend the plan to waive review and
  re-approve, or `/accept confirm`), and delegate's refusal names the same exits (S16.5b).
- **Findings are typed at the SOURCE.** `report_finding` is the reviewer child's only findings
  channel: a PER-TASK accumulator+instance the delegate constructs inside the fan-out (parallel
  lenses can never interleave), admitted through the named `childTools` seam. Bounded: 8 findings,
  600-char prose fields, paths validated with the plan-touches containment rule. Model-authored
  strings are neutralized AT INGESTION, because they are later rendered into harness-attributed
  lines; a PATH that sanitization would alter is refused outright rather than escaped (an altered
  path names no real file).
- **Capture is unconditional** for any reviewer child that existed: `review.findings` with an empty
  list is a recorded CLEAN lens; a completed reviewer with no capture means the round's evidence
  was lost. The group digest carries per-lens severity counts.
- **`foldReview` is pure** over (approved-and-current graph, events) with three rules: the
  REQUIREMENT is derived (≥1 executor task ⇒ required; the plan's `review` field waives it visibly
  with a user-approved reason, or forces it) and never stored; a round QUALIFIES only against real
  work — no effective `task.applied` may land INSIDE the round's window (reviewers that observed
  mid-apply state reviewed neither before nor after), and at least one unit of real work must
  precede it (a workspace change OR an executor capture, so a legitimate zero-net-change session is
  not locked out); and findings NEVER expire (a weak round 2 cannot launder round 1's criticals).
  Post-round fixes do NOT de-qualify the round — they surface as a caveat, because punishing the
  harness-recommended fix path made the loop never end.
- **Triage annotates; the fold derives its worth.** `verify` keeps blocking (confirmed real and
  unfixed is the strongest reason to block); `refute` clears but is recorded verbatim, labeled an
  UNVERIFIED MODEL CLAIM everywhere AND surfaced as an acceptance caveat (it is the cheapest path
  past the gate and the only one whose evidence is a bare claim); `accept` is medium/low only;
  `address` requires refs that both EXIST in the log and POSTDATE the finding. Every rule is
  enforced twice: refused at the call so the log stays clean, and re-derived in the fold so a
  hand-forged event cannot launder a blocker on replay.
- **Acceptance axis**: the fold's blockers join `unfinished` (a missing/stale round when required;
  every open critical/high ALWAYS — a waiver waives the round requirement, never what a
  voluntarily-run round found), its caveats join `caveats`. `/accept confirm` remains the user's
  sovereign override. Both tools are observe-class (events only) and confer no authority.
- **Scope boundary (deliberate):** the requirement is PLAN-scoped, so executor work delegated with
  no plan derives none; recorded findings still block regardless.

## The acceptance boundary (`runtime/acceptance.ts`, `/accept`)

A session's completion is an EXPLICIT, recorded boundary — never a side effect of quitting.
`computeAcceptance` is a pure fold over (plan state, graph fold, events): COMPLETE = the plan is
fully executed (every task completed/parent-owned; a DRAFT plan is deliberately NOT silently
complete) AND every applicable capture is applied, registry-wide including plan-unbound executor
work. Three further axes: a completed task whose declared check gate is still pending is
UNFINISHED; a declared `gates.completion` kind that has not passed since the last change is
UNFINISHED; an open escalation or unproven repair is UNFINISHED. It also carries non-blocking
**caveats** — above all gates WAIVED because the project cannot run them, each naming the project
it means ("NEVER RAN in web; it passed in api"), because a bare "NEVER RAN" was false whenever a
kind passed in one half of a stack and was unsupported in the other. One derivation feeds
`/accept`, `/status`, the quit summary, the report, and the journal handoff.

**Reviewer dead-end carve-outs (e933677 + S16.5b), both LOUD caveats and both fired live:** a
reviewer plan task NEVER BOUND via `plan_task` (queued/blocked, zero attempts) while the review
requirement is independently satisfied by recorded rounds is a dead end, not outstanding work —
once `MAX_REVIEW_ROUNDS` is spent there is no call left that could bind it. Same for the
BOUND-but-dead variant one event later: a reviewer child that ended failed/cancelled/interrupted
with the requirement satisfied AND the cap spent. While rounds REMAIN, a re-spawn with
`plan_task` is a real cure and both states still block.

- **`/accept`** (user-typed = consent; between-turns only, piped-deterministic): on COMPLETE,
  appends `session.accepted {complete, summary, deliveryRef?, deliveryOid?}` and runs bounded
  cleanup — prune this session's owed harness refs now, and retire a fully-executed
  approved-and-current plan through the EXISTING discard flow (`superseded` + `plan.discarded
  {reason:'accepted'}`; the file stays on disk as audit; zero new crash windows). With unfinished
  work it refuses with the honest list; the STATELESS `/accept confirm` records a partial
  acceptance and retires nothing. A prune failure is REPORTED, never swallowed.
- **Idempotence + crash repair:** re-accepting with no work since the last acceptance is a no-op —
  and that branch finishes an INTERRUPTED acceptance cleanup.
- **Staleness is honest:** work-shaped events after an acceptance mark it stale, and `/status`, the
  quit summary, and the journal handoff say "work has happened since" while the unfinished list and
  resume pointer always follow the LIVE derivation.
- Cleanup never erases rollback/audit/resume material: snapshots, captured-change blobs, spill
  blobs, plan files, and session logs all remain.

## The REPL (`repl/`)

A consumer of the same runtime: one session, `runTurn` per user line. `io.ts` owns the ONE
persistent readline — idle prompt and approval questions share it; echo is muted during turns
(Ctrl+C still arrives); typed-ahead lines are buffered; EOF at a pending approval resolves null →
deny-&-stop. `render.ts` subscribes to `EventLog.onAppend`, so the screen is a live view of the
persisted evidence. Three render-only incremental channels exist alongside it: `onText` (model
deltas), the live command-output preview (sanitized dim lines, 100ms cadence, 8 KiB/command cap,
stateful per-stream UTF-8 decode), and the structured child-status channel; for all three the
persisted truth remains the events. Stream split: **stdout = model text + requested artifacts
only; stderr = all chrome** (piped transcripts stay clean; non-TTY chrome uses ASCII glyphs).
Slash commands operate on the session's own live log (`/undo` → `applyUndo` on the same open log;
the model learns of it via a delimited `[[harness note: …]]` in the next `user.message`). Turn
errors repair and re-prompt; `/quit`, EOF, and double-Ctrl+C end as `user-quit` — never
`completed`.

Commands: `/help /status /undo /diff /commit /checkpoint /plan /tasks /cancel /accept /review
/checks /preview /report /map /quit`. `/checks` re-probes the detected project on demand and shows
the latest EVIDENCE per kind — a check that spawned and never completed reads as "NO VERDICT",
not as the older passing run. `/diff` carries the report's CHECKED verdict per file through the
same correlation the report uses (one implementation, so CHECKED cannot mean two things).

**The "working" heartbeat (`repl/heartbeat.ts`, S16.5b).** An always-thinking model (kimi-k3)
streams nothing while it reasons, so the screen looked frozen for minutes between tool steps.
One dim TTY-only status line — `· model working (Ns)` — driven by the render-only
`Session.onModelRequest` seam (`true` before every provider call, `false` in a finally: success,
error and abort alike; never an event). Drawn only while a request is in flight with NO text
streamed (a 2s grace stops fast responses from flashing it), erased SYNCHRONOUSLY by the
wrapped `onText` before the first stdout byte of a step — which is what preserves the status
area's no-interleaving invariant — zero bytes off-TTY, timer unref'd. The line is PLAIN text by
contract: the status area sanitizes (and ESCAPES) its content, so styling smuggled in through
content renders as visible `\u{1b}` text — the first recorded run proved it on camera.

**The live task surface.** `status.ts` is the sticky status area — the ONLY cursor-moving code,
strictly TTY- and stderr-confined: ALL chrome routes through its status-aware writer (erase →
write → redraw at line boundaries), approval prompts suspend it, every turn's finally clears it,
content is sanitized + clipped per redraw, and `!isTTY` is a pure pass-through emitting ZERO
escape bytes (piped transcripts stay byte-identical). Its safety rests on one structural fact: the
area is populated only during delegate flight, when the parent is blocked on the tool call — so
stderr cursor movement can never interleave with stdout model text. `live-tasks.ts` is the
render-only table behind it. Mid-turn, on a TTY only, `io.ts` offers typed `/`-lines to a handler
while NO read is pending (a displayed approval always wins; piped input keeps queue semantics
verbatim — scripted drivers depend on it): `/tasks` prints the live table, `/cancel` fires the
task-scoped cancel registry.

## Policy model (`policy/`)

Two independent ideas, honestly separated: **path validation** and **action classification**.

`validatePath` (Windows-first) hard-rejects NUL, `\\?\`/`\\.\` device prefixes, UNC, reserved
device names, NTFS ADS, and trailing dot/space; resolves via `realpathSync.native` of the deepest
existing ancestor + tail; and containment-checks against `realpath(workspace) + separator` so a
sibling prefix (`C:\ws` vs `C:\ws-evil`) cannot escape. It returns `{ resolved, inWorkspace,
protectedPath }`; the engine decides.

`decide(tool, input, ctx, grants)` — deny-first, first match wins:

- **Delegation** (`tool.delegates`) → the explicit STEP-0 branch. First on purpose: a delegating
  tool must never reach the command auto-run path or the observe fall-through.
- **Plan-document write** (`tool.planDoc`) → allow/`reversible` (the store archives prior bytes;
  the write cannot touch workspace files); planDoc+command → deny.
- **Typed check** (`tool.check`) → after planDoc and BEFORE the command branch: a check SPAWNS a
  process, so reaching the observe fall-through would be a trap with real execution behind it. All
  fact combinations refuse; a throwing fact denies. Verdict `reversible` + `noUndo` +
  `execBoundary: 'unsandboxed'`, and `ask` unless every resolved command already carries replay
  consent. The fact must be PURE — the tool resolves from a captured project snapshot, never the
  filesystem. KNOWN EXCEPTION, stated rather than papered over (S16.5b): run_check's bound
  `test-targeted` scope resolves via a planTouches lookup that reads the PLAN DOCUMENT at decide,
  and the plan file is outside the workspace drift stamps — the exposure window is exactly an
  open approval prompt (calls are otherwise serialized); the mechanism fix is in the deferred
  pool. Kind `'preview'` splits to distinct rule ids and persistent-process reasons.
- **Browser flow** (`tool.browser`) → previewBound allows; anything else DENIES.
- **Session-evidence read** (`tool.evidenceRead`) → allow only when the fact says the sha is
  `admitted`; an un-admitted sha DENIES.
- **Shell command** (`tool.command`) → **automatic review** (the single default). A declared
  `cwd` is validated with the same containment rule as a write target and REFUSED for protected
  paths: `.git` and the state dir are protected as PLACES, not only as write destinations. A hardcoded
  circuit-breaker denies workspace/drive wipes and `format`. Otherwise `analyzeCommand` decides: a
  command it PROVES safe **and** an active OS boundary together yield `allow` with `execBoundary:
  'sandbox'`; anything else is `ask` with `execBoundary: 'unsandboxed'`. With no enforced sandbox a
  provably-safe command still asks — auto-run is disabled (**fail closed**).
- **Declared write** → validate each target; out-of-workspace or protected (`.git`, the state dir,
  any `.agent-cli` segment, config `protectedPaths`) → `deny`; else `reversible` / `allow` with
  `requiresSnapshot`.
- **Reads** → out-of-workspace → `sensitive` / `ask`; secret-named → `sensitive` / `ask` + redaction.
  Secret classification runs on BOTH the raw request and the RESOLVED path, so a symlink or a
  Windows 8.3 alias of `.env` cannot evade it.

**`analyzeCommand`** is a POSITIVE proof of safety, deterministic over the command string alone
(the model's opinion is never consulted). `autoAllowable` requires all of: (1) a single simple
command with NO shell metacharacters/encoding/control chars — chaining, redirection, substitution,
expansion sigils, quotes, and the `--%` stop-parse token all disqualify; (2) an executable on a
small curated read-only allowlist (basename, extensions stripped, NFKC-normalized, casefolded);
(3) per-executable arg checks with no argument that escapes the workspace. Everything else returns
false → `ask`. Obfuscation defeats any string reviewer, so safety is *proven*, not pattern-matched
— and the reviewer is a prompt-skip gate, never the boundary (the sandbox is).

`Grants` are in-memory, session-scoped, keyed `(tool, class)`, and store only grantable classes
(`sensitive`/`external`) — never `destructive`, never `reversible` (an executor spawn must ask
every time), and NEVER any command-bearing tool: a command's classification is a best-effort label
over untrusted model text, so a session grant keyed on it would be standing shell permission won by
a label. Grants are not persisted or restored on resume. The approval prompt hides `[s]` whenever
no grant would actually be stored, and sanitizes every line it prints — summary, detail, AND the
reason (which embeds untrusted model text for command asks).

## Sandbox and enforced isolation (`sandbox/`)

Sandbox (what a process *can technically do*) is a separate axis from approval (when the agent must
ask). A `SandboxBackend` is selected once per session, PROBED, and reported truthfully; the runtime
never assumes enforcement from the platform name.

- **`windows-lowil`** is a genuinely OS-enforced boundary. `wrapSpec` is a *transform at spawn
  time*: it rewrites the spec so `runManaged` spawns a versioned PowerShell + inline-C#
  (`Add-Type` P/Invoke) **host** instead of the shell. The host duplicates the caller's own token,
  lowers it to **Low integrity** (`SetTokenInformation` with the `S-1-16-4096` label — no admin
  needed for a lowered copy of your own token), creates a **Job Object** (`KILL_ON_JOB_CLOSE` +
  active-process cap + UI restrictions), and `CreateProcessAsUser`-launches the real command
  **forwarding its inherited std handles**, so output capture and the kill/drain state machine are
  unchanged. The child's `TEMP`/`TMP` point at a Low-labeled scratch dir under the state root.
- **What it enforces** (verified against the live OS): Mandatory Integrity Control **denies the
  child's writes** to Medium+ objects — the workspace, the user profile, system dirs, and the
  **harness state dir** — at the kernel; and the Job Object's kill-on-close **reaps the whole tree
  on kill**, including a detached grandchild `taskkill /T` cannot reach. **What it does NOT
  enforce** (stated verbatim in `EnforcementFacts.doesNotConfine`): reads (a sandboxed command can
  still read secrets), network, writes to Low-labeled locations, and service-reparented work
  (schtasks/sc/wmic/BITS).
- **Probe + fail-closed.** `ensureAvailable()` runs a self-test that spawns a Low-IL child and
  confirms *both* Low integrity *and* an actual write-deny; only then is `enforced: true`. The
  probe allows 60 s and one bounded retry (measured ~4–11 s normally): a retry can recover a
  transient false negative but every path to `enforced: true` still requires the positive marker.
  On any non-Windows platform, or on probe failure, the backend degrades to `none` semantics and
  the engine disables auto-run. The host itself never falls back to unsandboxed.
- **Boundary selection per call.** `PolicyDecision.execBoundary` drives which wrap the runtime
  hands the tool: an ACTIVE `ExecSandbox` for an auto-run command, identity for an approved one.
  `run_command` applies `ctx.sandbox.wrap` unconditionally and records the actual boundary in
  `command.started.sandbox`.

## GitOps (`git/`) — a harness capability, never a model tool

Git serves review, delivery, recovery, and context — it does not replace the snapshot system, and
the model cannot reach it. **Why it must not be a tool:** `decide()` classifies a tool with no
`command()`, a null `mutates()`, and no reads as `observe`/auto-allow — a "git_commit" tool of
that shape would commit with NO approval (pinned by a policy regression test + a TOOLS registry
guard). The model keeps `run_command`: read-only git auto-runs inside the sandbox, mutations ask,
and work-discarding forms (`restore`, `checkout --`, `reset --hard`, `clean`, `stash drop|clear`,
`push --force*`) are labeled destructive.

**Consent contract** (explicit): user-typed commands ARE the consent, under three conditions —
(a) every mutating flow previews and interactively confirms (non-interactive requires `--yes`);
(b) every operation appends a provenance event (`git.commit` / `git.checkpoint` / `git.restore`);
(c) `GitClient` is structurally unreachable from the model.

**Hardening on every invocation**: git resolved to an ABSOLUTE path by scanning PATH directly — a
bare name resolves against the child cwd on Windows, so a `git.exe` planted in a workspace must
never execute (relative PATH entries skipped; `.cmd`/`.bat` shims rejected); `-c
core.fsmonitor=false` (a repo's own config must not start a daemon — the malicious-repo RCE
vector); `GIT_OPTIONAL_LOCKS=0`; `GIT_TERMINAL_PROMPT=0` and no stdin; repo-targeting `GIT_*` env
scrubbed; bounded timeouts. Parsed output is always `-z`/porcelain-v2.

**Deliberate commits**: default scope stages ONLY session-attributed paths (`sessionMutationState`
over `file.mutated`, undo folded in, intersected with git status so every pathspec provably exists
in git's view). Blockers where attribution would corrupt (missing identity — never set for the
user; pre-staged index in session scope); warnings for externally-modified session files and
unattributable `run_command` effects. Ordinary `add` + `commit -F`: hooks run, failures are honest.
Message carries a `Session:` line + `Co-authored-by: Agent CLI <agent-cli@localhost>` (disableable).

**Checkpoints**: plumbing against a temp `GIT_INDEX_FILE` under the state dir →
`refs/agent-cli/checkpoints/<session>/<n>`; the user-visible git state is byte-identical
before/after (tested), unborn repos use the empty tree, gitignored files are never swept, a large
untracked set requires confirmation — and when that guard cannot run (`ls-files` failed) the
checkpoint proceeds with an honest recorded note rather than silently skipping the guard. Honesty:
**low-pollution, not zero** — loose objects + hidden refs are written; `prune` frees them.
**Restore**: affected set from diff-tree filtered to the workspace prefix, including deleting files
the checkpoint predates; content materializes binary-safely via a second temp index +
`checkout-index --prefix` staging; all current bytes snapshot FIRST under one synthetic callId, so
the whole restore is a single `applyUndo('last')` unit. `git restore`/`git checkout` are never run
against the user's worktree. Everything is repoRoot-scoped with no globals.

## Event log (`store/event-log.ts`)

One JSON object per line at `<state>/projects/<slug>/sessions/<id>.jsonl`, written synchronously.
`EventLog.open` acquires an atomic exclusive lock (`{pid, startedAt, token}` — refuses a live
foreign holder, reclaims a stale one; a present-but-unparseable lock is re-read before any steal,
because the exclusive create is visible before the JSON bytes land, and a still-unreadable FRESH
lock refuses rather than stealing from a live sibling), repairs a partial trailing line **before**
the first append, refuses mid-file corruption (`CorruptLogError`) and newer schema versions
(`SchemaVersionError`), and exposes the committed events. `events` is **live** — appends through
the instance appear immediately (the in-session `/undo`, `/report`, `/status` depend on this) — and
observable via `onAppend`, fired after the synchronous write with observer throws swallowed.
`readLenient` is a lock-free, never-throwing reader for the report and session listing. Bounded
static readers `readFirstEvent` / `readLastEvent` / `readLastEventOfTypes` support the child-log
skip and the lifecycle (clean-end) question without full parses.

Event schema stays **v1**; every extension has been ADDITIVE (new event types or optional fields —
lenient-reader-safe; bumping `v` would lock old binaries out of new logs). The accumulated surface
(full shapes in `src/types.ts`):

| Area | Events / additive fields |
| --- | --- |
| session/turn | `session.started` (+`lineage`), `session.resumed`, `session.ended` (+`reason`), `turn.aborted {phase}`, `user.message`, `assistant.message` (+cache usage, +`reasoning[]` opaque blocks, +`usage.reasoningTokens`) |
| consent/config | `trust.verified {source}`, `config.loaded {sources}`, `policy.decision`, `approval.resolved` (+`source: 'task-aborted'`) |
| provider | `provider.changed {from, to, source: 'user-command'\|'resume', keyEnv?, baseUrlHost?, verification}` — env var NAMES and hosts only, never credentials; readers fold newest-wins |
| tools/files | `tool.requested`, `tool.completed` (+`fullOutputSaved`, `images`), `snapshot.created`, `snapshot.failed`, `file.mutated` (+`linesAdded/Removed`, `postStateUnverified/postStateError`), `undo.applied` |
| execution | `command.started` (+`sandbox`), `command.ended` (typed termination), `sandbox.status` |
| git | `git.context`, `git.commit`, `git.checkpoint`, `git.restore`, `git.checkpoint.pruned {kind}`, `harness.checkpoint {kind, ref, oid, callId?}` |
| context | `context.compacted` (+`newlyImageElidedCallIds`) |
| memory | `memory.loaded`, `memory.narrative`, `memory.updated` |
| retrieval | `workspace.mapped` (+`inventorySha256`, `indexedFiles`, `indexState`) |
| tasks | `task.started` (+`planTaskId`, `planTaskSha`), `task.ended`, `task.changes`, `task.applied`, `task.base-checkpoint`, `task.supervision`, `worktree.created`, `worktree.removed` |
| plans | `plan.route {mode, source}`, `plan.updated` (+`graph`), `plan.approved {sha256}`, `plan.discarded` (+`reason: 'accepted'`) |
| verification | `check.started` (a REAL spawn — a `WORK_EVENT_TYPES` member), `check.completed` (verdict + named signals + `scopePaths`), both +`projectId` |
| setup | `setup.started` (a REAL spawn; a `WORK_EVENT_TYPES` member), `setup.completed` (`ok`/`failed`/`error`/`unsupported` — never `pass`, and never readable as verification) |
| recovery | `repair.attempted` (+`projectId` — a proof must come from the project that failed), `repair.escalated` (deliberately NO `repair.ended` — a derived outcome cannot be lost in a crash) |
| preview/browser | `preview.started`, `preview.ready`, `preview.ended`, `preview.swept`, `browser.flow` (+`traceOmittedBytes`, `screenshotsOmitted`) |
| documents | `artifact.rendered` (validation verdict + `failureCount`; `embeddedWorkspaceImages` gates inherited inspect consent), `artifact.inspected` (page-image blob pointers) — PRODUCTS, never verification, and never `WORK_EVENT_TYPES` members |
| review | `review.findings` (an EMPTY list is a recorded clean lens), `review.triage` (deliberately NO `review.completed` — a round is derived from its capture events) |
| acceptance | `session.accepted {complete, summary, unfinished?, deliveryRef?, deliveryOid?}` |

## Recovery (`store/snapshots.ts`, `runtime/undo.ts`)

Pre-mutation file bytes are stored content-addressed at `<state>/…/objects/<sha256>` (no git
dependency — undo works with no repository present). `SnapshotStore.restore` verifies the file
still holds the recorded post-mutation hash and **refuses drifted files** rather than clobber them.
`applyUndo` reverts the last mutating action or all of them in reverse order, chaining a
multiply-edited file back to its original bytes, and removes directories the mutation created if
now empty. Every undo is appended as `undo.applied`; the log is never rewritten. Git checkpoints
LAYER ON TOP: a checkpoint restore snapshots current bytes first and records ordinary
`file.mutated` events under one synthetic callId, so it is itself one undoable unit of this same
machinery — git never becomes the undo mechanism.

## Resume (`runtime/session.ts` → `reconstruct`)

`reconstruct` rebuilds the provider conversation from the committed log. It is faithful for every
tool result except redacted secret reads (which, by design, are not persisted and cannot be
replayed). Crash recovery reconciles against `file.mutated`/postHash: a completed edit whose
`tool.completed` was lost to a truncated tail is recognized as **applied** (post-hash matches
disk), a snapshot without a matching mutation is flagged **unknown post-state**, and a bare
`tool.requested` is a true **orphan** — unless `command.started` shows the command had spawned
(the replay says its effects are unknown) or `task.started` shows delegated tasks were running
(the replay points at EVERY surviving child log, plus captured changes when a `task.changes`
exists). Grants and the system prompt/map are regenerated fresh — current state outranks stale
context. Rebuilt from events at assembly: the captured-changes registry, DelegateCaps, CheckCaps,
PreviewCaps, and the owed harness-ref list, so a crashed life's cleanup debts survive.

## Verification (`report/report.ts`)

`buildReport` is a pure function `(Event[], approvedGraph?) → { json, md }` (golden-testable). A
changed file is labeled **CHECKED** only if a `run_command` — or a typed **check** — genuinely
**exited** zero *after* its last mutation. The widening is honest because a check's `pass` is
derived from the identical `exited && exitCode === 0` rule; the two sources are merged and **sorted
by seq** before the lookup. `collectPassingEvidence`/`firstPassingEvidenceAfter` are the ONE
implementation, shared with `/diff`. Each entry carries the SCOPE it covers — a check's project
unit, a `run_command`'s declared cwd — and the correlation requires the file to be inside it
(`'.'`, and every pre-S16 event, covers everything). Without that axis a green `build` in `web/`
marked a changed file in `api/` as CHECKED, in the one artifact whose job is not overstating what
was verified. A `command.ended` recording a kill vetoes CHECKED even against
a stray exit-0 completion. Everything else is **UNCHECKED**, and the report prints *which command*
with the exact wording "check ran, exit 0" and **no correctness claim**.

"Commands run" lists only commands that actually executed (denied calls stay visible under
Actions/Approvals); killed commands render as `killed: … no exit code`, and a `command.started`
with no completion renders `STARTED but never completed … effects unknown`. Each command carries
its actual boundary marker (`[sandboxed: windows-lowil]` / `[unsandboxed]`), and a header block
renders the session's `sandbox.status` — mode, whether it was ENFORCED, and the verbatim
`confines`/`doesNotConfine` scope — plus the probed `git.context` line ("at session start", never
live state). The session's end is read from the NEWEST lifecycle event, so a resumed-then-crashed
log never reports the earlier clean end.

Sections (all derived purely from events): per-file `+n/−m` churn; "Commits (user-commanded)" /
"Checkpoints" / "Checkpoint restores"; "Task-base checkpoints" kept apart from user-commanded
consent provenance; per-command `captured output preserved: objects/<sha>` pointers; "Delegated
tasks (subagents)" with footers that child usage is NOT in the parent totals and subagent reports
are narration; "## Plan"; "## Task changes and integration"; "## Verification (typed checks)" (pass
/ fail / error / unsupported / no-verdict, findings, signals, plan-task label, targeted scope, and
the verbatim exit-code contract); "## Recovery" (attempts with DERIVED outcomes, the model-authored
hypothesis labeled recorded-not-verified); "## Preview processes (managed)"; "## Browser
verification" (typed step failures, `objects/<sha>` artifact pointers, and the footer that
screenshots prove pixels at a declared-ready moment while typed step outcomes are the functional
evidence); "## Adversarial review" (requirement, open blockers, rounds, findings, triage);
"## Git recovery and audit state" (delivery lines annotated when this log records them pruned);
and "## Completion". A browser pass can never mark a file CHECKED — the exit-0 rule is structurally
unsatisfiable by `exitCode: null`.

The reviewable CONTENT lives in `report/diff.ts`: the attributable session diff (first pre-image
blob → current disk bytes, undo folded in, external edits flagged DRIFTED), rendered by `/diff` and
`agent diff` with per-line sanitization and the CHECKED verdict per file. A log without
`session.ended` renders as "IN PROGRESS or CRASHED/UNKNOWN". The report always states that
assistant narrative is not evidence; the footer is mode-aware. PowerShell invocations run via
`-EncodedCommand` and append `; exit $LASTEXITCODE` so a failing inner command cannot masquerade as
exit 0 → a false CHECKED.

## Providers (`provider/`)

Five real providers over **two genuinely different protocols**, plus the mock, behind the same
`Provider` contract and the same `runTurn`. Everything provider-specific is either an adapter or
DATA; the runtime has no provider name-checks (one exception, the vision choke, reads the CATALOG,
not a name).

```
catalog.ts    Capability model as DATA: per-model context/output caps, defaultMaxTokens, vision +
              `toolResultImages` ('native'|'rehomed'|'none'), reasoning {mode, replay}, caching
              style, lifecycle, quirk notes, and `budgetTokens` (OUR cost cap, not the provider's
              window) + PROVIDERS (key envs, base-URL env, key URL, default model, models path).
              `CATALOG_VERIFIED` is rendered by every listing. Retired ids are ABSENT; invite-only
              models are never listed. An uncataloged model gets conservative defaults + a note.
profiles.ts   Per-provider wire deviations for the chat-compat adapter (param names, include_usage
              policy, strict-flag policy, reasoning-replay policy, usage extraction, extra
              finish_reasons, error envelopes).
errors.ts     ProviderError taxonomy (auth|rate-limit|balance|context-window|bad-request|server|
              network|aborted) + bounded CONNECTION-PHASE-ONLY retry, Retry-After aware — ≤2 by
              default, rate-limit 429s draw a deeper default budget (RATE_LIMIT_RETRIES = 4: a
              throttle is EXPECTED to clear, and kimi Tier 0 is 3 req/min); an explicit
              `retries` option is honored verbatim for every kind (S16.5b).
sse.ts        One incremental SSE parser: chunk splits mid-UTF-8, CRLF, comment keep-alives,
              multi-line data, `[DONE]` yielded to callers.
registry.ts   The ONE construction/discovery seam: env-only key discovery (NAMES + presence),
              base-URL overrides, and a bounded models-list validation probe.
```

- **`AnthropicProvider`** streams via the SDK (abort signal passed through), maps
  messages/blocks/stop-reasons, and applies `coalesceUserMessages` at the wire (aborted turns and
  crash-resumes legitimately leave consecutive user messages). The `thinking` parameter is
  deliberately OMITTED so each model's own default applies — which on `claude-opus-5` (the v1.1
  default), `claude-sonnet-5` and `claude-fable-5` means adaptive thinking is ON. It contains no
  networking logic — it obtains a `fetch` from the transport factory.
- **`OpenAiResponsesProvider`** speaks the **Responses API**, not Chat Completions: since GPT-5.4
  Chat Completions cannot tool-call with reasoning off, and reasoning-item replay is
  Responses-only. `store:false` + `include:['reasoning.encrypted_content']` keeps the harness
  stateless; the terminal `response.completed`/`incomplete` payload is authoritative (streamed
  deltas drive live text only), `incomplete` maps to `max_tokens`/`refusal`, and `response.failed`
  or a terminal-less stream throws rather than fabricating a turn.
- **`OpenAiCompatProvider`** is ONE Chat-Completions adapter parameterized by a profile
  (deepseek/kimi/glm). Load-bearing mappings: each tool_result becomes its own `role:'tool'`
  message before same-message user text (kimi's pairing rule); consecutive USER TEXT messages
  COALESCE at the wire (the crash-resume/aborted-turn shapes legitimately produce them, and
  "this family generally tolerates it" is not a contract — S16.5b); `[DONE]` is the terminator,
  and a stream that ends with NEITHER `[DONE]` nor any `finish_reason` THROWS a non-retryable
  typed server error rather than committing a half-generated turn (a proxy idle half-close used
  to turn a truncated sentence into the model's "final" answer; part of the stream was consumed,
  so a replay would double-bill — S16.5b); usage is accepted from all three documented
  locations; error-shaped `finish_reason`s throw typed errors; no sampling params, no
  `tool_choice`, no `thinking` are ever sent (provider defaults are what the harness wants, and
  kimi locks sampling outright).
- **`MockProvider`** replays scripted turns offline and throws if exhausted — the entire loop,
  policy, snapshot, resume, and report behavior are proven through it. `hang: true` turns
  (in-process only) resolve only when the abort signal fires — the deterministic way to test
  mid-stream aborts. A `reasoning` field scripts opaque reasoning blocks offline.

**Opaque reasoning round-trip.** `ContentBlock` has a `reasoning` variant carrying the
provider-NATIVE artifact verbatim (an Anthropic thinking/redacted_thinking block, an OpenAI
reasoning item incl. `encrypted_content`, a `reasoning_content` string), tagged with the producing
`providerName` + `model`. `assistant.message.reasoning` persists it (additive; old logs have no
field and rebuild exactly as before), `reconstruct` replays it at the head of assistant content,
and elision WEIGHS it but never replaces it (only tool_result content is rewritten). Each adapter
replays only its own blocks for its own model, within that provider's documented scope — kimi
`all`, anthropic/deepseek/openai `current-loop`, glm never (its server strips prior thinking).
Foreign or out-of-window blocks are dropped from the WIRE VIEW only; `session.messages` is never
mutated. This is what makes always-thinking models (kimi-k3, claude-fable-5) and reasoning tool
loops legal at all.

**Prompt caching:** `buildApiParams` is a pure, unit-tested request builder with two ephemeral
`cache_control` breakpoints — the system block (tools+system = the stable prefix) and a MOVING one
on the final content block of the final wire message, attached AFTER coalescing (a pre-attached
marker could land mid-merged-message and silently cache a shorter prefix) and never on a replayed
thinking block, whose bytes must not change. Each step re-reads the prior conversation from cache;
the pipeline order is fixed as elide → scope-reasoning → coalesce → cache-mark. The other
providers cache automatically. Cache accounting flows into events, `/status`, and the report;
`reasoningTokens` is recorded on `assistant.message.usage` only — no reader surfaces it yet
(deferred: fold it into the report/`/status` token lines).

**Identity, selection, and honest degradation.**

- Selection precedence is `--provider`/`--model` > user config (`provider`, `model`) > the
  provider's catalog default; the WORKSPACE config layer structurally cannot express either.
  Credentials are env-only: never a flag, never config, never a command argument (`/provider`
  refuses key-shaped arguments), so they cannot reach argv, `user.message`, or any event.
- `maxTokens` and the elision `contextBudget` come from the catalog — production finally sets
  `Session.contextBudget` (the V0.5 seam that only tests used).
- `/provider` and `/model` are between-turns user commands (never tools — the model cannot switch
  itself). They mutate the live session, append `provider.changed` (from/to, source, env var
  NAME, API host, and HOW the key was checked), push a harness note telling the model its
  predecessor produced the earlier turns, and print the capability line. Children follow via a
  live `currentRuntime()` getter read per delegate call, so a child's own `session.started`
  records the truth. Resuming under a different identity records the same event with
  `source:'resume'` — closing a silent-switch hole.
- Readers fold identity **newest-wins** (the same correction `endedReason` got): the report names
  the final identity and lists `modelsUsed` when it changed; the journal carries a model line.
- **Vision degrades honestly at ONE choke:** when the catalog says the model has no image input,
  `runExecution` replaces wire image parts with `[screenshot: stored as evidence at objects/<sha>
  — model has no image input]` and `view_image` refuses with the same explanation. Blobs, image
  metadata, DOM assertions, gates, checks and recovery are untouched — only the visual-judgment
  step degrades, and it says so.

## Networking (`net/transport.ts`)

A reusable transport factory, deliberately decoupled from any provider. `resolveProxy(targetUrl,
env, explicit?)` is a pure function that detects standard system proxy settings (`HTTPS_PROXY`,
`HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, either case) and decides, per target URL, whether to proxy
or go direct. Precedence: an explicit override wins; otherwise the protocol-specific variable beats
`ALL_PROXY`; and `NO_PROXY` (exact host, domain-suffix, `*`, or `host:port`) overrides an
environment-derived proxy but not an explicit override.

`createTransport(opts)` returns `{ fetch?, describe() }`; `describeUrl` names the representative
host so the label matches the provider actually in use (routing always resolves per request URL).
**Every network path goes through it — including the registry's key-validation probe:** a bare
global fetch ignores system proxy settings, and on a proxied machine that produced a 401/403 for a
valid key, which would have made `/provider` refuse a working credential (live-found, S15). When no
proxy could ever apply it returns no custom `fetch`, so the client uses its own default. Otherwise `fetch` resolves the proxy **per
request URL** and attaches an undici `ProxyAgent` **dispatcher for that request only** — there are
no global side effects (`setGlobalDispatcher` is never called); ProxyAgent instances are cached per
proxy URL. `describe()` returns a credential-redacted summary. Proxy URLs (and any embedded
credentials) are never written to the event log, report, or any persisted state.
