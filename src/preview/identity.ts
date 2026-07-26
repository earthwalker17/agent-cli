import os from 'node:os';
import { runManaged } from '../exec/run.js';
import { buildChildEnv } from '../exec/env.js';
import { shellInvocation } from '../exec/shell.js';

/**
 * Process identity verification for the preview sweep (Session 13).
 *
 * Killing a pid from a crashed session's registry is NOT like deleting its worktree directory:
 * PID reuse means the number may now belong to an innocent process, and a wrong kill is
 * irreversible. So the sweep verifies WHO the pid is before killing:
 *  - the command line must contain the token we would have spawned for the recorded command —
 *    on Windows that is the `-EncodedCommand` base64 payload (the recorded plaintext NEVER
 *    appears in Win32_Process.CommandLine, because shellInvocation wraps it), on POSIX the raw
 *    command (`ps` shows either `sh -c '<cmd>'` or the exec-replaced form — both contain it);
 *  - the process creation time must sit within a tolerance of the registry `createdAt` stamp
 *    (stamped just after spawn, so creation precedes it by at most the tolerance).
 *
 * Verification that cannot complete (query failure, no command line visible, unparsable time)
 * means NO KILL — the orphan is reported, never guessed at.
 */

export interface ProcessIdentity {
  commandLine: string;
  startedAtMs: number | null;
}

export type IdentityQuery = (pid: number) => Promise<ProcessIdentity | null>;

export const IDENTITY_TIME_TOLERANCE_MS = 15_000;
const QUERY_TIMEOUT_MS = 15_000;

/** The substring of the child's real command line that proves it is OUR spawn of `command`. */
export function expectedCommandLineToken(command: string): string {
  const inv = shellInvocation(command);
  if (process.platform === 'win32') return inv.args[inv.args.length - 1]!; // the base64 payload
  return command;
}

export const queryProcessIdentity: IdentityQuery = async (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return process.platform === 'win32' ? queryWindows(pid) : queryPosix(pid);
};

async function queryWindows(pid: number): Promise<ProcessIdentity | null> {
  // pid is a validated integer — safe to interpolate into the filter.
  const script =
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${String(pid)}'; ` +
    `if ($p) { ` +
    `$cl = if ($p.CommandLine) { $p.CommandLine } else { '' }; ` +
    `Write-Output ('CL|' + ($cl -replace \"[\\r\\n]\", ' ')); ` +
    `Write-Output ('TS|' + ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()) }`;
  const outcome = await runManaged({
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    cwd: os.tmpdir(),
    env: buildChildEnv(process.env),
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  if (outcome.termination !== 'exited' || outcome.exitCode !== 0) return null;
  let commandLine: string | null = null;
  let startedAtMs: number | null = null;
  for (const line of outcome.stdout.split(/\r?\n/)) {
    if (line.startsWith('CL|')) commandLine = line.slice(3);
    else if (line.startsWith('TS|')) {
      const n = Number(line.slice(3));
      startedAtMs = Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  if (commandLine === null) return null; // the pid no longer exists (no output at all)
  return { commandLine, startedAtMs };
}

async function queryPosix(pid: number): Promise<ProcessIdentity | null> {
  const outcome = await runManaged({
    file: 'ps',
    args: ['-o', 'etimes=,args=', '-p', String(pid)],
    cwd: os.tmpdir(),
    env: buildChildEnv(process.env),
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  if (outcome.termination !== 'exited' || outcome.exitCode !== 0) return null;
  const line = outcome.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (line === undefined) return null;
  const m = /^\s*(\d+)\s+(.*)$/.exec(line);
  if (m === null) return null;
  const etimesSec = Number(m[1]);
  return {
    commandLine: m[2] ?? '',
    startedAtMs: Number.isFinite(etimesSec) ? Date.now() - etimesSec * 1000 : null,
  };
}

/** True only when BOTH the command-line token and the creation time check out. */
export function identityMatches(
  identity: ProcessIdentity,
  expectedToken: string,
  createdAtIso: string,
  toleranceMs: number = IDENTITY_TIME_TOLERANCE_MS,
): boolean {
  if (expectedToken.length === 0 || !identity.commandLine.includes(expectedToken)) return false;
  if (identity.startedAtMs === null) return false;
  const createdAt = Date.parse(createdAtIso);
  if (!Number.isFinite(createdAt)) return false;
  return Math.abs(identity.startedAtMs - createdAt) <= toleranceMs;
}
