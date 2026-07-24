import { fmtTokens } from './format.js';
import type { TaskStatus } from '../types.js';
import { SESSION_CHILD_OUTPUT_TOKEN_CAP, TASKS_PER_SESSION, type ChildStatusUpdate } from '../runtime/subagent.js';
import type { DelegateCaps } from '../tools/delegate.js';
import type { LivePhase } from '../plan/graph-state.js';

/**
 * The in-memory live task table (Session 11): RENDER-ONLY state fed by the subagent runner's
 * structured onStatus channel plus the per-child cancel registry from the registerCancel seam.
 * Never persisted, never authority — the event log stays the truth; this exists so the status
 * area and mid-turn /tasks can show what is happening RIGHT NOW, and so /cancel can reach one
 * specific child. Everything collapses honestly on crash/resume (the fold reports interrupted).
 */

export type LiveTaskPhase = 'running' | 'tool' | 'approval-wait' | 'ended';

/** The runner's structured update shape — the runtime owns it; this table just consumes it. */
export type TaskStatusUpdate = ChildStatusUpdate;

export interface LiveTaskRow {
  childSessionId: string;
  role: string;
  planTaskId?: string;
  phase: LiveTaskPhase;
  lastTool?: string;
  steps: number;
  outTokens: number;
  startedAtMs: number;
  endedStatus?: TaskStatus;
  supervision: string[];
}

export interface TaskTable {
  update(u: TaskStatusUpdate): void;
  /** The registerCancel seam target: remembers the child's narrow cancel handle. */
  registerCancel(childSessionId: string, cancel: () => void): () => void;
  /** Cancel by child-id suffix (>=4 chars) or bound plan task id. */
  cancel(ref: string): { outcome: 'ok' | 'not-found' | 'ambiguous'; childSessionId?: string };
  /** Rows still live (not ended). */
  live(): LiveTaskRow[];
  /** Live phases keyed by childSessionId — the graph fold's live overlay. */
  livePhases(): Map<string, LivePhase>;
  /** Unstyled status-area lines ([] when nothing is live). */
  statusLines(caps?: DelegateCaps): string[];
}

export function createTaskTable(now: () => number = Date.now): TaskTable {
  const rows = new Map<string, LiveTaskRow>();
  const cancels = new Map<string, () => void>();

  const fmtElapsed = (ms: number): string => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s` : `${s}s`;
  };

  return {
    update(u): void {
      const existing = rows.get(u.childSessionId);
      const row: LiveTaskRow = existing ?? {
        childSessionId: u.childSessionId,
        role: u.role ?? 'task',
        phase: 'running',
        steps: 0,
        outTokens: 0,
        startedAtMs: now(),
        supervision: [],
      };
      if (u.role !== undefined) row.role = u.role;
      if (u.planTaskId !== undefined) row.planTaskId = u.planTaskId;
      if (u.phase !== undefined) row.phase = u.phase; // supervision flags ride without a phase change
      if (u.tool !== undefined) row.lastTool = u.tool;
      if (u.steps !== undefined) row.steps = u.steps;
      if (u.outTokens !== undefined) row.outTokens = u.outTokens;
      if (u.status !== undefined) row.endedStatus = u.status;
      if (u.supervision !== undefined && !row.supervision.includes(u.supervision)) row.supervision.push(u.supervision);
      rows.set(u.childSessionId, row);
    },

    registerCancel(childSessionId, cancel): (() => void) {
      cancels.set(childSessionId, cancel);
      return () => {
        cancels.delete(childSessionId);
      };
    },

    cancel(ref): { outcome: 'ok' | 'not-found' | 'ambiguous'; childSessionId?: string } {
      const needle = ref.trim();
      if (needle.length === 0) return { outcome: 'not-found' };
      const matches = [...cancels.keys()].filter((id) => {
        const row = rows.get(id);
        return id === needle || (needle.length >= 4 && id.endsWith(needle)) || row?.planTaskId === needle;
      });
      if (matches.length === 0) return { outcome: 'not-found' };
      if (matches.length > 1) return { outcome: 'ambiguous' };
      const id = matches[0]!;
      cancels.get(id)?.();
      return { outcome: 'ok', childSessionId: id };
    },

    live(): LiveTaskRow[] {
      return [...rows.values()].filter((r) => r.phase !== 'ended');
    },

    livePhases(): Map<string, LivePhase> {
      const out = new Map<string, LivePhase>();
      for (const r of rows.values()) {
        if (r.phase === 'ended') continue;
        out.set(r.childSessionId, r.phase === 'approval-wait' ? 'awaiting-approval' : 'running');
      }
      return out;
    },

    statusLines(caps): string[] {
      const live = this.live();
      if (live.length === 0) return [];
      const head =
        `▸ ${live.length} agent(s) running` +
        (caps !== undefined
          ? ` · tasks ${caps.tasksStarted}/${TASKS_PER_SESSION} · child-out ${fmtTokens(caps.childOutputTokens)}/${fmtTokens(SESSION_CHILD_OUTPUT_TOKEN_CAP)}`
          : '') +
        ' · /tasks · /cancel <id>';
      const agentLines = live.map((r) => {
        const activity =
          r.phase === 'approval-wait' ? 'WAITING FOR APPROVAL' : r.lastTool !== undefined ? r.lastTool : 'thinking';
        const sup = r.supervision.length > 0 ? ` · ⚑ ${r.supervision.join(',')}` : '';
        return (
          `▸ ${r.role}·${r.childSessionId.slice(-4)}${r.planTaskId !== undefined ? ` (${r.planTaskId})` : ''}` +
          ` · ${activity} · s${r.steps} · ${fmtTokens(r.outTokens)} out · ${fmtElapsed(now() - r.startedAtMs)}${sup}`
        );
      });
      return [head, ...agentLines];
    },
  };
}
