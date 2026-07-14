import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import type { Tool } from '../types.js';
import { truncateForModel } from '../shared/hash.js';

const RunInput = z
  .object({
    command: z.string().describe('A shell command to run in the workspace root'),
    timeoutMs: z.number().int().positive().max(600_000).optional().describe('Kill after this many ms (default 120000)'),
  })
  .strict();

const isWin = process.platform === 'win32';
const DEFAULT_TIMEOUT = 120_000;

/**
 * Build the shell invocation. On Windows we wrap in PowerShell and explicitly propagate the
 * inner command's exit code (`exit $LASTEXITCODE`) with `$ErrorActionPreference='Stop'`, so a
 * failing build/test cannot silently surface as exit 0 → a false "CHECKED" in the report.
 */
function shellInvocation(command: string): { file: string; args: string[] } {
  if (isWin) {
    const wrapped = `$ErrorActionPreference='Stop'; ${command}; exit $LASTEXITCODE`;
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', wrapped] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

function killTree(pid: number): void {
  if (isWin) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL'); // process group (requires detached); best effort
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * run_command executes a shell command with full user privilege. It is `command`-typed so the
 * policy gate always asks. HONEST LIMITATIONS (documented in README): no OS sandbox; side effects
 * are NOT snapshotted or undoable; output is captured and NOT scrubbed for secrets; the timeout
 * kills the direct process tree but detached grandchildren may survive.
 */
export const runCommandTool: Tool<z.infer<typeof RunInput>> = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace root and return combined stdout+stderr and the exit code. ' +
    'Runs with your full privileges; it is NOT sandboxed and its effects are NOT undoable.',
  schema: RunInput,
  mutates: () => null,
  command: (i) => i.command,
  async execute(input, ctx) {
    const started = Date.now();
    const { file, args } = shellInvocation(input.command);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT;

    return await new Promise((resolve) => {
      const child = spawn(file, args, {
        cwd: ctx.workspaceRoot,
        detached: !isWin,
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) killTree(child.pid);
      }, timeoutMs);

      child.stdout?.on('data', (d: Buffer) => chunks.push(d));
      child.stderr?.on('data', (d: Buffer) => chunks.push(d));

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          output: '',
          error: `failed to spawn shell: ${err.message}`,
          truncated: false,
          durationMs: Date.now() - started,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const t = truncateForModel(raw);
        const durationMs = Date.now() - started;
        if (timedOut) {
          resolve({
            ok: false,
            output: t.text,
            error: `timed out after ${timeoutMs}ms; process tree killed`,
            exitCode: -1,
            truncated: t.truncated,
            durationMs,
            ...(t.fullSha256 ? { fullOutputSha256: t.fullSha256 } : {}),
          });
          return;
        }
        const exitCode = code ?? -1;
        resolve({
          ok: exitCode === 0,
          output: t.text,
          exitCode,
          truncated: t.truncated,
          durationMs,
          ...(t.fullSha256 ? { fullOutputSha256: t.fullSha256 } : {}),
        });
      });
    });
  },
};
