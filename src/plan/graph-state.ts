import type { CheckKind, CheckStatus, SessionEvent, TaskChangeFile } from '../types.js';
import { planTaskDefinitionSha, topoOrder, type PlanGraph, type PlanTaskRole } from './schema.js';


/**
 * Execution state of the approved plan's task graph — a PURE fold over (plan graph, events),
 * the house pattern (like the captured-changes registry): no new store, identical re-derivation
 * on resume, and exactly one truth for "what happened" (the event log).
 *
 * Live-only phases ('running', 'awaiting-approval') come from the in-memory task table via the
 * optional `live` overlay, never from events: after a crash/resume they honestly collapse to
 * 'interrupted' with the child-log pointer, because the events genuinely cannot say more.
 */

export type PlanTaskStateName =
  | 'queued' // deps satisfied, not yet spawned
  | 'blocked' // waiting on unmet dependencies
  | 'running' // live overlay only
  | 'awaiting-approval' // live overlay only (a forwarded ask is displayed/queued)
  | 'integrating' // ended completed, captured changes not yet fully applied
  | 'completed' // ended completed AND integrated (or nothing to integrate)
  | 'failed' // ended error/timeout/budget-*/stalled — re-spawnable
  | 'cancelled' // ended aborted/user-stopped/cancelled — re-spawnable
  | 'parent-owned' // role 'main': the parent does it; the harness cannot verify completion
  | 'interrupted'; // started but never ended, and not live — crash/resume evidence

/** One binding's recorded outcome (Session 11.5): what each attempt actually did. */
export interface PlanTaskAttempt {
  childSessionId: string;
  /** The child's ended status, 'running'/'awaiting-approval' from the live overlay, or 'interrupted'. */
  outcome: string;
  /** The definition sha recorded at spawn; absent on pre-11.5 bindings. */
  planTaskSha?: string;
}

/**
 * The per-task verification gate (Session 12). Deliberately a FIELD on a `completed` task rather
 * than a new state name: R5 refuses re-running a `completed` task precisely because its captured
 * changes are already in the workspace, and a separate "unverified" state would have taken a
 * fully-integrated task out of that protection while R10's ceiling (which ignores `completed`
 * outcomes) could not bound the resulting re-runs.
 *
 * What a green gate PROVES, exactly: the declared check kinds passed on the workspace at a point
 * AFTER this task's own work was integrated. It does not prove the checks exercised this task's
 * code — later unrelated changes do not invalidate it either, which is why `gates.completion`
 * exists for the combined state.
 */
export interface TaskVerification {
  required: CheckKind[];
  /** Kinds satisfied by a passing run after this task's integration. */
  satisfied: CheckKind[];
  /** Kinds satisfied only because the project cannot run them — recorded, never silent. */
  waived: CheckKind[];
  missing: CheckKind[];
  status: 'none' | 'green' | 'waived' | 'pending';
}

export interface PlanTaskState {
  id: string;
  title: string;
  role: PlanTaskRole;
  state: PlanTaskStateName;
  /** The latest bound child session, when any binding exists. */
  childSessionId: string | null;
  /** Unmet dependency ids when blocked. */
  blockedOn: string[];
  /** Number of task.started bindings seen (>1 = retries happened). */
  attempts: number;
  /**
   * Every binding in start order with its outcome (Session 11.5) — the per-attempt history
   * the retry ceiling and future recovery policy read; `attempts` is its length.
   */
  attemptHistory: PlanTaskAttempt[];
  /** The task's CURRENT definition sha (Session 11.5) — what new bindings would record. */
  definitionSha: string;
  /** The declared check gate and its live state (Session 12); absent kinds ⇒ status 'none'. */
  verification: TaskVerification;
  /** Honest caveats: partial applies, omitted captures, parent-owned assertion, etc. */
  note?: string;
}

export interface GraphState {
  /** Topological order (declaration order among ties); declaration order if a cycle slipped in. */
  tasks: PlanTaskState[];
  byId: ReadonlyMap<string, PlanTaskState>;
  /** Ids ready to spawn now: state 'queued'. */
  ready: string[];
  /** One compact human line: ready/blocked/completed counts for notes and chrome. */
  summary: string;
}

