import fs from 'node:fs';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { buildChildEnv } from '../exec/env.js';
import { shellInvocation } from '../exec/shell.js';
import { stampsEqual } from '../checks/detect.js';
import { detectWorkspace, probeWorkspaceStamps, selectUnit } from '../checks/workspace.js';
import { previewFact, resolvePreview, type ResolvedPreview } from '../preview/recipes.js';
import { DEFAULT_PREVIEW_TTL_MS, readTail, startSupervised } from '../preview/process.js';
import { waitForReady, DEFAULT_READY_WAIT_MS, type ReadyOptions, type ReadyOutcome } from '../preview/ready.js';
import { LOG_ENDED_MARKER, previewLogFile, previewsFile, registerPreview, unregisterPreview, loadPreviewRegistry } from '../preview/registry.js';
import type { DetectedWorkspace, ManifestStamp } from '../checks/types.js';
import type { PreviewRegistryEntry, SupervisedHandle, SupervisedSpec } from '../preview/types.js';
import type { PreviewEndReason, SessionEvent, Tool, ToolContext, ToolResult } from '../types.js';

/**
 * preview — the managed preview-server tool (Session 13). A per-session factory holding a
 * DETECTED PROJECT SNAPSHOT (the run_check pattern: the policy `check()` fact must be pure, and
 * the human's approval must bind the exact command that will run) plus the live handles of this
 * session's preview processes.
 *
 * A preview is a SESSION resource, not a call resource: `start` returns while the server keeps
 * running, and its lifecycle is bounded elsewhere — explicit `stop`, `/preview stop`, the TTL,
 * the log cap, session end, or (after a crash) the next session's identity-verified sweep.
 *
 * Evidence ordering (load-bearing, see preview/registry.ts): registry entry BEFORE
 * `preview.started`; `preview.ended` (single writer: the exit listener) BEFORE unregister.
 */

const PreviewInput = z
  .object({
    action: z.enum(['start', 'stop', 'status']).describe('start a preview server, stop one, or list the current state'),
    project: z
      .string()
      .min(1)
      .max(260)
      .optional()
      .describe(
        'Which detected project to serve (its workspace-relative directory, e.g. "web"; "." is the workspace root). ' +
          'Optional in a single-project workspace; REQUIRED when several projects exist. Start each service as its own preview.',
      ),
    script: z
      .string()
      .max(64)
      .optional()
      .describe("Which preview-capable package.json script to serve from (dev/preview/serve/start). Default: the first one declared."),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe('Expected port (also exported to the server as PORT). Without it the harness parses the port from server output.'),
    wait_ms: z.number().int().min(1000).max(120_000).optional().describe('Readiness wait bound for start (default 30000).'),
    preview_id: z.string().max(64).optional().describe('Which preview to stop (required for stop when more than one is running).'),
  })
  .strict();
export type PreviewInputT = z.infer<typeof PreviewInput>;

/** Session-cumulative start budget, REBUILT FROM EVENTS at assembly (the CheckCaps pattern). */
export interface PreviewCaps {
  previewsStarted: number;
}

export const PREVIEWS_PER_SESSION = 8;
export const MAX_CONCURRENT_PREVIEWS = 2;
/** Tail excerpt shown to the model when a start fails or a preview is inspected. */
const TAIL_EXCERPT_BYTES = 2_048;

export function previewCapsFromEvents(events: readonly SessionEvent[]): PreviewCaps {
  let n = 0;
  for (const e of events) if (e.type === 'preview.started') n++;
  return { previewsStarted: n };
}

export interface ActivePreview {
  previewId: string;
  recipeId: string;
  /** The project unit this server belongs to — the label every multi-service surface needs. */
  projectId: string;
  command: string;
  handle: SupervisedHandle;
  startedAtMs: number;
  readyObserved: boolean;
  port: number | null;
  url: string | null;
}

export interface PreviewToolDeps {
  workspaceRoot: string;
  projectDir: string;
  sessionId: string;
  caps: PreviewCaps;
  /**
   * Session-bound appender for `preview.ended` — the ONE writer of that event. Must tolerate a
   * closed log (a process death may arrive after the session ends) and must never throw.
   */
  appendEnded: (e: {
    previewId: string;
    reason: PreviewEndReason;
    exitCode: number | null;
    signal?: string;
    logFile: string;
    logTail?: string;
  }) => void;
  /** Extra env-exclusion substrings (from config rules), matching run_command's behavior. */
  envExcludePatterns?: readonly string[];
  ownerPid?: number;
  ttlMs?: number;
  /** The session's shared initial detection (see CheckToolDeps.initial). */
  initial?: DetectedWorkspace;
  /** Injectable seams (tests). */
  detect?: (root: string) => DetectedWorkspace;
  probe?: (root: string) => ManifestStamp[];
  start?: (spec: SupervisedSpec) => Promise<SupervisedHandle>;
  readiness?: (handle: SupervisedHandle, opts: ReadyOptions) => Promise<ReadyOutcome>;
  newPreviewId?: () => string;
}

