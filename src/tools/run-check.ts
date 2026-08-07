import { z } from 'zod';
import { truncateForModel } from '../shared/hash.js';
import { buildChildEnv } from '../exec/env.js';
import { runManaged, type ExecSpec } from '../exec/run.js';
import { shellInvocation } from '../exec/shell.js';
import { selectUnit } from '../checks/workspace.js';
import { createSharedWorkspace, type SharedWorkspace } from '../checks/session-workspace.js';
import { availableKinds, resolveChecks } from '../checks/recipes.js';
import { normalizeCheckOutcome, unsupportedResult } from '../checks/normalize.js';
import type { CheckResult, DetectedProject, DetectedWorkspace, ManifestStamp, ResolvedCheck } from '../checks/types.js';
import { CHECK_KINDS, type CheckKind, type ResolvedCheckFact, type SessionEvent, type Tool, type ToolContext, type ToolResult } from '../types.js';

/**
 * run_check — typed project verification (Session 12). A per-session factory like retrieve and
 * delegate_task: it closes over a DETECTED PROJECT SNAPSHOT, because the policy `check()` fact
 * must be pure (decide() does no I/O) and because the human's approval has to bind the exact
 * command that will run.
 *
 * The model names KINDS; the harness names COMMANDS. That inversion is the whole point: a
 * `run_command` string is untrusted model text (hence always-ask, never grantable), while a check
 * command is regenerated deterministically from the recipe table, which is what makes replay
 * consent for a byte-identical command honest rather than a standing shell permission.
 *
 * Two honesty rules:
 * - `check.started` is emitted from `onSpawn` only, so it means what `command.started` means: a
 *   process really started. A kind that cannot run records only a completed/`unsupported` event.
 * - If the project changed between the gate and the execution such that a command would differ,
 *   NOTHING runs: the call refuses and the next call re-asks with the new command.
 */

// DELIBERATE SUBSET (Session 13): 'browser' is a CheckKind but is EXCLUDED here — a browser
// flow is an in-process drive of a managed preview, run only through browser_flow. The drift
// guard below is one-directional (subset), so this exclusion is pinned by a test, not the compiler.
const KIND_VALUES = ['build', 'test', 'test-targeted', 'typecheck', 'lint', 'format', 'static-analysis'] as const;
const _kindsAreCheckKinds: readonly CheckKind[] = KIND_VALUES;
void _kindsAreCheckKinds;

const RunCheckInput = z
  .object({
    checks: z
      .array(z.enum(KIND_VALUES))
      .min(1)
      .max(4)
      .describe(
        'Verification kinds to run. The harness resolves each to a project-appropriate command; you do not supply commands.',
      ),
    project: z
      .string()
      .min(1)
      .max(260)
      .optional()
      .describe(
        'Which detected project to verify (its workspace-relative directory, e.g. "api"; "." is the workspace root). ' +
          'Optional in a single-project workspace; REQUIRED when several projects exist — the harness refuses to guess.',
      ),
    scope_paths: z
      .array(z.string().min(1).max(260))
      .max(8)
      .optional()
      .describe('Workspace-relative paths for test-targeted (ignored by other kinds).'),
    plan_task: z
      .string()
      .max(41)
      .optional()
      .describe('The plan task this run verifies — recorded as a label on the evidence.'),
  })
  .strict();
export type RunCheckInputT = z.infer<typeof RunCheckInput>;

/** Session-cumulative check budget, REBUILT FROM EVENTS at assembly (the DelegateCaps pattern). */
export interface CheckCaps {
  checksRun: number;
}

/** No unbounded repetition: a repair loop that re-runs checks forever must hit a wall. */
/** Session 16: 60 → 80. Per-project checks multiply the kinds a full-stack session legitimately runs. */
export const CHECKS_PER_SESSION = 80;

export function checkCapsFromEvents(events: readonly SessionEvent[]): CheckCaps {
  // Counts every check that was ATTEMPTED, matching what the live counter increments. Neither
  // event alone suffices: a spawn failure emits no `check.started` (so counting starts would let
  // a non-spawning loop reset its whole budget on resume), and a crash mid-run emits no
  // `check.completed` (so counting completions would forgive an interrupted run). Union, deduped
  // by (callId, kind).
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type === 'check.started') seen.add(`${e.callId}::${e.check}`);
    else if (e.type === 'check.completed' && e.status !== 'unsupported') seen.add(`${e.callId}::${e.check}`);
  }
  return { checksRun: seen.size };
}

