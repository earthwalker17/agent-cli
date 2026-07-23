import path from 'node:path';
import { z } from 'zod';
import type { SubagentRoleName, TaskChangeFile, Tool, ToolContext, ToolResult } from '../types.js';
import {
  neutralizeHarnessDelimiters,
  runSubagentTask,
  SESSION_CHILD_OUTPUT_TOKEN_CAP,
  TASKS_PER_SESSION,
  type SubagentDeps,
  type SubagentResult,
} from '../runtime/subagent.js';
import fs from 'node:fs';
import { captureTaskChanges, type CaptureResult } from '../runtime/task-changes.js';
import { newWorktreeDir, registerWorktree, unregisterWorktree } from '../runtime/worktrees.js';
import { addWorktree, removeWorktree, worktreeSupport } from '../git/worktree.js';
import { createCheckpoint } from '../git/checkpoint.js';
import { detectGitFacts } from '../git/facts.js';
import { buildWorkspaceMapAuto } from '../workspace/map.js';
import { truncateForModel } from '../shared/hash.js';
import type { SnapshotStore } from '../store/snapshots.js';

/**
 * delegate_task — the model-facing surface of the subagent runner. Built PER SESSION at assembly
 * (never a member of the static TOOLS array): parents get an instance, children never do, so
 * recursion is impossible by construction. V0.7: one call takes 1–3 tasks that run as a PARALLEL
 * GROUP — one call = one attributable evidence unit, and for a group containing the mutating
 * executor role, ONE human approval (policy: ask, every time). Budgets and caps are
 * harness-fixed — the model chooses what to delegate, never how much authority or budget a
 * child gets.
 *
 * Executor orchestration lives HERE (the runner stays role-agnostic): one base checkpoint per
 * group (captures the parent's CURRENT working tree, dirty state included) → a detached git
 * worktree per executor task at a policy-safe temp home → the child runs scoped to the worktree
 * → changes are captured as content-addressed blobs + a task.changes event → the worktree is
 * ALWAYS removed (the diff outlives it; removal failure is honest evidence for the sweep).
 */

const TaskSpec = z
  .object({
    role: z
      .enum(['explorer', 'planner', 'reviewer', 'executor'])
      .describe('explorer: read-only survey/search. planner: read-only plan drafting. reviewer: read-only adversarial diff review. executor: implements changes in an ISOLATED git worktree (requires your approval to spawn; its approvals forward to the user).'),
    task: z.string().min(1).max(4000).describe('What to do, with the concrete questions the report must answer'),
    context: z
      .string()
      .max(20000)
      .optional()
      .describe('Verbatim supporting material for the child (findings, a scoped diff, the relevant plan tasks). It has its OWN context window — include what it needs, nothing more.'),
    expected_output: z.string().max(1000).optional().describe('Optional: the shape of the report you want back'),
    focus: z
      .array(z.string().min(1).max(260))
      .max(16)
      .optional()
      .describe('Workspace-relative path prefixes this task OWNS (e.g. ["src/runtime"]). Parallel tasks should have non-overlapping focus sets; each task sees its siblings\' focus as territory to avoid.'),
    avoid: z
      .array(z.string().min(1).max(260))
      .max(16)
      .optional()
      .describe('Workspace-relative path prefixes this task must NOT spend budget on (covered elsewhere or out of scope).'),
  })
  .strict();

const DelegateInput = z
  .object({
    tasks: z
      .array(TaskSpec)
      .min(1)
      .max(3)
      .describe('1–3 tasks. Tasks in ONE call run IN PARALLEL — batch only independent work (for executors: disjoint file ownership); sequence dependent work across separate calls.'),
  })
  .strict();
type DelegateInputT = z.infer<typeof DelegateInput>;