export type LivePhase = 'running' | 'awaiting-approval';

export function foldGraphState(
  graph: PlanGraph,
  events: readonly SessionEvent[],
  live?: ReadonlyMap<string, LivePhase>,
): GraphState {
  // Gather per-plan-task bindings and per-child outcomes from the event stream.
  const bindings = new Map<string, { childSessionId: string; planTaskSha?: string }[]>(); // in start order
  const ended = new Map<string, { status: string; seq: number }>();
  const captured = new Map<string, { files: TaskChangeFile[]; omittedCount: number }>();
  const applied = new Map<string, Set<string>>(); // childSessionId -> union of applied relPaths
  const appliedSeq = new Map<string, number>(); // childSessionId -> last apply seq (the gate anchor)
  const checkRuns: { check: CheckKind; status: CheckStatus; seq: number }[] = [];

  for (const e of events) {
    if (e.type === 'task.started' && e.planTaskId !== undefined) {
      const list = bindings.get(e.planTaskId) ?? [];
      list.push({ childSessionId: e.childSessionId, ...(e.planTaskSha !== undefined ? { planTaskSha: e.planTaskSha } : {}) });
      bindings.set(e.planTaskId, list);
    } else if (e.type === 'task.ended') {
      ended.set(e.childSessionId, { status: e.status, seq: e.seq });
    } else if (e.type === 'task.changes') {
      captured.set(e.childSessionId, { files: e.files, omittedCount: e.omittedCount ?? 0 });
    } else if (e.type === 'task.applied') {
      const set = applied.get(e.childSessionId) ?? new Set<string>();
      for (const p of e.applied) set.add(p);
      applied.set(e.childSessionId, set);
      appliedSeq.set(e.childSessionId, e.seq);
    } else if (e.type === 'check.completed') {
      checkRuns.push({ check: e.check, status: e.status, seq: e.seq });
    }
  }

  /**
   * The gate for one task. Anchored on THIS task's own integration evidence (its last apply, or
   * its end when there was nothing to apply): a check that ran before the work landed cannot
   * have verified it. `unsupported` counts as satisfied-with-a-caveat — the `parent-owned`
   * precedent — because an unrunnable gate must never be able to strand a plan with no exit.
   */
  const verificationFor = (required: readonly CheckKind[], anchorSeq: number): TaskVerification => {
    if (required.length === 0) return { required: [], satisfied: [], waived: [], missing: [], status: 'none' };
    const satisfied: CheckKind[] = [];
    const waived: CheckKind[] = [];
    const missing: CheckKind[] = [];
    for (const kind of required) {
      const after = checkRuns.filter((r) => r.check === kind && r.seq > anchorSeq);
      if (after.some((r) => r.status === 'pass')) satisfied.push(kind);
      else if (after.some((r) => r.status === 'unsupported')) waived.push(kind);
      else missing.push(kind);
    }
    return {
      required: [...required],
      satisfied,
      waived,
      missing,
      status: missing.length > 0 ? 'pending' : waived.length > 0 ? 'waived' : 'green',
    };
  };

  const order = topoOrder(graph.tasks) ?? graph.tasks.map((t) => t.id);
  const byDecl = new Map(graph.tasks.map((t) => [t.id, t] as const));
  const states = new Map<string, PlanTaskState>();

  for (const id of order) {
    const task = byDecl.get(id);
    if (task === undefined) continue;
    const bound = bindings.get(id) ?? [];
    const last = bound.length > 0 ? bound[bound.length - 1]! : null;
    const childSessionId = last !== null ? last.childSessionId : null;
    const attemptHistory: PlanTaskAttempt[] = bound.map((b) => ({
      childSessionId: b.childSessionId,
      outcome: ended.get(b.childSessionId)?.status ?? live?.get(b.childSessionId) ?? 'interrupted',
      ...(b.planTaskSha !== undefined ? { planTaskSha: b.planTaskSha } : {}),
    }));
    const base: Omit<PlanTaskState, 'state'> = {
      id,
      title: task.title,
      role: task.role,
      childSessionId,
      blockedOn: [],
      attempts: bound.length,
      attemptHistory,
      definitionSha: planTaskDefinitionSha(task),
      // Placeholder: only a task that reached a terminal completed state has an integration
      // anchor to measure a gate against. Every earlier state keeps the required list visible
      // (so /tasks and the plan view can show what WILL gate it) with nothing satisfied yet.
      verification: verificationFor(task.checks ?? [], Number.MAX_SAFE_INTEGER),
    };

    if (task.role === 'main') {
      states.set(id, {
        ...base,
        state: 'parent-owned',
        note: 'parent-owned — completion asserted by the parent, not verified by the harness',
      });
      continue;
    }

    if (childSessionId === null) {
      // Never spawned: queued or blocked on deps.
      const unmet = task.dependsOn.filter((dep) => !depSatisfied(states.get(dep)));
      states.set(id, unmet.length === 0 ? { ...base, state: 'queued' } : { ...base, state: 'blocked', blockedOn: unmet });
      continue;
    }

    const end = ended.get(childSessionId);
    if (end === undefined) {
      const phase = live?.get(childSessionId);
      states.set(
        id,
        phase !== undefined
          ? { ...base, state: phase }
          : {
              ...base,
              state: 'interrupted',
              // Re-run safety is PROVABLE for file effects (task.ended always precedes capture,
              // so an interrupted child captured nothing and its worktree work integrated
              // nowhere) — but NOT for external side effects of user-approved shell commands.
              note:
                `started but never ended — safe to re-run: the isolated worktree captured nothing; ` +
                `user-approved shell commands it ran may still have had external side effects (child log: ${childSessionId})`,
            },
      );
      continue;
    }

    if (end.status === 'completed') {
      const cap = captured.get(childSessionId);
      // Review F1 (Session 11): an EXECUTOR always records a task.changes event on successful
      // capture — even an empty one. A completed executor binding with NO capture event means
      // the capture failed (or the session crashed between end and capture): the work may be
      // lost and must stay re-runnable, never fold to a false 'completed' that R5 would block.
      if (task.role === 'executor' && cap === undefined) {
        states.set(id, {
          ...base,
          state: 'failed',
          note: 'child completed but no change capture was recorded — the work may be lost; re-run the task',
        });
        continue;
      }
      const applicable = (cap?.files ?? []).filter((f) => f.kind === 'delete' || (f.blobSha256 !== null && f.oversize !== true));
      const appliedSet = applied.get(childSessionId) ?? new Set<string>();
      const unapplied = applicable.filter((f) => !appliedSet.has(f.relPath));
      const notes: string[] = [];
      if ((cap?.omittedCount ?? 0) > 0) notes.push(`${cap!.omittedCount} captured file(s) omitted over the cap`);
      const skipped = (cap?.files ?? []).length - applicable.length;
      if (skipped > 0) notes.push(`${skipped} oversize file(s) can never be applied`);
      if (unapplied.length === 0) {
        // Definition identity (Session 11.5): 'completed' belongs to the definition that RAN.
        // An amendment that changed this task after completion re-opens it (conservative:
        // re-run rather than silently skip changed work). Pre-11.5 bindings without a
        // recorded sha keep the legacy id-sticky reading. Deliberately checked only at the
        // terminal state: an 'integrating' task keeps integrating its captured old-definition
        // work first (the gate refuses concurrent re-runs until applied).
        const boundSha = last?.planTaskSha;
        if (boundSha !== undefined && boundSha !== base.definitionSha) {
          const unmet = task.dependsOn.filter((dep) => !depSatisfied(states.get(dep)));
          states.set(
            id,
            unmet.length === 0
              ? { ...base, state: 'queued', note: `definition changed after completion (completed as ${boundSha.slice(0, 8)}) — re-runnable` }
              : { ...base, state: 'blocked', blockedOn: unmet, note: `definition changed after completion (completed as ${boundSha.slice(0, 8)})` },
          );
          continue;
        }
        // The gate anchor: the LATER of this task's end and its last apply — the moment its work
        // was actually in the workspace. A check before that point verified a different tree.
        const anchor = Math.max(end.seq, appliedSeq.get(childSessionId) ?? 0);
        const verification = verificationFor(task.checks ?? [], anchor);
        if (verification.status === 'pending') {
          notes.push(`required check(s) not passed since integration: ${verification.missing.join(', ')} — run run_check`);
        } else if (verification.status === 'waived') {
          notes.push(`check(s) ${verification.waived.join(', ')} WAIVED (unsupported in this project — not proof, recorded as a caveat)`);
        }
        states.set(id, { ...base, state: 'completed', verification, ...(notes.length > 0 ? { note: notes.join('; ') } : {}) });
      } else {
        notes.unshift(`${unapplied.length} of ${applicable.length} captured file(s) not yet applied`);
        states.set(id, { ...base, state: 'integrating', note: notes.join('; ') });
      }
      continue;
    }

    if (end.status === 'aborted' || end.status === 'user-stopped' || end.status === 'cancelled') {
      states.set(id, { ...base, state: 'cancelled', note: `child ended: ${end.status}` });
    } else {
      // error | timeout | budget-steps | budget-tokens | stalled | anything future — honest failure.
      states.set(id, { ...base, state: 'failed', note: `child ended: ${end.status}` });
    }
  }

  const tasks = order.map((id) => states.get(id)).filter((s): s is PlanTaskState => s !== undefined);
  const ready = tasks.filter((t) => t.state === 'queued').map((t) => t.id);
  return { tasks, byId: states, ready, summary: summarize(tasks, ready) };
}

