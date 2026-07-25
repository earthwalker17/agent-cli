import { sha256 } from '../shared/hash.js';
import type { CheckKind, CheckStatus, CommandTermination, FailureClass, SessionEvent, TaskStatus } from '../types.js';

/**
 * Typed failure classification (Session 12) — deterministic, structural first, and DERIVABLE FROM
 * EVENTS ALONE. That last property is load-bearing: the full check output is truncated for the
 * model and only preserved as a blob, so classification reads the NAMED SIGNALS that
 * `check.completed` persists rather than re-scanning text that may no longer be in context.
 *
 * Classification happens BEFORE any repair is planned. `unknown` is a real answer with real
 * consequences (stop and escalate), not a default that quietly permits another attempt.
 */

/** The failure inputs the harness can build from its own event log. */
export type FailureEvidence =
  | {
      source: 'check';
      seq: number;
      check: CheckKind;
      recipeId: string;
      status: CheckStatus;
      exitCode: number | null;
      termination?: CommandTermination;
      signals: string[];
      summary: string;
    }
  | {
      source: 'task';
      seq: number;
      planTaskId?: string;
      childSessionId: string;
      status: TaskStatus;
      supervision: string[];
    }
  | {
      source: 'integration';
      seq: number;
      childSessionId: string;
      refused: { relPath: string; reason: string }[];
    }
  | { source: 'policy'; seq: number; callId: string; tool: string; rule: string; decision: 'deny' | 'deny-stop' };

export interface FailureClassification {
  class: FailureClass;
  confidence: 'high' | 'medium' | 'low';
  /** The named facts that decided it — a classification must be attributable, never a vibe. */
  signals: string[];
  /**
   * Stable identity of THIS failure: class + subject + the signals that fired. Free text and
   * durations are deliberately excluded so the same failure recurring is recognizable across
   * attempts. It is a HEURISTIC identity — two different bugs with identical signals share a
   * signature — which is why it bounds retries rather than proving anything.
   */
  signature: string;
  /** The subject the failure attaches to: a plan task id, a recipe id, or a child session. */
  subject: string;
  detail: string;
}

/** Genuine failure outcomes — user interventions and crashes are not the model failing. */
const FAILURE_TASK_STATUSES: readonly TaskStatus[] = ['error', 'timeout', 'budget-steps', 'budget-tokens', 'stalled'];

export function isFailureTaskStatus(status: string): status is TaskStatus {
  return (FAILURE_TASK_STATUSES as readonly string[]).includes(status);
}

function signatureOf(cls: FailureClass, subject: string, signals: readonly string[]): string {
  return sha256(`${cls}\n${subject}\n${[...signals].sort().join(',')}`);
}

function classifyCheck(e: Extract<FailureEvidence, { source: 'check' }>): FailureClassification {
  const s = new Set(e.signals);
  const fired: string[] = [];
  let cls: FailureClass = 'unknown';
  let confidence: FailureClassification['confidence'] = 'low';

  // Order matters: a missing toolchain masks every downstream diagnostic, and a killed process
  // produced no verdict at all — both must win over "the test failed".
  if (e.termination === 'timeout') {
    cls = 'timeout-resource';
    confidence = 'high';
    fired.push('termination:timeout');
  } else if (e.termination === 'spawn-error' || s.has('command-not-found') || s.has('module-not-found') || s.has('missing-dependency')) {
    cls = 'dependency-setup';
    confidence = 'high';
    if (e.termination === 'spawn-error') fired.push('termination:spawn-error');
    for (const k of ['command-not-found', 'module-not-found', 'missing-dependency']) if (s.has(k)) fired.push(k);
  } else if (s.has('out-of-memory') || s.has('port-in-use')) {
    cls = 'timeout-resource';
    confidence = 'high';
    for (const k of ['out-of-memory', 'port-in-use']) if (s.has(k)) fired.push(k);
  } else if (s.has('network-error')) {
    cls = 'dependency-setup';
    confidence = 'medium';
    fired.push('network-error');
  } else if (s.has('permission-denied')) {
    cls = 'runtime-process';
    confidence = 'high';
    fired.push('permission-denied');
  } else if (s.has('ts-error') || s.has('syntax-error')) {
    cls = 'compile-type';
    confidence = 'high';
    for (const k of ['ts-error', 'syntax-error']) if (s.has(k)) fired.push(k);
  } else if (e.check === 'typecheck' || e.check === 'build') {
    cls = 'compile-type';
    confidence = s.has('type-error') ? 'high' : 'medium';
    fired.push(`kind:${e.check}`);
    if (s.has('type-error')) fired.push('type-error');
  } else if (e.check === 'test' || e.check === 'test-targeted') {
    cls = 'test-assertion';
    confidence = s.has('assertion-failed') ? 'high' : 'medium';
    fired.push(`kind:${e.check}`);
    if (s.has('assertion-failed')) fired.push('assertion-failed');
  } else if (e.check === 'lint' || e.check === 'format' || e.check === 'static-analysis') {
    cls = 'lint-format';
    confidence = 'high';
    fired.push(`kind:${e.check}`);
    if (s.has('lint-violation')) fired.push('lint-violation');
  } else if (e.termination === 'aborted') {
    // A user interruption is not a failure to repair; it produced no verdict at all.
    cls = 'unknown';
    confidence = 'high';
    fired.push('termination:aborted');
  }

  const detail =
    cls === 'unknown'
      ? `${e.check} check did not match any classification rule (${e.summary})`
      : `${e.check} check (${e.recipeId}) → ${e.status}${e.exitCode !== null ? ` exit ${e.exitCode}` : ''}`;
  return { class: cls, confidence, signals: fired, signature: signatureOf(cls, e.recipeId, fired), subject: e.recipeId, detail };
}