export interface CheckToolDeps {
  workspaceRoot: string;
  caps: CheckCaps;
  /** Injectable for deterministic tests; defaults to the real workspace detector. */
  detect?: (root: string) => DetectedWorkspace;
  probe?: (root: string) => ManifestStamp[];
  /**
   * The session's shared initial detection (Session 16). Assembly detects ONCE, before the system
   * prompt, and hands the same immutable result to every consumer — so the projects the model was
   * told about are exactly the projects this tool will resolve against. The copy is per-tool from
   * here on: a TOCTOU refresh here must not advance another tool's gate.
   */
  initial?: DetectedWorkspace;
  /**
   * The session's ONE live detection (Session 16.5). When present every tool reads through it, so
   * an install performed by `project_setup` is visible to the very next check instead of surfacing
   * as a false "the project changed after this call was approved". Absent ⇒ a private holder.
   */
  shared?: SharedWorkspace;
  /**
   * S14.5 (E): the bound plan task's declared `touches`, for defaulting a test-targeted scope
   * when the model omits one. null/absent = no plan context — the bad-request refusal stands
   * untouched. Safe by construction: gate matching is per-KIND, so a scoped `test-targeted`
   * pass can never discharge a full `test` gate, and the graph gate's scope-overlap rule
   * naturally matches (touches overlap touches).
   */
  planTouches?: (planTaskId: string) => string[] | null;
}

export interface RunCheckTool extends Tool<RunCheckInputT> {
  /** The current workspace snapshot — what /checks renders and what the policy fact resolves from. */
  workspaceSnapshot(): DetectedWorkspace;
  /** Force a re-detect (used by /checks so the surface never shows a stale project set). */
  refresh(): DetectedWorkspace;
}

/** Excerpt of a failing check's output shown to the model; the full text spills to a blob. */
/** Session 16: 3000 → 6000. The failing tail is the single most valuable text in a check result. */
const FAIL_EXCERPT_CHARS = 6000;

function toFact(r: ResolvedCheck): ResolvedCheckFact {
  return {
    recipeId: r.recipeId,
    kind: r.kind,
    command: r.command,
    ...(r.bodySha !== undefined ? { bodySha: r.bodySha } : {}),
    projectId: r.projectId,
    cwd: r.cwd,
    timeoutMs: r.timeoutMs,
    effects: r.effects,
  };
}

/**
 * Identity for the TOCTOU comparison: the command, the script body it invokes, AND where it runs.
 * This must stay the same tuple `checkReplayKey` hashes — one answers "may this re-run without
 * asking", the other "is this still what was approved". A component in one and not the other is
 * a hole, so they move together.
 */
function sameCommands(a: readonly ResolvedCheck[], b: readonly ResolvedCheck[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (x, i) =>
      x.recipeId === b[i]!.recipeId &&
      x.command === b[i]!.command &&
      x.bodySha === b[i]!.bodySha &&
      x.projectId === b[i]!.projectId &&
      x.cwd === b[i]!.cwd,
  );
}

function renderResult(r: CheckResult): string {
  const mark = r.status === 'pass' ? 'PASS' : r.status === 'unsupported' ? 'UNSUPPORTED' : r.status.toUpperCase();
  const lines = [`[${mark}] ${r.summary}`];
  if (r.command !== '') lines.push(`  command: ${r.command}`);
  for (const f of r.findings) {
    lines.push(`  - ${f.file !== undefined ? `${f.file}${f.line !== undefined ? `:${String(f.line)}` : ''} — ` : ''}${f.message}`);
  }
  return lines.join('\n');
}

