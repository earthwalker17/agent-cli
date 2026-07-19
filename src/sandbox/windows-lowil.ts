import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ExecSpec } from '../exec/run.js';
import { runManaged } from '../exec/run.js';
import { buildChildEnv } from '../exec/env.js';
import type { EnforcementFacts, SandboxBackend } from './types.js';
import { SANDBOX_HOST_SCRIPT, SANDBOX_HOST_VERSION, SELFTEST_OK_MARKER } from './bootstrap.js';

/**
 * The genuinely OS-enforced Windows backend. It runs a command at LOW integrity (Mandatory
 * Integrity Control denies writes to Medium+ objects — the workspace, the user profile, system
 * dirs, and the harness's own Medium state) inside a Job Object (KILL_ON_JOB_CLOSE reaps the whole
 * subtree, closing the detached-grandchild gap `taskkill /T` leaves). Non-admin, no special
 * privilege — a lowered copy of the caller's own token needs none. See `bootstrap.ts`.
 *
 * The transform is at spawn time (`wrapSpec`): the real ExecSpec is JSON-encoded and handed to a
 * PowerShell host that re-launches it at Low IL, forwarding the host's inherited std handles (=
 * Node's pipes) to the child so `runManaged` captures output exactly as for an unsandboxed command.
 *
 * HONEST SCOPE (rendered verbatim into banners/report/system-prompt): confines WRITES and process
 * lifecycle only. It does NOT stop the child from READING files (including secrets) or reaching the
 * NETWORK, and the child may still write Low-labeled locations (its scratch TEMP). Service-reparented
 * work (schtasks/sc/wmic Win32_Process.Create/BITS) escapes the Job Object.
 */

const CONFINES = [
  'writes to Medium+ objects (workspace files, user profile, system dirs, the harness state dir) — OS-denied',
  'process lifecycle — the whole tree is reaped on kill (incl. detached grandchildren), via Job Object kill-on-close',
];
const DOES_NOT_CONFINE = [
  'reads — a sandboxed command can still READ files it has access to, including secrets (approval/redaction still apply)',
  'network — Low integrity does not gate sockets or DNS',
  'writes to Low-labeled locations (the provided scratch TEMP, %USERPROFILE%\\AppData\\LocalLow)',
  'service-reparented work (schtasks / sc / wmic Win32_Process.Create / BITS) that leaves the process tree',
];

/** Test seam: the single self-test attempt, injectable so retry behavior is unit-testable. */
export interface ProbeRunner {
  (spec: ExecSpec): Promise<{ termination: string; exitCode: number | null; combined: string; durationMs: number }>;
}

export function createWindowsLowIlSandbox(
  stateRoot: string,
  opts: { probeTimeoutMs?: number; probeAttempts?: number; runProbe?: ProbeRunner } = {},
): SandboxBackend {
  const sandboxDir = path.join(stateRoot, 'sandbox');
  const hostScript = path.join(sandboxDir, `lowil-host-v${SANDBOX_HOST_VERSION}.ps1`);
  const scratchDir = path.join(sandboxDir, 'scratch');
  // Measured on the target machine: ~4–11 s normally, ~18 s under 6-way concurrent spawn load.
  // 30 s produced spurious fail-closed degrades during loaded full-suite runs; the timeout must
  // comfortably exceed worst observed contention, and one retry absorbs transient load spikes.
  const probeTimeoutMs = opts.probeTimeoutMs ?? 60_000;
  const probeAttempts = Math.max(1, opts.probeAttempts ?? 2);
  const runProbe: ProbeRunner = opts.runProbe ?? ((spec) => runManaged(spec));

  let cached: EnforcementFacts | undefined;
  const unavailable = (detail: string): EnforcementFacts => ({
    mode: 'windows-lowil',
    enforced: false,
    summary: 'windows-lowil requested but NOT established — auto-run disabled, every command asks',
    confines: [],
    doesNotConfine: ['writes', 'reads', 'network', 'process lifecycle'],
    detail,
  });

  function icaclsLabelLow(dir: string): Promise<boolean> {
    // Label the scratch dir Low so a Low-IL child may use it as writable TEMP without weakening the
    // boundary elsewhere. Best-effort; failure only means the child has no scratch space.
    return new Promise((resolve) => {
      const p = spawn('icacls', [dir, '/setintegritylevel', '(OI)(CI)Low'], { stdio: 'ignore', windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    });
  }

  return {
    mode: 'windows-lowil',

    async ensureAvailable(): Promise<EnforcementFacts> {
      if (cached) return cached;
      if (process.platform !== 'win32') {
        cached = unavailable('not win32');
        return cached;
      }
      try {
        fs.mkdirSync(sandboxDir, { recursive: true });
        fs.mkdirSync(scratchDir, { recursive: true });
        fs.writeFileSync(hostScript, SANDBOX_HOST_SCRIPT, 'utf8');
        await icaclsLabelLow(scratchDir);
      } catch (e) {
        cached = unavailable(`setup failed: ${(e as Error).message}`);
        return cached;
      }

      // The PROBE: run the host's self-test, which spawns a Low-IL child and confirms BOTH that the
      // child is Low integrity AND that its write to a Medium path is OS-denied. Enforcement is
      // asserted only on that positive evidence — never assumed from the platform name. A bounded
      // retry absorbs transient load-related false NEGATIVES (slow spawn under contention); it can
      // never overclaim, because every path to `enforced: true` still requires the positive marker.
      const failures: string[] = [];
      for (let attempt = 1; attempt <= probeAttempts; attempt++) {
        const outcome = await runProbe({
          file: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hostScript, '-SelfTest', '-ScratchDir', scratchDir],
          cwd: sandboxDir,
          env: buildChildEnv(process.env),
          timeoutMs: probeTimeoutMs,
        });
        const ok = outcome.termination === 'exited' && outcome.exitCode === 0 && outcome.combined.includes(SELFTEST_OK_MARKER);
        if (ok) {
          const retryNote = failures.length > 0 ? `; attempt 1 failed (${failures[0]})` : '';
          cached = {
            mode: 'windows-lowil',
            enforced: true,
            summary: 'windows-lowil — auto-run commands are OS-confined at Low integrity (write-denied) + reaped',
            confines: CONFINES,
            doesNotConfine: DOES_NOT_CONFINE,
            detail: `self-test passed (${outcome.durationMs} ms, attempt ${attempt})${retryNote}`,
          };
          return cached;
        }
        failures.push(
          outcome.termination !== 'exited'
            ? `self-test ${outcome.termination}`
            : `self-test exit ${outcome.exitCode}: ${outcome.combined.trim().slice(0, 200) || '(no marker)'}`,
        );
      }
      cached = unavailable(failures.join(' | then: '));
      return cached;
    },

    facts(): EnforcementFacts {
      return cached ?? unavailable('not yet probed');
    },

    wrapSpec(spec: ExecSpec): ExecSpec {
      const targetB64 = Buffer.from(JSON.stringify({ file: spec.file, args: spec.args }), 'utf8').toString('base64');
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hostScript, '-TargetB64', targetB64, '-ScratchDir', scratchDir];
      // Preserve every runManaged control field: the host is just a spawn-time transform. env is the
      // ALREADY-FILTERED child env — the Low-IL child inherits it (CreateProcessAsUser env=NULL),
      // and the host overrides only TEMP/TMP to the Low scratch dir.
      return {
        ...spec,
        file: 'powershell.exe',
        args,
      };
    },
  };
}
