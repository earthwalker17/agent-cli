import { describe, it, expect } from 'vitest';
import { buildReport } from '../src/report/report.js';
import { classifyFailure, latestFailureEvidence } from '../src/recovery/classify.js';
import { computeAcceptance } from '../src/runtime/acceptance.js';
import { needsPreIntegrationCheckpoint } from '../src/tools/apply-changes.js';
import { recoveryEntry } from '../src/recovery/catalogue.js';
import type { SessionEvent } from '../src/types.js';

/**
 * What setup evidence is, and — more importantly — what it is NOT. The whole reason
 * `setup.started`/`setup.completed` are their own event types is that every existing reader treats
 * a zero exit as verification, and an install exiting 0 verifies nothing.
 */

const report = (events: readonly SessionEvent[]): ReturnType<typeof buildReport> => buildReport({ events });

let seq = 0;
const ev = (body: Record<string, unknown>): SessionEvent =>
  ({ v: 1, seq: ++seq, ts: '2026-07-31T00:00:00.000Z', ...body }) as unknown as SessionEvent;
const reset = (): void => {
  seq = 0;
};

const started = (over: Record<string, unknown> = {}): SessionEvent =>
  ev({
    type: 'setup.started',
    callId: 'k1',
    action: 'install',
    projectId: 'api',
    recipeId: 'setup.install.npm.ci@api',
    command: 'npm ci',
    cwd: 'C:/ws/api',
    timeoutMs: 900_000,
    packageManager: 'npm',
    lockfile: 'package-lock.json',
    lockfileSha: 'a'.repeat(64),
    ...over,
  });

const completed = (over: Record<string, unknown> = {}): SessionEvent =>
  ev({
    type: 'setup.completed',
    callId: 'k1',
    action: 'install',
    projectId: 'api',
    recipeId: 'setup.install.npm.ci@api',
    status: 'ok',
    exitCode: 0,
    durationMs: 4200,
    summary: 'install completed (exit 0) for project api',
    ...over,
  });

describe('the report section', () => {
  it('renders setup as WORK and says plainly that it is not verification', () => {
    reset();
    const { md, json } = report([ev({ type: 'session.started', sessionId: 's', workspaceRoot: 'C:/ws', model: 'm' }), started(), completed()]);
    expect(json.setups).toHaveLength(1);
    expect(json.setups![0]).toMatchObject({ action: 'install', projectId: 'api', status: 'ok', lockfile: 'package-lock.json' });
    expect(md).toContain('## Project setup (dependencies, migrations, seed)');
    expect(md).toContain('install [project api] → OK (exit 0)');
    expect(md).toContain('in: C:/ws/api; lockfile: package-lock.json');
    expect(md).toContain('Setup is WORK, not verification');
    expect(md).toContain('never marks a file CHECKED');
  });

  it('omits the section entirely when no setup ran — old logs render byte-identically', () => {
    reset();
    const { md, json } = report([ev({ type: 'session.started', sessionId: 's', workspaceRoot: 'C:/ws', model: 'm' })]);
    expect(json.setups).toBeUndefined();
    expect(md).not.toContain('## Project setup');
  });

  it('renders an interrupted setup as UNKNOWN state, never as done', () => {
    reset();
    const { md, json } = report([ev({ type: 'session.started', sessionId: 's', workspaceRoot: 'C:/ws', model: 'm' }), started()]);
    expect(json.setups![0]!.neverCompleted).toBe(true);
    expect(md).toContain('STARTED but never completed; the dependency or local data state is UNKNOWN');
  });

  it('a non-zero exit renders FAILED with the code, and a kill renders ERROR with none', () => {
    reset();
    const failed = report([started(), completed({ status: 'failed', exitCode: 1 })]).md;
    expect(failed).toContain('FAILED (exit 1)');

    reset();
    const killed = report([started(), completed({ status: 'error', exitCode: null, termination: 'timeout' })]).md;
    expect(killed).toContain('ERROR (timeout; no exit code)');
  });
});

