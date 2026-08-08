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
import { checkCapsFromEvents, createRunCheckTool, workspaceAvailableKinds, type CheckCaps, type RunCheckTool } from '../tools/run-check.js';
import { createProjectSetupTool, setupCapsFromEvents, type ProjectSetupTool, type SetupCaps } from '../tools/project-setup.js';
import { detectWorkspace } from '../checks/workspace.js';
import { createSharedWorkspace } from '../checks/session-workspace.js';
import { createPreviewTool, previewCapsFromEvents, type PreviewCaps, type PreviewTool } from '../tools/preview.js';
import { artifactBytesFromEvents, createBrowserFlowTool } from '../tools/browser-flow.js';
import { createViewImageTool } from '../tools/view-image.js';
import { readDocumentTool } from '../tools/artifact-read.js';
import { createRenderDocumentTool, renderCapsFromEvents } from '../tools/artifact-render.js';
import { createInspectPagesTool, inspectBudgetFromEvents } from '../tools/artifact-inspect.js';
import { createWebSearchTool } from '../tools/web-search.js';
import { createWebExtractTool } from '../tools/web-extract.js';
import { createRecordSourceTool, type NoteAccumulator } from '../tools/record-source.js';
import { researchBudgetFromEvents, type ResearchBudget } from '../tools/research-budget.js';
import { createTavilyClient, noKeyMessage, tavilyKeyAvailability } from '../research/tavily.js';
import { EXTRACTS_PER_RESEARCH_TASK, type ResearchClient } from '../research/types.js';
import { detectRemoteContext } from '../remote/context.js';
import { createGhRunner } from '../remote/gh.js';
import type { GhRunner, RemoteContext } from '../remote/types.js';
import { createRemoteState, remoteSpendFromEvents, type RemoteState } from '../tools/remote-state.js';
import { createRemoteStatusTool } from '../tools/remote-status.js';
import { createRemotePushTool } from '../tools/remote-push.js';
import { createRemoteReleaseTool } from '../tools/remote-release.js';
import { capsFor, type ProviderName } from '../provider/catalog.js';
import { effectiveIdentity } from '../report/report.js';
import { cacheSuccessfulProbe, likelyBrowserAvailable, probeBrowser } from '../browser/probe.js';
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
import { approvedCurrentGraph, readPlanState } from '../plan/canonical.js';
import type { PlanGraph } from '../plan/schema.js';
import { foldGraphState, integrationGateState } from '../plan/graph-state.js';
import { deleteCheckpointRefs } from '../git/checkpoint.js';
import { randomSaltHex } from '../shared/hash.js';
import type { ProjectLayout } from '../store/layout.js';
import type { ResolvedConfig } from '../config/config.js';
import type { TrustDecision } from '../trust/gate.js';
import type { EventBody, HarnessRefKind, SessionEvent, Tool } from '../types.js';
import type { RunContext } from './context.js';

/**
 * The ONE session-assembly path shared by the one-shot CLI and the REPL, so the two interfaces
 * cannot drift into parallel construction. Order is load-bearing: sandbox select + PROBE and the
 * git probe run before the map and system prompt so both report the truth; the post-start records
 * land in a fixed order the report and tests rely on.
 */

/**
 * Every per-session tool name this assembly can attach to a PARENT session, in registration
 * order. It is the VOCABULARY, not the runtime registry: a session legitimately omits `retrieve`
 * without a git-backed index and `web_search` without a research credential.
 *
 * Exported because two other places need the same list and had been keeping their own copies —
 * the provider naming-rule check had silently gone four names stale (Session 19), which is a rule
 * that cannot enforce anything about a tool it does not know exists. One list, pinned against a
 * real assembly in `assemble.projects.test.ts`.
 */