/** Plan gate + consent-display state, read fresh from the file and events (bytes are truth). */
export interface PlanGateContext {
  status: 'none' | 'draft' | 'approved' | 'superseded' | 'unknown';
  /** sha256 of the plan file's CURRENT bytes; null when absent/unreadable. */
  currentSha: string | null;
  /** The sha the user last approved (from plan.approved/plan.discarded events); null = none. */
  approvedSha: string | null;
  /** status says approved but the file's bytes are no longer the approved bytes. */
  diverged: boolean;
}

/** Everything executor orchestration needs from assembly; absent ⇒ executors honestly unavailable. */
export interface ExecutorDeps {
  gitPath: string;
  gitVersion: string | null;
  repoRoot: string;
  /** Harness scratch (the project state dir): checkpoint temp index + capture staging. */
  stateDir: string;
  worktreesRoot: string;
  registryFile: string;
  snapshots: SnapshotStore;
  /** Current plan gate state, read fresh per use (gate at execute; display at the ask). */
  planContext: () => PlanGateContext;
  /**
   * Called with each group's base-checkpoint ref so assembly can prune them at session end
   * (V0.7.1): the ref is a live recovery point only while the session runs — the captured
   * blobs + task.changes events are the durable record, and silently accumulating one hidden
   * ref per executor group pollutes the user's repo.
   */
  noteBaseRef: (ref: string) => void;
  /** Feed the in-session apply registry the moment changes are captured. */
  registerChanges: (childSessionId: string, baseOid: string, files: TaskChangeFile[], omittedCount?: number) => void;
  clockIso: () => string;
}

interface TaskOutcome {
  result: SubagentResult;
  /** Extra harness lines for this task's report section (capture summary, worktree warnings). */
  notes: string[];
  capturedPaths: string[];
}

/**
 * Session 10: the required section headers of a completed explorer report. Prompt-enforced;
 * the harness CHECK below is informational only (a budget-cut report is legitimately partial —
 * flagging it must inform the parent, never manufacture failure).
 */
export const EXPLORER_REPORT_SECTIONS = [
  '## Scope inspected',
  '## Scope skipped',
  '## Findings',
  '## Change sites and risks',
  '## Tests',
  '## Open questions',
] as const;

/** Explorer-only: which required report sections a report lacks. */
export function missingExplorerSections(finalText: string): string[] {
  return EXPLORER_REPORT_SECTIONS.filter((s) => !finalText.includes(s));
}

function normalizePrefix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function prefixesOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

/**
 * Session 10: per-task brief lines (focus/avoid + sibling coverage) and group-level overlap
 * warnings, composed deterministically from the structured fields. Guidance and measurement,
 * deliberately NOT enforcement: read-only exploration crossing a path boundary is a cost
 * problem, not a safety problem, and pretending otherwise would be enforcement theater.
 */
export function composeBriefs(
  tasks: ReadonlyArray<{ role: string; focus?: string[] | undefined; avoid?: string[] | undefined }>,
  workspaceRoot: string,
): { briefs: string[][]; groupNotes: string[] } {
  const focusSets = tasks.map((t) => (t.focus ?? []).map(normalizePrefix).filter((p) => p.length > 0));
  const briefs = tasks.map((t, i) => {
    const lines: string[] = [];
    const focus = focusSets[i]!;
    if (focus.length > 0) {
      lines.push(`- Focus — paths this task owns: ${focus.join(', ')}`);
      const missing = focus.filter((p) => {
        try {
          return !fs.existsSync(path.join(workspaceRoot, p));
        } catch {
          return true;
        }
      });
      if (missing.length > 0) {
        lines.push(`- note: focus path(s) not found in the workspace right now: ${missing.join(', ')} — treat as a hint, not truth`);
      }
    }
    const avoid = (t.avoid ?? []).map(normalizePrefix).filter((p) => p.length > 0);
    if (avoid.length > 0) lines.push(`- Avoid — out of this task's scope: ${avoid.join(', ')}`);
    for (let j = 0; j < tasks.length; j++) {
      if (j === i || focusSets[j]!.length === 0) continue;
      lines.push(`- Sibling task ${j + 1} (${tasks[j]!.role}) owns: ${focusSets[j]!.join(', ')} — do not spend budget there.`);
    }
    return lines;
  });
  const groupNotes: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const shared = focusSets[i]!.filter((a) => focusSets[j]!.some((b) => prefixesOverlap(a, b)));
      if (shared.length > 0) {
        groupNotes.push(
          `WARNING — overlapping focus between task ${i + 1} and task ${j + 1} (${shared.join(', ')}): expect duplicated exploration; prefer disjoint focus sets.`,
        );
      }
    }
  }
  return { briefs, groupNotes };
}