/**
 * A dependency is satisfied by completed work whose declared check gate is not still pending, or
 * by parent-owned work (asserted, warned at spawn).
 *
 * This ONE predicate is the whole "dependents unblock only when the gate is green" mechanism
 * (Session 12): it is consulted for queued/blocked resolution here and, transitively, by the DAG
 * gate's R4 and by session acceptance. A task with no declared checks has status 'none' and is
 * unaffected — small tasks stay exactly as cheap as they were.
 */
export function depSatisfied(dep: PlanTaskState | undefined): boolean {
  if (dep === undefined) return false;
  if (dep.state === 'parent-owned') return true;
  return dep.state === 'completed' && dep.verification.status !== 'pending';
}

/**
 * The INTEGRATION boundary gate (Session 12): after captured work is applied, the declared
 * `gates.integration` kinds must pass before another executor wave starts. This is the "broader
 * checks at integration boundaries" rule as a structural refusal rather than a prompt reminder.
 *
 * Anchored on the last `task.applied`: before any integration there is nothing combined to
 * verify, so the gate is vacuously satisfied and a first wave is never delayed. `unsupported`
 * satisfies with a caveat, for the same never-strand-the-plan reason as a per-task gate.
 */
export function integrationGateState(
  graph: PlanGraph,
  events: readonly SessionEvent[],
): { required: CheckKind[]; pending: CheckKind[]; waived: CheckKind[] } {
  const required = [...(graph.gates?.integration ?? [])];
  if (required.length === 0) return { required, pending: [], waived: [] };
  let lastApply = 0;
  for (const e of events) if (e.type === 'task.applied') lastApply = Math.max(lastApply, e.seq);
  if (lastApply === 0) return { required, pending: [], waived: [] };
  const pending: CheckKind[] = [];
  const waived: CheckKind[] = [];
  for (const kind of required) {
    const after = events.filter((e) => e.type === 'check.completed' && e.check === kind && e.seq > lastApply);
    if (after.some((e) => e.type === 'check.completed' && e.status === 'pass')) continue;
    if (after.some((e) => e.type === 'check.completed' && e.status === 'unsupported')) waived.push(kind);
    else pending.push(kind);
  }
  return { required, pending, waived };
}