function classifyTask(e: Extract<FailureEvidence, { source: 'task' }>): FailureClassification {
  const subject = e.planTaskId ?? e.childSessionId;
  const fired: string[] = [`task:${e.status}`, ...e.supervision.map((k) => `supervision:${k}`)];
  let cls: FailureClass = 'unknown';
  let confidence: FailureClassification['confidence'] = 'low';
  if (e.status === 'timeout' || e.status === 'budget-steps' || e.status === 'budget-tokens') {
    cls = 'timeout-resource';
    confidence = 'high';
  } else if (e.status === 'stalled') {
    cls = 'runtime-process';
    confidence = 'medium';
  }
  // `error` stays UNKNOWN on purpose: a child that threw tells us a task failed, not why. The
  // honest next step is to read its evidence log, which is exactly what the unknown entry says.
  const detail =
    cls === 'unknown'
      ? `delegated task ended '${e.status}' with no classifying evidence — read the child log (agent report ${e.childSessionId})`
      : `delegated task ended '${e.status}'`;
  return { class: cls, confidence, signals: fired, signature: signatureOf(cls, subject, fired), subject, detail };
}

export function classifyFailure(e: FailureEvidence): FailureClassification {
  switch (e.source) {
    case 'check':
      return classifyCheck(e);
    case 'task':
      return classifyTask(e);
    case 'integration': {
      const fired = ['apply-refused', ...(e.refused.some((r) => r.reason.startsWith('drift')) ? ['drift'] : [])];
      return {
        class: 'integration-conflict',
        confidence: 'high',
        signals: fired,
        signature: signatureOf('integration-conflict', e.childSessionId, fired),
        subject: e.childSessionId,
        detail: `${e.refused.length} file(s) refused at integration: ${e.refused.slice(0, 3).map((r) => r.relPath).join(', ')}`,
      };
    }
    case 'policy': {
      const fired = [`policy:${e.decision}`, `rule:${e.rule}`];
      return {
        class: 'policy-approval',
        confidence: 'high',
        signals: fired,
        signature: signatureOf('policy-approval', e.tool, fired),
        subject: e.tool,
        detail: `${e.tool} was refused (${e.rule})`,
      };
    }
  }
}

/**
 * Build the LATEST failure evidence for a subject purely from the event log. `target` is a plan
 * task id, or undefined for the session at large (the newest failing check).
 *
 * Deliberately scoped to what the harness recorded: a task failure is only considered when its
 * outcome was a genuine failure (crashes and user interventions are excluded, the same rule R10
 * uses), because "the user stopped it" must never be classified as something to repair.
 */
export function latestFailureEvidence(events: readonly SessionEvent[], target?: string): FailureEvidence | null {
  let latest: FailureEvidence | null = null;
  const take = (e: FailureEvidence): void => {
    if (latest === null || e.seq > latest.seq) latest = e;
  };
  const childPlanTask = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'task.started' && e.planTaskId !== undefined) childPlanTask.set(e.childSessionId, e.planTaskId);
  }
  const supervisionBy = new Map<string, string[]>();
  for (const e of events) {
    if (e.type === 'task.supervision') {
      const list = supervisionBy.get(e.childSessionId) ?? [];
      list.push(e.kind);
      supervisionBy.set(e.childSessionId, list);
    }
  }

  for (const e of events) {
    if (e.type === 'check.completed' && (e.status === 'fail' || e.status === 'error')) {
      if (target !== undefined && e.planTaskId !== target) continue;
      take({
        source: 'check',
        seq: e.seq,
        check: e.check,
        recipeId: e.recipeId,
        status: e.status,
        exitCode: e.exitCode,
        ...(e.termination !== undefined ? { termination: e.termination } : {}),
        signals: e.signals ?? [],
        summary: e.summary,
      });
    } else if (e.type === 'task.ended' && isFailureTaskStatus(e.status)) {
      const planTaskId = childPlanTask.get(e.childSessionId);
      if (target !== undefined && planTaskId !== target) continue;
      take({
        source: 'task',
        seq: e.seq,
        ...(planTaskId !== undefined ? { planTaskId } : {}),
        childSessionId: e.childSessionId,
        status: e.status,
        supervision: supervisionBy.get(e.childSessionId) ?? [],
      });
    } else if (e.type === 'task.applied' && e.refused.length > 0) {
      const planTaskId = childPlanTask.get(e.childSessionId);
      if (target !== undefined && planTaskId !== target) continue;
      take({ source: 'integration', seq: e.seq, childSessionId: e.childSessionId, refused: e.refused });
    }
  }
  return latest;
}
