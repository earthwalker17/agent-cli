import { z } from 'zod';

/**
 * The browser flow specification (Session 13) — a DECLARED, bounded, typed program the harness
 * executes deterministically against a managed preview. The model declares intent (routes,
 * actions, assertions, screenshot points); the harness owns execution, waits, and the failure
 * taxonomy. Readiness honesty is structural:
 *
 * - every `goto` REQUIRES `ready_when` — a load event, networkidle, or a spinner disappearing
 *   is never accepted as readiness; the model must name application-meaningful state;
 * - `expect`/`screenshot` steps may not precede the first `goto` (schema-checked), and steps
 *   run strictly in order, each only after every prior step succeeded — so an assertion or
 *   screenshot can never observe a page that was not declared ready.
 */

/** Bounded per-step wait; the flow also has a wall clock. */
const STEP_TIMEOUT = z.number().int().min(100).max(15_000);
const SELECTOR = z.string().min(1).max(300);
const TEXT = z.string().min(1).max(300);
/** Workspace-app routes only: RELATIVE paths, origin-locked to the preview by construction. */
const ROUTE = z.string().min(1).max(500).regex(/^\//, 'route must be a relative path starting with /');

const ReadyWhen = z
  .object({
    selector: SELECTOR.optional().describe('CSS selector that must be VISIBLE for the page to count as ready'),
    text: TEXT.optional().describe('Text that must be visible for the page to count as ready'),
    timeout_ms: STEP_TIMEOUT.optional(),
  })
  .strict()
  .refine((r) => r.selector !== undefined || r.text !== undefined, {
    message: 'ready_when needs a selector or text — a bare page load is never readiness',
  });

export const FlowStepSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('goto'), path: ROUTE, ready_when: ReadyWhen }).strict(),
  z
    .object({ do: z.literal('click'), selector: SELECTOR.optional(), text: TEXT.optional(), timeout_ms: STEP_TIMEOUT.optional() })
    .strict()
    .refine((s) => s.selector !== undefined || s.text !== undefined, { message: 'click needs a selector or text' }),
  z.object({ do: z.literal('fill'), selector: SELECTOR, value: z.string().max(2000), timeout_ms: STEP_TIMEOUT.optional() }).strict(),
  z.object({ do: z.literal('select'), selector: SELECTOR, value: z.string().max(300), timeout_ms: STEP_TIMEOUT.optional() }).strict(),
  z.object({ do: z.literal('press'), key: z.string().min(1).max(40), selector: SELECTOR.optional(), timeout_ms: STEP_TIMEOUT.optional() }).strict(),
  z
    .object({
      do: z.literal('wait_for'),
      selector: SELECTOR.optional(),
      text: TEXT.optional(),
      state: z.enum(['visible', 'hidden']).optional(),
      timeout_ms: STEP_TIMEOUT.optional(),
    })
    .strict()
    .refine((s) => s.selector !== undefined || s.text !== undefined, { message: 'wait_for needs a selector or text' }),
  z
    .object({
      do: z.literal('expect'),
      kind: z.enum(['text', 'visible', 'hidden', 'value', 'url', 'count']),
      selector: SELECTOR.optional(),
      text: TEXT.optional().describe('expected text (kind text), value (kind value), or url substring (kind url)'),
      count: z.number().int().min(0).max(10_000).optional(),
      timeout_ms: STEP_TIMEOUT.optional(),
    })
    .strict(),
  z.object({ do: z.literal('screenshot'), label: z.string().min(1).max(60), full_page: z.boolean().optional() }).strict(),
]);
export type FlowStep = z.infer<typeof FlowStepSchema>;

export const FlowSpecSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'flow name must be a slug')
      .describe('Names this flow in evidence and gates.'),
    preview_id: z.string().max(64).optional().describe('Which running preview to drive (defaults to the only ready one).'),
    fail_on_console_error: z
      .boolean()
      .optional()
      .describe('Treat console.error output as a failing signal (default: recorded as findings only).'),
    steps: z.array(FlowStepSchema).min(1).max(20),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const firstGoto = spec.steps.findIndex((s) => s.do === 'goto');
    if (firstGoto === -1) {
      ctx.addIssue({ code: 'custom', message: 'a flow needs at least one goto step (with ready_when)' });
      return;
    }
    for (let i = 0; i < firstGoto; i++) {
      const s = spec.steps[i]!;
      if (s.do === 'expect' || s.do === 'screenshot') {
        ctx.addIssue({
          code: 'custom',
          message: `step ${i + 1} (${s.do}) precedes the first goto — nothing is loaded, let alone ready, to ${s.do} against`,
        });
      }
    }
    const screenshots = spec.steps.filter((s) => s.do === 'screenshot').length;
    if (screenshots > 4) ctx.addIssue({ code: 'custom', message: `at most 4 screenshots per flow (declared: ${screenshots})` });
  });
export type FlowSpec = z.infer<typeof FlowSpecSchema>;

/** The typed step-failure taxonomy — what recovery classification keys on. */
export type StepFailureClass = 'timeout' | 'navigation' | 'assertion' | 'runtime' | 'protocol';

export interface StepOutcome {
  n: number;
  kind: FlowStep['do'];
  target: string;
  ok: boolean;
  failure?: { class: StepFailureClass; detail: string };
}

export interface FlowArtifact {
  kind: 'screenshot' | 'trace';
  bytes: Buffer;
  label: string;
  mediaType: string;
}

export interface FlowRunResult {
  /** pass = every step ok AND no uncaught page error; fail = app misbehavior; error = the
   *  harness/browser/preview failed before the app could be judged. */
  status: 'pass' | 'fail' | 'error';
  steps: StepOutcome[];
  artifacts: FlowArtifact[];
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  offOriginRequests: string[];
  finalUrl: string | null;
  durationMs: number;
  /** Named signal ids for the check event (disjoint from shell-output signals by design). */
  signals: string[];
  summary: string;
}

export const DEFAULT_STEP_TIMEOUT_MS = 5_000;
/** Session 16: 60s → 90s. A flow against a cold dev server that proxies to a real API needs it. */
export const FLOW_WALL_MS = 90_000;
export const MAX_RECORDED_ERRORS = 10;
export const MAX_RECORDED_REQUESTS = 20;
