import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Locator, Page } from 'playwright-core';
import {
  DEFAULT_STEP_TIMEOUT_MS,
  FLOW_WALL_MS,
  MAX_RECORDED_ERRORS,
  MAX_RECORDED_REQUESTS,
  type FlowRunResult,
  type FlowSpec,
  type FlowStep,
  type StepFailureClass,
  type StepOutcome,
} from './types.js';

/**
 * The deterministic flow executor (Session 13). One flow = one headless browser launch, one
 * context, one traced run, then everything closed — the browser's lifetime is strictly inside
 * the call (and if the harness dies mid-flow, the playwright driver pipe closes and the browser
 * exits with it; no crash registry needed, unlike previews).
 *
 * Honesty rules baked in:
 * - readiness is the DECLARED ready_when condition; goto waits for 'commit' only — a load
 *   event, networkidle, or a quiet spinner never count;
 * - steps run strictly in order and stop at the first failure — an assertion or screenshot can
 *   never observe state later than a failure it should have reported;
 * - the failure taxonomy is typed: 'timeout' = an ACTION or declared readiness never completed;
 *   'assertion' = an expect condition did not hold within its bound; 'navigation' = the page
 *   left the preview origin (top-level) or navigation itself failed; 'runtime' = an uncaught
 *   page error; 'protocol' = the browser/driver failed — the app was never judged;
 * - a failing step gets a best-effort 'failure' screenshot — evidence of the state that failed,
 *   captured at the moment of failure (never a substitute for the typed record).
 */

export interface FlowRunDeps {
  /** Channel from the probe; undefined = the Playwright-cache Chromium. */
  channel?: string;
  /** The preview origin, e.g. http://127.0.0.1:5173 — the flow's whole world. */
  originUrl: string;
  /** Live preview check between steps: a dead server must read as preview-died, not timeouts. */
  isPreviewAlive: () => boolean;
  /** Fires once, right after the headless browser genuinely launched — the check.started hook. */
  onBrowserLaunched?: () => void;
  /** The turn's abort signal: a cancelled turn must not keep driving a browser. */
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  wallMs?: number;
}

const POLL_MS = 100;

/**
 * REAL origin comparison — `String.startsWith` is not one ('http://127.0.0.1:3000' is a prefix
 * of 'http://127.0.0.1:30001/...'). Unparsable URLs count as off-origin (fail closed).
 */
export function isSameOrigin(url: string, originUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(originUrl).origin;
  } catch {
    return false;
  }
}

