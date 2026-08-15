import fs from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolResult } from '../types.js';
import { truncateForModel } from '../shared/hash.js';
import { buildChildEnv } from '../exec/env.js';
import { runManaged, type ExecSpec } from '../exec/run.js';
import { shellInvocation } from '../exec/shell.js';
import { validatePath } from '../policy/paths.js';

/** A cwd the harness will not run in: refused as a CALL, so nothing spawns and nothing is recorded. */
function refuseCwd(detail: string, startedAt: number): ToolResult {
  return {
    ok: false,
    output: `refused: ${detail}. Name a workspace-relative directory that exists, or omit cwd to run at the workspace root.`,
    error: 'invalid cwd',
    durationMs: Date.now() - startedAt,
    truncated: false,
  };
}

const RunInput = z
  .object({
    command: z.string().describe('A shell command to run in the workspace (default: the workspace root)'),
    cwd: z
      .string()
      .min(1)
      .max(260)
      .optional()
      .describe(
        'Workspace-relative directory to run in (e.g. "api"). Must exist and be inside the workspace. ' +
          'Prefer this over `cd x && …`: the recorded evidence then names the directory the command really ran in.',
      ),
    // Session 16: 600s → 900s. A cold dependency install or a full build on Windows can exceed
    // ten minutes, and a timeout there produced no verdict about work that had actually run.
    timeoutMs: z.number().int().positive().max(900_000).optional().describe('Kill after this many ms (default 120000)'),
  })
  .strict();

const DEFAULT_TIMEOUT = 120_000;

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
    '900000) and the user can interrupt a running command. A killed command reports how it ' +
    'terminated and has NO exit code — never treat a killed command as evidence a check passed.',
  schema: RunInput,
  mutates: () => null,
  command: (i) => i.command,
  // Display-only (never consulted by policy): the human approving a command in a multi-project
  // workspace must see WHICH project it runs in. `npm ci` in `web/` and in `api/` are the same
  // string and different acts.
  approvalContext: (i) => (i.cwd !== undefined ? [`in: ${i.cwd}`] : []),
  async execute(input, ctx) {
    const startedAt = Date.now();
    const { file, args } = shellInvocation(input.command);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT;

    // A declared cwd is validated with the SAME containment rule as every write target, and must
    // be an existing directory. Refused here rather than in the policy engine because the command
    // branch answers before any path branch is reached — and because a cwd that does not resolve
    // would otherwise surface as an opaque spawn error.
    let cwd = ctx.workspaceRoot;
    if (input.cwd !== undefined) {
      let resolved: string;
      try {
        const v = validatePath(ctx.workspaceRoot, input.cwd, ctx.stateDir !== undefined ? { stateDir: ctx.stateDir } : {});
        if (!v.inWorkspace) {
          return refuseCwd(`'${input.cwd}' is outside the workspace`, startedAt);
        }
        // The same protected set every declared WRITE is refused against. A protected directory is
        // protected as a place, not only as a write target: `.git` and the harness's own state dir
        // are exactly where an accidental command does the most damage, and an approval prompt
        // reading `in: .agent-cli` asks a human to allow the containment the engine refuses.
        if (v.protectedPath) {
          return refuseCwd(`'${input.cwd}' is a protected directory (.git, .agent-cli, the harness state dir, or a configured protectedPath)`, startedAt);
        }
        resolved = v.resolved;
      } catch (e) {
        return refuseCwd(`'${input.cwd}' is not a usable path: ${(e as Error).message}`, startedAt);
      }
      let isDir = false;
      try {
        isDir = fs.statSync(resolved).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) return refuseCwd(`'${input.cwd}' is not an existing directory`, startedAt);
      cwd = resolved;
    }
    // 'active' means this specific call is auto-run and MUST be OS-confined; report the true boundary.
    const boundary = ctx.sandbox?.active ? ctx.sandbox.mode : 'none';

    const baseSpec: ExecSpec = {
      file,
      args,
      cwd,
      env: buildChildEnv(
        process.env,
        ctx.rules && ctx.rules.envExcludePatterns.length > 0 ? { extraExcludeSubstrings: ctx.rules.envExcludePatterns } : {},
      ),
      timeoutMs,
      signal: ctx.signal,
      ...(ctx.onOutput ? { onOutput: ctx.onOutput } : {}),
      onSpawn: (pid) => ctx.reportCommand?.({ kind: 'started', pid, shell: file, cwd, timeoutMs, sandbox: boundary }),
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
        // Cause-neutral (S22.5): in a child session this abort can be the wall clock, the token
        // budget or the loop supervisor — 'by user' was a false attribution in durable evidence.
        return { ...base, error: `aborted after ${outcome.durationMs}ms; no exit code${killNote}` };
      case 'spawn-error':
        return { ...base, error: outcome.spawnError ?? 'failed to spawn shell' };
    }
  },
};
