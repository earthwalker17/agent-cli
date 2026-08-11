import { describe, it, expect } from 'vitest';
import { classifyFailure, latestFailureEvidence, isFailureTaskStatus, type FailureEvidence } from '../src/recovery/classify.js';
import { foldRepairs, openRepairBlockers } from '../src/recovery/ledger.js';
import {
  evaluateRepair,
  MAX_REPAIR_ATTEMPTS,
  REPAIRS_PER_SESSION,
  REPAIR_CHILD_TOKEN_BUDGET,
  REPAIR_WALL_MS,
} from '../src/recovery/policy.js';
import { RECOVERY_CATALOGUE, recoveryEntry, renderRecoveryGuidance } from '../src/recovery/catalogue.js';
import { FAILURE_CLASSES, type CheckKind, type SessionEvent } from '../src/types.js';

let seq = 0;
let clockMs = Date.parse('2026-07-25T00:00:00.000Z');
const ev = (body: Record<string, unknown>, advanceMs = 1000): SessionEvent => {
  clockMs += advanceMs;
  return { v: 1, seq: ++seq, ts: new Date(clockMs).toISOString(), ...body } as unknown as SessionEvent;
};
function reset(): void {
  seq = 0;
  clockMs = Date.parse('2026-07-25T00:00:00.000Z');
}

const checkFail = (check: CheckKind, signals: string[], over: Record<string, unknown> = {}): SessionEvent =>
  ev({
    type: 'check.completed',
    callId: 'k',
    check,
    recipeId: `r.${check}`,
    status: 'fail',
    exitCode: 1,
    termination: 'exited',
    durationMs: 10,
    summary: `${check} FAIL`,
    signals,
    ...over,
  });

const attempt = (over: Record<string, unknown> = {}, advanceMs = 1000): SessionEvent =>
  ev(
    {
      type: 'repair.attempted',
      callId: 'c',
      target: 'api',
      failureClass: 'compile-type',
      signature: 'sig1',
      hypothesis: 'the type is wrong at the declaration',
      hypothesisSha: 'h1',
      scopePaths: ['src/api'],
      regressionChecks: ['typecheck'],
      attempt: 1,
      ...over,
    },
    advanceMs,
  );

const checkPass = (check: CheckKind): SessionEvent =>
  ev({ type: 'check.completed', callId: 'k', check, recipeId: 'r', status: 'pass', exitCode: 0, termination: 'exited', durationMs: 5, summary: 'ok' });

describe('the recovery catalogue', () => {
  it('covers every failure class with the full contract', () => {
    for (const cls of FAILURE_CLASSES) {
      const e = recoveryEntry(cls);
      expect(e.class, cls).toBe(cls);
      expect(e.label.length, cls).toBeGreaterThan(0);
      expect(e.signals.length, cls).toBeGreaterThan(0);
      expect(e.requiredEvidence.length, cls).toBeGreaterThan(0);
      expect(e.diagnostics.length, cls).toBeGreaterThan(0);
      expect(e.actions.length, cls).toBeGreaterThan(0);
      expect(e.stopConditions.length, cls).toBeGreaterThan(0);
      expect(typeof e.autoEligible, cls).toBe('string' === typeof true ? 'boolean' : 'boolean');
    }
    expect(Object.keys(RECOVERY_CATALOGUE).sort()).toEqual([...FAILURE_CLASSES].sort());
  });

  it('keeps the classes that need a human decision non-auto-eligible', () => {
    for (const cls of ['unknown', 'policy-approval', 'integration-conflict', 'dependency-setup', 'timeout-resource'] as const) {
      expect(recoveryEntry(cls).autoEligible, cls).toBe(false);
    }
    for (const cls of ['compile-type', 'test-assertion', 'lint-format', 'runtime-process'] as const) {
      expect(recoveryEntry(cls).autoEligible, cls).toBe(true);
    }
  });

  it('renders guidance that names the evidence, the diagnosis, and the proof', () => {
    const g = renderRecoveryGuidance('compile-type', { includeStops: true });
    expect(g).toContain('failure class: compile-type');
    expect(g).toContain('required evidence:');
    expect(g).toContain('diagnose first:');
    expect(g).toContain('prove the repair with: run_check');
    expect(g).toContain('stop and escalate when:');
    expect(renderRecoveryGuidance('unknown')).toContain('NOT eligible for automatic repair');
  });
});

