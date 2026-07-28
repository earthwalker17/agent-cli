import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSessionDiff, renderSessionDiff } from '../src/report/diff.js';
import { lineDiffStat, unifiedDiff, isProbablyBinary } from '../src/shared/diff.js';
import { SnapshotStore } from '../src/store/snapshots.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { startSession, endSession, runTurn, type Session } from '../src/runtime/session.js';
import { applyUndo } from '../src/runtime/undo.js';
import { MockProvider } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';

/** Stage-7 tests: shared diff utilities, per-mutation diffstat evidence, and the session diff. */

describe('shared diff utilities', () => {
  it('lineDiffStat counts added and removed lines', () => {
    expect(lineDiffStat('a\nb\nc\n', 'a\nX\nc\nd\n')).toEqual({ added: 2, removed: 1 });
    expect(lineDiffStat('same\n', 'same\n')).toEqual({ added: 0, removed: 0 });
  });
  it('unifiedDiff renders hunks and caps the body', () => {
    const patch = unifiedDiff('f.txt', 'a\nb\nc\n', 'a\nB\nc\n');
    expect(patch).toContain('--- a/f.txt');
    expect(patch).toContain('+++ b/f.txt');
    expect(patch).toContain('-b');
    expect(patch).toContain('+B');
    expect(unifiedDiff('f.txt', 'x\n', 'x\n')).toBe('');
    const big = unifiedDiff('f.txt', '', Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n'), 10);
    expect(big).toContain('diff truncated at 10 lines');
  });
  it('isProbablyBinary detects NUL bytes', () => {
    expect(isProbablyBinary(Buffer.from('plain text'))).toBe(false);
    expect(isProbablyBinary(Buffer.from([0x50, 0x4b, 0x00, 0x01]))).toBe(true);
  });
});

describe('session diff over a real session', () => {
  let tmp: string;
  let ws: string;
  let layout: ProjectLayout;
  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-sdiff-')));
    ws = path.join(tmp, 'ws');
    fs.mkdirSync(ws);
    layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function makeSession(script: ConstructorParameters<typeof MockProvider>[0]): Session {
    return startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'non-interactive',
      provider: new MockProvider(script),
      approver: autoDenyApprover,
      saltHex: '0'.repeat(32),
      maxSteps: 10,
      clock: fixedClock(0, 1),
      idGen: seededIdGen(),
    });
  }

  it("S14.5 (F): /diff carries the report's CHECKED verdict — one correlation, two surfaces", async () => {
    fs.writeFileSync(path.join(ws, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(ws, 'b.txt'), 'two\n');
    const session = makeSession([
      { say: 'editing a', calls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'one', new_string: 'ONE' } }] },
      { say: 'a done' },
      { say: 'editing b', calls: [{ name: 'edit_file', input: { path: 'b.txt', old_string: 'two', new_string: 'TWO' } }] },
      { say: 'b done' },
    ]);
    await runTurn(session, 'edit a.txt');
    // A passing typed check lands AFTER a.txt's mutation…
    session.log.append({
      type: 'check.completed', callId: 'chk-1', check: 'test', recipeId: 'node.pkgjson.test',
      status: 'pass', exitCode: 0, termination: 'exited', durationMs: 5, summary: 'ok',
    });
    // …and b.txt mutates AFTER the check, so no evidence covers it.
    await runTurn(session, 'edit b.txt');
    endSession(session, 'completed');

    const files = buildSessionDiff(session.log.events, session.snapshots, ws);
    const byRel = new Map(files.map((f) => [f.relPath, f]));
    expect(byRel.get('a.txt')).toMatchObject({ checked: true, checkedBy: 'test check (node.pkgjson.test)' });
    expect(byRel.get('b.txt')).toMatchObject({ checked: false });
    const rendered = renderSessionDiff(files);
    expect(rendered).toContain('[CHECKED: test check (node.pkgjson.test)');
    expect(rendered).toContain('no correctness claim');
    expect(rendered).toContain('[UNCHECKED]');
  });

  it('records diffstat evidence on file.mutated and renders the change as a unified diff', async () => {
    fs.writeFileSync(path.join(ws, 'a.txt'), 'one\ntwo\nthree\n');
    const session = makeSession([
      { say: 'editing', calls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'two', new_string: 'TWO\nextra' } }] },
      { say: 'done' },
    ]);
    await runTurn(session, 'edit a.txt');
    endSession(session, 'completed');

    const mut = session.log.events.find((e) => e.type === 'file.mutated');
    expect(mut).toMatchObject({ kind: 'modify', linesAdded: 2, linesRemoved: 1 });

    const files = buildSessionDiff(session.log.events, session.snapshots, ws);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ relPath: 'a.txt', kind: 'modify', drifted: false });
    expect(files[0]!.patch).toContain('-two');
    expect(files[0]!.patch).toContain('+TWO');
    const rendered = renderSessionDiff(files);
    expect(rendered).toContain('modify a.txt');
    expect(rendered).toContain('run_command side effects are not tracked');
  });

  it('a created-then-undone file reads as net-unchanged; external edits flag drift', async () => {
    fs.writeFileSync(path.join(ws, 'kept.txt'), 'base\n');
    const session = makeSession([
      {
        say: 'writing',
        calls: [
          { name: 'write_file', input: { path: 'new.txt', content: 'fresh\n' } },
          { name: 'edit_file', input: { path: 'kept.txt', old_string: 'base', new_string: 'BASE' } },
        ],
      },
      { say: 'done' },
    ]);
    await runTurn(session, 'write files');

    // Undo only the last change set? applyUndo('last') covers the last callId — undo new.txt via 'all' then redo scenario is overkill;
    // instead undo ALL, then externally re-edit kept.txt to create drift.
    const outcome = applyUndo(session.log.events, session.snapshots, 'all');
    session.log.append({ type: 'undo.applied', target: outcome.target, restored: outcome.restored, refused: outcome.refused });
    fs.writeFileSync(path.join(ws, 'kept.txt'), 'external edit\n');
    endSession(session, 'completed');

    const files = buildSessionDiff(session.log.events, session.snapshots, ws);
    const newFile = files.find((f) => f.relPath === 'new.txt')!;
    const kept = files.find((f) => f.relPath === 'kept.txt')!;
    expect(newFile.kind).toBe('unchanged'); // created, then undo deleted it
    expect(newFile.note).toContain('net-unchanged');
    expect(kept.drifted).toBe(true); // bytes differ from the undo-restored state the session recorded
  });

  it('renderSessionDiff states the empty case honestly', () => {
    expect(renderSessionDiff([])).toContain('no file-tool changes');
  });
});