/**
 * The COMPLETION boundary gate (Session 12): the declared `gates.completion` kinds must have
 * passed after the LAST change in the session. Strict on purpose — this mirrors the report's
 * CHECKED staleness rule, so an `/undo`, a checkpoint restore, or integrating a later task all
 * correctly invalidate it. (A per-task gate deliberately is NOT invalidated by unrelated later
 * changes; this gate is what covers the combined state.)
 */
export function completionGateState(
  graph: PlanGraph,
  events: readonly SessionEvent[],
): { required: CheckKind[]; pending: CheckKind[]; waived: CheckKind[] } {
  const required = [...(graph.gates?.completion ?? [])];
  if (required.length === 0) return { required, pending: [], waived: [] };
  let lastChange = 0;
  for (const e of events) if (e.type === 'file.mutated') lastChange = Math.max(lastChange, e.seq);
  const pending: CheckKind[] = [];
  const waived: CheckKind[] = [];
  for (const kind of required) {
    const after = events.filter((e) => e.type === 'check.completed' && e.check === kind && e.seq > lastChange);
    if (after.some((e) => e.type === 'check.completed' && e.status === 'pass')) continue;
    if (after.some((e) => e.type === 'check.completed' && e.status === 'unsupported')) waived.push(kind);
    else pending.push(kind);
  }
  return { required, pending, waived };
}

