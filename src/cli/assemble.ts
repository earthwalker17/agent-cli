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
import { createUpdatePlanTool } from '../tools/update-plan.js';
import { createApplyChangesTool, createTaskChangesRegistry } from '../tools/apply-changes.js';
import { createApprovalForwarder } from '../runtime/approval-forwarder.js';
import { registryFile, sweepOrphanedWorktrees, worktreesRoot } from '../runtime/worktrees.js';
import { readPlanState } from '../plan/canonical.js';
import { foldGraphState } from '../plan/graph-state.js';
import { deleteCheckpointRefs } from '../git/checkpoint.js';
import { randomSaltHex } from '../shared/hash.js';
import type { ProjectLayout } from '../store/layout.js';
import type { ResolvedConfig } from '../config/config.js';
import type { TrustDecision } from '../trust/gate.js';
import type { EventBody, SessionEvent } from '../types.js';
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
  /**
   * Delete this session's task-base checkpoint refs (V0.7.1) — call at clean session end,
   * BEFORE endSession (the provenance event must land in the open log). Returns a one-line
   * summary for chrome, or null when there is nothing to prune. Absent without a repo.
   */
  pruneTaskBaseRefs?: () => Promise<string | null>;
  /** The live delegation counters (Session 11, events-rebuilt) — read-only for the status area. */
  delegateCaps: DelegateCaps;
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

  // Child→parent approval forwarding (V0.7): the queue wraps the SESSION approver — never io
  // directly — so non-interactive parents fail closed structurally and EOF cascades deny-stop.
  const forwarder = createApprovalForwarder(ctx.approver, deps.onTaskProgress);
  // Captured executor changes, keyed by child session; REBUILT FROM EVENTS on resume so a
  // crash between capture and apply never strands integrable work.
  const changesRegistry = createTaskChangesRegistry();
  for (const e of session.log.events) {
    if (e.type === 'task.changes') changesRegistry.register(e.childSessionId, e.baseOid, e.files, e.omittedCount);
  }
  // Task-base checkpoint refs created for executor groups this session; pruned at session end.
  const taskBaseRefs: string[] = [];
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
          noteBaseRef: (ref) => taskBaseRefs.push(ref),
          clockIso: () => session.clock.iso(),
        }
      : undefined;

  // Plan gate state (Session 11), read FRESH per use — the file's current bytes are truth and
  // the approval binding lives in events. Wired independently of the executor bundle because
  // DAG bindings gate read-only tasks too. The fold gives the gate live dependency states.
  const planContext = (): PlanGateInfo => {
    const state = readPlanState(layout, session.id, session.log.events);
    const graph = state.canonical?.graph ?? null;
    return { state, graphState: graph !== null ? foldGraphState(graph, session.log.events) : null };
  };
  // Delegation caps REBUILT FROM EVENTS (Session 11): a resumed session keeps counting where it
  // left off — the changes-registry pattern applied to the budget counters.
  const delegateCaps = delegateCapsFromEvents(session.log.events);

  // Session-end hygiene (V0.7.1): the task-base ref is a live recovery point only while the
  // session runs — blobs + task.changes events are the durable record. Announced + recorded;
  // a crash before this leaks the refs to manual `agent checkpoint prune` (documented).
  const pruneTaskBaseRefs =
    executorDeps === undefined
      ? undefined
      : (): Promise<string | null> =>
          pruneTaskBaseCheckpointRefs(executorDeps.gitPath, executorDeps.repoRoot, taskBaseRefs.splice(0), session.log);

  // retrieve (Session 10): a per-session READ-ONLY view over the assembly-built index. The
  // parent gets it directly; read-only child roles get the SAME instance through the named
  // SubagentDeps.retrieveTool seam (executors deliberately not — wrong tree).
  const retrieveTool = ranked.handle !== null ? createRetrieveTool(ranked.handle) : undefined;

  // The delegate tool is a PER-SESSION instance appended to a fresh array (never TOOLS.push):
  // parents get it; child sessions have fixed role registries without it, so delegation depth
  // is 1 by construction. Children inherit the PROBED sandbox instance (no re-probe), the
  // narrowing rules, and the user constitution.
  session.tools = [
    ...session.tools,
    ...(retrieveTool !== undefined ? [retrieveTool] : []),
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
    createUpdatePlanTool({ layout, snapshots: session.snapshots, planId: session.id }),
    createApplyChangesTool(changesRegistry, session.snapshots),
  ];

  return {
    session,
    sandboxFacts,
    gitFacts,
    map,
    memory,
    retrieval: ranked.handle,
    delegateCaps,
    ...(ranked.note !== null ? { mapNote: ranked.note } : {}),
    ...(worktreeSweep !== undefined ? { worktreeSweep } : {}),
    ...(pruneTaskBaseRefs !== undefined ? { pruneTaskBaseRefs } : {}),
  };
}

/**
 * The session-end task-base prune (V0.7.1), factored for testability: delete the refs, record
 * the provenance event (a silent ref delete would violate the evidence invariant), return the
 * chrome summary line. `splice(0)` at the call site guarantees never-double-prune.
 */
export async function pruneTaskBaseCheckpointRefs(
  gitPath: string,
  repoRoot: string,
  refs: readonly string[],
  log: { append(body: EventBody): unknown },
): Promise<string | null> {
  if (refs.length === 0) return null;
  const r = await deleteCheckpointRefs(gitPath, repoRoot, [...new Set(refs)]);
  try {
    log.append({ type: 'git.checkpoint.pruned', kind: 'task-base', refs: r.deleted, failed: r.failed });
  } catch {
    /* best-effort hygiene: a failing log at quit must not block the end path */
  }
  return (
    `pruned ${r.deleted.length} task-base checkpoint ref(s)` +
    (r.failed.length > 0 ? `; ${r.failed.length} failed (agent checkpoint prune)` : '')
  );
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
