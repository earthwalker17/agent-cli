import { z } from 'zod';
import { normalizeRelPrefix } from '../shared/pathutil.js';
import { sanitizeLine } from '../shared/text.js';
import type { InspectionObservation, Tool, ToolResult } from '../types.js';

/**
 * report_observation (Session 21.5) — the `@review` inspector child's ONLY findings channel, and
 * the deliberate twin of `report_finding` rather than a reuse of it.
 *
 * The two differ in exactly one thing that matters: what reads them. A `ReviewFinding` is consumed
 * by the adversarial review gate — critical/high items block `/accept` regardless of whether a
 * review was required, they never expire, and the round that produced them spends one of only two
 * `MAX_REVIEW_ROUNDS`. That is correct for an end-of-session gate and wrong for a user who typed
 * `@review` to ask "does this look right?". An observation is advice: recorded as evidence,
 * rendered in the report, handed to the parent to act on, and read by no gate.
 *
 * Everything else follows `report_finding`'s discipline exactly, because those parts were right:
 * typed at the source so a malformed observation is refused back into the child's own revision
 * loop; paths validated as IDENTIFIERS (a path sanitization would alter is refused, not escaped —
 * a newline inside "a path" is spoofing); prose neutralized at ingestion, because these strings
 * are later rendered into harness-attributed lines where a forged `[harness]` prefix would read as
 * provenance.
 *
 * Policy shape: no facts and an empty mutation plan → observe/auto-allow. Recording evidence
 * confers no authority and spawns nothing. Pinned by test.
 *
 * observationIds are assigned at CAPTURE (`${childSessionId}#${ordinal}`), not here — the child
 * session id does not exist yet when the delegate constructs the instance.
 */

export const MAX_OBSERVATIONS_PER_INSPECTOR = 10;

const ObservationInput = z
  .object({
    kind: z
      .enum(['bug', 'regression-risk', 'architecture', 'weak-spot', 'debug-lead'])
      .describe('bug = it is wrong now · regression-risk = it will break under change · architecture = a structural problem · weak-spot = fragile but working · debug-lead = a concrete next step for an open failure'),
    severity: z
      .enum(['critical', 'high', 'medium', 'low'])
      .describe('How much it matters. NOTHING here blocks acceptance — this is advice, not a gate.'),
    title: z.string().min(8).max(120).describe('One-line statement of the problem, not a vague theme'),
    paths: z
      .array(z.string().min(1).max(260))
      .min(1)
      .max(8)
      .describe('Workspace-relative paths the observation affects (file or directory prefixes)'),
    evidence: z
      .string()
      .min(20)
      .max(600)
      .describe('What you ACTUALLY inspected — file:line references and the observed code/state. Never report from a diff alone.'),
    scenario: z
      .string()
      .min(10)
      .max(600)
      .describe('The concrete failure or risk: inputs/state → wrong outcome, or why this bites later'),
    confidence: z.enum(['high', 'medium', 'low']),
    suggestion: z
      .string()
      .max(600)
      .optional()
      .describe('What the PARENT should do to confirm or fix it. You cannot change anything yourself.'),
  })
  .strict();
type ObservationInputT = z.infer<typeof ObservationInput>;

/** The per-task accumulator: the delegate holds it and captures at task end (any child status). */
export interface ObservationAccumulator {
  items: Omit<InspectionObservation, 'observationId'>[];
}

export function createObservationAccumulator(): ObservationAccumulator {
  return { items: [] };
}

export function createReportObservationTool(acc: ObservationAccumulator): Tool<ObservationInputT> {
  return {
    name: 'report_observation',
    description:
      'Record ONE inspection observation (typed, bounded). Recorded observations are the ONLY thing that reaches ' +
      'the parent as evidence — anything left in your prose is narration and will be treated as such. Ground every ' +
      'observation in code you actually read; an honest "nothing found" (recording nothing) is a real and useful ' +
      'answer. These do NOT block acceptance and do NOT count as an adversarial review round. Budget: ' +
      `${MAX_OBSERVATIONS_PER_INSPECTOR} per inspection — consolidate variants of one problem.`,
    schema: ObservationInput,
    mutates: () => ({ paths: [] }),
    async execute(input): Promise<ToolResult> {
      const done = (ok: boolean, output: string, error?: string): ToolResult => ({
        ok,
        output,
        durationMs: 0,
        truncated: false,
        ...(error !== undefined ? { error } : {}),
      });
      if (acc.items.length >= MAX_OBSERVATIONS_PER_INSPECTOR) {
        return done(
          false,
          '',
          `observation budget exhausted (${MAX_OBSERVATIONS_PER_INSPECTOR} recorded): consolidate related items instead — ` +
            'raise anything remaining as lower-severity notes in your final report prose',
        );
      }
      const paths: string[] = [];
      for (const raw of input.paths) {
        const norm = normalizeRelPrefix(raw);
        if (norm === null) {
          return done(false, '', `path '${sanitizeLine(raw)}' is not a contained workspace-relative prefix — name the file as it appears in the repository`);
        }
        if (sanitizeLine(norm) !== norm) {
          return done(false, '', `path '${sanitizeLine(raw)}' contains control or spoofing characters — name the file as it appears in the repository`);
        }
        if (!paths.includes(norm)) paths.push(norm);
      }
      acc.items.push({
        kind: input.kind,
        severity: input.severity,
        title: sanitizeLine(input.title),
        paths,
        evidence: sanitizeLine(input.evidence),
        scenario: sanitizeLine(input.scenario),
        confidence: input.confidence,
        ...(input.suggestion !== undefined ? { suggestion: sanitizeLine(input.suggestion) } : {}),
      });
      return done(
        true,
        `observation ${acc.items.length} recorded (${input.kind}, ${input.severity}): ${input.title} — ` +
          `${MAX_OBSERVATIONS_PER_INSPECTOR - acc.items.length} slot(s) remain`,
      );
    },
  };
}