export async function runFlow(spec: FlowSpec, deps: FlowRunDeps): Promise<FlowRunResult> {
  const startedAt = Date.now();
  const wallDeadline = startedAt + (deps.wallMs ?? FLOW_WALL_MS);
  const origin = deps.originUrl.replace(/\/$/, '');
  const steps: StepOutcome[] = [];
  const artifacts: FlowRunResult['artifacts'] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const offOriginRequests: string[] = [];
  let finalUrl: string | null = null;
  let offOriginNav: string | null = null;
  let previewDied = false;

  const push = (arr: string[], v: string, cap: number): void => {
    if (arr.length < cap) arr.push(v.slice(0, 300));
  };

  let chromium: typeof import('playwright-core')['chromium'];
  try {
    ({ chromium } = await import('playwright-core'));
  } catch (e) {
    return protocolResult(`playwright-core is not importable: ${(e as Error).message}`, startedAt, steps);
  }

  let browser;
  try {
    browser = await chromium.launch({ ...(deps.channel !== undefined && deps.channel !== 'chromium-cache' ? { channel: deps.channel } : {}), headless: true, timeout: 30_000 });
  } catch (e) {
    return protocolResult(`browser launch failed: ${String((e as Error).message).split('\n')[0] ?? ''}`, startedAt, steps);
  }
  try {
    deps.onBrowserLaunched?.();
  } catch {
    /* an evidence observer must never fail the flow */
  }

  let traceBytes: Buffer | null = null;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    let tracing = false;
    try {
      await context.tracing.start({ screenshots: true, snapshots: true });
      tracing = true;
    } catch {
      /* tracing unavailable is a degraded artifact, never a flow failure */
    }
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') push(consoleErrors, msg.text(), MAX_RECORDED_ERRORS);
    });
    page.on('pageerror', (err) => push(pageErrors, err.message, MAX_RECORDED_ERRORS));
    page.on('requestfailed', (req) => push(failedRequests, `${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'failed'}`, MAX_RECORDED_REQUESTS));
    page.on('request', (req) => {
      if (!isSameOrigin(req.url(), origin)) push(offOriginRequests, req.url(), MAX_RECORDED_REQUESTS);
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && frame.url() !== 'about:blank' && !isSameOrigin(frame.url(), origin)) {
        offOriginNav = frame.url();
      }
    });

    // Each step's own timeout is clamped to the remaining wall so the declared flow bound is a
    // real bound, not "wall + one more step + screenshots".
    const stepTimeout = (declared?: number): number => {
      const want = declared ?? deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
      return Math.max(250, Math.min(want, wallDeadline - Date.now()));
    };

    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i]!;
      const n = i + 1;
      if (deps.signal?.aborted === true) {
        steps.push({ n, kind: step.do, target: describeStep(step), ok: false, failure: { class: 'protocol', detail: 'the turn was aborted by the user before this step ran' } });
        break;
      }
      if (!deps.isPreviewAlive()) {
        previewDied = true;
        break;
      }
      if (Date.now() > wallDeadline) {
        steps.push({ n, kind: step.do, target: describeStep(step), ok: false, failure: { class: 'timeout', detail: `flow wall clock (${String(deps.wallMs ?? FLOW_WALL_MS)}ms) exhausted before this step` } });
        break;
      }
      const outcome = await runStep(page, step, n, origin, stepTimeout);
      // An off-origin top-level navigation observed during ANY step aborts the flow as a typed
      // navigation failure — the origin lock is the consent boundary, not a soft warning.
      if (offOriginNav !== null && outcome.failure === undefined) {
        outcome.ok = false;
        outcome.failure = { class: 'navigation', detail: `top-level navigation left the preview origin: ${offOriginNav}` };
      }
      steps.push(outcome);
      if (step.do === 'screenshot' && outcome.ok) {
        try {
          const bytes = await page.screenshot({ fullPage: step.full_page === true, timeout: 5_000 });
          artifacts.push({ kind: 'screenshot', bytes, label: step.label, mediaType: 'image/png' });
        } catch (e) {
          outcome.ok = false;
          outcome.failure = { class: 'protocol', detail: `screenshot failed: ${(e as Error).message}` };
        }
      }
      if (!outcome.ok) {
        // Re-check liveness on the way out. The pre-step check catches a server that was already
        // gone; a server that dies DURING a step produced a timeout or a failed assertion, and
        // reporting that as a UI defect is a dishonest verdict — the app was never judged. It
        // also sends the repair budget after a rendering hypothesis for a process that no longer
        // exists (`browser-verification` instead of `runtime-process`).
        if (!deps.isPreviewAlive()) {
          previewDied = true;
          steps.pop();
          break;
        }
        // Best-effort failure screenshot: the state that failed, at the moment it failed.
        try {
          const bytes = await page.screenshot({ timeout: 3_000 });
          artifacts.push({ kind: 'screenshot', bytes, label: `failure-step${String(n)}`, mediaType: 'image/png' });
        } catch {
          /* a dead page cannot be photographed */
        }
        break;
      }
    }

    try {
      finalUrl = page.url();
      if (finalUrl === 'about:blank') finalUrl = null;
    } catch {
      finalUrl = null;
    }
    if (tracing) {
      const traceFile = path.join(os.tmpdir(), `agent-cli-trace-${randomBytes(4).toString('hex')}.zip`);
      try {
        await context.tracing.stop({ path: traceFile });
        traceBytes = fs.readFileSync(traceFile);
      } catch {
        traceBytes = null;
      } finally {
        try {
          fs.rmSync(traceFile, { force: true });
        } catch {
          /* temp file */
        }
      }
    }
    await context.close();
  } catch (e) {
    // A protocol-level failure mid-flow (browser died, context lost) — the app was not judged.
    steps.push({ n: steps.length + 1, kind: 'goto', target: '(flow)', ok: false, failure: { class: 'protocol', detail: (e as Error).message } });
  } finally {
    try {
      await browser.close();
    } catch {
      /* already gone */
    }
  }

  if (traceBytes !== null) artifacts.push({ kind: 'trace', bytes: traceBytes, label: `${spec.name}-trace`, mediaType: 'application/zip' });

  // ── Verdict + signals: typed outcomes only; narration never changes a status. ──
  const failures = steps.filter((s) => !s.ok).map((s) => s.failure).filter((f): f is NonNullable<StepOutcome['failure']> => f !== undefined);
  const signals: string[] = [];
  const add = (s: string): void => {
    if (!signals.includes(s)) signals.push(s);
  };
  if (previewDied) add('preview-died');
  for (const f of failures) {
    if (f.class === 'assertion') add('browser-assertion-failed');
    else if (f.class === 'timeout') add('browser-timeout');
    else if (f.class === 'navigation') add('browser-navigation');
  }
  if (pageErrors.length > 0) add('page-error');
  if (consoleErrors.length > 0) add('console-error');
  if (failedRequests.length > 0) add('request-failed');

  const protocolFailure = failures.some((f) => f.class === 'protocol');
  const executed = steps.length;
  const passedSteps = steps.filter((s) => s.ok).length;
  const shots = artifacts.filter((a) => a.kind === 'screenshot').length;

  let status: FlowRunResult['status'];
  if (previewDied || protocolFailure) status = 'error';
  else if (failures.some((f) => f.class === 'runtime' || f.class === 'assertion' || f.class === 'timeout' || f.class === 'navigation')) status = 'fail';
  else if (pageErrors.length > 0) status = 'fail';
  else if (spec.fail_on_console_error === true && consoleErrors.length > 0) status = 'fail';
  else status = 'pass';

  const failBit =
    failures.length > 0
      ? `; first failure: step ${String(steps.find((s) => !s.ok)?.n ?? 0)} (${failures[0]!.class}) ${failures[0]!.detail.slice(0, 140)}`
      : pageErrors.length > 0
        ? `; uncaught page error: ${pageErrors[0]!.slice(0, 140)}`
        : status === 'fail' && consoleErrors.length > 0
          ? `; console.error (fail_on_console_error): ${consoleErrors[0]!.slice(0, 140)}`
          : '';
  const summary = previewDied
    ? `flow '${spec.name}': the preview server died mid-flow after ${String(executed)} step(s)`
    : `flow '${spec.name}': ${status} — ${String(passedSteps)}/${String(spec.steps.length)} step(s)${shots > 0 ? `, ${String(shots)} screenshot(s)` : ''}${failBit}`;

  return {
    status,
    steps,
    artifacts,
    consoleErrors,
    pageErrors,
    failedRequests,
    offOriginRequests,
    finalUrl,
    durationMs: Date.now() - startedAt,
    signals,
    summary,
  };
}