describe('classification is structural and attributable', () => {
  const c = (e: FailureEvidence): ReturnType<typeof classifyFailure> => classifyFailure(e);
  const check = (over: Partial<Extract<FailureEvidence, { source: 'check' }>>): FailureEvidence => ({
    source: 'check',
    seq: 1,
    check: 'test',
    recipeId: 'r',
    status: 'fail',
    exitCode: 1,
    signals: [],
    summary: 's',
    ...over,
  });

  it('a missing toolchain outranks every downstream diagnostic', () => {
    for (const sig of ['command-not-found', 'module-not-found', 'missing-dependency']) {
      const r = c(check({ check: 'typecheck', signals: [sig, 'ts-error'] }));
      expect(r.class, sig).toBe('dependency-setup');
      expect(r.signals, sig).toContain(sig);
    }
    expect(c(check({ termination: 'spawn-error', status: 'error', exitCode: null })).class).toBe('dependency-setup');
  });

  it('a killed check is a resource failure, never a test failure', () => {
    const r = c(check({ check: 'test', termination: 'timeout', status: 'error', exitCode: null, signals: ['assertion-failed'] }));
    expect(r.class).toBe('timeout-resource');
    expect(r.signals).toContain('termination:timeout');
  });

  it('classifies compile, test, and lint failures by signal then by kind', () => {
    expect(c(check({ check: 'build', signals: ['ts-error'] })).class).toBe('compile-type');
    expect(c(check({ check: 'typecheck', signals: [] })).class).toBe('compile-type');
    expect(c(check({ check: 'test', signals: ['assertion-failed'] }))).toMatchObject({ class: 'test-assertion', confidence: 'high' });
    expect(c(check({ check: 'test', signals: [] }))).toMatchObject({ class: 'test-assertion', confidence: 'medium' });
    expect(c(check({ check: 'lint', signals: ['lint-violation'] })).class).toBe('lint-format');
    expect(c(check({ check: 'format', signals: [] })).class).toBe('lint-format');
  });

  it('classifies resource, permission, and network signals', () => {
    expect(c(check({ signals: ['out-of-memory'] })).class).toBe('timeout-resource');
    expect(c(check({ signals: ['port-in-use'] })).class).toBe('timeout-resource');
    expect(c(check({ signals: ['permission-denied'] })).class).toBe('runtime-process');
    expect(c(check({ signals: ['network-error'] }))).toMatchObject({ class: 'dependency-setup', confidence: 'medium' });
  });

  it('classifies cargo and go compiler failures as compile-type by their own signals (Session 18)', () => {
    expect(c(check({ check: 'build', signals: ['rust-error'] }))).toMatchObject({ class: 'compile-type', confidence: 'high' });
    // A go test run failing with COMPILE errors is a compile failure — the signal outranks the
    // kind fallback, which is exactly why the signal exists.
    expect(c(check({ check: 'test', signals: ['go-error'] }))).toMatchObject({ class: 'compile-type', confidence: 'high' });
    const r = c(check({ check: 'build', signals: ['rust-error'] }));
    expect(r.signals).toContain('rust-error');
    // An unrecognized cargo failure still lands via the kind fallback at medium confidence.
    expect(c(check({ check: 'build', signals: [] }))).toMatchObject({ class: 'compile-type', confidence: 'medium' });
  });

  it('a delegated task ending in a bare error stays UNKNOWN and points at the child log', () => {
    const r = c({ source: 'task', seq: 1, planTaskId: 'api', childSessionId: 'ch1', status: 'error', supervision: [] });
    expect(r.class).toBe('unknown');
    expect(r.detail).toContain('agent report ch1');
  });

  it('classifies task budget/timeout and supervisor-stall outcomes', () => {
    for (const status of ['timeout', 'budget-steps', 'budget-tokens'] as const) {
      expect(c({ source: 'task', seq: 1, childSessionId: 'ch', status, supervision: [] }).class, status).toBe('timeout-resource');
    }
    expect(c({ source: 'task', seq: 1, childSessionId: 'ch', status: 'stalled', supervision: ['loop'] })).toMatchObject({
      class: 'runtime-process',
    });
  });

  it('classifies integration refusals and policy denials', () => {
    expect(c({ source: 'integration', seq: 1, childSessionId: 'ch', refused: [{ relPath: 'a.ts', reason: 'drift: ...' }] })).toMatchObject({
      class: 'integration-conflict',
      confidence: 'high',
    });
    expect(c({ source: 'policy', seq: 1, callId: 'c', tool: 'run_command', rule: 'cmd.circuit-breaker', decision: 'deny' }).class).toBe(
      'policy-approval',
    );
  });

  it('gives the same failure a stable signature and different failures different ones', () => {
    const a = c(check({ check: 'typecheck', recipeId: 'r1', signals: ['ts-error'] }));
    const b = c(check({ check: 'typecheck', recipeId: 'r1', signals: ['ts-error'], seq: 99, summary: 'other text' }));
    const other = c(check({ check: 'typecheck', recipeId: 'r2', signals: ['ts-error'] }));
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(other.signature);
  });

  it('user interventions and crashes are not failure outcomes', () => {
    for (const s of ['cancelled', 'user-stopped', 'aborted', 'completed']) expect(isFailureTaskStatus(s), s).toBe(false);
    for (const s of ['error', 'timeout', 'budget-steps', 'budget-tokens', 'stalled']) expect(isFailureTaskStatus(s), s).toBe(true);
  });
});