export function createRunCheckTool(deps: CheckToolDeps): RunCheckTool {
  const shared =
    deps.shared ??
    createSharedWorkspace(deps.workspaceRoot, {
      ...(deps.initial !== undefined ? { initial: deps.initial } : {}),
      ...(deps.detect !== undefined ? { detect: deps.detect } : {}),
      ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
    });

  // S14.5 (E): an omitted test-targeted scope defaults from the BOUND plan task's touches.
  // Explicit scope always wins; without a binding (or plan context) nothing changes and the
  // bad-request refusal stays verbatim. The substitution happens HERE — before the `check:`
  // policy fact resolves — so the human approves exactly the command that will run.
  const scopeFor = (input: RunCheckInputT): { scope: string[]; defaultedFrom?: string } => {
    const explicit = input.scope_paths ?? [];
    if (explicit.length > 0 || input.plan_task === undefined || !input.checks.includes('test-targeted')) {
      return { scope: explicit };
    }
    const touches = deps.planTouches?.(input.plan_task) ?? null;
    if (touches === null || touches.length === 0) return { scope: explicit };
    return { scope: touches, defaultedFrom: input.plan_task };
  };
  /**
   * Which unit this call means. Selection is PURE over the snapshot (the `check()` fact contract),
   * and ambiguity refuses: in a workspace holding several real projects, guessing which one a
   * build belongs to is not a convenience, it is a wrong command run at full user privilege.
   */
  const unitFor = (input: RunCheckInputT): ReturnType<typeof selectUnit> => selectUnit(shared.current(), input.project);

  const resolveFor = (input: RunCheckInputT): ReturnType<typeof resolveChecks> => {
    const sel = unitFor(input);
    if (sel.unit === null) return { resolved: [], unsupported: [] };
    return resolveChecks(sel.unit, input.checks, scopeFor(input).scope);
  };

  return {
    name: 'run_check',
    description:
      'Run typed project verification (build, test, test-targeted, typecheck, lint, format, static-analysis). ' +
      'The harness detects the project and resolves each kind to the right command — you name kinds, not commands. ' +
      'Results are normalized: a check PASSES only when its process genuinely exited with code 0; a killed or ' +
      'timed-out check is an error and is never evidence that anything passed. A kind this project cannot run ' +
      'comes back UNSUPPORTED with the reason instead of a guess. Prefer this over run_command for verification: ' +
      'its results are recorded as durable evidence and are what plan task gates and session acceptance read. ' +
      'Checks run with full user privilege and are NOT sandboxed; the first run of each command asks for approval.',
    schema: RunCheckInput,
    // Honest: a build or test run writes outputs this tool cannot enumerate. Policy never reads
    // this (the `check` branch precedes the mutation branch), but the declaration must not lie.
    mutates: () => null,
    check: (input) => ({ resolved: resolveFor(input).resolved.map(toFact) }),

    async execute(input, ctx): Promise<ToolResult> {
      const startedAt = Date.now();
      const planTaskId = input.plan_task;
      const gated = resolveFor(input).resolved;

      // TOCTOU: the human approved the commands resolved from the snapshot above. Re-probe; only
      // if a manifest actually changed do we re-detect, and only if that changes a COMMAND do we
      // refuse. The snapshot is updated either way, so the next call is gated on current truth.
      if (shared.refreshIfStale()) {
        const now = resolveFor(input).resolved;
        if (!sameCommands(gated, now)) {
          const describe = (rs: readonly ResolvedCheck[]): string =>
            rs.map((r) => `${r.command}${r.bodySha !== undefined ? ` (script body ${r.bodySha.slice(0, 8)})` : ''}`).join(' ; ') || '(nothing)';
          // Two genuinely different situations, and calling both "the project changed after this
          // call was approved" was false in the second one — nothing was approved, because
          // nothing resolved. That message sent a model looking for a manifest edit that never
          // happened, when the honest answer is "call it again and it will work".
          const nothingWasGated = gated.length === 0;
          return {
            ok: false,
            output: nothingWasGated
              ? `refused: when this call was gated, no command resolved for it — so nothing was approved and nothing ran. ` +
                `The project's detected state has since changed and these command(s) now resolve: ${describe(now)}. ` +
                `Call run_check again; the current command(s) will be put in front of the user.`
              : `refused: the project changed after this call was approved, so the resolved command(s) no longer match what was gated.\n` +
                `  approved: ${describe(gated)}\n  now:      ${describe(now)}\nNothing ran. Call run_check again to have the current command(s) approved.`,
            error: nothingWasGated ? 'nothing was gated for this call; nothing ran' : 'project changed after approval; nothing ran',
            durationMs: Date.now() - startedAt,
            truncated: false,
          };
        }
      }

      // A project that could not be selected is a CALLER mistake, not a project capability: it
      // refuses the call with the real unit ids and records NOTHING, exactly as a malformed
      // test-targeted scope does. An `unsupported` event here would let "you did not say which
      // project" quietly waive a gate the user approved. Selected AFTER the re-detect above, so
      // the ids it names are the ones that exist now.
      const selected = unitFor(input);
      if (selected.unit === null) {
        return {
          ok: false,
          output:
            `refused: ${selected.reason}\n` +
            'Nothing ran and nothing was recorded: a call the harness cannot attribute to a project must never be ' +
            'mistaken for "this project cannot verify that".',
          error: 'no project selected',
          durationMs: Date.now() - startedAt,
          truncated: false,
        };
      }

      const resolution = resolveFor(input);
      // A malformed request must never become gate evidence: refuse the CALL rather than record
      // an `unsupported` result that a declared gate would then treat as a waiver.
      const badRequest = resolution.unsupported.find((u) => u.why === 'bad-request');
      if (badRequest !== undefined) {
        return {
          ok: false,
          output:
            `refused: ${badRequest.kind} — ${badRequest.reason}\n` +
            'Nothing ran and nothing was recorded: a malformed request must never be mistaken for "this project cannot verify that".',
          error: `invalid check request: ${badRequest.kind}`,
          durationMs: Date.now() - startedAt,
          truncated: false,
        };
      }
      if (deps.caps.checksRun + resolution.resolved.length > CHECKS_PER_SESSION) {
        return {
          ok: false,
          output:
            `refused: this session's check budget is exhausted (${deps.caps.checksRun}/${CHECKS_PER_SESSION} run). ` +
            `Nothing ran. Repeated identical checks are not progress.\n` +
            `Consequence: any plan task gating on a check can no longer be satisfied, so its dependents stay blocked and the ` +
            `session cannot be accepted as complete. The only exits are to amend the plan's checks/gates with update_plan ` +
            `(this resets approval and requires the user to re-approve), or to tell the user, who can record a partial ` +
            `acceptance with /accept confirm.`,
          error: 'check budget exhausted',
          durationMs: Date.now() - startedAt,
          truncated: false,
        };
      }

      const results: CheckResult[] = [];
      const fullParts: string[] = [];

      for (const u of resolution.unsupported) {
        const r = unsupportedResult(u.kind, u.reason);
        results.push(r);
        ctx.reportCheck?.({
          kind: 'ended',
          check: r.kind,
          recipeId: r.recipeId,
          status: 'unsupported',
          unsupportedReason: u.why,
          projectId: selected.unit.id,
          exitCode: null,
          durationMs: 0,
          summary: r.summary,
          ...(planTaskId !== undefined ? { planTaskId } : {}),
        });
      }

      for (const rc of resolution.resolved) {
        const { file, args } = shellInvocation(rc.command);
        const baseSpec: ExecSpec = {
          file,
          args,
          // The UNIT's directory, not the workspace root: `npm run test` in `api/` must run in
          // `api/`. The event records the same value, so the evidence names where it really ran.
          cwd: rc.cwd,
          env: buildChildEnv(
            process.env,
            ctx.rules && ctx.rules.envExcludePatterns.length > 0 ? { extraExcludeSubstrings: ctx.rules.envExcludePatterns } : {},
          ),
          timeoutMs: rc.timeoutMs,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(ctx.onOutput ? { onOutput: ctx.onOutput } : {}),
          // Emitted from onSpawn ONLY: check.started must mean a process really started, exactly
          // as command.started does — crash replay and the acceptance boundary rely on that.
          onSpawn: () =>
            ctx.reportCheck?.({
              kind: 'started',
              check: rc.kind,
              recipeId: rc.recipeId,
              command: rc.command,
              cwd: rc.cwd,
              timeoutMs: rc.timeoutMs,
              projectId: rc.projectId,
              ...(planTaskId !== undefined ? { planTaskId } : {}),
              ...(rc.scopePaths.length > 0 ? { scopePaths: rc.scopePaths } : {}),
            }),
        };
        // Uniform with run_command: tool code never branches on policy. The wrap is the identity
        // transform here in practice — policy always assigns a check execBoundary 'unsandboxed',
        // because the Low-IL boundary denies workspace writes and no build could run inside it.
        const spec = ctx.sandbox ? ctx.sandbox.wrap(baseSpec) : baseSpec;
        const outcome = await runManaged(spec);
        deps.caps.checksRun++;

        const result = normalizeCheckOutcome(rc, outcome);
        results.push(result);
        fullParts.push(`===== ${result.kind} (${result.recipeId}) — ${result.command} =====\n${outcome.combined}`);

        ctx.reportCheck?.({
          kind: 'ended',
          check: result.kind,
          recipeId: result.recipeId,
          status: result.status,
          projectId: rc.projectId,
          exitCode: result.exitCode,
          ...(result.termination !== null ? { termination: result.termination } : {}),
          durationMs: result.durationMs,
          summary: result.summary,
          ...(result.signals.length > 0 ? { signals: result.signals } : {}),
          ...(result.findings.length > 0 ? { findings: result.findings } : {}),
          ...(planTaskId !== undefined ? { planTaskId } : {}),
          ...(rc.scopePaths.length > 0 ? { scopePaths: rc.scopePaths } : {}),
        });

        // Stop the batch once the turn is cancelled: the remaining kinds report as not run rather
        // than each spawning and immediately dying.
        if (ctx.signal?.aborted) break;
      }

      const ran = new Set(results.map((r) => r.kind));
      for (const kind of input.checks) {
        if (!ran.has(kind)) {
          results.push(unsupportedResult(kind, 'not run: the turn was cancelled before this check started'));
        }
      }

      const failed = results.filter((r) => r.status === 'fail' || r.status === 'error');
      const scoped = scopeFor(input);
      const head =
        `run_check [project ${selected.unit.id}] — ${results.length} kind(s): ${results.map((r) => `${r.kind}=${r.status}`).join(', ')}` +
        (scoped.defaultedFrom !== undefined
          ? `\n(test-targeted scope defaulted from plan task '${scoped.defaultedFrom}' touches: ${scoped.scope.join(', ')})`
          : '');
      const blocks = results.map((r) => {
        const rendered = renderResult(r);
        if (r.status !== 'fail' && r.status !== 'error') return rendered;
        const part = fullParts.find((p) => p.includes(`===== ${r.kind} (${r.recipeId})`)) ?? '';
        const tail = part.length > FAIL_EXCERPT_CHARS ? part.slice(part.length - FAIL_EXCERPT_CHARS) : part;
        return `${rendered}\n  --- output (tail) ---\n${tail}`;
      });
      const modelText = [head, ...blocks].join('\n\n');
      const fullText = [head, ...fullParts].join('\n\n');
      // Spill seam (Session 11.5 contract): the runtime verifies sha(fullOutput) === the recorded
      // fullOutputSha256 before it stores the blob, so the string handed to truncateForModel MUST
      // be the string spilled. Truncating the excerpt while spilling the raw text made the sha
      // never match: the blob was written, rejected, and orphaned, and the recorded sha pointed at
      // bytes nothing could resolve.
      const t = truncateForModel(fullText);
      const modelOut = modelText.length <= t.text.length ? modelText : truncateForModel(modelText).text;
      const executed = results.filter((r) => r.status !== 'unsupported');

      return {
        // Honest `ok`: "nothing could be checked here" is not a successful verification. Only a
        // call in which at least one check genuinely ran, and none failed, is ok.
        ok: failed.length === 0 && executed.length > 0,
        output: modelOut,
        durationMs: Date.now() - startedAt,
        truncated: t.truncated,
        ...(failed.length > 0
          ? { error: `check(s) not passing: ${failed.map((r) => `${r.kind}=${r.status}`).join(', ')}` }
          : executed.length === 0
            ? { error: `no check ran: ${results.map((r) => `${r.kind}=unsupported`).join(', ')}` }
            : {}),
        ...(t.fullSha256 ? { fullOutputSha256: t.fullSha256 } : {}),
        ...(t.fullSha256 ? { fullOutput: fullText } : {}),
      };
    },

    workspaceSnapshot: () => shared.current(),
    refresh: () => shared.refresh(),
  };
}