export interface PreviewTool extends Tool<PreviewInputT> {
  workspaceSnapshot(): DetectedWorkspace;
  refresh(): DetectedWorkspace;
  /** This session's previews (live handles; callers re-probe isAlive() at render time). */
  active(): readonly ActivePreview[];
  /** The one the browser layer binds to: a ready, still-alive preview by id (or the only one). */
  readyPreview(previewId?: string): ActivePreview | null;
  stopById(previewId: string, reason: 'stopped' | 'session-end'): Promise<{ ok: boolean; detail: string }>;
  /** Stop everything this session owns (bounded); honest split of verified vs resistant. */
  stopAll(reason: 'session-end'): Promise<{ stopped: number; unverified: number }>;
}

const fmtUptime = (ms: number): string => (ms < 60_000 ? `${String(Math.round(ms / 1000))}s` : `${String(Math.round(ms / 60_000))}m`);

export function createPreviewTool(deps: PreviewToolDeps): PreviewTool {
  const detect = deps.detect ?? detectWorkspace;
  const probe = deps.probe ?? probeWorkspaceStamps;
  const start = deps.start ?? startSupervised;
  const readiness = deps.readiness ?? waitForReady;
  const ttlMs = deps.ttlMs ?? DEFAULT_PREVIEW_TTL_MS;
  const newId = deps.newPreviewId ?? ((): string => `pv-${randomBytes(3).toString('hex')}`);
  const registry = previewsFile(deps.projectDir);

  let workspace = deps.initial ?? detect(deps.workspaceRoot);
  const active = new Map<string, ActivePreview>();

  /** Which unit to serve. Pure over the snapshot (the `check()` fact contract); ambiguity refuses. */
  const unitFor = (input: PreviewInputT): ReturnType<typeof selectUnit> => selectUnit(workspace, input.project);

  const resolveFor = (input: PreviewInputT): ReturnType<typeof resolvePreview> => {
    const sel = unitFor(input);
    if (sel.unit === null) return { candidates: [], resolved: null, reason: sel.reason, badRequest: true };
    return resolvePreview(sel.unit, input.script);
  };

  const aliveActive = (): ActivePreview[] => [...active.values()].filter((a) => a.handle.isAlive());

  async function doStop(a: ActivePreview, reason: 'stopped' | 'session-end'): Promise<{ ok: boolean; detail: string }> {
    const r = await a.handle.stop(reason);
    // The exit listener owns the event + unregistration; nothing more to do here.
    return r;
  }

  return {
    name: 'preview',
    description:
      'Manage a preview server for this workspace as an explicit session resource. `start` resolves a ' +
      'preview-capable package.json script (dev/preview/serve/start) to a harness-composed command — you name the ' +
      'script, never the command — spawns it as a supervised process that KEEPS RUNNING between turns, and waits ' +
      '(bounded) until it answers HTTP; readiness, the port, and the log file are recorded as evidence. The server ' +
      'is stopped by `stop`, by the user, at session end, or by its bounded lifetime/log caps — never silently. ' +
      '`status` lists this session\'s previews with a log tail. Starting asks for approval (the process runs a ' +
      'workspace-defined script at full user privilege, unsandboxed, and binds a local port); browser verification ' +
      'drives a running preview. Do NOT start servers via run_command: they would be killed at the command timeout ' +
      'and leave no managed lifecycle.',
    schema: PreviewInput,
    // Honest: a dev server may write anywhere its script says (build caches, temp outputs).
    // Policy never reads this (the check branch precedes mutation), but it must not lie.
    mutates: () => null,
    check: (input) => {
      // stop/status are MANAGE actions on session-owned resources — the flag keeps the policy
      // record from classifying a process kill as observation.
      if (input.action !== 'start') return { resolved: [], manage: true };
      const r = resolveFor(input).resolved;
      return { resolved: r === null ? [] : [previewFact(r, ttlMs, input.port)] };
    },

    async execute(input, ctx): Promise<ToolResult> {
      const startedAt = Date.now();
      if (input.action === 'status') return statusResult(aliveActive(), active, registry, deps.sessionId, startedAt);
      if (input.action === 'stop') {
        const alive = aliveActive();
        const id = input.preview_id ?? (alive.length === 1 ? alive[0]!.previewId : undefined);
        const target = id !== undefined ? active.get(id) : undefined;
        if (id === undefined || target === undefined) {
          const others = loadPreviewRegistry(registry).filter((e) => e.ownerSessionId !== deps.sessionId);
          return {
            ok: false,
            output:
              alive.length === 0
                ? `nothing to stop: this session has no running preview${others.length > 0 ? ` (${String(others.length)} belong to other sessions — not yours to stop)` : ''}`
                : `refused: preview_id is required when more than one preview is running (running: ${alive.map((a) => a.previewId).join(', ')})`,
            error: 'no matching preview',
            durationMs: Date.now() - startedAt,
            truncated: false,
          };
        }
        const r = await doStop(target, 'stopped');
        return {
          ok: r.ok,
          output: r.ok
            ? `stopped ${target.previewId} (${target.command}); log: ${target.handle.logFile}`
            : `stop attempted but the process may still be alive: ${r.detail}`,
          ...(r.ok ? {} : { error: 'stop unverified' }),
          durationMs: Date.now() - startedAt,
          truncated: false,
        };
      }

      // ── start ──
      if (deps.caps.previewsStarted >= PREVIEWS_PER_SESSION) {
        return refuse(
          `this session's preview budget is exhausted (${String(deps.caps.previewsStarted)}/${String(PREVIEWS_PER_SESSION)} starts). ` +
            'Repeated restarts are not progress — fix the underlying failure or tell the user.',
          'preview budget exhausted',
          startedAt,
        );
      }
      const alive = aliveActive();
      if (alive.length >= MAX_CONCURRENT_PREVIEWS) {
        return refuse(
          `at most ${String(MAX_CONCURRENT_PREVIEWS)} previews may run at once (running: ${alive.map((a) => a.previewId).join(', ')}). ` +
            'Stop one first (action "stop", or the user can /preview stop).',
          'too many concurrent previews',
          startedAt,
        );
      }

      const gated = resolveFor(input).resolved;
      // TOCTOU: the human approved the command resolved from the snapshot. Re-probe; refuse if
      // the resolved command/body changed; the snapshot advances so the next call re-asks.
      if (!stampsEqual(workspace.stamps, probe(deps.workspaceRoot))) {
        workspace = detect(deps.workspaceRoot);
        const now = resolveFor(input).resolved;
        if (!samePreview(gated, now)) {
          const d = (r: ResolvedPreview | null): string => (r === null ? '(nothing)' : `${r.command} (script body ${r.bodySha.slice(0, 8)})`);
          return refuse(
            `the project changed after this call was approved, so the resolved preview command no longer matches what was gated.\n` +
              `  approved: ${d(gated)}\n  now:      ${d(now)}\nNothing started. Call preview again to have the current command approved.`,
            'project changed after approval; nothing started',
            startedAt,
          );
        }
      }
      const resolution = resolveFor(input);
      if (resolution.resolved === null) {
        return refuse(
          `${resolution.badRequest === true ? 'bad request' : 'not startable'}: ${resolution.reason ?? 'no preview-capable script'}` +
            (resolution.candidates.length > 0 ? `\n  declared preview-capable scripts: ${resolution.candidates.join(', ')}` : ''),
          resolution.badRequest === true ? 'invalid preview request' : 'no preview-capable script',
          startedAt,
        );
      }
      const rc = resolution.resolved;

      const previewId = newId();
      const logFile = previewLogFile(deps.projectDir, deps.sessionId, previewId);
      const inv = shellInvocation(rc.command);
      const env = buildChildEnv(
        process.env,
        deps.envExcludePatterns !== undefined && deps.envExcludePatterns.length > 0
          ? { extraExcludeSubstrings: [...deps.envExcludePatterns] }
          : {},
      );
      if (input.port !== undefined) env['PORT'] = String(input.port);

      let handle: SupervisedHandle;
      try {
        // The UNIT's directory: `npm run dev` for the frontend must run in the frontend.
        handle = await start({ file: inv.file, args: inv.args, cwd: rc.cwd, env, logFile, ttlMs });
      } catch (err) {
        // Nothing spawned: no pid, no registry entry, no event — the house onSpawn rule.
        return refuse(`the preview process could not be spawned: ${(err as Error).message}`, 'spawn failed; nothing started', startedAt);
      }

      const entry: PreviewRegistryEntry = {
        previewId,
        pid: handle.pid,
        command: rc.command,
        cwd: rc.cwd,
        ...(input.port !== undefined ? { port: input.port } : {}),
        ownerSessionId: deps.sessionId,
        ownerPid: deps.ownerPid ?? process.pid,
        createdAt: new Date().toISOString(),
        logFile,
      };
      const ap: ActivePreview = {
        previewId,
        recipeId: rc.recipeId,
        projectId: rc.projectId,
        command: rc.command,
        handle,
        startedAtMs: startedAt,
        readyObserved: false,
        port: null,
        url: null,
      };
      active.set(previewId, ap);

      // The single preview.ended writer: the exit listener, installed IMMEDIATELY after spawn so
      // every path on which a pid existed records its death — including a start whose
      // registration fails below. It also stamps the log file's ended marker, which is what
      // lets the sweep's unaccounted-log scan tell "lost before registration" apart from
      // "ended normally". Ordering note (load-bearing): this .then is registered BEFORE any
      // stop()'s own exited.then, so on the awaited stop paths the ended event lands before
      // stop() resolves — i.e. before session end closes the log.
      void handle.exited.then((info) => {
        const reason: PreviewEndReason = info.requestedStop ?? (ap.readyObserved ? 'crashed' : 'start-failed');
        try {
          fs.appendFileSync(logFile, `\n${LOG_ENDED_MARKER} (${reason})\n`);
        } catch {
          /* marker is best-effort; the event is the evidence */
        }
        deps.appendEnded({
          previewId,
          reason,
          exitCode: info.exitCode,
          ...(info.signal !== null ? { signal: info.signal } : {}),
          logFile,
          logTail: readTail(logFile, TAIL_EXCERPT_BYTES),
        });
        active.delete(previewId);
        void unregisterPreview(registry, previewId, deps.sessionId).catch(() => undefined);
      });

      // Registry BEFORE the started event: a crash between the two leaves a sweepable entry with
      // no event — never an event whose promised sweep cannot find the process. (The window
      // between the spawn above and this write is covered only by the log-file scan — see
      // preview/registry.ts.)
      try {
        await registerPreview(registry, entry);
      } catch {
        // Registration failing is a real gap in crash coverage; stop the process and say
        // EXACTLY what was verified. An unkillable process stays in `active` so session-end
        // stop-all retries it.
        const r = await handle.stop('start-failed');
        if (r.ok) active.delete(previewId);
        return refuse(
          `the preview crash-registry could not be written (lock contention?); ` +
            (r.ok
              ? 'the process was stopped again — a preview the next session cannot sweep must not keep running'
              : `stopping it FAILED (${r.detail}); it remains managed for a session-end stop (pid ${String(handle.pid)})`),
          'registry write failed; preview not started',
          startedAt,
        );
      }
      ctx.reportPreview?.({
        kind: 'started',
        previewId,
        recipeId: rc.recipeId,
        command: rc.command,
        cwd: rc.cwd,
        pid: handle.pid,
        ...(input.port !== undefined ? { expectedPort: input.port } : {}),
      });

      deps.caps.previewsStarted++;

      const ready = await readiness(handle, {
        ...(input.port !== undefined ? { expectedPort: input.port } : {}),
        waitMs: input.wait_ms ?? DEFAULT_READY_WAIT_MS,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });

      if (ready.ready) {
        ap.readyObserved = true;
        ap.port = ready.port ?? null;
        ap.url = ready.url ?? null;
        ctx.reportPreview?.({
          kind: 'ready',
          previewId,
          url: ready.url ?? '',
          port: ready.port ?? 0,
          waitedMs: ready.waitedMs,
          probeDetail: ready.probeDetail,
        });
        return {
          ok: true,
          output:
            `preview ${previewId} [project ${rc.projectId}] ready: ${ready.url ?? ''} (${ready.probeDetail}; waited ${String(ready.waitedMs)}ms)\n` +
            `  command: ${rc.command}   [${rc.recipeId}; pid ${String(handle.pid)}; cwd ${rc.cwd}]\n` +
            `  lifetime: until stopped, session end, or ${String(Math.round(ttlMs / 60_000))}min TTL; log: ${logFile}\n` +
            `  note: an HTTP answer on the announced port proves A server is up (socket ownership is not verified) — ` +
            `application state is verified by browser flows, not this.`,
          durationMs: Date.now() - startedAt,
          truncated: false,
        };
      }

      if (ready.cause === 'aborted') {
        return {
          ok: false,
          output:
            `preview ${previewId} start initiated, but readiness was not observed (turn aborted). ` +
            `The process is LEFT RUNNING (pid ${String(handle.pid)}); action "status" re-checks it, "stop" ends it.`,
          error: 'readiness not observed (aborted); preview left running',
          durationMs: Date.now() - startedAt,
          truncated: false,
        };
      }

      if (ready.cause === 'died') {
        await handle.exited; // the listener has appended preview.ended {start-failed}
        return {
          ok: false,
          output:
            `preview ${previewId} FAILED TO START: the process exited during startup (${ready.probeDetail}).\n` +
            `  command: ${rc.command}\n  --- log tail ---\n${readTail(logFile, TAIL_EXCERPT_BYTES)}`,
          error: 'preview start failed (process exited)',
          durationMs: Date.now() - startedAt,
          truncated: false,
        };
      }

      // timeout: never became a preview — stop it with the honest reason.
      await handle.stop('start-failed');
      return {
        ok: false,
        output:
          `preview ${previewId} FAILED TO START: ${ready.probeDetail}. The process was stopped (it never became a preview).\n` +
          `  command: ${rc.command}\n  --- log tail ---\n${readTail(logFile, TAIL_EXCERPT_BYTES)}`,
        error: 'preview start failed (readiness timeout)',
        durationMs: Date.now() - startedAt,
        truncated: false,
      };
    },

    workspaceSnapshot: () => workspace,
    refresh: () => {
      workspace = detect(deps.workspaceRoot);
      return workspace;
    },
    active: () => [...active.values()],
    readyPreview: (previewId) => {
      const alive = aliveActive().filter((a) => a.readyObserved);
      if (previewId !== undefined) return alive.find((a) => a.previewId === previewId) ?? null;
      return alive.length === 1 ? alive[0]! : null;
    },
    stopById: async (previewId, reason) => {
      const a = active.get(previewId);
      if (a === undefined) return { ok: false, detail: `no such preview in this session: ${previewId}` };
      return doStop(a, reason);
    },
    stopAll: async (reason) => {
      const alive = aliveActive();
      const results = await Promise.all(alive.map((a) => doStop(a, reason)));
      const stopped = results.filter((r) => r.ok).length;
      return { stopped, unverified: results.length - stopped };
    },
  };
}