describe('latestFailureEvidence reads only recorded failures', () => {
  it('picks the newest failure and can scope to a plan task', () => {
    reset();
    const events = [
      ev({ type: 'task.started', callId: 'c1', role: 'executor', childSessionId: 'ch1', budget: {}, planTaskId: 'api' }),
      checkFail('typecheck', ['ts-error'], { planTaskId: 'api' }),
      checkFail('lint', ['lint-violation'], { planTaskId: 'ui' }),
    ];
    expect(latestFailureEvidence(events)!.source).toBe('check');
    expect((latestFailureEvidence(events, 'api') as { check: string }).check).toBe('typecheck');
    expect(latestFailureEvidence(events, 'nope')).toBeNull();
  });

  it('ignores user-terminated tasks and passing checks', () => {
    reset();
    const events = [
      ev({ type: 'task.started', callId: 'c1', role: 'executor', childSessionId: 'ch1', budget: {}, planTaskId: 'api' }),
      ev({ type: 'task.ended', callId: 'c1', childSessionId: 'ch1', status: 'user-stopped', steps: 1, usage: { inputTokens: 0, outputTokens: 0 }, resultSha256: 'x', durationMs: 1 }),
      checkPass('test'),
    ];
    expect(latestFailureEvidence(events)).toBeNull();
  });
});

