import { describe, expect, it } from 'vitest';
import { classifyFailure, latestFailureEvidence, type FailureEvidence } from '../src/recovery/classify.js';
import { proveWith, recoveryEntry, renderRecoveryGuidance } from '../src/recovery/catalogue.js';
import { foldRepairs } from '../src/recovery/ledger.js';
import { evaluateRepair } from '../src/recovery/policy.js';
import { FAILURE_CLASSES, type SessionEvent } from '../src/types.js';

/**
 * Session 13 recovery integration: browser and preview failures classify deterministically into
 * the two new classes (or the existing ones where they honestly belong), guidance never names
 * an impossible call, and the generic ledger closes browser repairs on a flow pass.
 */

let seq = 0;
const ev = (body: Record<string, unknown>): SessionEvent => ({ v: 1, seq: ++seq, ts: 't', ...body }) as unknown as SessionEvent;

const browserCheck = (signals: string[], status: 'fail' | 'error' = 'fail'): FailureEvidence => ({
  source: 'check',
  seq: 1,
  check: 'browser',
  recipeId: 'browser.flow/smoke',
  status,
  exitCode: null,
  signals,
  summary: 'flow failed',
});

describe('S14.5 FIX: a user-ABORTED check is not a repairable defect', () => {
  it('classifies aborted as unknown for EVERY check kind (the branch was unreachable below the per-kind rules)', () => {
    // `termination: 'aborted'` sat after branches matching every CheckKind, so a Ctrl+C'd
    // typecheck classified as 'compile-type' — auto-eligible — and a cancellation that produced
    // NO verdict became a diagnosis that spent the repair budget.
    for (const kind of ['typecheck', 'build', 'test', 'test-targeted', 'lint', 'format', 'static-analysis'] as const) {
      const c = classifyFailure({
        source: 'check',
        seq: 1,
        check: kind,
        recipeId: `node.${kind}`,
        status: 'error',
        exitCode: null,
        termination: 'aborted',
        signals: [],
        summary: `${kind} check → error`,
      });
      expect(c.class, kind).toBe('unknown');
      expect(c.signals, kind).toContain('termination:aborted');
    }
  });
});

describe('classifyCheck — the browser branch', () => {
  it('routes assertion/timeout/navigation/page-error failures to browser-verification (high)', () => {
    for (const sig of ['browser-assertion-failed', 'browser-timeout', 'browser-navigation', 'page-error']) {
      const c = classifyFailure(browserCheck([sig]));
      expect(c.class, sig).toBe('browser-verification');
      expect(c.confidence).toBe('high');
      expect(c.signals).toContain(sig);
      expect(c.subject).toBe('browser.flow/smoke');
    }
  });

  it('browser-unavailable outranks everything → dependency-setup (a toolchain only the user installs)', () => {
    const c = classifyFailure(browserCheck(['browser-unavailable', 'browser-assertion-failed'], 'error'));
    expect(c.class).toBe('dependency-setup');
  });

  it('preview-died routes to runtime-process — the server died; the flow was only the witness', () => {
    const c = classifyFailure(browserCheck(['preview-died'], 'error'));
    expect(c.class).toBe('runtime-process');
  });

  it('a signal-less browser FAIL still classifies browser-verification (medium); an ERROR stays unknown', () => {
    expect(classifyFailure(browserCheck(['console-error']))).toMatchObject({ class: 'browser-verification', confidence: 'medium' });
    expect(classifyFailure(browserCheck([], 'error')).class).toBe('unknown');
  });

  it('NEVER falls through to legacy shell branches: even lying legacy signals cannot misroute browser evidence', () => {
    // Hostile/erroneous 'ts-error' on browser evidence: without the branch guard this would
    // classify compile-type and a "repair" would go hunting for type errors that do not exist.
    const c = classifyFailure(browserCheck(['ts-error', 'syntax-error']));
    expect(c.class).toBe('browser-verification');
    expect(c.signals).not.toContain('ts-error');
  });
});

describe('classifyFailure — the preview evidence arm', () => {
  const preview = (reason: 'crashed' | 'start-failed', logTail?: string): FailureEvidence => ({
    source: 'preview',
    seq: 1,
    previewId: 'pv-1',
    reason,
    exitCode: 1,
    ...(logTail !== undefined ? { logTail } : {}),
  });

  it('start-failed → preview-startup; an EADDRINUSE log tail fires port-in-use', () => {
    expect(classifyFailure(preview('start-failed'))).toMatchObject({ class: 'preview-startup', confidence: 'high', subject: 'pv-1' });
    const conflict = classifyFailure(preview('start-failed', 'Error: listen EADDRINUSE: address already in use'));
    expect(conflict.class).toBe('preview-startup');
    expect(conflict.signals).toContain('port-in-use');
    expect(conflict.detail).toContain('port in use');
  });

  it('crashed-while-serving → runtime-process (the existing class; no new vocabulary needed)', () => {
    expect(classifyFailure(preview('crashed')).class).toBe('runtime-process');
  });
});

