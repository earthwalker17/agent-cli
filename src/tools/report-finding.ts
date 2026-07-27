import { z } from 'zod';
import { normalizeRelPrefix } from '../shared/pathutil.js';
import type { ReviewFinding, Tool, ToolResult } from '../types.js';

/**
 * report_finding (Session 14) — the reviewer child's ONLY findings channel. Findings become
 * TYPED AT THE SOURCE: each call is zod-validated here (a malformed finding is refused back
 * into the child's own revision loop — the update_plan precedent), accumulates in a PER-TASK
 * closure the delegate constructs for each reviewer child, and reaches the parent log as one
 * `review.findings` capture at task end. The review gate reads only those records; reviewer
 * prose remains narration.
 *
 * Policy shape: no command/delegates/planDoc/check/browser/evidenceRead facts and an empty
 * mutation plan → observe/auto-allow (the `recover` precedent: recording evidence confers no
 * authority and spawns nothing). Pinned by test.
 *
 * findingIds are assigned at CAPTURE (`${childSessionId}#${ordinal}`), not here — the child
 * session id does not exist yet when the delegate constructs the instance.
 */

export const MAX_FINDINGS_PER_REVIEWER = 8;

const FindingInput = z
  .object({
    severity: z.enum(['critical', 'high', 'medium', 'low']).describe('critical/high BLOCK acceptance until triaged by the parent'),
    title: z.string().min(8).max(120).describe('One-line defect statement (what breaks), not a vague theme'),
    paths: z
      .array(z.string().min(1).max(260))
      .min(1)
      .max(8)
      .describe('Workspace-relative paths the finding affects (file or directory prefixes)'),
    evidence: z
      .string()
      .min(20)
      .max(600)
      .describe('What you ACTUALLY inspected — file:line references and the observed code/state. Never report from the diff alone.'),
    scenario: z.string().min(10).max(600).describe('The concrete failure: inputs/state → wrong outcome'),
    confidence: z.enum(['high', 'medium', 'low']),
    reproduction: z.string().max(600).optional().describe('How the parent can reproduce or verify it (commands, steps, a check kind)'),
  })
  .strict();
type FindingInputT = z.infer<typeof FindingInput>;

/** The per-task accumulator: the delegate holds it and captures at task end (any child status). */
export interface FindingAccumulator {
  items: Omit<ReviewFinding, 'findingId'>[];
}

export function createFindingAccumulator(): FindingAccumulator {
  return { items: [] };
}

export function createReportFindingTool(acc: FindingAccumulator): Tool<FindingInputT> {
  return {
    name: 'report_finding',
    description:
      'Record ONE review finding (typed, bounded). Recorded findings are the ONLY input the review gate reads — ' +
      'anything only in your prose report does not exist for the gate. Ground every finding in code you actually ' +
      'inspected; an honest "no findings" (recording nothing) beats an invented one. Budget: ' +
      `${MAX_FINDINGS_PER_REVIEWER} findings per review task — consolidate variants of one defect.`,
    schema: FindingInput,
    mutates: () => ({ paths: [] }),
    async execute(input): Promise<ToolResult> {
      const done = (ok: boolean, output: string, error?: string): ToolResult => ({
        ok,
        output,
        durationMs: 0,
        truncated: false,
        ...(error !== undefined ? { error } : {}),
      });
      if (acc.items.length >= MAX_FINDINGS_PER_REVIEWER) {
        return done(
          false,
          '',
          `finding budget exhausted (${MAX_FINDINGS_PER_REVIEWER} recorded): consolidate related findings instead — ` +
            'raise remaining observations as lower-severity notes in your final report prose',
        );
      }
      // Paths are later rendered, joined against plan touches, and read by humans — validate
      // them with the same containment rule as plan touches (never disk-probed).
      const paths: string[] = [];
      for (const raw of input.paths) {
        const norm = normalizeRelPrefix(raw);
        if (norm === null) {
          return done(false, '', `path '${raw}' is not a contained workspace-relative prefix — name the file as it appears in the repository`);
        }
        if (!paths.includes(norm)) paths.push(norm);
      }
      acc.items.push({
        severity: input.severity,
        title: input.title,
        paths,
        evidence: input.evidence,
        scenario: input.scenario,
        confidence: input.confidence,
        ...(input.reproduction !== undefined ? { reproduction: input.reproduction } : {}),
      });
      return done(
        true,
        `finding ${acc.items.length} recorded (${input.severity}): ${input.title} — ${MAX_FINDINGS_PER_REVIEWER - acc.items.length} slot(s) remain`,
      );
    },
  };
}