function protocolResult(detail: string, startedAt: number, steps: StepOutcome[]): FlowRunResult {
  return {
    status: 'error',
    steps,
    artifacts: [],
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    offOriginRequests: [],
    finalUrl: null,
    durationMs: Date.now() - startedAt,
    signals: ['browser-unavailable'],
    summary: `browser flow could not run: ${detail}`,
  };
}

function describeStep(s: FlowStep): string {
  switch (s.do) {
    case 'goto':
      return s.path;
    case 'click':
      return s.selector ?? `text=${s.text ?? ''}`;
    case 'fill':
    case 'select':
      return s.selector;
    case 'press':
      return `${s.selector !== undefined ? `${s.selector} ` : ''}${s.key}`;
    case 'wait_for':
      return s.selector ?? `text=${s.text ?? ''}`;
    case 'expect':
      return `${s.kind}${s.selector !== undefined ? ` ${s.selector}` : ''}${s.text !== undefined ? ` ~ ${s.text}` : ''}${s.count !== undefined ? ` = ${String(s.count)}` : ''}`;
    case 'screenshot':
      return s.label;
  }
}

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.message.includes('Timeout'));
}

async function runStep(page: Page, step: FlowStep, n: number, origin: string, stepTimeout: (t?: number) => number): Promise<StepOutcome> {
  const base: StepOutcome = { n, kind: step.do, target: describeStep(step), ok: true };
  const fail = (cls: StepFailureClass, detail: string): StepOutcome => ({ ...base, ok: false, failure: { class: cls, detail } });
  try {
    switch (step.do) {
      case 'goto': {
        const t = stepTimeout(step.ready_when.timeout_ms);
        try {
          await page.goto(origin + step.path, { waitUntil: 'commit', timeout: t });
        } catch (e) {
          return fail(isTimeoutError(e) ? 'timeout' : 'navigation', `goto ${step.path}: ${(e as Error).message.split('\n')[0] ?? ''}`);
        }
        // Declared readiness — the whole honesty of every later assertion and screenshot.
        const target = step.ready_when.selector !== undefined ? page.locator(step.ready_when.selector).first() : page.getByText(step.ready_when.text ?? '').first();
        try {
          await target.waitFor({ state: 'visible', timeout: t });
        } catch {
          return fail(
            'timeout',
            `declared readiness (${step.ready_when.selector ?? `text ~ "${step.ready_when.text ?? ''}"`}) not reached within ${String(t)}ms — the page loaded but the application never showed the declared state`,
          );
        }
        return base;
      }
      case 'click': {
        const loc = step.selector !== undefined ? page.locator(step.selector).first() : page.getByText(step.text ?? '', { exact: false }).first();
        await loc.click({ timeout: stepTimeout(step.timeout_ms) });
        return base;
      }
      case 'fill': {
        await page.locator(step.selector).first().fill(step.value, { timeout: stepTimeout(step.timeout_ms) });
        return base;
      }
      case 'select': {
        await page.locator(step.selector).first().selectOption(step.value, { timeout: stepTimeout(step.timeout_ms) });
        return base;
      }
      case 'press': {
        if (step.selector !== undefined) await page.locator(step.selector).first().press(step.key, { timeout: stepTimeout(step.timeout_ms) });
        else await page.keyboard.press(step.key);
        return base;
      }
      case 'wait_for': {
        const loc = step.selector !== undefined ? page.locator(step.selector).first() : page.getByText(step.text ?? '').first();
        try {
          await loc.waitFor({ state: step.state ?? 'visible', timeout: stepTimeout(step.timeout_ms) });
        } catch (e) {
          return fail(isTimeoutError(e) ? 'timeout' : 'protocol', `wait_for ${describeStep(step)}: not ${step.state ?? 'visible'} within ${String(stepTimeout(step.timeout_ms))}ms`);
        }
        return base;
      }
      case 'expect':
        return await runExpect(page, step, base, fail, stepTimeout(step.timeout_ms));
      case 'screenshot':
        return base; // captured by the caller after the ok is confirmed
    }
  } catch (e) {
    return fail(isTimeoutError(e) ? 'timeout' : 'protocol', `${step.do} ${describeStep(step)}: ${(e as Error).message.split('\n')[0] ?? ''}`);
  }
}

