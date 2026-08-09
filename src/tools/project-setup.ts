import { z } from 'zod';
import { truncateForModel } from '../shared/hash.js';
import { buildChildEnv } from '../exec/env.js';
import { runManaged, type ExecSpec } from '../exec/run.js';
import { shellInvocation } from '../exec/shell.js';
import { selectUnit } from '../checks/workspace.js';
import { createSharedWorkspace, type SharedWorkspace } from '../checks/session-workspace.js';
import { extractSignals } from '../checks/normalize.js';
import { resolveSetup, sameSetup, setupFact, type ResolvedSetup } from '../setup/intents.js';
import type { DetectedWorkspace, ManifestStamp } from '../checks/types.js';
import { SETUP_ACTIONS, type SessionEvent, type SetupStatus, type Tool, type ToolResult } from '../types.js';

/**
 * project_setup — dependency installation, migrations and seeding (Session 16). A per-session
 * factory over a detected-workspace snapshot, exactly like `run_check` and `preview`, and for the
 * same two reasons: the policy `check()` fact must be pure, and the command the human approved
 * must be the command that runs.
 *
 * The inversion holds: **the model names an INTENT and a UNIT; the harness names the command.**
 * The model cannot ask for `npm install --force`, cannot point an install at another registry,
 * and cannot smuggle a script through `migrate` — the intent tables in `src/setup/intents.ts` are
 * a fixed vocabulary, and everything else is a bad request.
 *
 * PARENT-ONLY, deliberately: executor worktrees materialise without gitignored files, so an
 * install inside one would populate a directory that is about to be deleted, and a migration
 * inside one would write to the REAL local database from a sandbox the user believes is isolated.
 */

const SetupInput = z
  .object({
    action: z.enum(SETUP_ACTIONS).describe(
      'install = install this project\'s dependencies from its lockfile; migrate = run its declared migration script; ' +
        'seed = run its declared seed script. You name the intent; the harness resolves the command.',
    ),
    project: z
      .string()
      .min(1)
      .max(260)
      .optional()
      .describe(
        'Which detected project to set up (its workspace-relative directory, e.g. "api"; "." is the workspace root). ' +
          'Optional in a single-project workspace; REQUIRED when several projects exist.',
      ),
  })
  .strict();
export type SetupInputT = z.infer<typeof SetupInput>;

/** Session-cumulative budget, REBUILT FROM EVENTS at assembly (the CheckCaps pattern). */
export interface SetupCaps {
  setupsRun: number;
}

/**
 * Setup is slow, consequential and human-gated, so the ceiling is about stopping a LOOP, not
 * about rationing legitimate work: two or three projects installing, migrating and seeding, plus
 * room to recover from a genuine failure, and then a wall.
 */
export const SETUPS_PER_SESSION = 12;

export function setupCapsFromEvents(events: readonly SessionEvent[]): SetupCaps {
  // Counts every ATTEMPT, matching the live counter — the checkCapsFromEvents argument exactly:
  // counting starts alone would let a non-spawning loop reset its budget on resume, and counting
  // completions alone would forgive a run interrupted by a crash. Union, deduped by callId.
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type === 'setup.started') seen.add(e.callId);
    else if (e.type === 'setup.completed' && e.status !== 'unsupported') seen.add(e.callId);
  }
  return { setupsRun: seen.size };
}

export interface SetupToolDeps {
  workspaceRoot: string;
  caps: SetupCaps;
  /** Injectable seams (tests); default to the real detector. */
  detect?: (root: string) => DetectedWorkspace;
  probe?: (root: string) => ManifestStamp[];
  /** The session's shared initial detection (see CheckToolDeps.initial). */
  initial?: DetectedWorkspace;
  /** The session's ONE live detection (Session 16.5) — see CheckToolDeps.shared. */
  shared?: SharedWorkspace;
}

export interface ProjectSetupTool extends Tool<SetupInputT> {
  workspaceSnapshot(): DetectedWorkspace;
  refresh(): DetectedWorkspace;
}

const FAIL_EXCERPT_CHARS = 8000;

function refuse(output: string, error: string, startedAt: number): ToolResult {
  return { ok: false, output: `refused: ${output}`, error, durationMs: Date.now() - startedAt, truncated: false };
}