export function createDelegateTool(deps: SubagentDeps, parentSessionId: string, executor?: ExecutorDeps): Tool<DelegateInputT> {
  let tasksStarted = 0;
  let childOutputTokens = 0;
  return {
    name: 'delegate_task',
    description:
      'Delegate 1–3 bounded subagent tasks, each with its own isolated context; tasks in one call run IN PARALLEL. ' +
      'Read-only roles: explorer (survey/search/analysis that would flood this conversation), planner (draft a plan ' +
      'document from findings), reviewer (adversarial review of a diff, findings classified by severity). Mutating ' +
      'role: executor — implements a task inside an ISOLATED git worktree (never the real workspace); spawning asks ' +
      'the user every time, the executor\'s own risky calls forward to the user, and its changes only reach the ' +
      'workspace via apply_task_changes after your review. Reports are NARRATION, not verified evidence — verify ' +
      'load-bearing claims before relying on them.',
    schema: DelegateInput,
    // Null = undeclarable side effects; irrelevant to policy here because the `delegates` branch
    // decides FIRST (and a delegates+command combination is denied outright).
    mutates: () => null,
    delegates: (i) => ({ roles: i.tasks.map((t) => t.role) }),
    // Display-only plan state for the executor-spawn ask (V0.7.1): the human approving a spawn
    // must SEE whether the plan they approved is still the plan on disk. Read fresh at ask time;
    // the gate below re-reads at execute time (fresher — the safe direction). Never policy.
    approvalContext: (i) => {
      if (!i.tasks.some((t) => t.role === 'executor') || executor === undefined) return [];
      const p = executor.planContext();
      const short = (sha: string | null): string => (sha !== null ? sha.slice(0, 12) : '(unknown)');
      if (p.status === 'none') return ['plan: none — no plan document exists for this session'];
      if (p.status === 'approved') {
        if (p.approvedSha === null) {
          return ['plan: file says APPROVED but no /plan approve is recorded this session (status possibly hand-edited) — review /plan show'];
        }
        return p.diverged
          ? [`plan: APPROVED but DIVERGED after approval (approved ${short(p.approvedSha)}, current ${short(p.currentSha)}) — review /plan show before allowing`]
          : [`plan: APPROVED (sha ${short(p.currentSha)}, matches the user-approved bytes)`];
      }
      if (p.status === 'superseded') return ['plan: SUPERSEDED (discarded) — executors would run without an active plan'];
      return [`plan: ${p.status.toUpperCase()} — executor tasks will refuse until /plan approve`];
    },
    async execute(input, ctx): Promise<ToolResult> {
      const refuse = (error: string): ToolResult => ({ ok: false, output: '', error, durationMs: 0, truncated: false });
      // Group-atomic caps: a group either fully fits the remaining budget or is refused whole —
      // silently starting a partial group would misreport what the model asked for.
      if (tasksStarted + input.tasks.length > TASKS_PER_SESSION) {
        return refuse(
          `task budget exhausted: this session already delegated ${tasksStarted} of ${TASKS_PER_SESSION} tasks and the group of ${input.tasks.length} does not fit; finish the work directly with your own tools`,
        );
      }
      if (childOutputTokens >= SESSION_CHILD_OUTPUT_TOKEN_CAP) {
        return refuse(
          `delegation output-token budget exhausted (${childOutputTokens} of ${SESSION_CHILD_OUTPUT_TOKEN_CAP} output tokens across child tasks); finish the work directly with your own tools`,
        );
      }

      // Executor preconditions — all checked BEFORE anything spawns, so a refusal spawns nothing.
      const executorCount = input.tasks.filter((t) => t.role === 'executor').length;
      let baseOid: string | null = null;
      if (executorCount > 0) {
        if (executor === undefined) {
          return refuse('executor tasks need a git repository with a probed git binary; none is available in this session');
        }
        const support = worktreeSupport(executor.gitVersion);
        if (!support.ok) return refuse(`executor tasks unavailable: ${support.reason}`);
        const plan = executor.planContext();
        if (plan.status === 'draft' || plan.status === 'unknown') {
          return refuse(
            `a plan document exists but is not approved (status: ${plan.status}) — executor tasks are blocked until the user runs /plan approve (or /plan discard)`,
          );
        }
        // ONE base checkpoint per group, created sequentially before any fan-out: every member
        // starts from the same attributable oid, dirty parent state included.
        const base = await createCheckpoint(
          { gitPath: executor.gitPath, repoRoot: executor.repoRoot, workspaceRoot: deps.workspaceRoot, stateDir: executor.stateDir },
          parentSessionId,
          { label: 'task base' },
        );
        if (!base.ok || base.oid === undefined) {
          return refuse(`cannot capture the task-base checkpoint: ${base.error ?? 'unknown error'}`);
        }
        baseOid = base.oid;
        if (base.ref !== undefined) executor.noteBaseRef(base.ref);
      }
      tasksStarted += input.tasks.length;

      // Brief composition (Session 10): focus/avoid + sibling coverage per task, overlap
      // warnings for the group — deterministic, before any child exists.
      const composed = composeBriefs(input.tasks, deps.workspaceRoot);

      // Fan out. Group size is schema-capped at 3, so Promise.all IS the concurrency limit.
      // Each child gets its own session/log; evidence events interleave at event granularity
      // through the shared callId-bound reportTask channel (join key: childSessionId).
      const outcomes: TaskOutcome[] = await Promise.all(
        input.tasks.map(async (t, index): Promise<TaskOutcome> => {
          const spec = {
            role: t.role as SubagentRoleName,
            task: t.task,
            parentSessionId,
            ...(t.context !== undefined ? { context: t.context } : {}),
            ...(t.expected_output !== undefined ? { expectedOutput: t.expected_output } : {}),
            ...(composed.briefs[index]!.length > 0 ? { briefLines: composed.briefs[index]! } : {}),
          };
          const provider = deps.providerForTask?.(index, spec.role) ?? deps.provider;
          const taskDeps: SubagentDeps = {
            ...deps,
            provider,
            ...(ctx.reportTask !== undefined ? { reportTask: ctx.reportTask } : {}),
          };
          if (spec.role !== 'executor') {
            return { result: await runSubagentTask(taskDeps, spec, ctx.signal), notes: [], capturedPaths: [] };
          }
          return runExecutorTask(taskDeps, spec, executor!, baseOid!, ctx);
        }),
      );
      for (const o of outcomes) childOutputTokens += o.result.usage.outputTokens;

      // Overlap detection across the group's captured write-sets (apply order defines the
      // winner; the warning makes the collision visible BEFORE anything integrates).
      const groupNotes: string[] = [...composed.groupNotes];
      if (executorCount > 1) {
        const seen = new Map<string, number>();
        for (const o of outcomes) for (const p of o.capturedPaths) seen.set(p, (seen.get(p) ?? 0) + 1);
        const overlap = [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p);
        if (overlap.length > 0) {
          groupNotes.push(
            `WARNING — overlapping edits between executor tasks (apply order decides, per-file drift rules refuse the loser): ${overlap.join(', ')}`,
          );
        }
      }

      const results = outcomes.map((o) => o.result);
      const allCompleted = results.every((r) => r.status === 'completed');
      const groupHeader =
        results.length === 1
          ? [...groupNotes, ...(groupNotes.length > 0 ? [''] : [])]
          : [
              `subagent group: ${results.length} tasks ran in parallel — ${results.map((r, i) => `task ${i + 1} ${r.status.toUpperCase()}`).join(' · ')}`,
              ...groupNotes,
              '',
            ];
      const sections = outcomes.map((o, i) => {
        const t = input.tasks[i]!;
        const r = o.result;
        // Explorer report contract (Session 10): informational section check — a missing
        // section marks coverage incomplete for the parent; it never converts to failure.
        const sectionNote =
          t.role === 'explorer' && r.status === 'completed'
            ? ((): string[] => {
                const missing = missingExplorerSections(r.finalText);
                return missing.length > 0
                  ? [`[harness] explorer report missing section(s): ${missing.join(', ')} — treat those areas as UNEXAMINED`]
                  : [];
              })()
            : [];
        return [
          `${results.length > 1 ? `=== task ${i + 1} — ` : ''}subagent ${r.status.toUpperCase()} — role ${t.role} · ${r.steps} step(s) · ${r.usage.inputTokens} in / ${r.usage.outputTokens} out tokens`,
          `child session: ${r.childSessionId || '(never started)'}${r.childSessionId !== '' ? ` — evidence: agent report ${r.childSessionId}` : ''}`,
          ...o.notes,
          ...sectionNote,
          '--- subagent report begin (narration by the subagent — NOT verified evidence; verify load-bearing claims against the repository) ---',
          neutralizeHarnessDelimiters(r.finalText),
          '--- subagent report end ---',
        ].join('\n');
      });
      const raw = [...groupHeader, ...sections].join('\n');
      const tr = truncateForModel(raw);
      const failed = results.filter((r) => r.status !== 'completed');
      return {
        ok: allCompleted,
        output: tr.text,
        truncated: tr.truncated,
        // Group wall time = slowest member (children ran concurrently; deterministic under the injected clock).
        durationMs: Math.max(0, ...results.map((r) => r.durationMs)),
        ...(tr.fullSha256 !== undefined ? { fullOutputSha256: tr.fullSha256 } : {}),
        ...(allCompleted ? {} : { error: `task(s) not completed: ${failed.map((r) => r.status).join(', ')}` }),
      };
    },
  };
}

