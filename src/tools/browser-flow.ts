import { z } from 'zod';
import { FLOW_WALL_MS, FlowSpecSchema } from '../browser/types.js';
import { runFlow, type FlowRunDeps } from '../browser/flow.js';
import { probeBrowser, type BrowserAvailability } from '../browser/probe.js';
import { CHECKS_PER_SESSION, type CheckCaps } from './run-check.js';
import type { ActivePreview, PreviewTool } from './preview.js';
import type { FlowRunResult } from '../browser/types.js';
import type { BrowserArtifact, CheckFinding, SessionEvent, Tool, ToolResult } from '../types.js';

/**
 * browser_flow — state-aware browser verification against a managed preview (Session 13).
 *
 * The check-inversion, applied to UI: the model declares a TYPED FLOW (routes, actions,
 * assertions, screenshot points — never raw browser control), and the harness executes it
 * deterministically with bounded waits and a typed failure taxonomy. Evidence rides the
 * Session-12 check channel (kind 'browser' — gates, waivers, acceptance, classification all
 * read it) plus one `browser.flow` detail event; screenshots and traces become content-
 * addressed blobs the report points at and view_image can re-fetch.
 *
 * Field scheme on the check events (load-bearing, pinned): `recipeId` is `browser.flow/<name>`;
 * `command` is the literal '(in-process browser flow — no shell command)' — an honest
 * non-command marker, because nothing here is shell text; `exitCode` is ALWAYS null and
 * `termination` ALWAYS absent, which is precisely what keeps a browser pass out of the
 * report's file-CHECKED correlation (that rule requires exit 0) while gates — which key on
 * status alone — are satisfied normally.
 */

const BrowserFlowInput = z
  .object({
    flow: FlowSpecSchema,
    plan_task: z.string().max(41).optional().describe('The plan task this flow verifies — recorded as a label on the evidence.'),
  })
  .strict();
export type BrowserFlowInputT = z.infer<typeof BrowserFlowInput>;

export const NO_SHELL_COMMAND = '(in-process browser flow — no shell command)';
export const ARTIFACT_BYTES_PER_SESSION = 96 * 1024 * 1024;

/** Bytes of stored browser artifacts, REBUILT FROM EVENTS at assembly (the caps pattern). */
export function artifactBytesFromEvents(events: readonly SessionEvent[]): number {
  let n = 0;
  for (const e of events) {
    if (e.type === 'browser.flow') for (const a of e.artifacts) n += a.bytes;
  }
  return n;
}

export interface BrowserToolDeps {
  /** `active` is read for project attribution and for naming what is running in a denial;
   *  `endedReason` tells a harness lifecycle stop apart from a crash (S16.5b review). */
  preview: Pick<PreviewTool, 'readyPreview' | 'active' | 'endedReason'>;
  putBlob: (bytes: Buffer) => string;
  /** The SAME live instance run_check refuses on — flows share the session check budget. */
  caps: CheckCaps;
  artifactBudget: { usedBytes: number };
  /** Cached per session by the caller; a real launch probe costs seconds. */
  probe?: () => Promise<BrowserAvailability>;
  run?: (spec: BrowserFlowInputT['flow'], deps: FlowRunDeps) => Promise<FlowRunResult>;
}