describe('a setup NEVER counts as verification', () => {
  it('does not mark a mutated file CHECKED, even though it exited 0 after the mutation', () => {
    reset();
    const events = [
      ev({ type: 'session.started', sessionId: 's', workspaceRoot: 'C:/ws', model: 'm' }),
      ev({
        type: 'file.mutated',
        callId: 'm1',
        path: 'C:/ws/api/src/db.ts',
        kind: 'edit',
        beforeSha256: 'a'.repeat(64),
        afterSha256: 'b'.repeat(64),
        createdDirs: [],
      }),
      started(),
      completed(), // exit 0, strictly AFTER the mutation
    ];
    const { json, md } = report(events);
    expect(json.filesChanged[0]!.checked).toBe(false);
    expect(md).toContain('UNCHECKED');
  });

  it('a typed check with the same shape DOES mark it checked — the difference is the event type', () => {
    reset();
    const events = [
      ev({ type: 'session.started', sessionId: 's', workspaceRoot: 'C:/ws', model: 'm' }),
      ev({
        type: 'file.mutated',
        callId: 'm1',
        path: 'C:/ws/api/src/db.ts',
        kind: 'edit',
        beforeSha256: 'a'.repeat(64),
        afterSha256: 'b'.repeat(64),
        createdDirs: [],
      }),
      ev({ type: 'check.started', callId: 'c1', check: 'test', recipeId: 'r', command: 'npm test', cwd: 'C:/ws/api', timeoutMs: 1, projectId: 'api' }),
      ev({ type: 'check.completed', callId: 'c1', check: 'test', recipeId: 'r', status: 'pass', exitCode: 0, durationMs: 1, summary: 'ok', projectId: 'api' }),
    ];
    expect(report(events).json.filesChanged[0]!.checked).toBe(true);
  });

  it('labels a check with its project when there is more than one', () => {
    reset();
    const md = report([
      ev({ type: 'check.started', callId: 'c1', check: 'test', recipeId: 'r@api', command: 'npm test', cwd: 'C:/ws/api', timeoutMs: 1, projectId: 'api' }),
      ev({ type: 'check.completed', callId: 'c1', check: 'test', recipeId: 'r@api', status: 'pass', exitCode: 0, durationMs: 1, summary: 'ok', projectId: 'api' }),
    ]).md;
    expect(md).toContain('[project api]');
  });
});

describe('setup is work — it makes an acceptance stale and needs a recovery point', () => {
  it('setup.started marks a prior acceptance stale', () => {
    reset();
    const events = [
      ev({ type: 'session.accepted', complete: true, summary: 'done' }),
      started(),
    ];
    expect(computeAcceptance({ status: 'none' } as never, null, events).acceptedStale).toBe(true);
  });

  it('setup.started triggers the pre-integration checkpoint rule', () => {
    reset();
    expect(needsPreIntegrationCheckpoint([started()])).toBe(true);
  });
});

describe('recovery reads a failed setup as exactly its own class', () => {
  it('classifies a failed install as dependency-setup with high confidence', () => {
    reset();
    const e = latestFailureEvidence([started(), completed({ status: 'failed', exitCode: 1, signals: ['missing-dependency'] })])!;
    expect(e.source).toBe('setup');
    const c = classifyFailure(e);
    expect(c.class).toBe('dependency-setup');
    expect(c.confidence).toBe('high');
    expect(c.signals).toContain('setup:install');
    expect(c.detail).toContain("project install for 'api' failed (exit 1)");
  });

  it('an ABORTED setup is unknown — a user interruption is not a defect to repair', () => {
    reset();
    const e = latestFailureEvidence([started(), completed({ status: 'error', exitCode: null, termination: 'aborted' })])!;
    const c = classifyFailure(e);
    expect(c.class).toBe('unknown');
    expect(c.detail).toContain('nothing here to diagnose');
  });

  it('a TIMED-OUT setup is timeout-resource, not a dependency defect', () => {
    reset();
    const e = latestFailureEvidence([started(), completed({ status: 'error', exitCode: null, termination: 'timeout' })])!;
    expect(classifyFailure(e).class).toBe('timeout-resource');
  });

  it('is session-scoped: a task-targeted query never picks up a setup it did not run', () => {
    reset();
    expect(latestFailureEvidence([started(), completed({ status: 'failed', exitCode: 1 })], 'task-a')).toBeNull();
  });

  it('the dependency-setup catalogue now names a path forward, still human-gated', () => {
    const entry = recoveryEntry('dependency-setup');
    expect(entry.actions.join(' ')).toContain('project_setup install');
    expect(entry.autoEligible).toBe(false); // installing is never automatic
    expect(entry.requiresConfirmation.join(' ')).toContain('reaches the network');
  });
});