export const SESSION_TOOL_NAMES = [
  'retrieve',
  'run_check',
  'project_setup',
  'preview',
  'browser_flow',
  'view_image',
  'read_document',
  'web_search',
  'render_document',
  'inspect_pages',
  // Session 20. Registered only when the workspace actually has a git remote — the `retrieve` and
  // `web_search` precedent: a model told about a tool its registry does not contain will reach for
  // it, be told it does not exist, and reach again.
  'remote_status',
  'remote_push',
  'remote_release',
  'delegate_task',
  'update_plan',
  'apply_task_changes',
  'recover',
  'review',
] as const;

/** Tool names that exist only inside a CHILD session's registry, never the parent's. */
export const CHILD_ONLY_TOOL_NAMES = ['report_finding', 'web_extract', 'record_source'] as const;

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
  /** Render-only model-request lifecycle (S16.5b) — drives the REPL's "working" heartbeat. */
  onModelRequest?: (inFlight: boolean) => void;
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
   * One-line chrome note naming the projects detected in a MULTI-project workspace, and which of
   * them are not installed (Session 16.5). The model has been told all of this in its system
   * prompt since Session 16; the human at the terminal had not been told any of it, so a
   * two-service repository looked identical to a one-package one right up until the first
   * ambiguity refusal. Single-project workspaces print nothing, exactly as before.
   */
  projectsNote?: string;
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
  /** The project-setup tool instance (Session 16) — /checks reads the same workspace snapshot. */
  setupTool: ProjectSetupTool;
  /** The live setup counter (Session 16, events-rebuilt). */
  setupCaps: SetupCaps;
  /**
   * The live session research budget (Session 19, events-rebuilt) — ONE object shared by the
   * parent's web_search and every researcher child's instances. `/research` reads it.
   */
  researchBudget: ResearchBudget;
  /**
   * Why research is unavailable this session, or undefined when it is available. Present means
   * the tools were never registered and the system prompt says nothing about them — the honest
   * shape for a capability whose credential is absent.
   */
  researchUnavailable?: string;
  /**
   * The live remote-delivery state (Session 20): the local remote inventory, the events-rebuilt
   * read/write spend, the in-memory observations, and the gh identity once one is established.
   * `/remote` reads it. Present even when there is no remote — it then reports exactly that.
   */
  remoteState: RemoteState;
  /**
   * Why remote delivery is unavailable this session, or undefined when it is available. Present
   * means the three tools were NOT registered and the system prompt says nothing about them.
   */
  remoteUnavailable?: string;
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
  /** Resume honesty (Session 15): the session resumed under a different provider/model. */
  providerResumeNote?: string;
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
  // ONE detection per session (Session 16), before the prompt is built. Two things follow: the
  // model learns which projects exist and what each can run — it cannot name a `project` it has
  // never been told about — and the check and preview tools stop detecting independently, which
  // was two snapshots of the same workspace that could already disagree. Each tool still keeps
  // its OWN mutable copy for its own TOCTOU refresh, so no tool can advance another tool's gate.
  //
  // Session 16.5 makes that ONE LIVE holder rather than three diverging copies. The per-tool
  // copies had no window to protect (tool calls execute strictly one at a time, so decide() and
  // execute() for a call are back-to-back), and they cost a real defect: after `project_setup
  // install` created node_modules, the next run_check/preview still resolved against a snapshot
  // where nothing could run — allowed as 'nothing to run', then refused at execute with 'the
  // project changed after this call was approved' for a call nobody approved.
  const detectedWorkspace = detectWorkspace(ctx.ws);
  const sharedWorkspace = createSharedWorkspace(ctx.ws, { initial: detectedWorkspace });
  // The human's one-line version of the block the model gets. Only for a MULTI-project workspace:
  // for a single project it would be noise, and the ambiguity it warns about does not exist there.
  const projectsNote =
    detectedWorkspace.units.length > 1
      ? (() => {
          const uninstalled = detectedWorkspace.units.filter((u) => u.hasDependencies && !u.hasNodeModules).map((u) => u.id);
          return (
            `${String(detectedWorkspace.units.length)} projects: ${detectedWorkspace.units.map((u) => u.id).join(', ')}` +
            (uninstalled.length > 0 ? ` — dependencies NOT installed in ${uninstalled.join(', ')}` : '') +
            ' (checks, previews and setup each take a `project`; /checks re-probes)'
          );
        })()
      : undefined;
  // Web research (Session 19). The credential is discovered ENV-ONLY, by name — configuration
  // structurally cannot express one, and it never reaches argv, an event, or a prompt.
  //
  // No credential means the tools are NOT REGISTERED at all (the `retrieveTool` precedent) rather
  // than registered and refusing. A tool the model can see but can never use costs a step and a
  // retry loop every time it looks useful; absence plus a `/research` line explaining the cure is
  // the honest shape. Built HERE, before the prompt, because the prompt's research paragraph is
  // conditional on the same flag — the model is never told about a capability its registry does
  // not contain.
  const researchKey = tavilyKeyAvailability(process.env);
  const researchClient: ResearchClient | null =
    researchKey.present && researchKey.keyEnv !== undefined
      ? createTavilyClient({
          apiKey: (process.env[researchKey.keyEnv] ?? '').trim(),
          blockedDomains: deps.config.rules.researchBlockedDomains,
        })
      : null;
  const researchUnavailable = researchClient === null ? noKeyMessage() : undefined;

  // Remote delivery (Session 20). The inventory is LOCAL and network-free: git config plus
  // `gh --version`. Knowing a remote is configured is local knowledge; every question whose answer
  // lives on the remote needs authority, so nothing here contacts anything and nothing here
  // establishes who the user is.
  //
  // Built before the prompt for the S19 reason: the prompt's remote paragraph is conditional on
  // the same flag, so the model is never told about a capability its registry does not contain.
  const remoteContext: RemoteContext = await detectRemoteContext({
    gitPath: gitFacts.gitPath,
    repoRoot: gitFacts.repoRoot,
  });
  const ghRunner: GhRunner | null = remoteContext.gh.ghPath !== null ? createGhRunner(remoteContext.gh.ghPath) : null;
  const remoteUnavailable =
    remoteContext.endpoints.length === 0
      ? gitFacts.isRepo
        ? 'no git remote is configured for this repository, so there is nowhere to publish (`git remote add …` first)'
        : 'the workspace is not inside a git repository, so there is no remote to deliver to'
      : undefined;
  const system = buildSystemPrompt(
    ctx.ws,
    map,
    sandboxFacts,
    gitFacts,
    promptMemory(memory),
    detectedWorkspace,
    researchClient !== null,
    remoteUnavailable === undefined ? { defaultRemote: remoteContext.defaultRemote, ghAvailable: ghRunner !== null } : undefined,
  );

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
    // Session 15: production finally sets the elision budget, derived from the model's catalog
    // entry (the seam existed since V0.5 but only tests narrowed it).
    contextBudget: ctx.contextBudget,
    saltHex: randomSaltHex(),
    rules: deps.config.rules,
    sandbox,
    sandboxFacts,
    gitFacts,
    ...(deps.onText !== undefined ? { onText: deps.onText } : {}),
    ...(deps.onCommandOutput !== undefined ? { onCommandOutput: deps.onCommandOutput } : {}),
    ...(deps.onModelRequest !== undefined ? { onModelRequest: deps.onModelRequest } : {}),
  };

  const session = deps.resumeId !== undefined
    ? resumeSession({ ...common, sessionId: deps.resumeId })
    : startSession({ ...common, argv: deps.argv ?? [] });

  if (deps.onLogEvent !== undefined) session.log.onAppend = deps.onLogEvent;
  session.log.append({ type: 'trust.verified', source: deps.trust.source });
  session.log.append({ type: 'config.loaded', sources: deps.config.sources });
  recordSandboxStatus(session, sandboxFacts);
  recordGitContext(session, gitFacts);
  // The local remote inventory, recorded whether or not it is usable. "This session knew there was
  // a remote called origin pointing at X, and that gh was version Y" is the premise every later
  // remote decision rests on, and a premise that is not written down is not evidence.
  session.log.append({
    type: 'remote.context',
    ghVersion: remoteContext.gh.version,
    ghAuthStatusLeakRisk: remoteContext.gh.authStatusLeakRisk,
    remotes: remoteContext.endpoints.map((e) => ({
      name: e.name,
      url: e.displayUrl,
      host: e.host,
      slug: e.slug,
      isGitHub: e.isGitHub,
      hadCredentials: e.hadCredentials,
    })),
    defaultRemote: remoteContext.defaultRemote,
    ...(remoteContext.ambiguity !== null ? { ambiguity: remoteContext.ambiguity } : {}),
    ...(remoteContext.gh.hostOverride !== undefined ? { ghHostOverride: remoteContext.gh.hostOverride } : {}),
    ...(remoteContext.gh.configDirOverride !== undefined ? { ghConfigDirOverride: remoteContext.gh.configDirOverride } : {}),
    tokenEnvNotForwarded: remoteContext.gh.tokenEnvPresentButNotForwarded,
    detail: remoteContext.detail,
  });

  // Resume honesty (Session 15): resuming under a DIFFERENT provider/model used to switch
  // silently — the report kept asserting the original identity for work the new model did.
  // The mismatch is now recorded (newest-wins readers fold it) and surfaced as a note.
  let providerResumeNote: string | undefined;
  if (deps.resumeId !== undefined) {
    const prior = effectiveIdentity(session.log.events).current;
    if (prior !== null && (prior.providerName !== ctx.provider.name || prior.model !== ctx.model)) {
      // 'presence-only' means "a key was found but no list endpoint exists" — claiming it for the
      // mock provider (which has no credential concept at all) would be a fabricated verification
      // label, so the no-credential case is recorded as unverified (S15 review finding).
      session.log.append({
        type: 'provider.changed',
        from: prior,
        to: { providerName: ctx.provider.name, model: ctx.model },
        source: 'resume',
        verification: ctx.provider.name === 'mock' ? 'unverified-network' : 'presence-only',
      });
      providerResumeNote =
        `this session previously ran on ${prior.providerName}·${prior.model} and resumes on ` +
        `${ctx.provider.name}·${ctx.model} — reasoning from the previous model does not carry across; recorded as provider.changed`;
    }
  }
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
  const checkTool = createRunCheckTool({
    workspaceRoot: ctx.ws,
    caps: checkCaps,
    shared: sharedWorkspace,
    // S14.5 (E): a bound test-targeted run with no explicit scope defaults to the plan task's
    // declared touches — same approved-and-current filter as every other gate consumer.
    planTouches: (planTaskId) => {
      const graph = approvedCurrentGraph(readPlanState(layout, session.id, session.log.events));
      const t = graph?.tasks.find((x) => x.id === planTaskId);
      return t !== undefined ? [...t.touches] : null;
    },
  });

  // project_setup (Session 16): dependency installs, migrations and seeding. Per-session for the
  // same snapshot reason, and parent-only for a sharper one than run_check's — an executor's
  // worktree is disposable, so an install there populates a directory about to be deleted, and a
  // migration there writes the REAL local database from what the user believes is isolation.
  const setupCaps = setupCapsFromEvents(session.log.events);
  const setupTool = createProjectSetupTool({ workspaceRoot: ctx.ws, caps: setupCaps, shared: sharedWorkspace });

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
    shared: sharedWorkspace,
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
  // Success-only caching (S16.5b review): a transiently failed probe must not waive browser
  // gates for the rest of the session. See cacheSuccessfulProbe.
  const cachedProbe = cacheSuccessfulProbe(probeBrowser);
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
    // Read at CALL time (closure over the live session) so /provider and /model switches are
    // honored: a text-only model refuses the LOOK, never the evidence (Session 15).
    modelInfo: () => ({
      model: session.model,
      visionInput: capsFor(session.provider.name as ProviderName, session.model).visionInput,
    }),
  });

  // ONE budget object for the whole session, seeded from the parent's events so a resume cannot
  // refill it, and handed by reference to the parent's tool AND to every researcher child's.
  const researchBudget: ResearchBudget = researchBudgetFromEvents(session.log.events);

  // ONE remote-state object for the whole session. Spend is rebuilt from events (a resume cannot
  // refill the allowance); observations and the gh identity are NOT — they live in memory only, so
  // a resumed session must look at the remote again before it may change it. That asymmetry is the
  // point, and it matches how grants are never restored.
  const remoteState: RemoteState = createRemoteState({
    context: remoteContext,
    initialSpend: remoteSpendFromEvents(session.log.events),
  });
  const remoteGitDeps =
    gitFacts.gitPath !== null && gitFacts.repoRoot !== null
      ? { gitPath: gitFacts.gitPath, repoRoot: gitFacts.repoRoot, workspaceRoot: ctx.ws }
      : null;

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
      // "Start a new preview" was a dead end when the survivor STILL HOLDS its port: Vite's
      // strictPort exits EADDRINUSE, and the api's announcement-gated readiness rightly refuses
      // to adopt a foreign server — so name the possibility and the honest way out (S16.5b).
      previewResumeNote = unended
        .map(
          ([id, v]) =>
            `preview ${id} (${v.command}) was running when the previous life ended; ${outcome(id, v.pid)}. ` +
            `It is NOT attached to this session. If its process is still alive it still holds its port — verify and stop it (pid above) before starting a replacement; otherwise start a new preview.`,
        )
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
    setupTool,
    previewTool,
    browserTool,
    viewImageTool,
    readDocumentTool,
    // Session 19: the parent gets web_search ONLY. web_extract (full page text) and record_source
    // are researcher-only, which is what makes "the main agent never receives raw webpages" a
    // property of the registry rather than a hope about behaviour.
    ...(researchClient !== null ? [createWebSearchTool({ client: researchClient, budget: researchBudget })] : []),
    // Session 20: three instances, and only when a remote actually exists. They are parent-only —
    // no role registry names them, and `CHILD_ADMISSIBLE_FACTS` refuses both remote facts — so
    // "no subagent reaches the remote" is a property of the registry, not a hope about behaviour.
    ...(remoteUnavailable === undefined
      ? [
          createRemoteStatusTool({ state: remoteState, gh: ghRunner, git: remoteGitDeps }) as Tool,
          createRemotePushTool({ state: remoteState, git: remoteGitDeps, events: () => session.log.events }) as Tool,
          createRemoteReleaseTool({
            state: remoteState,
            gh: ghRunner,
            git: remoteGitDeps,
            // The notes file is staged in the PROJECT STATE dir, never the workspace: it is a
            // transient argument to gh, not a workspace artifact, and the workspace is where a
            // path validator would rightly refuse an undeclared write.
            notesDir: layout.projectDir,
            events: () => session.log.events,
          }) as Tool,
        ]
      : []),
    createRenderDocumentTool({ probe: cachedProbe, caps: renderCapsFromEvents(session.log.events) }),
    createInspectPagesTool({
      probe: cachedProbe,
      putBlob: (bytes) => session.snapshots.putBlob(bytes),
      events: () => session.log.events,
      budget: inspectBudgetFromEvents(session.log.events),
      modelInfo: () => ({
        model: session.model,
        visionInput: capsFor(session.provider.name as ProviderName, session.model).visionInput,
      }),
    }),
    createDelegateTool(
      {
        layout,
        workspaceRoot: ctx.ws,
        model: ctx.model,
        maxTokens: ctx.maxTokens,
        provider: ctx.provider,
        // Session 15: children follow the LIVE session identity across /provider and /model
        // switches (read per delegate call), so a child's session.started records the truth.
        currentRuntime: () => ({
          model: session.model,
          maxTokens: session.maxTokens,
          provider: session.provider,
          ...(session.contextBudget !== undefined ? { contextBudget: session.contextBudget } : {}),
        }),
        rules: deps.config.rules,
        sandbox,
        sandboxFacts,
        gitFacts,
        map,
        forwardAsk: (req, signal) => forwarder.ask(req, signal),
        ...(retrieveTool !== undefined ? { retrieveTool } : {}),
        // Session 19: a FACTORY, not finished instances. These three need the credential, the
        // proxy transport, the operator denylist and the ONE shared budget — none of which the
        // delegate has — so assembly closes over them and the delegate supplies only the per-task
        // accumulator. Absent when no credential is configured, which is what makes the delegate
        // refuse a researcher spawn instead of starting a child with no tools.
        ...(researchClient !== null
          ? {
              researchBudget,
              researchToolsFor: (acc: NoteAccumulator) => {
                // Per-TASK state, created fresh on each call because this factory runs once per
                // task: the page ceiling and the spend counter are the task's own, while the
                // budget closed over above stays shared across the whole session.
                const taskSpend = { searches: 0, extracts: 0, credits: 0, contentChars: 0 };
                return {
                  taskSpend,
                  webSearch: createWebSearchTool({ client: researchClient, budget: researchBudget, taskSpend }) as Tool,
                  // The page cap came from the live S19 run, where one researcher spent 10 of the
                  // 12 session extracts and then timed out with nothing recorded.
                  webExtract: createWebExtractTool({
                    client: researchClient,
                    budget: researchBudget,
                    taskCap: EXTRACTS_PER_RESEARCH_TASK,
                    taskSpend,
                  }) as Tool,
                  recordSource: createRecordSourceTool({ acc }) as Tool,
                };
              },
            }
          : {}),
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
      // The UNION across every detected project: plan validation only warns, and warning that a
      // gate is unrunnable because the ROOT cannot run it would be wrong in exactly the
      // multi-project workspaces this session exists to support.
      availableChecks: () => [...workspaceAvailableKinds(checkTool.workspaceSnapshot()), ...(likelyBrowserAvailable() ? (['browser'] as const) : [])],
      knownProjects: () => checkTool.workspaceSnapshot().units.map((u) => u.id),
      // The reopened-completed-tasks warning (S16.5b): the fold needs the live event stream.
      events: () => session.log.events,
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
      planGraph: () => approvedCurrentGraph(readPlanState(layout, session.id, session.log.events)),
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
    researchBudget,
    ...(researchUnavailable !== undefined ? { researchUnavailable } : {}),
    remoteState,
    ...(remoteUnavailable !== undefined ? { remoteUnavailable } : {}),
    checkTool,
    checkCaps,
    setupTool,
    setupCaps,
    previewTool,
    previewCaps,
    stopAllPreviews,
    ...(previewResumeNote !== undefined ? { previewResumeNote } : {}),
    ...(providerResumeNote !== undefined ? { providerResumeNote } : {}),
    ...(ranked.note !== null ? { mapNote: ranked.note } : {}),
    ...(worktreeSweep !== undefined ? { worktreeSweep } : {}),
    ...(previewSweep !== undefined ? { previewSweep } : {}),
    ...(projectsNote !== undefined ? { projectsNote } : {}),
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
  // A task failure inherits the project its plan task declared, so its repair proof must come
  // from that project — the same rule a check failure already followed.
  const taskProjects = new Map(graph.tasks.filter((t) => t.project !== undefined).map((t) => [t.id, t.project!] as const));
  for (const task of graph.tasks) {
    const evidence = latestFailureEvidence(events, task.id, taskProjects);
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
