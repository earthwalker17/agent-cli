import { z } from 'zod';
import { sha256 } from '../shared/hash.js';
import { normalizeRelPrefix } from '../shared/pathutil.js';
import { classifyFailure, latestFailureEvidence } from '../recovery/classify.js';
import { foldRepairs } from '../recovery/ledger.js';
import { evaluateRepair, MAX_REPAIR_ATTEMPTS } from '../recovery/policy.js';
import { renderRecoveryGuidance } from '../recovery/catalogue.js';
import type { PlanGraph } from '../plan/schema.js';
import type { CheckKind, SessionEvent, Tool, ToolResult } from '../types.js';

/**
 * recover — the bounded repair ledger (Session 12). Two actions, both of which only WRITE
 * EVIDENCE: `attempt` records a classified failure with the hypothesis and scope being tried, and
 * `escalate` records an honest stop. Neither grants authority — an executor spawn still asks every
 * time, and every file change still goes through the same snapshot-backed tools.
 *
 * Why there is no `start`/`end` pair and no checkpoint creation here: the recovery POINT already
 * exists in both paths (parent edits are snapshot-backed by construction; an executor re-run
 * creates a fresh group base checkpoint), and an attempt's outcome is DERIVED from what happened
 * after it. Adding a second recovery mechanism and an end event would create crash windows to buy
 * nothing.
 *
 * Policy: this tool declares no command, no mutation, no delegation, and no plan-document write —
 * it appends events, exactly as every tool's evidence channel does — so it classifies as observe.
 * That is honest precisely because recording a repair plan confers no new permission.
 */

const KIND_VALUES = ['build', 'test', 'test-targeted', 'typecheck', 'lint', 'format', 'static-analysis', 'browser'] as const;
const _kindsAreCheckKinds: readonly CheckKind[] = KIND_VALUES;
void _kindsAreCheckKinds;

const RecoverInput = z
  .object({
    action: z
      .enum(['attempt', 'escalate'])
      .describe('attempt = record a bounded repair plan for a classified failure; escalate = stop honestly and hand it to the user'),
    target: z
      .string()
      .min(1)
      .max(41)
      .describe("The plan task id being repaired, or 'session' for work outside the task graph."),
    hypothesis: z
      .string()
      .min(20)
      .max(600)
      .optional()
      .describe('attempt: what you believe is wrong and why this change should fix it. Recorded verbatim as evidence.'),
    scope_paths: z
      .array(z.string().min(1).max(260))
      .max(16)
      .optional()
      .describe('attempt: workspace-relative prefixes this repair may touch. Changes outside them stop the repair.'),
    regression_checks: z
      .array(z.enum(KIND_VALUES))
      .min(1)
      .max(4)
      .optional()
      .describe('attempt: the typed checks that will PROVE the repair worked.'),
    reason: z.string().min(10).max(600).optional().describe('escalate: what you tried, what is blocking, and what the user must decide.'),
  })
  .strict();
export type RecoverInputT = z.infer<typeof RecoverInput>;

export interface RecoverDeps {
  /** The live session events (the log instance is live; read fresh per call). */
  events: () => readonly SessionEvent[];
  /** The approved plan graph, when one exists — supplies each task's touches as extra scope. */
  planGraph: () => PlanGraph | null;
}

function fail(error: string, output: string, startedAt: number): ToolResult {
  return { ok: false, output, error, durationMs: Math.max(0, Date.now() - startedAt), truncated: false };
}