/** What one project unit can be verified with — the per-unit block of the /checks surface. */
export function describeProject(project: DetectedProject): string[] {
  const lines: string[] = [];
  lines.push(
    project.kinds.length > 0
      ? `project: ${project.kinds.join(', ')}`
      : 'project: no supported manifest detected (Node/TS, Python, Rust/Cargo and Go are supported; CMake is detected but unsupported)',
  );
  if (project.packageManager !== null) lines.push(`package manager: ${project.packageManager}`);
  for (const e of project.evidence) lines.push(`evidence: ${e}`);
  const kinds = availableKinds(project);
  lines.push(kinds.length > 0 ? `runnable checks: ${kinds.join(', ')}` : 'runnable checks: none');
  return lines;
}

/**
 * Every project the workspace holds — the /checks surface and the system-prompt facts. A
 * single-project workspace renders exactly as it did before Session 16 (one unqualified block);
 * the `[project …]` heading appears only where there is genuinely more than one thing to name.
 */
export function describeWorkspace(ws: DetectedWorkspace): string[] {
  if (ws.units.length === 0) return describeProject(ws.rootUnit);
  const single = ws.units.length === 1 && ws.units[0]!.id === '.';
  const lines: string[] = [];
  for (const u of ws.units) {
    if (!single) lines.push(`[project ${u.id}]`);
    for (const l of describeProject(u)) lines.push(single ? l : `  ${l}`);
  }
  for (const n of ws.notes) lines.push(`note: ${n}`);
  return lines;
}

/** The union of every unit's runnable kinds — the plan-time "can this project run that gate" warning. */
export function workspaceAvailableKinds(ws: DetectedWorkspace): CheckKind[] {
  const seen = new Set<CheckKind>();
  for (const u of ws.units) for (const k of availableKinds(u)) seen.add(k);
  return CHECK_KINDS.filter((k) => seen.has(k));
}
