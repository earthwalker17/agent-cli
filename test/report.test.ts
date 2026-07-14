import { describe, it, expect } from 'vitest';
import { buildReport } from '../src/report/report.js';
import type { SessionEvent } from '../src/types.js';

const started: SessionEvent = {
  v: 1, seq: 1, ts: 't', type: 'session.started',
  sessionId: 's1', workspaceRoot: 'C:\\ws', model: 'm', mode: 'interactive', providerName: 'mock', argv: [],
};

type DistOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
function evt(e: DistOmit<SessionEvent, 'v' | 'ts'>): SessionEvent {
  return { v: 1, ts: 't', ...e } as unknown as SessionEvent;
}

describe('buildReport CHECKED/UNCHECKED', () => {
  it('marks a file CHECKED when a command exits 0 after the last mutation', () => {
    const events: SessionEvent[] = [
      started,
      evt({ seq: 2, type: 'user.message', text: 'edit and test' }),
      evt({ seq: 3, type: 'tool.requested', callId: 'c1', tool: 'edit_file', input: {} }),
      evt({ seq: 4, type: 'file.mutated', callId: 'c1', path: 'C:\\ws\\a.ts', kind: 'modify', beforeSha256: 'aa', afterSha256: 'bb', createdDirs: [] }),
      evt({ seq: 5, type: 'tool.completed', callId: 'c1', ok: true, outputPreview: 'edited', durationMs: 3, truncated: false }),
      evt({ seq: 6, type: 'tool.requested', callId: 'c2', tool: 'run_command', input: { command: 'npm test' } }),
      evt({ seq: 7, type: 'tool.completed', callId: 'c2', ok: true, outputPreview: 'ok', exitCode: 0, durationMs: 100, truncated: false }),
      evt({ seq: 8, type: 'session.ended', reason: 'completed' }),
    ];
    const { json, md } = buildReport({ events });
    expect(json.filesChanged[0]).toMatchObject({ path: 'C:\\ws\\a.ts', checked: true, checkedBy: 'npm test' });
    expect(md).toContain('CHECKED (check ran, exit 0: `npm test`)');
  });

  it('marks a file UNCHECKED when no passing command ran after the change', () => {
    const events: SessionEvent[] = [
      started,
      evt({ seq: 2, type: 'tool.requested', callId: 'c1', tool: 'write_file', input: {} }),
      evt({ seq: 3, type: 'file.mutated', callId: 'c1', path: 'C:\\ws\\a.ts', kind: 'create', beforeSha256: null, afterSha256: 'bb', createdDirs: [] }),
      evt({ seq: 4, type: 'tool.completed', callId: 'c1', ok: true, outputPreview: 'created', durationMs: 2, truncated: false }),
      evt({ seq: 5, type: 'session.ended', reason: 'completed' }),
    ];
    const { json, md } = buildReport({ events });
    expect(json.filesChanged[0]!.checked).toBe(false);
    expect(md).toContain('UNCHECKED');
  });

  it('does NOT mark CHECKED when the command failed (nonzero) after the change', () => {
    const events: SessionEvent[] = [
      started,
      evt({ seq: 2, type: 'tool.requested', callId: 'c1', tool: 'edit_file', input: {} }),
      evt({ seq: 3, type: 'file.mutated', callId: 'c1', path: 'C:\\ws\\a.ts', kind: 'modify', beforeSha256: 'aa', afterSha256: 'bb', createdDirs: [] }),
      evt({ seq: 4, type: 'tool.completed', callId: 'c1', ok: true, outputPreview: '', durationMs: 1, truncated: false }),
      evt({ seq: 5, type: 'tool.requested', callId: 'c2', tool: 'run_command', input: { command: 'npm test' } }),
      evt({ seq: 6, type: 'tool.completed', callId: 'c2', ok: false, outputPreview: 'FAIL', exitCode: 1, durationMs: 50, truncated: false }),
    ];
    expect(buildReport({ events }).json.filesChanged[0]!.checked).toBe(false);
  });
});

describe('buildReport determinism & honesty', () => {
  it('produces byte-identical output for identical events', () => {
    const events: SessionEvent[] = [started, evt({ seq: 2, type: 'session.ended', reason: 'completed' })];
    expect(buildReport({ events }).md).toBe(buildReport({ events }).md);
  });

  it('always prints the narrative-is-not-evidence and undo-scope footer', () => {
    const md = buildReport({ events: [started] }).md;
    expect(md).toContain('Assistant narrative is not evidence');
    expect(md).toContain('run_command side effects');
    expect(md).toContain('no OS sandbox');
  });

  it('renders a crashed session (no session.ended) as CRASHED/UNKNOWN, never completed', () => {
    const md = buildReport({ events: [started] }).md;
    expect(md).toContain('CRASHED/UNKNOWN');
    expect(md).not.toContain('ended: completed');
  });

  it('surfaces a corrupt-log banner and still renders prior events', () => {
    const events: SessionEvent[] = [started, evt({ seq: 2, type: 'user.message', text: 'do a thing' })];
    const { md } = buildReport({ events, corruptAt: { line: 5, kind: 'json' } });
    expect(md).toContain('CORRUPT LOG');
    expect(md).toContain('do a thing');
  });

  it('marks a snapshot-less mutation as NOT undoable', () => {
    const events: SessionEvent[] = [
      started,
      evt({ seq: 2, type: 'tool.requested', callId: 'c1', tool: 'write_file', input: {} }),
      evt({ seq: 3, type: 'file.mutated', callId: 'c1', path: 'C:\\ws\\a.ts', kind: 'modify', beforeSha256: 'aa', afterSha256: 'bb', createdDirs: [] }),
    ];
    // No snapshot.created event for c1.
    expect(buildReport({ events }).md).toContain('NOT undoable');
  });
});
