import { startSession, resumeSession, recordWorkspaceMap, recordSandboxStatus, recordGitContext, type Session } from '../runtime/session.js';
import { selectSandbox, type SandboxBackend, type EnforcementFacts } from '../sandbox/index.js';
import { detectGitFacts } from '../git/facts.js';
import type { GitFacts } from '../git/types.js';
import type { WorkspaceMap } from '../workspace/map.js';
import { buildRankedMap } from '../retrieval/ranked-map.js';
import type { RetrievalHandle } from '../retrieval/rank.js';
import { buildSystemPrompt, type SystemPromptMemory } from '../workspace/system-prompt.js';
import { loadMemory, type LoadedMemory } from '../memory/load.js';
import { createDelegateTool, delegateCapsFromEvents, type DelegateCaps, type ExecutorDeps, type PlanGateInfo } from '../tools/delegate.js';
import type { ChildStatusUpdate } from '../runtime/subagent.js';
import { createRetrieveTool } from '../tools/retrieve.js';
import { checkCapsFromEvents, createRunCheckTool, type CheckCaps, type RunCheckTool } from '../tools/run-check.js';
import { createPreviewTool, previewCapsFromEvents, type PreviewCaps, type PreviewTool } from '../tools/preview.js';
import { artifactBytesFromEvents, createBrowserFlowTool } from '../tools/browser-flow.js';
import { createViewImageTool } from '../tools/view-image.js';
import { likelyBrowserAvailable, probeBrowser, type BrowserAvailability } from '../browser/probe.js';
import { createUpdatePlanTool } from '../tools/update-plan.js';
import { createApplyChangesTool, createTaskChangesRegistry } from '../tools/apply-changes.js';
import { createRecoverTool } from '../tools/recover.js';
import { createReviewTool } from '../tools/review.js';
import { classifyFailure, latestFailureEvidence } from '../recovery/classify.js';
import { foldRepairs } from '../recovery/ledger.js';
import { evaluateRepair, type RepairVerdict } from '../recovery/policy.js';
import { createApprovalForwarder } from '../runtime/approval-forwarder.js';
import { registryFile, sweepOrphanedWorktrees, worktreesRoot } from '../runtime/worktrees.js';
import { loadPreviewRegistry, previewsFile, sweepOrphanedPreviews, type PreviewSweepResult } from '../preview/registry.js';
import { isPidAlive } from '../store/event-log.js';
import { readPlanState } from '../plan/canonical.js';
import type { PlanGraph } from '../plan/schema.js';
import { foldGraphState, integrationGateState } from '../plan/graph-state.js';
import { availableKinds } from '../checks/recipes.js';
import { deleteCheckpointRefs } from '../git/checkpoint.js';
import { randomSaltHex } from '../shared/hash.js';
import type { ProjectLayout } from '../store/layout.js';
import type { ResolvedConfig } from '../config/config.js';
import type { TrustDecision } from '../trust/gate.js';
import type { EventBody, HarnessRefKind, SessionEvent } from '../types.js';
import type { RunContext } from './context.js';

/**
 * The ONE session-assembly path shared by the one-shot CLI and the REPL, so the two interfaces
 * cannot drift into parallel construction. Order is load-bearing: sandbox select + PROBE and the
 * git probe run before the map and system prompt so both report the truth; the post-start records
 * land in a fixed order the report and tests rely on.
 */