describe('the repair ledger derives outcomes; it never records them', () => {
  it('an attempt closes only when EVERY declared regression check passes after it', () => {
    reset();
    const partial = [attempt({ regressionChecks: ['typecheck', 'test'] }), checkPass('typecheck')];
    expect(foldRepairs(partial).attempts[0]).toMatchObject({ outcome: 'open', pendingChecks: ['test'] });

    reset();
    const full = [attempt({ regressionChecks: ['typecheck', 'test'] }), checkPass('typecheck'), checkPass('test')];
    expect(foldRepairs(full).attempts[0]).toMatchObject({ outcome: 'succeeded', pendingChecks: [] });
  });

  it('a check that passed BEFORE the attempt cannot close it', () => {
    reset();
    const events = [checkPass('typecheck'), attempt()];
    expect(foldRepairs(events).attempts[0]!.outcome).toBe('open');
  });

  it('a newer attempt for the same signature supersedes the previous one', () => {
    reset();
    const events = [attempt(), attempt({ hypothesisSha: 'h2', attempt: 2 }), checkPass('typecheck')];
    const l = foldRepairs(events);
    expect(l.attempts[0]!.outcome).toBe('superseded');
    expect(l.attempts[1]!.outcome).toBe('succeeded');
  });

  it('detects changes outside the declared scope (an expanding diff)', () => {
    reset();
    const events = [
      attempt({ scopePaths: ['src/api'] }),
      ev({ type: 'file.mutated', callId: 'm', path: 'src/api/a.ts', kind: 'modify', beforeSha256: 'a', afterSha256: 'b', createdDirs: [] }),
      ev({ type: 'file.mutated', callId: 'm', path: 'src/ui/b.ts', kind: 'modify', beforeSha256: 'a', afterSha256: 'b', createdDirs: [] }),
    ];
    expect(foldRepairs(events).attempts[0]!.outOfScope).toEqual(['src/ui/b.ts']);
    // The caller supplies the plan task's own touches as extra allowed scope.
    expect(foldRepairs(events, { extraScope: () => ['src/ui'] }).attempts[0]!.outOfScope).toEqual([]);
  });

  it('counts applied task files as changes for scope purposes', () => {
    reset();
    const events = [
      attempt({ scopePaths: ['src/api'] }),
      ev({ type: 'task.applied', callId: 'c', childSessionId: 'ch', applied: ['src/other/x.ts'], refused: [] }),
    ];
    expect(foldRepairs(events).attempts[0]!.outOfScope).toEqual(['src/other/x.ts']);
  });

  it('does NOT count another plan task’s integration as this repair spreading', () => {
    // Review finding: integrating an unrelated task permanently tripped the scope-expanded stop
    // for whichever repair happened to be open — bricking the repair path for a different task.
    reset();
    const events = [
      ev({ type: 'task.started', callId: 'c2', role: 'executor', childSessionId: 'chB', budget: {}, planTaskId: 'ui' }),
      attempt({ target: 'api', scopePaths: ['src/api'] }),
      ev({ type: 'task.applied', callId: 'c2', childSessionId: 'chB', applied: ['src/ui/b.ts'], refused: [] }),
    ];
    expect(foldRepairs(events).attempts[0]!.outOfScope).toEqual([]);
  });

  it('tracks wall time from the attempt to the newest event', () => {
    reset();
    const events = [attempt({}, 0), checkFail('typecheck', ['ts-error'])];
    expect(foldRepairs(events).attempts[0]!.ageMs).toBe(1000);
  });

  it('an escalation stands until a later attempt for the same signature succeeds', () => {
    reset();
    const open = [ev({ type: 'repair.escalated', callId: 'c', target: 'api', failureClass: 'unknown', signature: 'sig1', reason: 'no idea' })];
    expect(foldRepairs(open).escalations[0]!.open).toBe(true);
    expect(openRepairBlockers(foldRepairs(open))[0]).toContain('repair escalated and unresolved');

    reset();
    const resolved = [
      ev({ type: 'repair.escalated', callId: 'c', target: 'api', failureClass: 'unknown', signature: 'sig1', reason: 'no idea' }),
      attempt(),
      checkPass('typecheck'),
    ];
    expect(foldRepairs(resolved).escalations[0]!.open).toBe(false);
    expect(openRepairBlockers(foldRepairs(resolved))).toEqual([]);
  });

  it('an unproven repair is an honest blocker', () => {
    reset();
    expect(openRepairBlockers(foldRepairs([attempt()]))[0]).toContain('is unproven');
  });

  it('a USER dismissal closes the escalation, joined on the escalation seq (S21)', () => {
    reset();
    const escalated = ev({ type: 'repair.escalated', callId: 'c', target: 'session', failureClass: 'timeout-resource', signature: 'sig1', reason: 'wall clock' });
    const escSeq = (escalated as { seq: number }).seq;
    const events = [
      escalated,
      ev({ type: 'repair.dismissed', escalationSeq: escSeq, target: 'session', failureClass: 'timeout-resource', signature: 'sig1', reason: 'reviewed by hand; timeout was environmental', source: 'user' }),
    ];
    const ledger = foldRepairs(events);
    expect(ledger.escalations[0]!.open).toBe(false);
    expect(ledger.escalations[0]!.dismissed).toEqual({ seq: (events[1] as { seq: number }).seq, reason: 'reviewed by hand; timeout was environmental' });
    expect(openRepairBlockers(ledger)).toEqual([]);
  });

  it('a dismissal for a DIFFERENT escalation seq does not clear this one, even with the same signature', () => {
    reset();
    const escalated = ev({ type: 'repair.escalated', callId: 'c', target: 'session', failureClass: 'timeout-resource', signature: 'sig1', reason: 'wall clock' });
    const events = [
      escalated,
      ev({ type: 'repair.dismissed', escalationSeq: 999_999, target: 'session', failureClass: 'timeout-resource', signature: 'sig1', reason: 'stale index', source: 'user' }),
    ];
    const ledger = foldRepairs(events);
    expect(ledger.escalations[0]!.open).toBe(true);
    expect(ledger.escalations[0]!.dismissed).toBeNull();
  });

  it('a dismissal whose source is not the user is inert (fold-level consent, the review-triage precedent)', () => {
    reset();
    const escalated = ev({ type: 'repair.escalated', callId: 'c', target: 'session', failureClass: 'timeout-resource', signature: 'sig1', reason: 'wall clock' });
    const escSeq = (escalated as { seq: number }).seq;
    const forged = ev({ type: 'repair.dismissed', escalationSeq: escSeq, target: 'session', failureClass: 'timeout-resource', signature: 'sig1', reason: 'model says fine', source: 'model' } as never);
    const ledger = foldRepairs([escalated, forged]);
    expect(ledger.escalations[0]!.open).toBe(true);
    expect(openRepairBlockers(ledger).length).toBe(1);
  });

  it('is identical when re-derived (crash-resume safety)', () => {
    reset();
    const events = [attempt(), checkPass('typecheck')];
    expect(JSON.stringify(foldRepairs(events))).toBe(JSON.stringify(foldRepairs(events)));
  });
});