export function createProjectSetupTool(deps: SetupToolDeps): ProjectSetupTool {
  const shared =
    deps.shared ??
    createSharedWorkspace(deps.workspaceRoot, {
      ...(deps.initial !== undefined ? { initial: deps.initial } : {}),
      ...(deps.detect !== undefined ? { detect: deps.detect } : {}),
      ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
    });

  const unitFor = (input: SetupInputT): ReturnType<typeof selectUnit> => selectUnit(shared.current(), input.project);
  const resolveFor = (input: SetupInputT): ResolvedSetup | null => {
    const sel = unitFor(input);
    if (sel.unit === null) return null;
    return resolveSetup(sel.unit, input.action).resolved;
  };

  return {
    name: 'project_setup',
    description:
      'Prepare a detected project so it can be built, served and verified: `install` its dependencies from its ' +
      'lockfile, run its declared `migrate` script, or run its declared `seed` script. You name the INTENT and the ' +
      'project; the harness resolves the exact command from the lockfile or from the project\'s own package.json — ' +
      'you never supply a command, and no other script can be reached this way. Every call asks for approval and ' +
      'shows the command and the directory. An install downloads and executes third-party code with network access; ' +
      'migrate and seed change local data the harness cannot undo, so they ask EVERY time. Use this instead of ' +
      'run_command for setup: only its results are recorded as attributable setup evidence. A setup is NOT ' +
      'verification — it can never satisfy a plan gate; run_check does that.',
    schema: SetupInput,
    // Honest: an install writes a whole dependency tree and a migration writes a database. Policy
    // never reads this (the check branch precedes the mutation branch), but it must not lie.
    mutates: () => null,
    check: (input) => {
      const r = resolveFor(input);
      return { resolved: r === null ? [] : [setupFact(r)] };
    },

    async execute(input, ctx): Promise<ToolResult> {
      const startedAt = Date.now();
      const gated = resolveFor(input);

      // TOCTOU, identical in shape to run_check and preview: re-probe cheaply, re-detect only if a
      // manifest moved, and refuse only if that changed the resolved command — which for an
      // install includes the LOCKFILE, so a dependency edit between the approval and the run
      // re-asks instead of installing something else. This runs BEFORE unit selection so every
      // decision below is made against current truth rather than the snapshot policy saw.
      if (shared.refreshIfStale()) {
        const now = resolveFor(input);
        if (!sameSetup(gated, now)) {
          const d = (r: ResolvedSetup | null): string =>
            r === null ? '(nothing)' : `${r.command}${r.lockfile !== undefined ? ` (lockfile ${r.lockfile.name} ${String(r.lockfile.sha256).slice(0, 8)})` : ''}`;
          // See run_check: "changed after approval" is false when nothing resolved at gate time.
          return gated === null
            ? refuse(
                `when this call was gated, no setup command resolved for it — so nothing was approved and nothing ran. ` +
                  `The project's detected state has since changed and this now resolves: ${d(now)}. Call project_setup again.`,
                'nothing was gated for this call; nothing ran',
                startedAt,
              )
            : refuse(
                'the project changed after this call was approved, so the resolved setup command no longer matches what was gated.\n' +
                  `  approved: ${d(gated)}\n  now:      ${d(now)}\nNothing ran. Call project_setup again to have the current command approved.`,
                'project changed after approval; nothing ran',
                startedAt,
              );
        }
      }

      // A project the harness cannot attribute the call to is a CALLER mistake: it refuses, spawns
      // nothing and records nothing. Setup evidence is what the recovery layer reads to decide a
      // dependency failure is resolved; a "you did not say which project" must never enter it.
      const selected = unitFor(input);
      if (selected.unit === null) return refuse(selected.reason, 'no project selected', startedAt);

      const resolution = resolveSetup(selected.unit, input.action);
      if (resolution.resolved === null) {
        // A project-capability gap is RECORDED as `unsupported` (the model and the report both
        // need to see "this project has no migrate script"); a bad request records nothing.
        // The missing-node_modules state is neither: the project DECLARES the script and the
        // cure is named — recording 'no-recipe' put a falsifiable capability claim in the log
        // right next to the later successful run (S16.5b review).
        const why = resolution.badRequest === true ? 'bad-request' : resolution.curable === true ? 'precondition-curable' : 'no-recipe';
        if (why === 'bad-request') {
          return refuse(resolution.reason ?? 'invalid setup request', `invalid setup request: ${input.action}`, startedAt);
        }
        ctx.reportSetup?.({
          kind: 'ended',
          action: input.action,
          projectId: selected.unit.id,
          recipeId: `setup.${input.action}`,
          status: 'unsupported',
          unsupportedReason: why,
          exitCode: null,
          durationMs: 0,
          summary: resolution.reason ?? `no ${input.action} recipe applies to this project`,
        });
        return {
          ok: false,
          output: `[UNSUPPORTED] ${input.action} [project ${selected.unit.id}]: ${resolution.reason ?? 'no recipe applies'}`,
          error: `${input.action} unsupported for project ${selected.unit.id}`,
          durationMs: Date.now() - startedAt,
          truncated: false,
        };
      }

      if (deps.caps.setupsRun >= SETUPS_PER_SESSION) {
        return refuse(
          `this session's project-setup budget is exhausted (${String(deps.caps.setupsRun)}/${String(SETUPS_PER_SESSION)} run). ` +
            'Nothing ran. Re-installing repeatedly is not progress — read the failure, or tell the user.',
          'setup budget exhausted',
          startedAt,
        );
      }

      const rc = resolution.resolved;
      const { file, args } = shellInvocation(rc.command);
      const spec: ExecSpec = {
        file,
        args,
        cwd: rc.cwd,
        env: buildChildEnv(
          process.env,
          ctx.rules && ctx.rules.envExcludePatterns.length > 0 ? { extraExcludeSubstrings: ctx.rules.envExcludePatterns } : {},
        ),
        timeoutMs: rc.timeoutMs,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.onOutput ? { onOutput: ctx.onOutput } : {}),
        // From onSpawn ONLY — `setup.started` means a process really started, exactly as
        // `command.started` and `check.started` do.
        onSpawn: () =>
          ctx.reportSetup?.({
            kind: 'started',
            action: rc.action,
            projectId: rc.projectId,
            recipeId: rc.recipeId,
            command: rc.command,
            cwd: rc.cwd,
            timeoutMs: rc.timeoutMs,
            ...(selected.unit.packageManager !== null ? { packageManager: selected.unit.packageManager } : {}),
            ...(rc.lockfile !== undefined ? { lockfile: rc.lockfile.name } : {}),
            ...(rc.lockfile?.sha256 != null ? { lockfileSha: rc.lockfile.sha256 } : {}),
          }),
      };
      // Deliberately NOT sandbox-wrapped: policy always assigns setup `execBoundary:
      // 'unsandboxed'`, because the Low-IL boundary denies workspace writes and no install could
      // write node_modules inside it. The boundary is recorded, never implied.
      const outcome = await runManaged(spec);
      deps.caps.setupsRun++;

      // An install just created a dependency tree; a migration just created a database file. Both
      // change what every OTHER tool can resolve, and the whole point of the shared holder is that
      // the next `run_check` or `preview` sees it at DECIDE time — so the human is asked about the
      // real command instead of the call being allowed as "nothing to run" and then refused.
      shared.refresh();

      // The exit code is the verdict — the same single rule typed checks live by. A killed or
      // timed-out setup is an `error` with NO exit code, and can never read as "dependencies are
      // installed": the classifier and the report both branch on this.
      const status: SetupStatus = outcome.termination !== 'exited' ? 'error' : outcome.exitCode === 0 ? 'ok' : 'failed';
      const signals = extractSignals(outcome.combined);
      const summary =
        status === 'ok'
          ? `${rc.action} completed (exit 0) for project ${rc.projectId}`
          : status === 'failed'
            ? `${rc.action} FAILED (exit ${String(outcome.exitCode)}) for project ${rc.projectId}`
            : `${rc.action} did not complete (${outcome.termination}; no exit code) for project ${rc.projectId} — its effects are unknown`;

      ctx.reportSetup?.({
        kind: 'ended',
        action: rc.action,
        projectId: rc.projectId,
        recipeId: rc.recipeId,
        status,
        exitCode: outcome.exitCode,
        ...(outcome.termination !== 'exited' ? { termination: outcome.termination } : {}),
        durationMs: outcome.durationMs,
        summary,
        ...(signals.length > 0 ? { signals } : {}),
      });

      const head =
        `project_setup ${rc.action} [project ${rc.projectId}] — ${status.toUpperCase()}\n` +
        `  command: ${rc.command}   [${rc.recipeId}; cwd ${rc.cwd}]` +
        (rc.lockfile !== undefined ? `\n  lockfile: ${rc.lockfile.name}` : '') +
        (signals.length > 0 ? `\n  signals: ${signals.join(', ')}` : '');
      const full = `${head}\n--- output ---\n${outcome.combined}`;
      const tail = outcome.combined.length > FAIL_EXCERPT_CHARS ? outcome.combined.slice(-FAIL_EXCERPT_CHARS) : outcome.combined;
      const modelText = status === 'ok' ? head : `${head}\n  --- output (tail) ---\n${tail}`;

      // Spill seam (Session 11.5 contract): the string handed to truncateForModel MUST be the
      // string spilled, or the recorded sha points at bytes nothing can resolve.
      const t = truncateForModel(full);
      const modelOut = modelText.length <= t.text.length ? modelText : truncateForModel(modelText).text;

      return {
        ok: status === 'ok',
        output: modelOut,
        durationMs: Date.now() - startedAt,
        truncated: t.truncated,
        ...(status !== 'ok' ? { error: `${rc.action} ${status}` } : {}),
        termination: outcome.termination,
        ...(t.fullSha256 ? { fullOutputSha256: t.fullSha256, fullOutput: full } : {}),
      };
    },

    workspaceSnapshot: () => shared.current(),
    refresh: () => shared.refresh(),
  };
}