function refuse(output: string, error: string, startedAt: number): ToolResult {
  return { ok: false, output: `refused: ${output}`, error, durationMs: Date.now() - startedAt, truncated: false };
}

/** Same tuple `checkReplayKey` hashes for a preview fact — consent and TOCTOU move together. */
function samePreview(a: ResolvedPreview | null, b: ResolvedPreview | null): boolean {
  if (a === null || b === null) return a === b;
  return a.recipeId === b.recipeId && a.command === b.command && a.bodySha === b.bodySha && a.projectId === b.projectId && a.cwd === b.cwd;
}

function statusResult(
  alive: ActivePreview[],
  all: Map<string, ActivePreview>,
  registryFile: string,
  sessionId: string,
  startedAt: number,
): ToolResult {
  const lines: string[] = [];
  if (alive.length === 0) lines.push('no preview is running in this session');
  for (const a of alive) {
    lines.push(
      `${a.previewId} [project ${a.projectId}]: ${a.readyObserved ? `ready at ${a.url ?? '?'}` : 'started, readiness never observed'} ` +
        `(pid ${String(a.handle.pid)}, up ${fmtUptime(Date.now() - a.startedAtMs)}) — ${a.command}`,
    );
    const tail = a.handle
      .tail(1024)
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .slice(-5);
    for (const l of tail) lines.push(`    | ${l}`);
  }
  const others = loadPreviewRegistry(registryFile).filter((e) => e.ownerSessionId !== sessionId);
  for (const o of others) {
    lines.push(`${o.previewId}: recorded by another session (pid ${String(o.pid)}) — not managed here`);
  }
  const stoppedCount = all.size - alive.length;
  if (stoppedCount > 0) lines.push(`(${String(stoppedCount)} earlier preview(s) of this session already ended — see preview.ended events)`);
  return { ok: true, output: lines.join('\n'), durationMs: Date.now() - startedAt, truncated: false };
}