export function createRecoverTool(deps: RecoverDeps): Tool<RecoverInputT> {
  const foldOpts = (): { extraScope: (target: string) => readonly string[] } => {
    const graph = deps.planGraph();
    return {
      extraScope: (target: string) => graph?.tasks.find((t) => t.id === target)?.touches ?? [],
    };
  };

  return {
    name: 'recover',
    description:
      'Record a BOUNDED repair plan for a classified failure, or escalate honestly when repair is not appropriate. ' +
      'The harness classifies the failure itself from recorded evidence (it does not take your word for the class), ' +
      'checks eligibility against the recovery catalogue and the repair budgets, and returns the catalogue guidance ' +
      'for that class. Use action="attempt" BEFORE making repair edits or re-running a failed task: classification ' +
      'comes before repair planning, and the scheduler refuses a second retry of a failed task without one. Use ' +
      'action="escalate" when the class is not automatically repairable, the budgets are spent, or you do not know ' +
      'what is wrong — an honest stop is a result, and looping is not.',
    schema: RecoverInput,
    mutates: () => ({ paths: [] }),

    async execute(input, ctx): Promise<ToolResult> {
      const startedAt = Date.now();
      const events = deps.events();
      const target = input.target;
      const evidence = latestFailureEvidence(events, target === 'session' ? undefined : target);
      if (evidence === null) {
        return fail(
          'no recorded failure to recover from',
          `no failing check, failed delegated task, or refused integration is recorded for '${target}'. ` +
            'Recovery works from EVIDENCE: run the relevant check with run_check first, or name the plan task that actually failed.',
          startedAt,
        );
      }
      const classification = classifyFailure(evidence);
      const ledger = foldRepairs(events, foldOpts());

      if (input.action === 'escalate') {
        if (input.reason === undefined) {
          return fail('escalate requires a reason', 'Provide `reason`: what you tried, what is blocking, and what the user must decide.', startedAt);
        }
        ctx.reportRepair?.({
          kind: 'escalated',
          target,
          failureClass: classification.class,
          signature: classification.signature,
          reason: input.reason,
        });
        return {
          ok: true,
          output: [
            `escalated: ${target} — ${classification.class} (${classification.detail})`,
            'Recorded as an unresolved blocker: it appears in /status, the report, and the session handoff, and it prevents accepting the session as complete.',
            target === 'session'
              ? 'It clears only if a later repair attempt for this same failure is recorded and proven. Otherwise it stands for the rest of the session, and the user can still record a partial acceptance with /accept confirm.'
              : `It clears by EVIDENCE: once plan task '${target}' is completed with its declared check gate satisfied, the blocker resolves itself. The user can also record a partial acceptance with /accept confirm.`,
            'Tell the user plainly what is blocked and what you need from them. Do not keep retrying.',
          ].join('\n'),
          durationMs: Math.max(0, Date.now() - startedAt),
          truncated: false,
        };
      }

      // action === 'attempt'
      if (input.hypothesis === undefined || input.regression_checks === undefined) {
        return fail(
          'attempt requires a hypothesis and regression_checks',
          'A repair attempt must state WHAT you think is wrong (hypothesis) and WHAT WILL PROVE the fix (regression_checks). ' +
            'Without a declared proof the repair can never close — that is the definition of a loop.',
          startedAt,
        );
      }
      // The proof must cover the thing that actually failed. Without this, a repair could be
      // "proven" by a green check unrelated to the failure — and, worse, that bogus success is
      // what clears an escalation.
      if (evidence.source === 'check' && !input.regression_checks.includes(evidence.check)) {
        return fail(
          `regression_checks must include '${evidence.check}'`,
          `The failure being repaired is a ${evidence.check} check. A repair is proven by re-running WHAT FAILED — ` +
            `declaring only ${input.regression_checks.join(', ')} would let an unrelated green check close this repair. ` +
            `Include '${evidence.check}'.`,
          startedAt,
        );
      }
      const hypothesisSha = sha256(input.hypothesis.trim().toLowerCase().replace(/\s+/g, ' '));
      const verdict = evaluateRepair({ classification, failureSeq: evidence.seq, ledger, hypothesisSha });
      if (!verdict.eligible) {
        return fail(
          `repair refused: ${verdict.stop!.reason}`,
          [
            `failure: ${classification.class} — ${classification.detail}`,
            `signals: ${classification.signals.join(', ') || '(none)'}`,
            `REFUSED (${verdict.stop!.reason}): ${verdict.stop!.detail}`,
            '',
            renderRecoveryGuidance(classification.class, { includeStops: true }),
            '',
            `Escape hatches: recover with action="escalate" (records an honest stop), revise the task with update_plan (a materially different definition resets the retry ceiling and requires re-approval), do the work directly, or ask the user how to proceed.`,
          ].join('\n'),
          startedAt,
        );
      }

      const scope: string[] = [];
      const rejected: string[] = [];
      for (const raw of input.scope_paths ?? []) {
        const norm = normalizeRelPrefix(raw);
        if (norm === null) rejected.push(raw.slice(0, 60));
        else if (!scope.includes(norm)) scope.push(norm);
      }
      scope.sort();

      const attempt = verdict.attemptsUsed + 1;
      ctx.reportRepair?.({
        kind: 'attempted',
        target,
        failureClass: classification.class,
        signature: classification.signature,
        hypothesis: input.hypothesis,
        hypothesisSha,
        scopePaths: scope,
        regressionChecks: [...input.regression_checks],
        attempt,
      });

      return {
        ok: true,
        output: [
          `repair attempt ${attempt}/${MAX_REPAIR_ATTEMPTS} recorded for '${target}'`,
          `classified: ${classification.class} (confidence ${classification.confidence}) — ${classification.detail}`,
          `signals: ${classification.signals.join(', ') || '(none)'}`,
          `scope: ${scope.length > 0 ? scope.join(', ') : '(none declared — declare one; an expanding diff is a stopping condition)'}`,
          ...(rejected.length > 0 ? [`scope path(s) refused as not contained workspace-relative prefixes: ${rejected.join(', ')}`] : []),
          `prove it with: run_check ${input.regression_checks.join(', ')} — until every one passes, this repair stays UNPROVEN and blocks acceptance`,
          '',
          renderRecoveryGuidance(classification.class),
          '',
          'Bounds the harness ENFORCES: attempt count, in-session wall time, and the session/token budgets. ' +
            (scope.length > 0
              ? 'Scope is MEASURED, not prevented: a change outside the declared scope stops the NEXT attempt, it does not block the write.'
              : 'You declared no scope, so an expanding diff CANNOT be detected for this attempt — declare scope_paths next time.') +
            ' Whether your next hypothesis is genuinely a different idea is YOUR judgement — it is recorded verbatim for review, not verified.',
        ].join('\n'),
        durationMs: Math.max(0, Date.now() - startedAt),
        truncated: false,
      };
    },
  };
}