describe('latestFailureEvidence — preview.ended', () => {
  it('picks up crashed/start-failed at session scope; lifecycle ends are never failures; plan targets skip it', () => {
    seq = 0;
    const events = [
      ev({ type: 'preview.ended', previewId: 'pv-a', reason: 'stopped', exitCode: null, logFile: 'x' }),
      ev({ type: 'preview.ended', previewId: 'pv-b', reason: 'crashed', exitCode: 3, logFile: 'x', logTail: 'boom' }),
      ev({ type: 'preview.ended', previewId: 'pv-c', reason: 'ttl-timeout', exitCode: null, logFile: 'x' }),
    ];
    const got = latestFailureEvidence(events);
    expect(got).toMatchObject({ source: 'preview', previewId: 'pv-b', reason: 'crashed', logTail: 'boom' });
    expect(latestFailureEvidence(events, 'some-plan-task')).toBeNull();
  });

  it('the newest failure wins across sources', () => {
    seq = 0;
    const events = [
      ev({ type: 'check.completed', callId: 'c1', check: 'test', recipeId: 'r', status: 'fail', exitCode: 1, durationMs: 1, summary: 's' }),
      ev({ type: 'preview.ended', previewId: 'pv-b', reason: 'start-failed', exitCode: 1, logFile: 'x' }),
    ];
    expect(latestFailureEvidence(events)).toMatchObject({ source: 'preview', reason: 'start-failed' });
  });
});

describe('catalogue — the two new rows', () => {
  it('every FailureClass has a row (the compiler forces it; this pins the runtime view)', () => {
    for (const cls of FAILURE_CLASSES) expect(recoveryEntry(cls).class).toBe(cls);
  });

  it('preview-startup and browser-verification are auto-eligible with browser regression proofs', () => {
    expect(recoveryEntry('preview-startup')).toMatchObject({ autoEligible: true, regressionChecks: ['browser'] });
    expect(recoveryEntry('browser-verification')).toMatchObject({ autoEligible: true, regressionChecks: ['browser', 'test'] });
  });

  it('proveWith is the one composer every kind-list instruction goes through', () => {
    expect(proveWith(['test', 'lint'])).toBe('run_check test, lint');
    expect(proveWith(['browser'])).toBe('a passing browser_flow');
    expect(proveWith(['test', 'browser'])).toBe('run_check test + a passing browser_flow');
  });

  it("guidance NEVER instructs the impossible 'run_check browser'", () => {
    const g1 = renderRecoveryGuidance('preview-startup');
    expect(g1).toContain('prove the repair with: a passing browser_flow');
    expect(g1).not.toContain('run_check browser');
    const g2 = renderRecoveryGuidance('browser-verification');
    expect(g2).toContain('run_check test + a passing browser_flow');
    expect(g2).not.toContain('run_check browser');
    // Shell-kind guidance is untouched.
    expect(renderRecoveryGuidance('lint-format')).toContain('prove the repair with: run_check lint, format');
  });
});

describe('ledger + policy over the new classes', () => {
  it("a ['browser'] repair attempt is closed by a later browser flow PASS (the generic closure)", () => {
    seq = 0;
    const events = [
      ev({
        type: 'repair.attempted',
        callId: 'r1',
        target: 'session',
        failureClass: 'browser-verification',
        signature: 'sig-1',
        hypothesis: 'the add handler never updates the list; wire it to state',
        hypothesisSha: 'h1',
        scopePaths: ['src/'],
        regressionChecks: ['browser'],
        attempt: 1,
      }),
      ev({ type: 'check.completed', callId: 'c9', check: 'browser', recipeId: 'browser.flow/smoke', status: 'pass', exitCode: null, durationMs: 5, summary: 'pass' }),
    ];
    const ledger = foldRepairs(events);
    expect(ledger.attempts[0]!.outcome).toBe('succeeded');
    expect(ledger.attempts[0]!.pendingChecks).toEqual([]);
  });

  it('a fresh browser-verification failure is auto-eligible; unknown browser errors stop', () => {
    const classification = classifyFailure(browserCheck(['browser-assertion-failed']));
    const verdict = evaluateRepair({ classification, failureSeq: 10, ledger: foldRepairs([]) });
    expect(verdict.stop).toBeUndefined();

    const unknown = classifyFailure(browserCheck([], 'error'));
    const stopped = evaluateRepair({ classification: unknown, failureSeq: 10, ledger: foldRepairs([]) });
    expect(stopped.stop?.reason).toBe('unknown-classification');
  });
});
