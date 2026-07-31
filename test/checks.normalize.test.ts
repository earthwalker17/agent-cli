import { describe, it, expect } from 'vitest';
import { extractFindings, extractSignals, normalizeCheckOutcome, unsupportedResult } from '../src/checks/normalize.js';
import type { ExecOutcome } from '../src/exec/run.js';
import type { ResolvedCheck } from '../src/checks/types.js';

function outcome(over: Partial<ExecOutcome> = {}): ExecOutcome {
  const combined = over.combined ?? '';
  return {
    termination: 'exited',
    exitCode: 0,
    durationMs: 120,
    stdout: combined,
    stderr: '',
    combined,
    captureTruncated: false,
    drainTimedOut: false,
    ...over,
  };
}

const resolved: ResolvedCheck = {
  kind: 'typecheck',
  recipeId: 'node.script.typecheck',
  command: 'npm run typecheck',
  projectId: '.',
  cwd: 'C:/ws',
  timeoutMs: 300_000,
  effects: { writesOutputs: false, network: false, workspaceAuthored: false },
  scopePaths: [],
};

describe('the exit code is the verdict', () => {
  it('exited 0 is a pass', () => {
    const r = normalizeCheckOutcome(resolved, outcome({ exitCode: 0 }));
    expect(r.status).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.findings).toEqual([]);
  });

  it('exited non-zero is a fail', () => {
    const r = normalizeCheckOutcome(resolved, outcome({ exitCode: 2, combined: 'src/a.ts(3,1): error TS2322: Type oops' }));
    expect(r.status).toBe('fail');
    expect(r.exitCode).toBe(2);
  });

  it('a timeout is an error with NO exit code, never a pass', () => {
    const r = normalizeCheckOutcome(resolved, outcome({ termination: 'timeout', exitCode: null }));
    expect(r.status).toBe('error');
    expect(r.exitCode).toBeNull();
    expect(r.summary).toContain('no exit code');
  });

  it('an abort is an error with NO exit code', () => {
    const r = normalizeCheckOutcome(resolved, outcome({ termination: 'aborted', exitCode: null }));
    expect(r.status).toBe('error');
    expect(r.exitCode).toBeNull();
  });

  it('a stray exit code on a killed process can never read as a pass', () => {
    const r = normalizeCheckOutcome(resolved, outcome({ termination: 'timeout', exitCode: 0 }));
    expect(r.status).toBe('error');
    expect(r.exitCode).toBeNull();
  });

  it('a spawn failure is an error carrying the spawn reason', () => {
    const r = normalizeCheckOutcome(resolved, outcome({ termination: 'spawn-error', exitCode: null, spawnError: 'ENOENT npm' }));
    expect(r.status).toBe('error');
    expect(r.summary).toContain('ENOENT npm');
  });

  it('output parsing never moves the verdict', () => {
    const looksBad = normalizeCheckOutcome(resolved, outcome({ exitCode: 0, combined: 'error TS2322: Type oops\nFAILED x' }));
    expect(looksBad.status).toBe('pass');
    const looksGood = normalizeCheckOutcome(resolved, outcome({ exitCode: 1, combined: 'all good, 0 problems' }));
    expect(looksGood.status).toBe('fail');
  });
});

describe('signals', () => {
  it('fire in fixed table order and are capped', () => {
    const text = [
      'npm ERR! something',
      'Cannot find module "x"',
      'is not recognized as a command',
      'error TS1005: oops',
      'TypeError: bad',
      'SyntaxError: nope',
      'AssertionError: expected 1 to be 2',
      'EACCES denied',
    ].join('\n');
    const s = extractSignals(text);
    expect(s).toEqual(['command-not-found', 'module-not-found', 'missing-dependency', 'ts-error', 'type-error', 'syntax-error']);
    expect(s.length).toBeLessThanOrEqual(6);
  });

  it('is deterministic and empty for clean output', () => {
    expect(extractSignals('ok\n3 passed')).toEqual([]);
    expect(extractSignals('Cannot find module x')).toEqual(extractSignals('Cannot find module x'));
  });

  it('detects python-flavoured variants too', () => {
    expect(extractSignals('ModuleNotFoundError: No module named pytest')).toContain('module-not-found');
  });

  it('scans both ends of a very large output', () => {
    const big = `${'a'.repeat(200_000)}\nerror TS2345: late failure`;
    expect(extractSignals(big)).toContain('ts-error');
  });
});

describe('findings', () => {
  it('extracts TypeScript diagnostics with file and line', () => {
    const f = extractFindings('typecheck', 'src/a.ts(12,5): error TS2322: Type A is not assignable to B');
    expect(f[0]).toMatchObject({ file: 'src/a.ts', line: 12, message: 'TS2322: Type A is not assignable to B' });
  });

  it('extracts pytest failures', () => {
    const f = extractFindings('test', 'FAILED tests/test_a.py::test_x - assert 1 == 2');
    expect(f[0]).toMatchObject({ file: 'tests/test_a.py::test_x', message: 'assert 1 == 2' });
  });

  it('extracts vitest failure lines for test kinds only', () => {
    const out = '  FAIL  test/a.test.ts > adds';
    expect(extractFindings('test', out).length).toBeGreaterThan(0);
    expect(extractFindings('format', out).every((x) => x.message !== 'test/a.test.ts > adds')).toBe(true);
  });

  it('extracts prettier reformat targets for the format kind', () => {
    const f = extractFindings('format', '[warn] src/a.ts\n[warn] Code style issues found');
    expect(f[0]).toMatchObject({ file: 'src/a.ts', message: 'would reformat' });
  });

  it('falls back to a short generic scan for unrecognized tools', () => {
    const f = extractFindings('static-analysis', 'weird tool\nfatal error: everything broke\nmore');
    expect(f.length).toBeGreaterThan(0);
    expect(f.length).toBeLessThanOrEqual(3);
  });

  it('is bounded and sanitizes control characters out of messages', () => {
    const many = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts(1,1): error TS1: e${i}`).join('\n');
    expect(extractFindings('typecheck', many).length).toBeLessThanOrEqual(8);
    const esc = extractFindings('typecheck', 'src/a.ts(1,1): error TS1: bad[31mred');
    expect(esc[0]!.message).not.toContain('');
  });
});

describe('unsupportedResult', () => {
  it('never ran, never a pass, and states the reason', () => {
    const r = unsupportedResult('lint', 'no lint recipe applies to this project');
    expect(r).toMatchObject({ status: 'unsupported', exitCode: null, termination: null, command: '', durationMs: 0 });
    expect(r.summary).toContain('no lint recipe applies');
  });
});