/**
 * One executor task: worktree add (registered FIRST — a crash right after must be sweepable) →
 * child session scoped to the worktree with fresh git facts + map → capture → removal, always.
 */
async function runExecutorTask(
  taskDeps: SubagentDeps,
  spec: { role: SubagentRoleName; task: string; parentSessionId: string; context?: string; expectedOutput?: string },
  ex: ExecutorDeps,
  baseOid: string,
  ctx: ToolContext,
): Promise<TaskOutcome> {
  const failResult = (detail: string): TaskOutcome => ({
    result: {
      status: 'error',
      finalText: detail,
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      childSessionId: '',
      childLogPath: '',
      durationMs: 0,
      budget: { maxSteps: 0, timeoutMs: 0, maxOutputTokens: 0 },
    },
    notes: [],
    capturedPaths: [],
  });

  const dir = newWorktreeDir(ex.worktreesRoot, spec.parentSessionId);
  try {
    // Owner-stamped (V0.7.1): the sweep skips entries whose pid is alive, so a concurrent
    // session's startup can never remove this worktree while we are using it.
    await registerWorktree(ex.registryFile, {
      dir,
      repoRoot: ex.repoRoot,
      childSessionId: '',
      createdAt: ex.clockIso(),
      ownerSessionId: spec.parentSessionId,
      pid: process.pid,
    });
  } catch (err) {
    return failResult(`executor setup failed: cannot record the worktree registry entry (${(err as Error).message})`);
  }
  const add = await addWorktree(ex.gitPath, ex.repoRoot, dir, baseOid);
  if (!add.ok) {
    try {
      await unregisterWorktree(ex.registryFile, dir);
    } catch {
      /* registry cleanup is best-effort; the sweep is path-guarded anyway */
    }
    return failResult(`executor setup failed: git worktree add: ${add.error ?? 'unknown error'}`);
  }
  // childSessionId is '' here by necessity: the worktree exists BEFORE its child session; the
  // shared callId joins this event to the task.started that follows.
  ctx.reportTask?.({ kind: 'worktree-created', childSessionId: '', path: dir, baseOid });

  const notes: string[] = [];
  let capturedPaths: string[] = [];
  let result: SubagentResult = failResult('executor task did not run').result;
  try {
    // Subdir workspaces: the checkpoint tree spans the whole repo; the child must live at the
    // same relative subtree inside the worktree, and capture filters to it.
    const wsRelOs = path.relative(ex.repoRoot, taskDeps.workspaceRoot);
    const wsRel = wsRelOs.split(path.sep).join('/');
    const childWs = wsRelOs.length > 0 ? path.join(dir, wsRelOs) : dir;
    try {
      const childGitFacts = await detectGitFacts(childWs);
      const childMap = await buildWorkspaceMapAuto(childWs, {}, childGitFacts);
      result = await runSubagentTask(
        { ...taskDeps, workspaceRoot: childWs, gitFacts: childGitFacts, map: childMap },
        spec,
        ctx.signal,
      );
    } catch (err) {
      // runSubagentTask never throws; a probe/map throw must still flow into honest capture +
      // guaranteed removal rather than escaping past the finally with half a task recorded.
      result = failResult(`executor task failed before the child ran: ${(err as Error).message}`).result;
    }

    // Capture even for aborted/timeout/user-stopped children: partial work is still evidence;
    // whether it integrates stays a decision for the main agent and the user.
    const cap: CaptureResult = await captureTaskChanges({
      gitPath: ex.gitPath,
      worktreeDir: dir,
      wsRel,
      baseOid,
      snapshots: ex.snapshots,
      scratchDir: ex.stateDir,
    });
    if (cap.error !== undefined) {
      notes.push(`[harness] change capture FAILED: ${cap.error} — nothing from this task can be integrated`);
    } else {
      ctx.reportTask?.({
        kind: 'changes',
        childSessionId: result.childSessionId,
        baseOid,
        files: cap.files,
        ...(cap.omittedCount > 0 ? { omittedCount: cap.omittedCount } : {}),
      });
      ex.registerChanges(result.childSessionId, baseOid, cap.files, cap.omittedCount);
      capturedPaths = cap.files.map((f) => f.relPath);
      const oversize = cap.files.filter((f) => f.oversize === true).length;
      notes.push(
        `[harness] captured ${cap.files.length} changed file(s)${cap.omittedCount > 0 ? ` (+${cap.omittedCount} omitted over the cap)` : ''}${oversize > 0 ? `, ${oversize} oversize (recorded, not integrable)` : ''} vs base ${baseOid.slice(0, 12)} — review, then integrate with apply_task_changes {"child_session_id": "${result.childSessionId}"}`,
      );
    }
  } finally {
    const rem = await removeWorktree(ex.gitPath, ex.repoRoot, dir);
    if (rem.ok) {
      try {
        await unregisterWorktree(ex.registryFile, dir);
      } catch {
        /* stale entry is harmless: the sweep skips missing dirs */
      }
    } else {
      notes.push(`[harness] worktree removal FAILED (${rem.detail ?? 'unknown'}); it stays registered for the startup sweep`);
    }
    ctx.reportTask?.({
      kind: 'worktree-removed',
      childSessionId: result.childSessionId,
      ok: rem.ok,
      ...(rem.detail !== undefined ? { detail: rem.detail } : {}),
    });
  }
  return { result, notes, capturedPaths };
}
