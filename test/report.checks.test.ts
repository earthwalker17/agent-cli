import { describe, it, expect } from 'vitest';
import { buildReport } from '../src/report/report.js';
import type { EventBody, SessionEvent } from '../src/types.js';

let seq = 0;
function evt(body: EventBody): SessionEvent {
  return { v: 1, seq: ++seq, ts: 't', ...body } as SessionEvent;
}
function reset(): void {
  seq = 0;
}

function base(): SessionEvent[] {
  return [
    evt({
      type: 'session.started',
      sessionId: 's1',
      workspaceRoot: 'C:/ws',
      model: 'm',
      mode: 'interactive',
      providerName: 'mock',
      argv: [],
    }),
  ];
}

function mutated(path = 'src/a.ts'): EventBody {
  return { type: 'file.mutated', callId: 'm1', path, kind: 'modify', beforeSha256: 'a', afterSha256: 'b', createdDirs: [] };
}

function checkDone(over: Partial<Extract<EventBody, { type: 'check.completed' }>> = {}): EventBody {
  return {
    type: 'check.completed',
    callId: 'k1',
    check: 'typecheck',
    recipeId: 'node.script.typecheck',
    status: 'pass',
    exitCode: 0,
    termination: 'exited',
    durationMs: 1200,
    summary: 'typecheck PASS — node.script.typecheck: exit 0 in 1200ms',
    ...over,
  } as Extract<EventBody, { type: 'check.completed' }>;
}

describe('report: the Verification section', () => {
  it('renders passing, failing, and unsupported checks with honest verdicts', () => {
    reset();
    const events = [
      ...base(),
      evt({ type: 'check.started', callId: 'k1', check: 'typecheck', recipeId: 'node.script.typecheck', command: 'npm run typecheck', cwd: 'C:/ws', timeoutMs: 300_000 }),
      evt(checkDone()),
      evt({ type: 'check.started', callId: 'k2', check: 'test', recipeId: 'node.script.test', command: 'npm run test', cwd: 'C:/ws', timeoutMs: 900_000 }),
      evt(
        checkDone({
          callId: 'k2',
          check: 'test',
          recipeId: 'node.script.test',
          status: 'fail',
          exitCode: 1,
          summary: 'test FAIL — node.script.test: exit 1 in 900ms',
          findings: [{ file: 'test/a.test.ts', line: 3, message: 'expected 1 to be 2' }],
          signals: ['assertion-failed'],
        }),
      ),
      evt(
        checkDone({
          callId: 'k3',
          check: 'lint',
          recipeId: '(none)',
          status: 'unsupported',
          exitCode: null,
          durationMs: 0,
          summary: 'lint UNSUPPORTED — no lint recipe applies to this project',
        }),
      ),
      evt({ type: 'session.ended', reason: 'completed' }),
    ];
    const { md, json } = buildReport({ events });
    expect(json.checks?.length).toBe(3);
    expect(md).toContain('## Verification (typed checks)');
    expect(md).toContain('typecheck (node.script.typecheck) → PASS (exit 0) in 1200 ms — `npm run typecheck`');
    expect(md).toContain('test (node.script.test) → FAIL (exit 1)');
    expect(md).toContain('test/a.test.ts:3 — expected 1 to be 2');
    expect(md).toContain('signals: assertion-failed');
    expect(md).toContain('lint → UNSUPPORTED (never ran)');
    expect(md).toContain('A typed check PASSES only when its process genuinely exited with code 0.');
  });

  it('renders an interrupted check as having produced NO verdict', () => {
    reset();
    const events = [
      ...base(),
      evt({ type: 'check.started', callId: 'k9', check: 'build', recipeId: 'node.script.build', command: 'npm run build', cwd: 'C:/ws', timeoutMs: 600_000 }),
    ];
    const { md, json } = buildReport({ events });
    expect(json.checks?.[0]).toMatchObject({ status: 'no-verdict', neverCompleted: true });
    expect(md).toContain('STARTED but never completed; NO verdict');
  });

  it('records the plan-task label and targeted scope on the evidence', () => {
    reset();
    const events = [
      ...base(),
      evt({ type: 'check.started', callId: 'k1', check: 'test-targeted', recipeId: 'node.vitest.targeted', command: 'npx --no vitest run src/a', cwd: 'C:/ws', timeoutMs: 300_000, planTaskId: 'api', scopePaths: ['src/a'] }),
      evt(checkDone({ check: 'test-targeted', recipeId: 'node.vitest.targeted', planTaskId: 'api', scopePaths: ['src/a'], summary: 'test-targeted PASS' })),
    ];
    const { md } = buildReport({ events });
    expect(md).toContain('[plan task api]');
    expect(md).toContain('[scope: src/a]');
  });

  it('omits the section entirely when no check ran (old logs stay byte-identical)', () => {
    reset();
    const { md, json } = buildReport({ events: [...base(), evt({ type: 'session.ended', reason: 'completed' })] });
    expect(json.checks).toBeUndefined();
    expect(md).not.toContain('## Verification');
  });
});