export interface AssembleDeps {
  /** Structural proof the trust gate ran and PASSED — assembly is impossible untrusted. */
  trust: Extract<TrustDecision, { trusted: true }>;
  config: ResolvedConfig;
  ctx: RunContext;
  layout: ProjectLayout;
  /** Resume this session instead of starting a fresh one. */
  resumeId?: string;
  argv?: string[];
  onText?: (delta: string) => void;
  onCommandOutput?: (callId: string, chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Live log observer (the REPL renderer); assigned BEFORE the post-start records so it misses nothing. */
  onLogEvent?: (e: SessionEvent) => void;
  /** Injectable for deterministic, platform-independent tests; defaults to selectSandbox. */
  sandbox?: SandboxBackend;
  /** Injectable for deterministic tests; defaults to a real detectGitFacts probe. */
  gitFacts?: GitFacts;
  /** Render-only chrome for delegated-task progress lines (the caller sanitizes/styles). */
  onTaskProgress?: (line: string) => void;
  /** Render-only STRUCTURED child status updates (Session 11) — feeds the live task table. */
  onTaskStatus?: (u: ChildStatusUpdate) => void;
  /** The task-scoped cancellation registry seam (Session 11): remembers per-child handles. */
  registerTaskCancel?: (childSessionId: string, cancel: () => void) => (() => void) | void;
}

export interface Assembled {
  session: Session;
  sandboxFacts: EnforcementFacts;
  gitFacts: GitFacts;
  map: WorkspaceMap;
  memory: LoadedMemory;
  /**
   * Read-only in-memory retrieval view (Session 10): ranked index handle for the retrieve
   * tool and /map. Null when the session fell back to the flat map (non-repo, git failure).
   * The index FILE is written only during assembly — never by a tool call.
   */
  retrieval: RetrievalHandle | null;
  /** One-line chrome note about index building (first run, partial state); Session 10. */
  mapNote?: string;
  /** One-line summary when crash-orphaned task worktrees were swept at startup (V0.7). */
  worktreeSweep?: string;
  /** One-line summary when crash-orphaned preview processes were swept at startup (Session 13). */
  previewSweep?: string;
  /**
   * Delete this session's owed harness checkpoint refs (V0.7.1; kind-aware Session 14:
   * task-base + pre-integration + superseded delivery — the latest delivery ref survives as
   * the durable audit anchor) — call at clean session end, BEFORE endSession (the provenance
   * event must land in the open log). Returns a one-line summary for chrome, or null when
   * there is nothing to prune. Absent without a repo.
   */
  pruneHarnessRefs?: () => Promise<string | null>;
  /** The live delegation counters (Session 11, events-rebuilt) — read-only for the status area. */
  delegateCaps: DelegateCaps;
  /** The typed-check tool instance (Session 12) — /checks reads its project snapshot. */
  checkTool: RunCheckTool;
  /** The live check counters (Session 12, events-rebuilt). */
  checkCaps: CheckCaps;
  /** The managed-preview tool instance (Session 13) — /preview reads its live handles. */
  previewTool: PreviewTool;
  /** The live preview-start counter (Session 13, events-rebuilt). */
  previewCaps: PreviewCaps;
  /**
   * Stop every preview this session owns (Session 13) — call at session end BEFORE
   * runMemoryUpdate/endSession so the preview.ended events land in the open log. Bounded and
   * best-effort; returns a one-line chrome summary or null when nothing was running.
   */
  stopAllPreviews: () => Promise<string | null>;
  /** Resume honesty (Session 13): what happened to previews a previous life left running. */
  previewResumeNote?: string;
}

export async function assembleSession(deps: AssembleDeps): Promise<Assembled> {
  const { ctx, layout } = deps;

  // Establish + probe the execution sandbox before the first turn, so the banner and system
  // prompt report the truth. Then the git probe (post-trust — it executes git against the repo).
  const sandbox = deps.sandbox ?? selectSandbox({ stateRoot: layout.stateRoot });
  const sandboxFacts = await sandbox.ensureAvailable();
  const gitFacts = deps.gitFacts ?? (await detectGitFacts(ctx.ws));
  // Ranked map + retrieval index (Session 10) for git-backed workspaces; ANY failure inside
  // falls back to the flat file list — the pre-Session-10 behavior is always reachable.
  const ranked = await buildRankedMap({ root: ctx.ws, git: gitFacts, projectDir: layout.projectDir, rules: deps.config.rules });
  const map = ranked.map;

  // Sweep crash-orphaned task worktrees (V0.7): registry-driven, path-guarded, honest summary.
  let worktreeSweep: string | undefined;
  if (gitFacts.isRepo && gitFacts.gitPath !== null) {
    try {
      const swept = await sweepOrphanedWorktrees(layout.projectDir, gitFacts.gitPath);
      if (swept.lockUnavailable === true) {
        worktreeSweep = 'sweep skipped (registry busy); orphans are retried next session';
      } else if (swept.removed.length > 0 || swept.failed.length > 0 || swept.skippedLive.length > 0) {
        worktreeSweep = [
          swept.removed.length > 0 ? `removed ${swept.removed.length} orphaned task worktree(s) from a previous run` : '',
          swept.failed.length > 0 ? `${swept.failed.length} could not be removed (retried next session)` : '',
          swept.skippedLive.length > 0 ? `${swept.skippedLive.length} left in place (owned by a live session)` : '',
        ]
          .filter((s) => s !== '')
          .join('; ');
      }
    } catch {
      /* the sweep must never block a session; leftovers are retried next time */
    }
  }

  // Sweep crash-orphaned preview PROCESSES (Session 13): registry-driven, identity-verified
  // kills, unverified orphans reported and left alone. Runs pre-session (an orphan must not
  // collide with this session's own previews); the evidence event is appended after the log
  // opens. Unconditional — previews do not require a git repo.
  let previewSweep: string | undefined;
  let previewSweepResult: PreviewSweepResult | undefined;
  try {
    const swept = await sweepOrphanedPreviews(layout.projectDir);
    if (swept.lockUnavailable === true) {
      previewSweep = `preview sweep skipped (${swept.lockDetail ?? 'registry unavailable'}); orphans are retried next session`;
    } else if (
      swept.killed.length > 0 ||
      swept.killFailed.length > 0 ||
      swept.skippedUnverified.length > 0 ||
      swept.skippedLiveOwner.length > 0 ||
      swept.droppedDead.length > 0 ||
      swept.retiredStale.length > 0 ||
      swept.unaccountedLogs.length > 0
    ) {
      previewSweepResult = swept;
      previewSweep = [
        swept.killed.length > 0 ? `stopped ${swept.killed.length} orphaned preview process(es) from a previous run` : '',
        swept.killFailed.length > 0 ? `${swept.killFailed.length} could not be stopped (retried next session)` : '',
        swept.skippedUnverified.length > 0
          ? `${swept.skippedUnverified.length} left running (identity could not be verified — see previews.json)`
          : '',
        swept.skippedLiveOwner.length > 0 ? `${swept.skippedLiveOwner.length} owned by a live sibling session (untouched)` : '',
        swept.droppedDead.length > 0 ? `${swept.droppedDead.length} stale record(s) cleared` : '',
        swept.retiredStale.length > 0 ? `${swept.retiredStale.length} unverifiable record(s) >24h old deregistered (nothing killed)` : '',
        swept.unaccountedLogs.length > 0
          ? `${swept.unaccountedLogs.length} preview log(s) with no registry record — a start may have been lost before registration (check the file)`
          : '',
      ]
        .filter((s) => s !== '')
        .join('; ');
    }
  } catch {
    /* the sweep must never block a session; leftovers are retried next time */
  }

  // Project memory: loaded post-trust (the gate is a structural parameter of this function),
  // capped, and degrading — a broken memory doc must never block a session.
  const memory = loadMemory(deps.layout, ctx.ws, {
    currentMapSha256: map.sha256,
    ...(map.inventorySha256 !== undefined ? { currentInventorySha256: map.inventorySha256 } : {}),
    ...(deps.resumeId !== undefined ? { resumeId: deps.resumeId } : {}),
  });
  const system = buildSystemPrompt(ctx.ws, map, sandboxFacts, gitFacts, promptMemory(memory));

  const common = {
    workspaceRoot: ctx.ws,
    layout,
    model: ctx.model,
    mode: ctx.mode,
    provider: ctx.provider,
    approver: ctx.approver,
    system,
    maxSteps: ctx.maxSteps,
    maxTokens: ctx.maxTokens,
    saltHex: randomSaltHex(),
    rules: deps.config.rules,
    sandbox,
    sandboxFacts,
    gitFacts,
    ...(deps.onText !== undefined ? { onText: deps.onText } : {}),
    ...(deps.onCommandOutput !== undefined ? { onCommandOutput: deps.onCommandOutput } : {}),
  };

  const session = deps.resumeId !== undefined
    ? resumeSession({ ...common, sessionId: deps.resumeId })
    : startSession({ ...common, argv: deps.argv ?? [] });

  if (deps.onLogEvent !== undefined) session.log.onAppend = deps.onLogEvent;
  session.log.append({ type: 'trust.verified', source: deps.trust.source });
  session.log.append({ type: 'config.loaded', sources: deps.config.sources });
  recordSandboxStatus(session, sandboxFacts);
  recordGitContext(session, gitFacts);
  recordWorkspaceMap(session, map);
  session.log.append({
    type: 'memory.loaded',
    files: [memory.agent, memory.journal, memory.codebase].map((d) => ({
      name: d.name,
      sha256: d.sha256,
      bytes: d.bytes,
      truncated: d.truncated,
      status: d.status,
    })),
  });
  if (previewSweepResult !== undefined) {
    session.log.append({
      type: 'preview.swept',
      killed: previewSweepResult.killed,
      killFailed: previewSweepResult.killFailed,
      skippedUnverified: previewSweepResult.skippedUnverified,
      droppedDead: previewSweepResult.droppedDead,
      ...(previewSweepResult.retiredStale.length > 0 ? { retiredStale: previewSweepResult.retiredStale } : {}),
      ...(previewSweepResult.unaccountedLogs.length > 0 ? { unaccountedLogs: previewSweepResult.unaccountedLogs } : {}),
    });
  }

  // Child→parent approval forwarding (V0.7): the queue wraps the SESSION approver — never io
  // directly — so non-interactive parents fail closed structurally and EOF cascades deny-stop.
  const forwarder = createApprovalForwarder(ctx.approver, deps.onTaskProgress);
  // Captured executor changes, keyed by child session; REBUILT FROM EVENTS on resume so a
  // crash between capture and apply never strands integrable work.
  const changesRegistry = createTaskChangesRegistry();
  for (const e of session.log.events) {
    if (e.type === 'task.changes') changesRegistry.register(e.childSessionId, e.baseOid, e.files, e.omittedCount);
  }
  // Harness checkpoint refs owed a prune (Session 11.5, generalized Session 14): the owed set
  // is RE-FOLDED FROM LIVE EVENTS at prune time — session.log.events is live, so creations
  // appended during this session (task-base via reportTask, pre-integration via
  // reportCheckpoint, delivery via /accept) and a crashed prior life's leaked creations are
  // one derivation, and a second prune call naturally finds nothing (the pruned events from
  // the first are in the fold). The in-memory list below is belt-and-suspenders for base refs
  // noted on paths where no reportTask channel exists (the noteBaseRef seam predates the
  // events fold and some tests exercise it directly).
  const notedBaseRefs: string[] = [];
  // Executor orchestration bundle — absent (⇒ honest tool-level refusal) without a probed repo.
  const executorDeps: ExecutorDeps | undefined =
    gitFacts.isRepo && gitFacts.gitPath !== null && gitFacts.repoRoot !== null
      ? {
          gitPath: gitFacts.gitPath,
          gitVersion: gitFacts.gitVersion,
          repoRoot: gitFacts.repoRoot,
          stateDir: layout.projectDir,
          worktreesRoot: worktreesRoot(layout.projectDir),
          registryFile: registryFile(layout.projectDir),
          snapshots: session.snapshots,
          registerChanges: (childSessionId, baseOid, files, omittedCount) => changesRegistry.register(childSessionId, baseOid, files, omittedCount),
          noteBaseRef: (ref) => notedBaseRefs.push(ref),
          clockIso: () => session.clock.iso(),
        }
      : undefined;

  // Plan gate state (Session 11), read FRESH per use — the file's current bytes are truth and
  // the approval binding lives in events. Wired independently of the executor bundle because
  // DAG bindings gate read-only tasks too. The fold gives the gate live dependency states.
  const planContext = (): PlanGateInfo => {
    const state = readPlanState(layout, session.id, session.log.events);
    const graph = state.canonical?.graph ?? null;
    return {
      state,
      graphState: graph !== null ? foldGraphState(graph, session.log.events) : null,
      // The integration-boundary gate (Session 12) is computed HERE, where the events are, so
      // checkDagRules stays a pure function of its declared inputs.
      integrationGate: graph !== null ? integrationGateState(graph, session.log.events) : null,
      // Per-task repair verdicts (Session 12), same rationale: classification and the bounded
      // repair policy need the whole event log, and the DAG gate must stay pure over its inputs.
      repairVerdicts: graph !== null ? repairVerdictsFor(graph, session.log.events) : null,
    };
  };
  // Delegation caps REBUILT FROM EVENTS (Session 11): a resumed session keeps counting where it
  // left off — the changes-registry pattern applied to the budget counters.
  const delegateCaps = delegateCapsFromEvents(session.log.events);

  // Session-end hygiene (V0.7.1, kind-aware Session 14): task-base and pre-integration refs
  // are live recovery points only while the session runs — blobs + events are the durable
  // record; the LATEST delivery ref survives as the durable audit anchor. Announced +
  // recorded. Since Session 14 the creation event lands BEFORE update-ref, so there is no
  // crash instant that leaks a harness ref (a phantom creation prunes as already-deleted).
  const pruneHarnessRefs =
    executorDeps === undefined
      ? undefined
      : async (): Promise<string | null> => {
          const owed = owedHarnessRefsFromEvents(session.log.events);
          const seen = new Set(owed.map((o) => o.ref));
          // The noted refs are consumed here, but a ref whose deletion genuinely FAILED is
          // put back: it has no creation event (that is precisely why this fallback list
          // exists), so the events fold could never re-own it and the retry would be lost.
          const noted = notedBaseRefs.splice(0);
          for (const ref of noted) if (!seen.has(ref)) owed.push({ ref, kind: 'task-base' });
          try {
            const result = await pruneHarnessCheckpointRefs(executorDeps.gitPath, executorDeps.repoRoot, owed, session.log);
            if (result !== null && result.failed.length > 0) {
              const notedSet = new Set(noted);
              for (const ref of result.failed) if (notedSet.has(ref)) notedBaseRefs.push(ref);
            }
            return result?.line ?? null;
          } catch (e) {
            // A THROW (spawn failure, wedged git) must not lose the fallback list the way a
            // reported per-ref failure does not: put every noted ref back so a later retry
            // (the /accept path, then the quit path) can still own them. Callers report.
            for (const ref of noted) if (!notedBaseRefs.includes(ref)) notedBaseRefs.push(ref);
            throw e;
          }
        };

  // retrieve (Session 10): a per-session READ-ONLY view over the assembly-built index. The
  // parent gets it directly; read-only child roles get the SAME instance through the named
  // SubagentDeps.retrieveTool seam (executors deliberately not — wrong tree).
  const retrieveTool = ranked.handle !== null ? createRetrieveTool(ranked.handle) : undefined;

  // run_check (Session 12): a per-session instance holding the DETECTED PROJECT SNAPSHOT. The
  // snapshot exists because the policy `check()` fact must be pure — decide() does no I/O — and
  // because the command the human approves must be the command that runs. Parent-only: an
  // executor worktree materializes without gitignored dependencies, so a check there would refuse
  // on a precondition almost every time; the parent verifies after apply_task_changes, where the
  // workspace is real.
  const checkCaps = checkCapsFromEvents(session.log.events);
  const checkTool = createRunCheckTool({ workspaceRoot: ctx.ws, caps: checkCaps });

  // preview (Session 13): the managed preview-server tool — per-session for the same snapshot
  // reason as run_check, plus it owns this session's live process handles. `appendEnded` is the
  // session-bound single writer of `preview.ended`; a process death can arrive after the session
  // ends, so it must tolerate a closed log and never throw (the first harness-async log writer).
  const previewCaps = previewCapsFromEvents(session.log.events);
  const previewTool = createPreviewTool({
    workspaceRoot: ctx.ws,
    projectDir: layout.projectDir,
    sessionId: session.id,
    caps: previewCaps,
    envExcludePatterns: deps.config.rules.envExcludePatterns,
    appendEnded: (e) => {
      try {
        session.log.append({ type: 'preview.ended', ...e });
      } catch {
        /* closed log (session already ended) — the registry entry + sweep carry the truth */
      }
    },
  });
  const stopAllPreviews = async (): Promise<string | null> => {
    try {
      const r = await previewTool.stopAll('session-end');
      if (r.stopped === 0 && r.unverified === 0) return null;
      // Honest split: "stopped" is a VERIFIED death; a kill-resistant process is named, never
      // silently counted as stopped.
      return r.unverified > 0
        ? `stopped ${r.stopped} preview server(s); ${r.unverified} could NOT be verified dead (the next session's sweep retries)`
        : `stopped ${r.stopped} preview server(s)`;
    } catch {
      return 'preview stop-all failed; the next session\'s sweep will verify and stop leftovers';
    }
  };

  // browser_flow + view_image (Session 13): the browser probe is a real headless launch, so it
  // is cached per session and only runs when a flow actually needs it. Flows share the SESSION
  // CHECK BUDGET (the same live CheckCaps instance run_check refuses on) plus an artifact byte
  // budget rebuilt from browser.flow events.
  let browserProbePromise: Promise<BrowserAvailability> | null = null;
  const cachedProbe = (): Promise<BrowserAvailability> => {
    browserProbePromise ??= probeBrowser();
    return browserProbePromise;
  };
  const artifactBudget = { usedBytes: artifactBytesFromEvents(session.log.events) };
  const browserTool = createBrowserFlowTool({
    preview: previewTool,
    putBlob: (bytes) => session.snapshots.putBlob(bytes),
    caps: checkCaps,
    artifactBudget,
    probe: cachedProbe,
  });
  const viewImageTool = createViewImageTool({
    getBlob: (sha) => session.snapshots.getBlob(sha),
    events: () => session.log.events,
  });

  // Resume honesty (Session 13): a preview from a PREVIOUS life cannot be re-attached (the
  // handle died with the process's owner); the sweep above already dealt with the process, so
  // tell the model what happened rather than let a stale "ready" claim stand.
  let previewResumeNote: string | undefined;
  if (deps.resumeId !== undefined) {
    const started = new Map<string, { pid: number; command: string }>();
    const endedIds = new Set<string>();
    for (const e of session.log.events) {
      if (e.type === 'preview.started') started.set(e.previewId, { pid: e.pid, command: e.command });
      else if (e.type === 'preview.ended') endedIds.add(e.previewId);
    }
    const unended = [...started.entries()].filter(([id]) => !endedIds.has(id));
    if (unended.length > 0) {
      const outcome = (id: string, pid: number): string => {
        if (previewSweepResult?.killed.some((k) => k.previewId === id) === true) return 'stopped by the startup sweep';
        if (previewSweepResult?.killFailed.some((k) => k.previewId === id) === true) return 'the sweep could NOT stop it';
        if (previewSweepResult?.skippedUnverified.some((k) => k.previewId === id) === true)
          return 'left running (identity unverified — possibly not our process anymore)';
        if (previewSweepResult?.skippedLiveOwner.includes(id) === true)
          return 'still recorded and possibly running (the recorded owner pid looks alive — a sibling session, or a recycled pid)';
        if (previewSweepResult?.retiredStale.includes(id) === true) return 'deregistered as stale (>24h, unverifiable; nothing was killed)';
        if (previewSweepResult?.droppedDead.includes(id) === true) return 'already dead';
        // No sweep bucket names it: answer from the registry itself instead of guessing.
        try {
          const entry = loadPreviewRegistry(previewsFile(layout.projectDir)).find((e) => e.previewId === id);
          if (entry === undefined) return `no longer recorded (pid ${String(pid)})`;
          return isPidAlive(entry.pid)
            ? `STILL RECORDED with a live pid ${String(entry.pid)} — the sweep did not resolve it this time`
            : 'recorded but its pid is dead (cleared at the next sweep)';
        } catch {
          return `state unknown (pid ${String(pid)})`;
        }
      };
      previewResumeNote = unended
        .map(([id, v]) => `preview ${id} (${v.command}) was running when the previous life ended; ${outcome(id, v.pid)}. It is NOT attached to this session — start a new preview if needed.`)
        .join(' ');
    }
  }

  // The delegate tool is a PER-SESSION instance appended to a fresh array (never TOOLS.push):
  // parents get it; child sessions have fixed role registries without it, so delegation depth
  // is 1 by construction. Children inherit the PROBED sandbox instance (no re-probe), the
  // narrowing rules, and the user constitution.
  session.tools = [
    ...session.tools,
    ...(retrieveTool !== undefined ? [retrieveTool] : []),
    checkTool,
    previewTool,
    browserTool,
    viewImageTool,
    createDelegateTool(
      {
        layout,
        workspaceRoot: ctx.ws,
        model: ctx.model,
        maxTokens: ctx.maxTokens,
        provider: ctx.provider,
        rules: deps.config.rules,
        sandbox,
        sandboxFacts,
        gitFacts,
        map,
        forwardAsk: (req, signal) => forwarder.ask(req, signal),
        ...(retrieveTool !== undefined ? { retrieveTool } : {}),
        ...(memory.agent.status === 'ok' || memory.agent.status === 'oversize'
          ? { agentMd: { text: memory.agent.text, truncated: memory.agent.truncated } }
          : {}),
        ...(deps.onTaskProgress !== undefined ? { onProgress: deps.onTaskProgress } : {}),
        ...(deps.onTaskStatus !== undefined ? { onStatus: deps.onTaskStatus } : {}),
        ...(deps.registerTaskCancel !== undefined ? { registerCancel: deps.registerTaskCancel } : {}),
      },
      session.id,
      executorDeps,
      { planContext, caps: delegateCaps },
    ),
    // update_plan and apply_task_changes are likewise parent-only (no role registry contains
    // them): the model's single gated write paths to the plan document and to integration.
    createUpdatePlanTool({
      layout,
      snapshots: session.snapshots,
      planId: session.id,
      // Plan-time reality check (Session 12): a declared gate this project cannot run becomes a
      // warning in the revision loop, long before the user approves an unsatisfiable graph.
      // 'browser' merges from the CHEAP existence guess (Session 13) — plan validation is a
      // non-blocking warning surface; the real launch probe is the runtime truth.
      availableChecks: () => [...availableKinds(checkTool.projectSnapshot()), ...(likelyBrowserAvailable() ? (['browser'] as const) : [])],
    }),
    createApplyChangesTool(
      changesRegistry,
      session.snapshots,
      // Pre-integration checkpoint deps (Session 14): repo-gated like the executor bundle. The
      // apply itself never depends on this — absent deps simply mean no whole-workspace point.
      executorDeps !== undefined
        ? {
            cctx: { gitPath: executorDeps.gitPath, repoRoot: executorDeps.repoRoot, workspaceRoot: ctx.ws, stateDir: layout.projectDir },
            sessionId: session.id,
            events: () => session.log.events,
          }
        : undefined,
    ),
    // recover (Session 12): the bounded repair ledger. Parent-only like the other orchestration
    // tools — a child cannot plan its own retry policy. It reads the live log and the approved
    // graph fresh per call (bytes and events are truth) and writes only evidence.
    createRecoverTool({
      events: () => session.log.events,
      planGraph: () => readPlanState(layout, session.id, session.log.events).canonical?.graph ?? null,
    }),
    // review (Session 14): triage over recorded findings — the same observe-class, events-only
    // shape as recover, reading the live log fresh per call. The graph is filtered to an
    // APPROVED-AND-CURRENT plan exactly as computeAcceptance and /review filter it: three
    // derivations of one gate must never disagree about whether a round is required.
    createReviewTool({
      events: () => session.log.events,
      planGraph: () => {
        const st = readPlanState(layout, session.id, session.log.events);
        return st.kind === 'canonical' && st.status === 'approved' && st.approvedAndCurrent ? (st.canonical?.graph ?? null) : null;
      },
    }),
  ];

  return {
    session,
    sandboxFacts,
    gitFacts,
    map,
    memory,
    retrieval: ranked.handle,
    delegateCaps,
    checkTool,
    checkCaps,
    previewTool,
    previewCaps,
    stopAllPreviews,
    ...(previewResumeNote !== undefined ? { previewResumeNote } : {}),
    ...(ranked.note !== null ? { mapNote: ranked.note } : {}),
    ...(worktreeSweep !== undefined ? { worktreeSweep } : {}),
    ...(previewSweep !== undefined ? { previewSweep } : {}),
    ...(pruneHarnessRefs !== undefined ? { pruneHarnessRefs } : {}),
  };
}

/**
 * Per-plan-task repair verdicts (Session 12): for every task whose latest recorded failure is
 * classifiable, the bounded-repair policy's answer. Computed here — where the events and the
 * graph both are — so `checkDagRules` stays a pure function of its declared inputs.
 */
export function repairVerdictsFor(graph: PlanGraph, events: readonly SessionEvent[]): Map<string, RepairVerdict> {
  const out = new Map<string, RepairVerdict>();
  const ledger = foldRepairs(events, { extraScope: (target) => graph.tasks.find((t) => t.id === target)?.touches ?? [] });
  for (const task of graph.tasks) {
    const evidence = latestFailureEvidence(events, task.id);
    if (evidence === null) continue;
    const classification = classifyFailure(evidence);
    out.set(task.id, evaluateRepair({ classification, failureSeq: evidence.seq, ledger }));
  }
  return out;
}

/** A harness-owned checkpoint ref still owed a prune, with the kind that decides its lifecycle. */
export interface OwedHarnessRef {
  ref: string;
  kind: HarnessRefKind;
}

/**
 * Harness checkpoint refs still owed a prune, folded purely from events (Session 11.5,
 * generalized Session 14): task-base and pre-integration creations minus successful deletions;
 * a delivery ref survives ONLY while it is the one the latest recorded acceptance actually
 * CONSUMED (`session.accepted.deliveryRef`). The fold is seq-aware and
 * latest-writer-per-ref-wins: after a PHANTOM creation (update-ref failed after the event
 * append) the next checkpoint may reuse the same ref name, and a ref pruned then re-created
 * later is owed again. Refs whose deletion FAILED stay owed (retried at the next prune; the
 * missing-ref tolerance in deleteCheckpointRefs makes retries converge — a phantom's owed ref
 * simply counts as already deleted).
 *
 * Keying delivery survival on the ACCEPTANCE rather than on the newest creation event is
 * load-bearing (review, 4/4 lenses): under event-before-ref a creation event can exist for a
 * ref that never landed, and a phantom holding the newest seq would supersede — and therefore
 * prune — the real anchor of the last recorded acceptance, leaving a dangling deliveryRef and
 * zero audit anchors. An acceptance's recorded ref is the only identity that is both durable
 * and provably consumed; an acceptance that captured NO ref leaves the previous anchor alone
 * rather than destroying one it cannot replace.
 */
export function owedHarnessRefsFromEvents(events: readonly SessionEvent[]): OwedHarnessRef[] {
  const created = new Map<string, { kind: HarnessRefKind; seq: number }>();
  const deleted = new Map<string, number>();
  let acceptedDeliveryRef: string | null = null;
  for (const e of events) {
    if (e.type === 'task.base-checkpoint') {
      created.set(e.ref, { kind: 'task-base', seq: e.seq });
    } else if (e.type === 'harness.checkpoint') {
      created.set(e.ref, { kind: e.kind, seq: e.seq });
    } else if (e.type === 'session.accepted' && e.deliveryRef !== undefined) {
      // The latest acceptance that actually CAPTURED a ref defines the surviving anchor. An
      // acceptance with no ref (git failure, decline, non-repo, or a phantom whose update-ref
      // failed) does NOT clear the previous one: it has nothing to replace it with, and the
      // earlier acceptance's recorded deliveryRef must not be left dangling.
      acceptedDeliveryRef = e.deliveryRef;
    } else if (e.type === 'git.checkpoint.pruned') {
      // Deletion is tracked per ref regardless of the event's kind grouping — the ref name is
      // the identity; the kind on the pruned event exists for readers, not for this fold.
      for (const ref of e.refs) deleted.set(ref, e.seq);
    }
  }
  const owed: OwedHarnessRef[] = [];
  for (const [ref, c] of created) {
    if ((deleted.get(ref) ?? 0) >= c.seq) continue;
    if (c.kind === 'delivery' && ref === acceptedDeliveryRef) continue;
    owed.push({ ref, kind: c.kind });
  }
  return owed;
}

/**
 * The session-end harness-ref prune (V0.7.1, kind-aware since Session 14), factored for
 * testability: delete the refs, record one provenance event per kind (a silent ref delete
 * would violate the evidence invariant), return the chrome summary line. Idempotence comes
 * from the events themselves: the pruned events this appends make the next
 * `owedHarnessRefsFromEvents` fold exclude everything successfully deleted.
 */
export async function pruneHarnessCheckpointRefs(
  gitPath: string,
  repoRoot: string,
  owed: readonly OwedHarnessRef[],
  log: { append(body: EventBody): unknown },
): Promise<{ line: string; failed: string[] } | null> {
  if (owed.length === 0) return null;
  const byKind = new Map<HarnessRefKind, string[]>();
  for (const o of owed) {
    const list = byKind.get(o.kind) ?? [];
    if (!list.includes(o.ref)) list.push(o.ref);
    byKind.set(o.kind, list);
  }
  const parts: string[] = [];
  const failed: string[] = [];
  for (const kind of ['task-base', 'pre-integration', 'delivery'] as const) {
    const refs = byKind.get(kind);
    if (refs === undefined) continue;
    const r = await deleteCheckpointRefs(gitPath, repoRoot, refs);
    try {
      log.append({ type: 'git.checkpoint.pruned', kind, refs: r.deleted, failed: r.failed });
    } catch {
      /* best-effort hygiene: a failing log at quit must not block the end path */
    }
    parts.push(`${r.deleted.length} ${kind}`);
    failed.push(...r.failed);
  }
  return {
    line: `pruned ${parts.join(' + ')} checkpoint ref(s)` + (failed.length > 0 ? `; ${failed.length} failed (agent checkpoint prune)` : ''),
    failed,
  };
}

/** Map the loaded docs onto the system-prompt injection shape (only usable docs are injected). */
function promptMemory(memory: LoadedMemory): SystemPromptMemory {
  const usable = (status: string): boolean => status === 'ok' || status === 'oversize';
  return {
    ...(usable(memory.agent.status) ? { agentText: memory.agent.text, agentTruncated: memory.agent.truncated } : {}),
    ...(usable(memory.journal.status) ? { journalText: memory.journal.text, journalTruncated: memory.journal.truncated } : {}),
    ...(usable(memory.codebase.status) ? { codebaseText: memory.codebase.text, codebaseStale: memory.codebase.stale } : {}),
    ...(memory.crashNote !== null ? { crashNote: memory.crashNote } : {}),
  };
}
