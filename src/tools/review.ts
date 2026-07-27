import { z } from 'zod';
import { foldReview } from '../review/ledger.js';
import type { PlanGraph } from '../plan/schema.js';
import type { SessionEvent, Tool, ToolResult } from '../types.js';

/**
 * review — the parent's triage surface over recorded findings (Session 14). Every action only
 * WRITES EVIDENCE (`review.triage`); the fold derives what it is worth. Like `recover`, the
 * tool declares no command/mutation/delegation/plan facts, so it classifies as observe — a
 * triage confers no authority, and clearing a finding changes nothing on disk.
 *
 * Refusals happen at the CALL where possible (unknown finding, severity-invalid accept,
 * unverifiable address refs) so the log stays clean and the model gets a revision loop; the
 * fold re-derives the same rules anyway (defense in depth — events are the contract, and a
 * future writer must not be able to launder a critical through a malformed triage).
 */

const ReviewInput = z
  .object({
    finding: z
      .string()
      .min(3)
      .max(80)
      .describe('The findingId to triage (childSessionId#ordinal — shown in the review round digest and /review)'),
    action: z.enum(['verify', 'refute', 'accept', 'address']).describe(
      'verify = you confirmed it real in the code (it KEEPS blocking until addressed); ' +
        'refute = you checked and it is not real (recorded verbatim as an UNVERIFIED model claim); ' +
        'accept = record a medium/low finding as a known limitation (acceptance caveat); ' +
        'address = the fix landed — cite the evidence refs',
    ),
    evidence: z
      .string()
      .min(20)
      .max(600)
      .describe('What you actually checked, file:line — recorded VERBATIM. For refute: why the scenario cannot happen.'),
    refs: z
      .array(z.string().min(1).max(120))
      .max(8)
      .optional()
      .describe('address only: callIds of the mutating/apply calls and/or passing check recipeIds that contain and prove the fix'),
  })
  .strict();
export type ReviewInputT = z.infer<typeof ReviewInput>;

export interface ReviewToolDeps {
  /** The live session events (read fresh per call; the triage event lands through reportReview). */
  events: () => readonly SessionEvent[];
  /** The APPROVED-AND-CURRENT plan graph, when one exists — the fold derives the requirement
   *  from it. The caller filters (assembly): /review, /accept and this tool must agree. */
  planGraph: () => PlanGraph | null;
}

function fail(error: string, output: string, startedAt: number): ToolResult {
  return { ok: false, output, error, durationMs: Math.max(0, Date.now() - startedAt), truncated: false };
}