describe('report: CHECKED accepts a passing typed check', () => {
  it('marks a file CHECKED when a typed check passed after its last mutation', () => {
    reset();
    const events = [
      ...base(),
      evt(mutated()),
      evt({ type: 'check.started', callId: 'k1', check: 'test', recipeId: 'node.script.test', command: 'npm run test', cwd: 'C:/ws', timeoutMs: 900_000 }),
      evt(checkDone({ check: 'test', recipeId: 'node.script.test' })),
    ];
    const { md, json } = buildReport({ events });
    expect(json.filesChanged[0]!.checked).toBe(true);
    expect(json.filesChanged[0]!.checkedBy).toBe('test check (node.script.test)');
    expect(md).toContain('CHECKED (check ran, exit 0: `test check (node.script.test)`)');
  });

  it('a FAILING or ERRORED typed check never marks a file CHECKED', () => {
    for (const over of [
      { status: 'fail' as const, exitCode: 1 },
      { status: 'error' as const, exitCode: null, termination: 'timeout' as const },
      { status: 'unsupported' as const, exitCode: null },
    ]) {
      reset();
      const events = [...base(), evt(mutated()), evt(checkDone(over))];
      expect(buildReport({ events }).json.filesChanged[0]!.checked, over.status).toBe(false);
    }
  });

  it('a typed check BEFORE the mutation does not mark it CHECKED', () => {
    reset();
    const events = [...base(), evt(checkDone()), evt(mutated())];
    expect(buildReport({ events }).json.filesChanged[0]!.checked).toBe(false);
  });

  it('attributes the file to the EARLIEST passing evidence after the change, command or check', () => {
    // Ordering pin: check and command evidence are merged and sorted by seq. An unsorted
    // concatenation would attribute this file to the later command instead of the earlier check.
    reset();
    const events = [
      ...base(),
      evt(mutated()),
      evt(checkDone()),
      evt({ type: 'tool.requested', callId: 'q1', tool: 'run_command', input: { command: 'npm test' } }),
      evt({ type: 'policy.decision', callId: 'q1', classification: 'observe', decision: 'allow', rule: 'r', reason: 'r' }),
      evt({ type: 'tool.completed', callId: 'q1', ok: true, outputPreview: '', exitCode: 0, durationMs: 5, truncated: false }),
    ];
    expect(buildReport({ events }).json.filesChanged[0]!.checkedBy).toBe('typecheck check (node.script.typecheck)');

    // And the reverse order attributes it to the command.
    reset();
    const reversed = [
      ...base(),
      evt(mutated()),
      evt({ type: 'tool.requested', callId: 'q1', tool: 'run_command', input: { command: 'npm test' } }),
      evt({ type: 'policy.decision', callId: 'q1', classification: 'observe', decision: 'allow', rule: 'r', reason: 'r' }),
      evt({ type: 'tool.completed', callId: 'q1', ok: true, outputPreview: '', exitCode: 0, durationMs: 5, truncated: false }),
      evt(checkDone()),
    ];
    expect(buildReport({ events: reversed }).json.filesChanged[0]!.checkedBy).toBe('npm test');
  });
});
