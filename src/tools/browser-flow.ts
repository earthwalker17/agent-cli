import { z } from 'zod';
import { FlowSpecSchema } from '../browser/types.js';
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
export const ARTIFACT_BYTES_PER_SESSION = 64 * 1024 * 1024;

/** Bytes of stored browser artifacts, REBUILT FROM EVENTS at assembly (the caps pattern). */
export function artifactBytesFromEvents(events: readonly SessionEvent[]): number {
  let n = 0;
  for (const e of events) {
    if (e.type === 'browser.flow') for (const a of e.artifacts) n += a.bytes;
  }
  return n;
}

export interface BrowserToolDeps {
  preview: Pick<PreviewTool, 'readyPreview'>;
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
        return refuse(
          `this session's check budget is exhausted (${String(deps.caps.checksRun)}/${String(CHECKS_PER_SESSION)} run — browser flows share it). Nothing ran.`,
          'check budget exhausted',
        );
      }
      if (deps.artifactBudget.usedBytes >= ARTIFACT_BYTES_PER_SESSION) {
        return refuse(
          `this session's browser-artifact budget is exhausted (${String(Math.round(deps.artifactBudget.usedBytes / 1024 / 1024))} MiB stored). Nothing ran.`,
          'artifact budget exhausted',
        );
      }

      // TOCTOU: the gate held when decide() saw a ready preview; it may have died since. A dead
      // preview is a typed ERROR with evidence — never a silent pass, never a caller mistake.
      const preview = deps.preview.readyPreview(flow.preview_id);
      if (preview === null || preview.url === null) {
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
        onBrowserLaunched: () =>
          // check.started means a REAL process started — here, the headless browser.
          ctx.reportCheck?.({
            kind: 'started',
            check: 'browser',
            recipeId: `browser.flow/${flow.name}`,
            command: NO_SHELL_COMMAND,
            cwd: ctx.workspaceRoot,
            timeoutMs: 60_000,
            ...(planTaskId !== undefined ? { planTaskId } : {}),
          }),
      });
      deps.caps.checksRun++;

      // Store artifacts under the byte budget; what is dropped is recorded, never silent.
      const stored: BrowserArtifact[] = [];
      let traceOmittedBytes: number | undefined;
      for (const a of result.artifacts) {
        if (deps.artifactBudget.usedBytes + a.bytes.length > ARTIFACT_BYTES_PER_SESSION) {
          if (a.kind === 'trace') traceOmittedBytes = a.bytes.length;
          continue;
        }
        try {
          const sha = deps.putBlob(a.bytes);
          deps.artifactBudget.usedBytes += a.bytes.length;
          stored.push({ kind: a.kind, sha256: sha, bytes: a.bytes.length, label: a.label, mediaType: a.mediaType });
        } catch {
          if (a.kind === 'trace') traceOmittedBytes = a.bytes.length;
        }
      }

      const findings: CheckFinding[] = [
        ...result.steps.filter((s) => !s.ok).map((s) => ({ message: `step ${String(s.n)} (${s.kind} ${s.target}): [${s.failure?.class ?? '?'}] ${s.failure?.detail ?? ''}`.slice(0, 200) })),
        ...result.pageErrors.map((p) => ({ message: `page error: ${p}`.slice(0, 200) })),
        ...result.consoleErrors.slice(0, 3).map((c) => ({ message: `console.error: ${c}`.slice(0, 200) })),
      ].slice(0, 8);

      completed({ status: result.status, summary: result.summary, durationMs: result.durationMs, signals: result.signals, findings });
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
      });

      const lines: string[] = [result.summary];
      for (const s of result.steps) {
        lines.push(`  ${s.ok ? 'ok ' : 'FAIL'} ${String(s.n).padStart(2)}. ${s.kind} ${s.target}${s.failure !== undefined ? ` — [${s.failure.class}] ${s.failure.detail}` : ''}`);
      }
      const shots = stored.filter((a) => a.kind === 'screenshot');
      for (const a of shots) lines.push(`  screenshot '${a.label}': objects/${a.sha256} (${String(Math.round(a.bytes / 1024))} KiB) — view_image to look at it`);
      const trace = stored.find((a) => a.kind === 'trace');
      if (trace !== undefined) lines.push(`  trace: objects/${trace.sha256} (${String(Math.round(trace.bytes / 1024))} KiB; open with npx playwright show-trace or trace.playwright.dev)`);
      if (traceOmittedBytes !== undefined) lines.push(`  trace NOT stored (${String(Math.round(traceOmittedBytes / 1024))} KiB over the artifact budget)`);
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
