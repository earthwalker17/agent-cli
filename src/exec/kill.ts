import { spawn } from 'node:child_process';

/**
 * Best-effort process-tree termination with honest verification. On Windows the only dependable
 * kill for console children is forceful (`taskkill /T /F`); there is no graceful signal from
 * stock Node (child.kill() is always TerminateProcess of the direct child only). `/T` walks the
 * parent-pid chain at invocation time, so grandchildren orphaned by an already-dead intermediate
 * parent are structurally unreachable — the contract is BEST EFFORT, and `KillResult` says what
 * was actually verified rather than claiming the tree died.
 */

const isWin = process.platform === 'win32';

export interface KillResult {
  /** True when a bounded liveness probe confirmed the direct child is gone. */
  verified: boolean;
  /** Honest mechanics, e.g. 'taskkill exit 0; probe: dead' or 'taskkill exit 1; probe: STILL ALIVE'. */
  detail: string;
}

/** Liveness probe. EPERM means "exists but not ours" → alive. PID reuse makes this heuristic. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Await a spawned helper's exit code (null on spawn failure), never throwing. */
function runHelper(file: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(file, args, { stdio: 'ignore', windowsHide: true });
    p.on('error', () => resolve(null));
    p.on('exit', (code) => resolve(code));
  });
}

const PROBE_ATTEMPTS = 5;
const PROBE_INTERVAL_MS = 100;

/**
 * Kill `pid` and its reachable descendants, then verify the direct child is dead with a bounded
 * probe. Windows: `taskkill /PID <pid> /T /F` — exit 0 = killed, exit 128 = "no running instance"
 * (the target already exited; the objective is achieved), both treated as success (empirical
 * contract; Microsoft documents no exit codes). POSIX: SIGTERM to the process group (requires the
 * child was spawned detached), short grace, then SIGKILL, with a direct-kill fallback.
 */
export async function killTree(pid: number): Promise<KillResult> {
  let attempt: string;
  if (isWin) {
    const code = await runHelper('taskkill', ['/PID', String(pid), '/T', '/F']);
    attempt =
      code === 0
        ? 'taskkill exit 0'
        : code === 128
          ? 'taskkill exit 128 (target already exited)'
          : `taskkill exit ${code ?? 'spawn-failed'}`;
  } else {
    attempt = posixKill(pid, 'SIGTERM');
    await delay(200);
    if (isAlive(pid)) attempt += `; ${posixKill(pid, 'SIGKILL')}`;
  }

  for (let i = 0; i < PROBE_ATTEMPTS; i++) {
    if (!isAlive(pid)) return { verified: true, detail: `${attempt}; probe: dead` };
    await delay(PROBE_INTERVAL_MS);
  }
  return { verified: false, detail: `${attempt}; probe: STILL ALIVE after ${PROBE_ATTEMPTS * PROBE_INTERVAL_MS}ms` };
}

/** Group-kill with direct-kill fallback; returns a description of what was attempted. */
function posixKill(pid: number, signal: NodeJS.Signals): string {
  try {
    process.kill(-pid, signal);
    return `group ${signal}`;
  } catch {
    try {
      process.kill(pid, signal);
      return `direct ${signal} (group kill unavailable)`;
    } catch {
      return `${signal} target already gone`;
    }
  }
}