export function createReviewTool(deps: ReviewToolDeps): Tool<ReviewInputT> {
  return {
    name: 'review',
    description:
      'Triage ONE recorded review finding: verify (confirmed real — still blocks until addressed), refute ' +
      '(checked, not real — your evidence is recorded verbatim and labeled an unverified model claim), accept ' +
      '(medium/low only — a recorded limitation), or address (the fix landed — cite the mutating callIds or ' +
      'passing check recipeIds). Verify load-bearing findings against the ACTUAL code yourself before triaging; ' +
      'never refute from memory. Open critical/high findings block /accept until triaged (or the user records ' +
      '/accept confirm).',
    schema: ReviewInput,
    mutates: () => ({ paths: [] }),

    async execute(input, ctx): Promise<ToolResult> {
      const startedAt = Date.now();
      const before = foldReview(deps.planGraph(), deps.events());
      const st = before.findings.find((f) => f.finding.findingId === input.finding);
      if (st === undefined) {
        const known = before.findings.map((f) => f.finding.findingId);
        return fail(
          `unknown finding '${input.finding}'`,
          known.length > 0
            ? `recorded findings in this session: ${known.join(', ')} (see /review). Triage records evidence about a RECORDED finding — it cannot create one.`
            : 'no findings are recorded in this session — a review round (delegate_task with reviewer tasks) records them via report_finding.',
          startedAt,
        );
      }
      const sev = st.finding.severity;
      if (input.action === 'accept' && (sev === 'critical' || sev === 'high')) {
        return fail(
          `'accept' is invalid for a ${sev} finding`,
          `${st.finding.findingId} (${sev}) '${st.finding.title}' cannot be recorded as an accepted limitation: critical/high findings ` +
            'block acceptance until refuted with evidence or addressed with a cited fix. If it genuinely must ship, the USER records ' +
            'that decision with /accept confirm — that consent is not yours to give.',
          startedAt,
        );
      }
      if (input.action === 'address') {
        const refs = input.refs ?? [];
        if (refs.length === 0) {
          return fail(
            "'address' requires refs",
            'Cite WHERE the fix lives: the callId(s) of the mutating or apply calls, and/or the recipeId of a passing check that proves it.',
            startedAt,
          );
        }
        // The same existence AND ordering rules the fold applies (they must never disagree) —
        // refused here so a malformed triage never lands on the log at all.
        const events = deps.events();
        const refSeqs = new Map<string, number>();
        const noteRef = (key: string, seq: number): void => {
          refSeqs.set(key, Math.max(refSeqs.get(key) ?? 0, seq));
        };
        let anchor = 0;
        for (const e of events) {
          if (e.type === 'file.mutated' || (e.type === 'task.applied' && e.applied.length > 0)) noteRef(e.callId, e.seq);
          else if (e.type === 'check.completed' && e.status === 'pass') {
            noteRef(e.callId, e.seq);
            noteRef(e.recipeId, e.seq);
          } else if (e.type === 'review.findings' && e.findings.some((f) => f.findingId === input.finding)) {
            anchor = e.seq;
          }
        }
        const missing = refs.filter((r) => !refSeqs.has(r));
        if (missing.length > 0) {
          return fail(
            `ref(s) not found in this session's evidence: ${missing.join(', ')}`,
            'An address ref must EXIST in the log: a callId that recorded file mutations / applied captures / a passing check, ' +
              'or a passing check recipeId. The fix must be recorded evidence before it can clear a finding.',
            startedAt,
          );
        }
        const stale = refs.filter((r) => (refSeqs.get(r) ?? 0) < anchor);
        if (stale.length > 0) {
          return fail(
            `ref(s) predate the finding: ${stale.join(', ')}`,
            'An address ref must POSTDATE the finding it claims to fix — a check that passed before the review ran, or the very ' +
              'change the finding criticizes, is not evidence of a fix. Make the change, re-run the check that proves it, then cite those.',
            startedAt,
          );
        }
      }

      ctx.reportReview?.({
        kind: 'triage',
        findingId: input.finding,
        action: input.action,
        evidence: input.evidence,
        ...(input.refs !== undefined && input.refs.length > 0 ? { refs: input.refs } : {}),
      });

      // Post-state from the LIVE log (the triage event is already appended).
      const after = foldReview(deps.planGraph(), deps.events());
      const now = after.findings.find((f) => f.finding.findingId === input.finding);
      const statusLine = `finding ${input.finding} (${sev}) is now ${now?.status ?? 'unknown'}${now?.blocking === true ? ' — STILL BLOCKING' : ''}`;
      const blockers = after.openBlockers.length;
      return {
        ok: true,
        output: [
          statusLine,
          ...(input.action === 'refute'
            ? ['Your refutation is recorded VERBATIM and rendered as an unverified model claim — the report shows it beside the finding for the user to audit.']
            : []),
          ...(input.action === 'verify'
            ? ['Verified findings keep blocking: confirmed-real-and-unfixed is the strongest reason to block. Address it with a cited fix, and re-run the checks that prove it.']
            : []),
          ...(input.action === 'accept' ? ['Recorded as an accepted limitation — it becomes an acceptance caveat, visible in /status, the report, and the handoff.'] : []),
          blockers === 0
            ? 'No review blockers remain.'
            : `${blockers} review blocker(s) remain:\n${after.openBlockers.map((b) => `  - ${b}`).join('\n')}`,
        ].join('\n'),
        durationMs: Math.max(0, Date.now() - startedAt),
        truncated: false,
      };
    },
  };
}
