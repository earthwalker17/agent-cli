import type { SessionEvent, TaskChangeFile } from '../types.js';
import { topoOrder, type PlanGraph, type PlanTaskRole } from './schema.js';

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
  const bindings = new Map<string, string[]>(); // planTaskId -> childSessionIds in start order
  const ended = new Map<string, { status: string }>();
  const captured = new Map<string, { files: TaskChangeFile[]; omittedCount: number }>();
  const applied = new Map<string, Set<string>>(); // childSessionId -> union of applied relPaths

  for (const e of events) {
    if (e.type === 'task.started' && e.planTaskId !== undefined) {
      const list = bindings.get(e.planTaskId) ?? [];
      list.push(e.childSessionId);
      bindings.set(e.planTaskId, list);
    } else if (e.type === 'task.ended') {
      ended.set(e.childSessionId, { status: e.status });
    } else if (e.type === 'task.changes') {
      captured.set(e.childSessionId, { files: e.files, omittedCount: e.omittedCount ?? 0 });
    } else if (e.type === 'task.applied') {
      const set = applied.get(e.childSessionId) ?? new Set<string>();
      for (const p of e.applied) set.add(p);
      applied.set(e.childSessionId, set);
    }
  }

  const order = topoOrder(graph.tasks) ?? graph.tasks.map((t) => t.id);
  const byDecl = new Map(graph.tasks.map((t) => [t.id, t] as const));
  const states = new Map<string, PlanTaskState>();

  for (const id of order) {
    const task = byDecl.get(id);
    if (task === undefined) continue;
    const bound = bindings.get(id) ?? [];
    const childSessionId = bound.length > 0 ? bound[bound.length - 1]! : null;
    const base: Omit<PlanTaskState, 'state'> = {
      id,
      title: task.title,
      role: task.role,
      childSessionId,
      blockedOn: [],
      attempts: bound.length,
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
              note: `started but never ended — child evidence log: ${childSessionId}`,
            },
      );
      continue;
    }

    if (end.status === 'completed') {
      const cap = captured.get(childSessionId);
      const applicable = (cap?.files ?? []).filter((f) => f.kind === 'delete' || (f.blobSha256 !== null && f.oversize !== true));
      const appliedSet = applied.get(childSessionId) ?? new Set<string>();
      const unapplied = applicable.filter((f) => !appliedSet.has(f.relPath));
      const notes: string[] = [];
      if ((cap?.omittedCount ?? 0) > 0) notes.push(`${cap!.omittedCount} captured file(s) omitted over the cap`);
      const skipped = (cap?.files ?? []).length - applicable.length;
      if (skipped > 0) notes.push(`${skipped} oversize file(s) can never be applied`);
      if (unapplied.length === 0) {
        states.set(id, { ...base, state: 'completed', ...(notes.length > 0 ? { note: notes.join('; ') } : {}) });
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

/** A dependency is satisfied by completed work or by parent-owned work (asserted, warned at spawn). */
export function depSatisfied(dep: PlanTaskState | undefined): boolean {
  return dep !== undefined && (dep.state === 'completed' || dep.state === 'parent-owned');
}

function summarize(tasks: readonly PlanTaskState[], ready: readonly string[]): string {
  const total = tasks.length;
  const done = tasks.filter((t) => t.state === 'completed').length;
  const parts: string[] = [`${done}/${total} completed`];
  if (ready.length > 0) parts.push(`ready: ${ready.join(', ')}`);
  const blocked = tasks.filter((t) => t.state === 'blocked');
  if (blocked.length > 0) parts.push(`blocked: ${blocked.map((t) => `${t.id} (on ${t.blockedOn.join(', ')})`).join(', ')}`);
  const integrating = tasks.filter((t) => t.state === 'integrating').map((t) => t.id);
  if (integrating.length > 0) parts.push(`integrating: ${integrating.join(', ')}`);
  const failed = tasks.filter((t) => t.state === 'failed' || t.state === 'cancelled' || t.state === 'interrupted');
  if (failed.length > 0) parts.push(`needs attention: ${failed.map((t) => `${t.id} (${t.state})`).join(', ')}`);
  return parts.join(' · ');
}