/**
 * Bounded-poll assertions: an expect that does not hold within its bound is an ASSERTION
 * failure (the condition was judged and found wanting), distinct from an action timeout.
 * The last observed state is part of the evidence.
 */
async function runExpect(
  page: Page,
  step: Extract<FlowStep, { do: 'expect' }>,
  base: StepOutcome,
  fail: (cls: StepFailureClass, detail: string) => StepOutcome,
  timeoutMs: number,
): Promise<StepOutcome> {
  const deadline = Date.now() + timeoutMs;
  let lastObserved = '(nothing observed)';
  const locator = (): Locator | null => (step.selector !== undefined ? page.locator(step.selector).first() : null);

  for (;;) {
    try {
      switch (step.kind) {
        case 'text': {
          const loc = locator();
          const content = loc !== null ? ((await loc.textContent({ timeout: 1_000 })) ?? '') : await page.locator('body').innerText({ timeout: 1_000 });
          lastObserved = content.slice(0, 200);
          if (step.text !== undefined && content.includes(step.text)) return base;
          break;
        }
        case 'visible':
        case 'hidden': {
          const loc = locator();
          if (loc === null) return fail('assertion', `expect ${step.kind} needs a selector`);
          const visible = await loc.isVisible();
          lastObserved = visible ? 'visible' : 'not visible';
          if ((step.kind === 'visible') === visible) return base;
          break;
        }
        case 'value': {
          const loc = locator();
          if (loc === null) return fail('assertion', 'expect value needs a selector');
          const v = await loc.inputValue({ timeout: 1_000 });
          lastObserved = v.slice(0, 200);
          if (v === (step.text ?? '')) return base;
          break;
        }
        case 'url': {
          const u = page.url();
          lastObserved = u;
          if (step.text !== undefined && u.includes(step.text)) return base;
          break;
        }
        case 'count': {
          const loc = step.selector !== undefined ? page.locator(step.selector) : null;
          if (loc === null) return fail('assertion', 'expect count needs a selector');
          const c = await loc.count();
          lastObserved = `count=${String(c)}`;
          if (c === (step.count ?? -1)) return base;
          break;
        }
      }
    } catch (e) {
      if (Date.now() >= deadline) {
        return fail('assertion', `expect ${describeStep(step)}: probe failed at the deadline (${(e as Error).message.split('\n')[0] ?? ''})`);
      }
    }
    if (Date.now() >= deadline) {
      return fail('assertion', `expect ${describeStep(step)} did not hold within ${String(timeoutMs)}ms; last observed: ${lastObserved}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