export function createBrowserFlowTool(deps: BrowserToolDeps): Tool<BrowserFlowInputT> {
  const probe = deps.probe ?? probeBrowser;
  const run = deps.run ?? runFlow;

  return {
    name: 'browser_flow',
    description:
      'Verify the running managed preview as a real user: a declared flow of goto (with REQUIRED app-meaningful ' +
      'ready_when — a load event or spinner never counts as ready), click, fill, select, press, wait_for, typed ' +
      'expect assertions (text/visible/hidden/value/url/count), and screenshot points. The harness executes it ' +
      'deterministically with bounded waits; failures are typed (timeout/navigation/assertion/runtime/protocol); ' +
      'console errors, page errors, and failed requests are recorded; screenshots and a Playwright trace are stored ' +
      'as evidence blobs (view_image shows a screenshot). Results are check evidence of kind "browser" — plan gates ' +
      'and acceptance read them. Requires a RUNNING preview (start one with the preview tool); flows are ' +
      'origin-locked to it. Visual judgment from screenshots is supplementary and can never override a failed ' +
      'deterministic assertion.',
    schema: BrowserFlowInput,
    mutates: () => null, // the app's server may write its own state; undeclarable, and policy gates on the browser fact first
    browser: (input) => ({
      flowName: input.flow.name,
      stepCount: input.flow.steps.length,
      previewBound: deps.preview.readyPreview(input.flow.preview_id) !== null,
      ...(input.flow.preview_id !== undefined ? { requestedPreviewId: input.flow.preview_id } : {}),
      // Ready == what `readyPreview` would consider bindable: alive AND readiness-observed.
      readyPreviews: deps.preview
        .active()
        .filter((a) => a.readyObserved && a.handle.isAlive())
        .map((a) => ({ previewId: a.previewId, projectId: a.projectId })),
    }),

    async execute(input, ctx): Promise<ToolResult> {
      const startedAt = Date.now();
      const planTaskId = input.plan_task;
      const flow = input.flow;

      const refuse = (output: string, error: string): ToolResult => ({
        ok: false,
        output: `refused: ${output}`,
        error,
        durationMs: Date.now() - startedAt,
        truncated: false,
      });
      /**
       * The project this flow's evidence belongs to. Session 16 gave every check event a
       * `projectId` and every gate consumer folds a missing one to the root `'.'` — so a browser
       * flow that recorded none made a project-scoped `browser` gate permanently unsatisfiable
       * AND unwaivable, with no other call able to produce that kind. The preview already knows
       * which unit it serves; the flow just has to say so. Best-effort by design: attribution is
       * for the gate, and a flow whose preview has vanished is an `error` that satisfies nothing
       * either way.
       */
      const boundProject = (): string | undefined => {
        const all = deps.preview.active();
        const hit =
          flow.preview_id !== undefined
            ? all.find((a) => a.previewId === flow.preview_id)
            : all.filter((a) => a.readyObserved)[0];
        return hit?.projectId;
      };
      const projectId = boundProject();

      const completed = (r: {
        status: 'pass' | 'fail' | 'error' | 'unsupported';
        summary: string;
        unsupportedReason?: 'precondition';
        durationMs?: number;
        signals?: string[];
        findings?: CheckFinding[];
      }): void => {
        ctx.reportCheck?.({
          kind: 'ended',
          check: 'browser',
          recipeId: `browser.flow/${flow.name}`,
          status: r.status,
          ...(projectId !== undefined ? { projectId } : {}),
          ...(r.unsupportedReason !== undefined ? { unsupportedReason: r.unsupportedReason } : {}),
          exitCode: null,
          durationMs: r.durationMs ?? 0,
          summary: r.summary,
          ...(r.signals !== undefined && r.signals.length > 0 ? { signals: r.signals } : {}),
          ...(r.findings !== undefined && r.findings.length > 0 ? { findings: r.findings } : {}),
          ...(planTaskId !== undefined ? { planTaskId } : {}),
        });
      };

      if (deps.caps.checksRun + 1 > CHECKS_PER_SESSION) {
        // Mirrors run_check's budget refusal (S22.5): a bare refusal stranded a plan gating on
        // 'browser' with no exit named — the flow is this kind's ONLY producer.
        return refuse(
          `this session's check budget is exhausted (${String(deps.caps.checksRun)}/${String(CHECKS_PER_SESSION)} run — browser flows share it). Nothing ran. ` +
            `Repeated identical flows are not progress.\n` +
            `Consequence: any plan task gating on a browser check can no longer be satisfied, so its dependents stay blocked and the ` +
            `session cannot be accepted as complete. The only exits are to amend the plan's checks/gates with update_plan ` +
            `(this resets approval and requires the user to re-approve), or to tell the user, who can record a partial ` +
            `acceptance with /accept confirm.`,
          'check budget exhausted',
        );
      }
      // A spent ARTIFACT byte budget deliberately does NOT refuse the flow (S22.5): the gate's
      // evidence is the typed step outcomes, not the stored screenshots, and the storage loop
      // below already drops over-budget artifacts with recorded omission markers — the same
      // honest degradation a mid-run exhaustion gets. Refusing here stranded the browser gate
      // over bytes that were never what the flow proves.

      // A turn aborted before anything ran: refuse the CALL, no events, nothing spawned.
      if (ctx.signal?.aborted === true) {
        return refuse('the turn was aborted before the flow ran; nothing launched and nothing was recorded', 'turn aborted');
      }

      // TOCTOU: the gate held when decide() saw a ready preview; it may have died since. A dead
      // preview is a typed ERROR with evidence — never a silent pass, never a caller mistake.
      const preview = deps.preview.readyPreview(flow.preview_id);
      if (preview === null || preview.url === null) {
        // Budget symmetry with checkCapsFromEvents: this completed row counts on resume, so the
        // live counter must count it too.
        deps.caps.checksRun++;
        // A harness LIFECYCLE stop (TTL, log cap, an explicit stop) is not a crash: recording
        // it as 'preview-died' classified a healthy app as runtime-process and sent repair
        // guidance hunting a process failure that never happened (S16.5b review). An UNBOUND
        // flow (admitted because exactly one preview was ready) asks for the most recently
        // ended preview's reason — but only when nothing is left alive, so a second preview
        // becoming ready in the window cannot be misread as the first one's death (S20.5).
        const ended =
          flow.preview_id !== undefined
            ? deps.preview.endedReason(flow.preview_id)
            : deps.preview.active().some((a) => a.handle.isAlive())
              ? undefined
              : deps.preview.endedReason();
        const lifecycle = ended === 'ttl-timeout' || ended === 'log-overflow' || ended === 'stopped' || ended === 'session-end';
        if (lifecycle) {
          completed({
            status: 'error',
            summary: `flow '${flow.name}': the bound preview was stopped by the harness before the flow ran (${ended}) — the server did not crash`,
            signals: ['preview-stopped-lifecycle'],
          });
          return {
            ok: false,
            output:
              `browser flow '${flow.name}' could not run: the bound preview was stopped (${ended}) — a lifecycle bound, not an app failure. ` +
              'Start the preview again and re-run the flow.',
            error: `preview stopped (${ended}) before the flow ran`,
            durationMs: Date.now() - startedAt,
            truncated: false,
          };
        }
        completed({
          status: 'error',
          summary: `flow '${flow.name}': the bound preview is no longer running (it died between approval and execution)`,
          signals: ['preview-died'],
        });
        return {
          ok: false,
          output:
            `browser flow '${flow.name}' could not run: the preview died between approval and execution. ` +
            'Check preview status, restart it, and re-run the flow.',
          error: 'preview died before the flow ran',
          durationMs: Date.now() - startedAt,
          truncated: false,
        };
      }

      const availability = await probe();
      if (!availability.available) {
        // A machine with no launchable browser CANNOT run this kind — the honest unsupported
        // precondition, which is exactly what lets a declared gate waive with a caveat.
        completed({ status: 'unsupported', unsupportedReason: 'precondition', summary: `browser unavailable: ${availability.reason ?? 'no launchable browser'}` });
        return {
          ok: false,
          output: `browser flows are unsupported here: ${availability.reason ?? 'no launchable browser'}`,
          error: 'browser unavailable',
          durationMs: Date.now() - startedAt,
          truncated: false,
        };
      }

      const result = await run(flow, {
        ...(availability.channel !== undefined ? { channel: availability.channel } : {}),
        originUrl: preview.url,
        isPreviewAlive: () => preview.handle.isAlive(),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        onBrowserLaunched: () =>
          // check.started means a REAL process started — here, the headless browser.
          ctx.reportCheck?.({
            kind: 'started',
            check: 'browser',
            recipeId: `browser.flow/${flow.name}`,
            command: NO_SHELL_COMMAND,
            cwd: ctx.workspaceRoot,
            timeoutMs: FLOW_WALL_MS,
            ...(projectId !== undefined ? { projectId } : {}),
            ...(planTaskId !== undefined ? { planTaskId } : {}),
          }),
      });
      deps.caps.checksRun++;

      // Store artifacts under the byte budget; what is dropped is recorded, never silent —
      // for EVERY kind. Screenshots used to be skipped without a marker while only traces
      // recorded their omission, so late in a long session the model could cite a screenshot
      // that was never stored and view_image would refuse the expected sha with no explanation
      // anywhere (S16.5b review).
      const stored: BrowserArtifact[] = [];
      let traceOmittedBytes: number | undefined;
      let screenshotsOmitted = 0;
      for (const a of result.artifacts) {
        const drop = (): void => {
          if (a.kind === 'trace') traceOmittedBytes = a.bytes.length;
          else screenshotsOmitted++;
        };
        if (deps.artifactBudget.usedBytes + a.bytes.length > ARTIFACT_BYTES_PER_SESSION) {
          drop();
          continue;
        }
        try {
          const sha = deps.putBlob(a.bytes);
          deps.artifactBudget.usedBytes += a.bytes.length;
          stored.push({ kind: a.kind, sha256: sha, bytes: a.bytes.length, label: a.label, mediaType: a.mediaType });
        } catch {
          drop();
        }
      }

      const findings: CheckFinding[] = [
        ...result.steps.filter((s) => !s.ok).map((s) => ({ message: `step ${String(s.n)} (${s.kind} ${s.target}): [${s.failure?.class ?? '?'}] ${s.failure?.detail ?? ''}`.slice(0, 200) })),
        ...result.pageErrors.map((p) => ({ message: `page error: ${p}`.slice(0, 200) })),
        ...result.consoleErrors.slice(0, 3).map((c) => ({ message: `console.error: ${c}`.slice(0, 200) })),
      ].slice(0, 8);

      // A lifecycle stop can land MID-flow too — the TTL and log-cap reapers are asynchronous —
      // and the flow then reports 'preview-died', which classifies runtime-process and sends
      // the repair budget hunting a crash that never happened. The S16.5b fix covered only the
      // pre-run window; re-consult the ended reason after the run (S20.5). Best-effort: if the
      // exit listener has not recorded a reason yet, the died reading stands.
      let signals = result.signals;
      let summary = result.summary;
      if (signals.includes('preview-died')) {
        const endedNow = deps.preview.endedReason(preview.previewId);
        if (endedNow === 'ttl-timeout' || endedNow === 'log-overflow' || endedNow === 'stopped' || endedNow === 'session-end') {
          signals = signals.map((s) => (s === 'preview-died' ? 'preview-stopped-lifecycle' : s));
          summary = `${summary} — the preview was stopped by the harness (${endedNow}), not a crash`;
        }
      }
      completed({ status: result.status, summary, durationMs: result.durationMs, signals, findings });
      ctx.reportBrowser?.({
        flowName: flow.name,
        previewId: preview.previewId,
        status: result.status,
        steps: result.steps.map((s) => ({ n: s.n, kind: s.kind, target: s.target, ok: s.ok, ...(s.failure !== undefined ? { failure: s.failure } : {}) })),
        artifacts: stored,
        consoleErrors: result.consoleErrors,
        pageErrors: result.pageErrors,
        failedRequests: result.failedRequests,
        offOriginRequests: result.offOriginRequests,
        finalUrl: result.finalUrl,
        ...(traceOmittedBytes !== undefined ? { traceOmittedBytes } : {}),
        ...(screenshotsOmitted > 0 ? { screenshotsOmitted } : {}),
      });

      // Name what was driven. An unbound flow binds to whatever single preview is ready — which
      // in a full-stack session can legitimately be the API — so "the UI assertion failed" and
      // "the flow was pointed at the backend" must be distinguishable from the result alone.
      const lines: string[] = [
        summary,
        `  drove preview ${preview.previewId} [project ${preview.projectId}] at ${preview.url}` +
          (flow.preview_id === undefined ? ' (no preview_id was given; this was the only ready preview)' : ''),
      ];
      for (const s of result.steps) {
        lines.push(`  ${s.ok ? 'ok ' : 'FAIL'} ${String(s.n).padStart(2)}. ${s.kind} ${s.target}${s.failure !== undefined ? ` — [${s.failure.class}] ${s.failure.detail}` : ''}`);
      }
      const shots = stored.filter((a) => a.kind === 'screenshot');
      for (const a of shots) lines.push(`  screenshot '${a.label}': objects/${a.sha256} (${String(Math.round(a.bytes / 1024))} KiB) — view_image to look at it`);
      const trace = stored.find((a) => a.kind === 'trace');
      if (trace !== undefined) lines.push(`  trace: objects/${trace.sha256} (${String(Math.round(trace.bytes / 1024))} KiB; open with npx playwright show-trace or trace.playwright.dev)`);
      if (traceOmittedBytes !== undefined) lines.push(`  trace NOT stored (${String(Math.round(traceOmittedBytes / 1024))} KiB over the artifact budget)`);
      if (screenshotsOmitted > 0) {
        lines.push(
          `  ${String(screenshotsOmitted)} declared screenshot(s) NOT stored (session artifact budget exhausted or storage failed) — do not cite them; the typed step outcomes above are the evidence`,
        );
      }
      if (result.consoleErrors.length > 0) lines.push(`  console errors (${String(result.consoleErrors.length)}): ${result.consoleErrors[0] ?? ''}`.slice(0, 240));
      if (result.pageErrors.length > 0) lines.push(`  page errors (${String(result.pageErrors.length)}): ${result.pageErrors[0] ?? ''}`.slice(0, 240));
      if (result.failedRequests.length > 0) lines.push(`  failed requests (${String(result.failedRequests.length)}): ${result.failedRequests[0] ?? ''}`.slice(0, 240));
      if (result.offOriginRequests.length > 0) lines.push(`  off-origin requests (recorded, not blocked): ${result.offOriginRequests.slice(0, 3).join(', ')}`.slice(0, 300));
      if (result.finalUrl !== null) lines.push(`  final url: ${result.finalUrl}`);

      return {
        ok: result.status === 'pass',
        output: lines.join('\n'),
        durationMs: Date.now() - startedAt,
        truncated: false,
        ...(result.status !== 'pass' ? { error: `browser flow ${result.status}` } : {}),
      };
    },
  };
}

/** Narrow structural view used by tests to fake a ready preview. */
export type { ActivePreview };