function summarize(tasks: readonly PlanTaskState[], ready: readonly string[]): string {
  // Parent-owned (role main) tasks are ASSERTED, never verified — counting them in the
  // completed denominator made an all-main plan read "0/4 completed" beside an honest
  // "complete" acceptance (observed live in the S11.5 demo). Count them separately.
  const parentOwned = tasks.filter((t) => t.state === 'parent-owned').length;
  const countable = tasks.length - parentOwned;
  // "completed" in the summary means DONE — integrated AND past its declared gate. Counting a
  // gate-pending task as completed would put "3/3 completed" beside dependents the same fold is
  // holding blocked, and beside an acceptance that refuses. One meaning, everywhere.
  const done = tasks.filter((t) => t.state === 'completed' && t.verification.status !== 'pending').length;
  const parts: string[] = [];
  if (countable > 0) {
    parts.push(`${done}/${countable} completed`);
    if (parentOwned > 0) parts.push(`${parentOwned} parent-owned (asserted)`);
  } else {
    parts.push(`all ${parentOwned} task(s) parent-owned (asserted)`);
  }
  // Live phases (overlay-fed folds only, e.g. the mid-turn /tasks plan line): running work
  // must be visible in the summary, not silently "not completed".
  const live = tasks.filter((t) => t.state === 'running' || t.state === 'awaiting-approval');
  if (live.length > 0) parts.push(`running: ${live.map((t) => `${t.id}${t.state === 'awaiting-approval' ? ' (awaiting approval)' : ''}`).join(', ')}`);
  if (ready.length > 0) parts.push(`ready: ${ready.join(', ')}`);
  const blocked = tasks.filter((t) => t.state === 'blocked');
  if (blocked.length > 0) parts.push(`blocked: ${blocked.map((t) => `${t.id} (on ${t.blockedOn.join(', ')})`).join(', ')}`);
  const integrating = tasks.filter((t) => t.state === 'integrating').map((t) => t.id);
  if (integrating.length > 0) parts.push(`integrating: ${integrating.join(', ')}`);
  const awaiting = tasks.filter((t) => t.state === 'completed' && t.verification.status === 'pending');
  if (awaiting.length > 0) {
    parts.push(`awaiting checks: ${awaiting.map((t) => `${t.id} (${t.verification.missing.join(', ')})`).join(', ')}`);
  }
  const failed = tasks.filter((t) => t.state === 'failed' || t.state === 'cancelled' || t.state === 'interrupted');
  if (failed.length > 0) parts.push(`needs attention: ${failed.map((t) => `${t.id} (${t.state})`).join(', ')}`);
  return parts.join(' · ');
}
