import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWindowsLowIlSandbox, type ProbeRunner } from '../src/sandbox/windows-lowil.js';

/**
 * Regression: the enforcement probe intermittently reported "not established" on a loaded
 * machine (measured: ~4–11 s normally, ~18 s under 6-way concurrent spawn load, against the old
 * 30 s timeout), silently degrading a genuinely-enforceable session to fail-closed ask-everything.
 * The fix is a bounded retry + a timeout sized to observed contention. These tests pin the retry
 * CONTRACT with an injected prober: a retry can recover a transient false negative, but every
 * path to `enforced: true` still requires the positive self-test marker — it can never overclaim.
 */
const win = process.platform === 'win32';

const MARKER_OUTCOME = {
  termination: 'exited' as const,
  exitCode: 0,
  combined: 'AGENTSBX_SELFTEST_OK',
  durationMs: 5,
};
const TIMEOUT_OUTCOME = {
  termination: 'timeout' as const,
  exitCode: null,
  combined: '',
  durationMs: 60000,
};

describe.skipIf(!win)('windows-lowil probe retry (injected prober)', () => {
  let stateRoot: string;
  beforeEach(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-probe-retry-'));
  });
  afterEach(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it('recovers from a transient first-attempt failure (retry → enforced)', async () => {
    let calls = 0;
    const runProbe: ProbeRunner = async () => (++calls === 1 ? TIMEOUT_OUTCOME : MARKER_OUTCOME);
    const backend = createWindowsLowIlSandbox(stateRoot, { runProbe });
    const facts = await backend.ensureAvailable();
    expect(calls).toBe(2);
    expect(facts.enforced).toBe(true);
    expect(facts.detail).toMatch(/attempt 2/);
    expect(facts.detail).toMatch(/attempt 1 failed \(self-test timeout\)/);
  });

  it('stays fail-closed when every attempt fails, reporting each failure', async () => {
    let calls = 0;
    const runProbe: ProbeRunner = async () => {
      calls++;
      return calls === 1 ? TIMEOUT_OUTCOME : { termination: 'exited' as const, exitCode: 1, combined: 'boom', durationMs: 3 };
    };
    const backend = createWindowsLowIlSandbox(stateRoot, { runProbe });
    const facts = await backend.ensureAvailable();
    expect(calls).toBe(2);
    expect(facts.enforced).toBe(false);
    expect(facts.detail).toMatch(/self-test timeout/);
    expect(facts.detail).toMatch(/exit 1: boom/);
  });

  it('a passing first attempt probes exactly once and never claims a retry', async () => {
    let calls = 0;
    const runProbe: ProbeRunner = async () => {
      calls++;
      return MARKER_OUTCOME;
    };
    const backend = createWindowsLowIlSandbox(stateRoot, { runProbe });
    const facts = await backend.ensureAvailable();
    expect(calls).toBe(1);
    expect(facts.enforced).toBe(true);
    expect(facts.detail).toMatch(/attempt 1\)/);
    expect(facts.detail).not.toMatch(/failed/);
  });

  it('the retry cannot overclaim: exit 0 WITHOUT the positive marker is still a failure', async () => {
    const runProbe: ProbeRunner = async () => ({
      termination: 'exited' as const,
      exitCode: 0,
      combined: 'looks fine but no marker',
      durationMs: 4,
    });
    const backend = createWindowsLowIlSandbox(stateRoot, { runProbe });
    const facts = await backend.ensureAvailable();
    expect(facts.enforced).toBe(false);
  });

  it('passes the configured timeout through to every probe attempt', async () => {
    const seen: number[] = [];
    const runProbe: ProbeRunner = async (spec) => {
      seen.push(spec.timeoutMs ?? -1);
      return TIMEOUT_OUTCOME;
    };
    const backend = createWindowsLowIlSandbox(stateRoot, { probeTimeoutMs: 12345, runProbe });
    await backend.ensureAvailable();
    expect(seen).toEqual([12345, 12345]);
  });
});
