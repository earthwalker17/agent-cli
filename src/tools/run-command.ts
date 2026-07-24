import { z } from 'zod';
import type { Tool, ToolResult } from '../types.js';
import { truncateForModel } from '../shared/hash.js';
import { buildChildEnv } from '../exec/env.js';
import { runManaged, type ExecSpec } from '../exec/run.js';

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
 *
 * The wrapped script is passed via `-EncodedCommand` (base64 UTF-16LE), not `-Command`: it is
 * immune to all shell quoting, and — critically — it survives the sandbox host's argv→command-line
 * round-trip (PowerShell's `-Command` re-parsing does not, so a sandboxed command would mangle).
 */
function shellInvocation(command: string): { file: string; args: string[] } {
  if (isWin) {
    const wrapped = `$ErrorActionPreference='Stop'; ${command}; exit $LASTEXITCODE`;
    const enc = Buffer.from(wrapped, 'utf16le').toString('base64');
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

/**
 * run_command executes a shell command with full user privilege through the managed exec
 * substrate. It is `command`-typed so the policy gate always asks. HONEST LIMITATIONS
 * (documented in README): no OS sandbox; side effects are NOT snapshotted or undoable; output is
 * NOT scrubbed for secrets; tree termination is BEST EFFORT (orphaned grandchildren of an
 * already-dead intermediate parent are unreachable). The child env drops variables whose names
 * look secret-like; proxy variables pass through.
 */
export const runCommandTool: Tool<z.infer<typeof RunInput>> = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace root and return its output and exit code. ' +
    'Runs with full user privileges; it is NOT sandboxed and its effects are NOT undoable. ' +
    'stdin is not connected: commands must be non-interactive. The child environment omits ' +
    'variables whose names look secret-like (KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL) — do not ' +
    'write commands that expect them. Commands time out (default 120s; set timeoutMs up to ' +
    '600000) and the user can interrupt a running command. A killed command reports how it ' +
    'terminated and has NO exit code — never treat a killed command as evidence a check passed.',
  schema: RunInput,
  mutates: () => null,
  command: (i) => i.command,
  async execute(input, ctx) {
    const { file, args } = shellInvocation(input.command);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT;
    // 'active' means this specific call is auto-run and MUST be OS-confined; report the true boundary.
    const boundary = ctx.sandbox?.active ? ctx.sandbox.mode : 'none';

    const baseSpec: ExecSpec = {
      file,
      args,
      cwd: ctx.workspaceRoot,
      env: buildChildEnv(
        process.env,
        ctx.rules && ctx.rules.envExcludePatterns.length > 0 ? { extraExcludeSubstrings: ctx.rules.envExcludePatterns } : {},
      ),
      timeoutMs,
      signal: ctx.signal,
      ...(ctx.onOutput ? { onOutput: ctx.onOutput } : {}),
      onSpawn: (pid) => ctx.reportCommand?.({ kind: 'started', pid, shell: file, cwd: ctx.workspaceRoot, timeoutMs, sandbox: boundary }),
    };
    // Transform-at-spawn: an auto-run call is rewritten to launch inside the enforced boundary; an
    // approved (unsandboxed) call gets the identity wrap. run_command never branches on policy.
    const spec = ctx.sandbox ? ctx.sandbox.wrap(baseSpec) : baseSpec;
    const outcome = await runManaged(spec);

    ctx.reportCommand?.({
      kind: 'ended',
      termination: outcome.termination,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      ...(outcome.killDetail !== undefined ? { killDetail: outcome.killDetail } : {}),
      ...(outcome.drainTimedOut ? { drainTimedOut: true } : {}),
    });

    const drainNote = outcome.drainTimedOut
      ? '\n[output may be incomplete: stream drain timed out after the process ended]'
      : '';
    const t = truncateForModel(outcome.combined + drainNote);

    const base: ToolResult = {
      ok: false,
      output: t.text,
      durationMs: outcome.durationMs,
      truncated: t.truncated || outcome.captureTruncated,
      termination: outcome.termination,
      ...(t.fullSha256 ? { fullOutputSha256: t.fullSha256 } : {}),
      // Spill seam (Session 11.5): command output is unrecoverable once truncated (bounded live
      // capture, nothing on disk) — hand the runtime the captured string so the truncated-away
      // bytes survive as a blob. Only when model-truncation actually dropped bytes: t.fullSha256
      // is the blob key, and it describes the CAPTURED stream (capture caps may have applied).
      ...(t.fullSha256 ? { fullOutput: outcome.combined + drainNote } : {}),
      ...(outcome.killDetail !== undefined ? { killDetail: outcome.killDetail } : {}),
    };

    // Report the kill HONESTLY: surface what the liveness probe actually verified rather than
    // asserting "force-killed" even when killDetail says the process is STILL ALIVE, and don't
    // claim a tree kill for a pre-aborted signal where nothing ever spawned.
    const killNote = outcome.killDetail
      ? `; process tree kill (best effort): ${outcome.killDetail}`
      : '; no process was spawned';
    switch (outcome.termination) {
      case 'exited':
        return {
          ...base,
          ok: outcome.exitCode === 0,
          ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}),
        };
      case 'timeout':
        return { ...base, error: `timed out after ${timeoutMs}ms; no exit code${killNote}` };
      case 'aborted':
        return { ...base, error: `aborted by user after ${outcome.durationMs}ms; no exit code${killNote}` };
      case 'spawn-error':
        return { ...base, error: outcome.spawnError ?? 'failed to spawn shell' };
    }
  },
};