describe('the bounded repair policy', () => {
  const classification = (over: Record<string, unknown> = {}) =>
    ({ class: 'compile-type', confidence: 'high', signals: ['ts-error'], signature: 'sig1', subject: 'r', detail: 'd', ...over }) as never;

  it('an UNKNOWN classification stops and escalates — it never permits an attempt', () => {
    reset();
    const v = evaluateRepair({ classification: classification({ class: 'unknown' }), failureSeq: 1, ledger: foldRepairs([]) });
    expect(v.eligible).toBe(false);
    expect(v.stop!.reason).toBe('unknown-classification');
  });

  it('a class that needs a human decision stops, whatever the budget', () => {
    reset();
    for (const cls of ['policy-approval', 'integration-conflict', 'dependency-setup', 'timeout-resource'] as const) {
      const v = evaluateRepair({ classification: classification({ class: cls }), failureSeq: 1, ledger: foldRepairs([]) });
      expect(v.stop?.reason, cls).toBe('requires-user-decision');
    }
  });

  it('permits a first attempt on an auto-eligible class and names its preconditions', () => {
    reset();
    const v = evaluateRepair({ classification: classification(), failureSeq: 1, ledger: foldRepairs([]) });
    expect(v.eligible).toBe(true);
    expect(v.attemptsRemaining).toBe(MAX_REPAIR_ATTEMPTS);
    expect(v.needsNewPlan).toBe(true);
    expect(v.requires.join(' ')).toContain('differs from the previous attempt');
    expect(v.requires.join(' ')).toContain('regression check');
  });

  it('stops when the per-signature attempt ceiling is spent', () => {
    reset();
    const events = Array.from({ length: MAX_REPAIR_ATTEMPTS }, (_, i) => attempt({ hypothesisSha: `h${i}`, attempt: i + 1 }));
    const v = evaluateRepair({ classification: classification(), failureSeq: 0, ledger: foldRepairs(events) });
    expect(v.stop!.reason).toBe('attempts-exhausted');
  });

  it('stops on a repeated identical hypothesis', () => {
    reset();
    const v = evaluateRepair({ classification: classification(), failureSeq: 0, ledger: foldRepairs([attempt()]), hypothesisSha: 'h1' });
    expect(v.stop!.reason).toBe('repeated-identical-hypothesis');
    const fresh = evaluateRepair({ classification: classification(), failureSeq: 0, ledger: foldRepairs([attempt()]), hypothesisSha: 'h2' });
    expect(fresh.eligible).toBe(true);
  });

  it('stops when a previous attempt expanded outside its declared scope', () => {
    reset();
    const events = [
      attempt({ scopePaths: ['src/api'] }),
      ev({ type: 'file.mutated', callId: 'm', path: 'src/elsewhere/x.ts', kind: 'modify', beforeSha256: 'a', afterSha256: 'b', createdDirs: [] }),
    ];
    const v = evaluateRepair({ classification: classification(), failureSeq: 0, ledger: foldRepairs(events), hypothesisSha: 'h9' });
    expect(v.stop!.reason).toBe('scope-expanded');
    expect(v.stop!.detail).toContain('src/elsewhere/x.ts');
  });

  it('stops when the session-wide repair budget is spent', () => {
    reset();
    const events = Array.from({ length: REPAIRS_PER_SESSION }, (_, i) => attempt({ signature: `s${i}`, hypothesisSha: `h${i}` }));
    const v = evaluateRepair({ classification: classification({ signature: 'brand-new' }), failureSeq: 0, ledger: foldRepairs(events) });
    expect(v.stop!.reason).toBe('session-budget-exhausted');
  });

  it('stops when delegated repair work has spent its token budget', () => {
    reset();
    const events = [
      attempt(),
      ev({
        type: 'task.ended',
        callId: 'c',
        childSessionId: 'ch',
        status: 'completed',
        steps: 1,
        usage: { inputTokens: 0, outputTokens: REPAIR_CHILD_TOKEN_BUDGET },
        resultSha256: 'x',
        durationMs: 1,
      }),
    ];
    const v = evaluateRepair({ classification: classification(), failureSeq: 0, ledger: foldRepairs(events), hypothesisSha: 'h2' });
    expect(v.stop!.reason).toBe('token-budget-exhausted');
  });

  it('stops when one failure has absorbed too much IN-SESSION wall time', () => {
    reset();
    // Many small steps, each within the idle window, summing past the budget.
    const events: SessionEvent[] = [attempt({}, 0)];
    const step = 60_000;
    for (let t = 0; t <= REPAIR_WALL_MS + step; t += step) events.push(ev({ type: 'user.message', text: 'working' }, step));
    const v = evaluateRepair({ classification: classification(), failureSeq: 0, ledger: foldRepairs(events), hypothesisSha: 'h2' });
    expect(v.stop!.reason).toBe('wall-time-exhausted');
  });

  it('does NOT count time the session was not running (a resume the next day must not exhaust it)', () => {
    reset();
    // One attempt, then a 16-hour gap: the budget measures effort, not the calendar.
    const events = [attempt({}, 0), ev({ type: 'user.message', text: 'good morning' }, 16 * 60 * 60 * 1000)];
    const v = evaluateRepair({ classification: classification(), failureSeq: 0, ledger: foldRepairs(events), hypothesisSha: 'h2' });
    expect(v.stop).toBeUndefined();
    expect(v.eligible).toBe(true);
  });

  it('needsNewPlan is false while an attempt is still OPEN, and true once it closed', () => {
    // Re-running the failing check is the catalogue's own prescribed diagnostic; it must not
    // invalidate the plan just recorded, or following the guidance would burn the budget.
    reset();
    const open = foldRepairs([attempt(), checkFail('typecheck', ['ts-error'])]);
    expect(evaluateRepair({ classification: classification(), failureSeq: 99, ledger: open }).needsNewPlan).toBe(false);

    reset();
    const closed = foldRepairs([attempt(), checkPass('typecheck')]);
    expect(evaluateRepair({ classification: classification(), failureSeq: 99, ledger: closed }).needsNewPlan).toBe(true);

    reset();
    expect(evaluateRepair({ classification: classification(), failureSeq: 0, ledger: foldRepairs([]) }).needsNewPlan).toBe(true);
  });
});
