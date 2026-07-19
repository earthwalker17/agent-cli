import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWindowsLowIlSandbox } from '../src/sandbox/windows-lowil.js';
import { runManaged, type ExecSpec } from '../src/exec/run.js';
import { buildChildEnv } from '../src/exec/env.js';
import { isAlive } from '../src/exec/kill.js';
import type { SandboxBackend } from '../src/sandbox/index.js';

/**
 * The genuinely-OS-enforced boundary, exercised end-to-end through the real backend + runManaged.
 * These are the primary evidence for Session 5: what the Low-IL sandbox PREVENTS (writes to
 * Medium+ objects; a leaked grandchild surviving a kill) and what it deliberately does NOT
 * (reads). Windows-only by nature — skipped elsewhere (no simulated parity).
 */
const win = process.platform === 'win32';

/** Build a powershell ExecSpec the way run_command does (EncodedCommand), for a raw inner script. */
function psSpec(inner: string, cwd: string, extra: Partial<ExecSpec> = {}): ExecSpec {
  const enc = Buffer.from(inner, 'utf16le').toString('base64');
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
    cwd,
    env: buildChildEnv(process.env),
    timeoutMs: 30_000,
    ...extra,
  };
}

async function waitDead(pid: number, attempts = 40): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

describe.skipIf(!win)('windows-lowil sandbox: enforced boundary (real OS)', () => {
  let stateRoot: string;
  let ws: string;
  let backend: SandboxBackend;
  const leaked: number[] = [];

  beforeAll(async () => {
    stateRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-sbx-state-')));
    backend = createWindowsLowIlSandbox(stateRoot);
    await backend.ensureAvailable();
  }, 60_000);

  beforeEach(() => {
    ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-sbx-ws-')));
  });
  afterEach(async () => {
    for (const pid of leaked.splice(0)) if (isAlive(pid)) { try { process.kill(pid); } catch { /* gone */ } }
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('probe reports genuine enforcement on this machine', () => {
    const facts = backend.facts();
    expect(facts.mode).toBe('windows-lowil');
    expect(facts.enforced).toBe(true);
    expect(facts.confines.length).toBeGreaterThan(0);
    expect(facts.doesNotConfine.join(' ')).toMatch(/reads|network/i);
  });

  it('DENIES a write to the Medium-integrity workspace (the core boundary)', async () => {
    const target = path.join(ws, 'should-not-exist.txt');
    const inner = `try { Set-Content -LiteralPath '${target}' -Value hi -ErrorAction Stop; 'WROTE' } catch { 'DENIED' }`;
    const outcome = await runManaged(backend.wrapSpec(psSpec(inner, ws)));
    expect(outcome.termination).toBe('exited');
    expect(outcome.combined).toMatch(/DENIED/);
    expect(outcome.combined).not.toMatch(/WROTE/);
    expect(fs.existsSync(target)).toBe(false);
  }, 30_000);

  it('DENIES a write to the harness state dir (a Medium object)', async () => {
    const target = path.join(stateRoot, 'tamper.txt');
    const inner = `try { Set-Content -LiteralPath '${target}' -Value x -ErrorAction Stop; 'WROTE' } catch { 'DENIED' }`;
    const outcome = await runManaged(backend.wrapSpec(psSpec(inner, ws)));
    expect(outcome.combined).toMatch(/DENIED/);
    expect(fs.existsSync(target)).toBe(false);
  }, 30_000);

  it('ALLOWS reads (honest limitation: not a confidentiality boundary)', async () => {
    const secret = path.join(ws, 'secret.txt');
    fs.writeFileSync(secret, 'TOP-SECRET-XYZ');
    const inner = `Get-Content -LiteralPath '${secret}' -Raw`;
    const outcome = await runManaged(backend.wrapSpec(psSpec(inner, ws)));
    expect(outcome.combined).toMatch(/TOP-SECRET-XYZ/);
  }, 30_000);

  it('relays the child exit code faithfully (a killed/failed sandboxed command cannot read as pass)', async () => {
    const outcome = await runManaged(backend.wrapSpec(psSpec('exit 7', ws)));
    expect(outcome.termination).toBe('exited');
    expect(outcome.exitCode).toBe(7);
  }, 30_000);

  it('captures stdout from the confined child through the inherited pipes', async () => {
    const outcome = await runManaged(backend.wrapSpec(psSpec(`Write-Output 'CAPTURE-abc123'`, ws)));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.combined).toMatch(/CAPTURE-abc123/);
  }, 30_000);

  it('runs the confined child at LOW integrity', async () => {
    // Full System32 path, like the product probe (bootstrap.ts): a bare `whoami` can resolve to
    // Git's MSYS whoami.exe when the suite runs from Git Bash (Git\usr\bin first on PATH), and
    // msys-2.0.dll crashes at Low IL before printing groups.
    const whoami = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
    const outcome = await runManaged(backend.wrapSpec(psSpec(`& '${whoami}' /groups | Select-String 'S-1-16-' | ForEach-Object { $_.Line.Trim() }`, ws)));
    expect(outcome.combined).toMatch(/S-1-16-4096/); // Low mandatory label
  }, 30_000);

  it('reaps a DETACHED grandchild on kill via the Job Object (closes taskkill /T gap)', async () => {
    // The sandboxed command launches a detached, hidden grandchild that would outlive taskkill /T
    // (its parent exits immediately, severing the PID chain), prints the grandchild PID, then idles
    // so the host stays alive holding the Job handle. We read the PID, abort (kill the host), and
    // assert the Job Object's KILL_ON_JOB_CLOSE reaped the grandchild.
    const marker = path.join(ws, 'gc.pid');
    const inner = [
      `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','ping -n 30 127.0.0.1 >NUL' -WindowStyle Hidden -PassThru`,
      `Set-Content -LiteralPath '${marker.replace(/\\/g, '\\\\')}' -Value $p.Id`,
      `Write-Output ('GCPID=' + $p.Id)`,
      `Start-Sleep -Seconds 30`,
    ].join('; ');

    const controller = new AbortController();
    let gcPid = 0;
    const spec = backend.wrapSpec(
      psSpec(inner, ws, {
        signal: controller.signal,
        timeoutMs: 45_000,
        onOutput: (chunk) => {
          const m = /GCPID=(\d+)/.exec(chunk);
          if (m && gcPid === 0) {
            gcPid = Number(m[1]);
            leaked.push(gcPid);
            setTimeout(() => controller.abort(), 300); // let the grandchild settle, then kill the host
          }
        },
      }),
    );
    const outcome = await runManaged(spec);
    expect(outcome.termination).toBe('aborted');
    // Fall back to the marker file if the PID never streamed (timing), so the assertion is meaningful.
    if (gcPid === 0 && fs.existsSync(marker)) gcPid = Number(fs.readFileSync(marker, 'utf8').trim());
    expect(gcPid).toBeGreaterThan(0);
    expect(await waitDead(gcPid)).toBe(true); // reaped by KILL_ON_JOB_CLOSE, not orphaned
  }, 60_000);
});
