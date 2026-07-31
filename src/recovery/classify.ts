import { sha256 } from '../shared/hash.js';
import type { CheckKind, CheckStatus, CommandTermination, FailureClass, SessionEvent, SetupAction, TaskStatus } from '../types.js';

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
  | { source: 'policy'; seq: number; callId: string; tool: string; rule: string; decision: 'deny' | 'deny-stop' }
  | {
      /** A managed preview that FAILED (Session 13) — stopped/TTL/session-end are not failures. */
      source: 'preview';
      seq: number;
      previewId: string;
      reason: 'crashed' | 'start-failed';
      exitCode: number | null;
      logTail?: string;
    }
  | {
      /** A project setup that FAILED (Session 16). `unsupported` never spawned and is not one. */
      source: 'setup';
      seq: number;
      action: SetupAction;
      projectId: string;
      recipeId: string;
      status: 'failed' | 'error';
      exitCode: number | null;
      termination?: CommandTermination;
      signals: string[];
      summary: string;
    };

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
  } else if (e.termination === 'aborted') {
    // A user interruption produced NO verdict, so it is not a defect to repair. This test must
    // sit HERE, beside timeout: below the per-kind branches it was unreachable (every CheckKind
    // matches one of them), and a Ctrl+C'd typecheck classified as a repairable compile-type
    // failure — a cancellation becoming a diagnosis, spending the repair budget on non-evidence.
    cls = 'unknown';
    confidence = 'high';
    fired.push('termination:aborted');
  } else if (e.check === 'browser') {
    // Browser evidence routes ONLY by its own disjoint signal namespace (Session 13) and never
    // falls through to the shell-output branches: a page error whose text happens to say
    // "SyntaxError" must not classify as compile-type.
    if (s.has('browser-unavailable')) {
      cls = 'dependency-setup'; // a missing browser is a toolchain the user installs
      confidence = 'high';
      fired.push('browser-unavailable');
    } else if (s.has('preview-died')) {
      cls = 'runtime-process'; // the server died at runtime; the flow was only the witness
      confidence = 'high';
      fired.push('preview-died');
    } else if (s.has('browser-assertion-failed') || s.has('page-error') || s.has('browser-timeout') || s.has('browser-navigation')) {
      cls = 'browser-verification';
      confidence = 'high';
      for (const k of ['browser-assertion-failed', 'page-error', 'browser-timeout', 'browser-navigation']) if (s.has(k)) fired.push(k);
    } else if (e.status === 'fail') {
      cls = 'browser-verification'; // e.g. a console-error-only failure under fail_on_console_error
      confidence = 'medium';
      fired.push('kind:browser');
    }
    // an 'error' with no recognized signal stays unknown — read the flow evidence
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
    case 'setup': {
      // A failed setup IS the dependency-setup class, by construction rather than by inference —
      // this is the one evidence source whose subject matter is exactly that class. The ordering
      // rule the whole module lives by still wins first: a setup that was TIMED OUT or ABORTED
      // produced no verdict, so it is `unknown` and cannot spend the repair budget. A user's
      // Ctrl+C on a slow `npm ci` must never be read as a diagnosable defect.
      if (e.termination === 'timeout') {
        const fired = ['termination:timeout', `setup:${e.action}`];
        return {
          class: 'timeout-resource',
          confidence: 'high',
          signals: fired,
          signature: signatureOf('timeout-resource', e.recipeId, fired),
          subject: e.recipeId,
          detail: `project ${e.action} for '${e.projectId}' timed out; its effects are unknown`,
        };
      }
      if (e.termination === 'aborted') {
        const fired = ['termination:aborted', `setup:${e.action}`];
        return {
          class: 'unknown',
          confidence: 'high',
          signals: fired,
          signature: signatureOf('unknown', e.recipeId, fired),
          subject: e.recipeId,
          detail: `project ${e.action} for '${e.projectId}' was interrupted and produced no result — re-run it; there is nothing here to diagnose`,
        };
      }
      const fired = [`setup:${e.action}`, ...e.signals];
      return {
        class: 'dependency-setup',
        confidence: 'high',
        signals: fired,
        signature: signatureOf('dependency-setup', e.recipeId, fired),
        subject: e.recipeId,
        detail: `project ${e.action} for '${e.projectId}' failed${e.exitCode !== null ? ` (exit ${e.exitCode})` : ''}: ${e.summary}`,
      };
    }
    case 'preview': {
      // start-failed = the server never became a preview (boot bug, port conflict); crashed =
      // it was serving and died at runtime. EADDRINUSE is read from the log tail because a
      // preview has no output parser — the tail IS the recorded diagnostic surface.
      const portConflict = e.logTail !== undefined && e.logTail.includes('EADDRINUSE');
      const fired = [`preview:${e.reason}`, ...(portConflict ? ['port-in-use'] : [])];
      const cls: FailureClass = e.reason === 'start-failed' ? 'preview-startup' : 'runtime-process';
      return {
        class: cls,
        confidence: 'high',
        signals: fired,
        signature: signatureOf(cls, e.previewId, fired),
        subject: e.previewId,
        detail:
          e.reason === 'start-failed'
            ? `preview ${e.previewId} failed to start${e.exitCode !== null ? ` (exit ${e.exitCode})` : ''}${portConflict ? ' — port in use' : ''}; read the log tail`
            : `preview ${e.previewId} crashed while serving${e.exitCode !== null ? ` (exit ${e.exitCode})` : ''}`,
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
    } else if (e.type === 'setup.completed' && (e.status === 'failed' || e.status === 'error')) {
      // Session-scoped only: a setup carries no plan-task binding, so a task-targeted query must
      // not pick one up and attribute a failed install to a task that never ran it.
      if (target === undefined) {
        take({
          source: 'setup',
          seq: e.seq,
          action: e.action,
          projectId: e.projectId,
          recipeId: e.recipeId,
          status: e.status,
          exitCode: e.exitCode,
          ...(e.termination !== undefined ? { termination: e.termination } : {}),
          signals: e.signals ?? [],
          summary: e.summary,
        });
      }
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
    } else if (e.type === 'preview.ended' && (e.reason === 'crashed' || e.reason === 'start-failed')) {
      // Preview failures are SESSION-scoped evidence (a preview is not bound to a plan task);
      // stopped/ttl-timeout/log-overflow/session-end are lifecycle ends, not failures — the
      // same rule that excludes user interventions from task outcomes.
      if (target !== undefined) continue;
      take({
        source: 'preview',
        seq: e.seq,
        previewId: e.previewId,
        reason: e.reason,
        exitCode: e.exitCode,
        ...(e.logTail !== undefined ? { logTail: e.logTail } : {}),
      });
    }
  }
  return latest;
}
