import { applyUndo } from '../runtime/undo.js';
import { buildReport } from '../report/report.js';
import { buildSessionDiff, renderSessionDiff } from '../report/diff.js';
import { runCommitFlow } from '../git/commit.js';
import { createCheckpoint, listCheckpoints, runRestoreFlow, type CheckpointContext } from '../git/checkpoint.js';
import { buildWorkspaceMapAuto } from '../workspace/map.js';
import { renderRepoMap } from '../retrieval/render.js';
import type { RetrievalHandle } from '../retrieval/rank.js';
import { readPlan, setPlanStatus } from '../plan/store.js';
import { approvedCurrentGraph, readCanonicalPlan, readPlanState, setCanonicalStatus } from '../plan/canonical.js';
import { completionGateState, foldGraphState, integrationGateState, type PlanTaskState } from '../plan/graph-state.js';
import { computeAcceptance, workSince, type AcceptanceState } from '../runtime/acceptance.js';
import { foldRepairs } from '../recovery/ledger.js';
import { foldReview, type ReviewState } from '../review/ledger.js';
import { runInit } from './init.js';
import { renderUserPlanView, writeUserView } from '../plan/views.js';
import { sanitizeLine } from '../shared/text.js';
import { CHECKS_PER_SESSION, describeWorkspace, type CheckCaps, type RunCheckTool } from '../tools/run-check.js';
import { SETUPS_PER_SESSION, type SetupCaps } from '../tools/project-setup.js';
import type { PreviewTool } from '../tools/preview.js';
import type { ResearchBudget } from '../tools/research-budget.js';
import type { RemoteState } from '../tools/remote-state.js';
import { describeRelation } from '../remote/observe.js';
import type { SessionEvent } from '../types.js';
import { loadPreviewRegistry, previewsFile } from '../preview/registry.js';
import { likelyBrowserAvailable } from '../browser/probe.js';
import {
  CATALOG_VERIFIED,
  capsFor,
  contextBudgetFor,
  defaultMaxTokensFor,
  modelsFor,
  providersOfModel,
  type ProviderName,
} from '../provider/catalog.js';
import { resolveProviderName, type ProviderRegistry } from '../provider/registry.js';
import type { Session } from '../runtime/session.js';
import type { ProjectLayout } from '../store/layout.js';
import type { Renderer } from './render.js';

/**
 * Slash commands are thin adapters over existing kernel functions, run against the session's OWN
 * open EventLog (which is live — never a second EventLog.open, which would deadlock on the lock).
 */

export interface CommandContext {
  session: Session;
  layout: ProjectLayout;
  renderer: Renderer;
  modelOut: NodeJS.WritableStream;
  /** Notes to prepend (clearly delimited) to the next user message so the model learns of
   *  out-of-band changes like /undo. Logged verbatim inside user.message — attributable. */
  pendingNotes: string[];
  /** Interactive confirmation seam (the REPL's shared readline); null answer = EOF = decline. */
  question?: (q: string) => Promise<string | null>;
  /** Session 10: the assembled read-only retrieval handle; /map renders it when present. */
  retrieval?: RetrievalHandle | null;
  /** Session 11.5: /accept runs the harness-ref prune immediately (the assembled closure;
   *  kind-aware since Session 14 — the latest delivery ref survives by construction). */
  pruneHarnessRefs?: () => Promise<string | null>;
  /** Session 12: the typed-check tool instance; /checks renders its (refreshed) project snapshot. */
  checkTool?: RunCheckTool;
  /** Session 12: the events-rebuilt check counters, for the /checks budget line. */
  checkCaps?: CheckCaps;
  /** Session 16: the events-rebuilt project-setup counter, for the /checks budget line. */
  setupCaps?: SetupCaps;
  /** Session 13: the managed-preview tool instance; /preview lists and stops its live handles. */
  previewTool?: PreviewTool;
  /** Session 19: the live session research budget; /research renders spend, remaining, and sources. */
  researchBudget?: ResearchBudget;
  /** Session 19: why research is unavailable this session (absent = available). */
  researchUnavailable?: string;
  /** Session 20: the live remote-delivery state; /remote renders identity, allowance, observations. */
  remoteState?: RemoteState;
  /** Session 20: why remote delivery is unavailable this session (absent = available). */
  remoteUnavailable?: string;
  /** Session 15: the provider registry (env-only key discovery, bounded validation, construction)
   *  — the /provider and /model switching seam. Absent = switching unavailable in this context. */
  registry?: ProviderRegistry;
}

export const HELP = [
  'commands:',
  '  /help           this help',
  '  /status         session, model, workspace, token usage',
  '  /provider [name [model]]',
  '                  list providers (key env NAMES + presence, defaults) or switch provider —',
  '                  credentials are env-only; a switch validates the key (bounded) and records',
  '                  provider.changed evidence. Between turns only.',
  '  /model [id]     list the current provider\'s model catalog (capabilities, lifecycle) or',
  '                  switch models within the provider. Between turns only.',
  '  /undo [all]     revert the last (or all) file-tool change(s) of this session',
  '  /diff           show what this session changed (unified diff vs the session pre-images)',
  '  /commit [-m "msg"] [--all] [--no-trailer]',
  '                  commit session-attributed changes (or --all) after a preview + confirmation',
  '  /checkpoint [label | list | restore <n>]',
  '                  capture the workspace to a hidden git ref (recovery point; no history',
  '                  touched); restore <n> returns to a checkpoint as one undoable batch',
  '  /tasks          plan-task DAG states + delegated subagent tasks (also works MID-TURN while',
  '                  a task group runs, on a TTY)',
  '  /cancel <ref>   MID-TURN only (TTY): cancel ONE running delegated task by child-id suffix',
  '                  or plan-task id — the rest of the group and the turn continue',
  '  /plan [show | approve | discard]',
  '                  show the plan document for this session; approve it (records consent and',
  '                  unblocks planned execution) or discard it. You can also edit the file directly.',
  '  /accept [confirm]',
  '                  accept the session result (the completion boundary): verifies the plan is',
  '                  fully executed, every capture integrated, gates green, and the review gate',
  '                  satisfied; captures the DELIVERY checkpoint (a hidden ref that survives as',
  '                  the audit anchor), records the acceptance, prunes session-scoped harness',
  '                  refs, and retires a completed plan. With unfinished work, /accept lists it',
  '                  and "/accept confirm" records a partial acceptance instead.',
  '  /checks         what this project can be verified with, and the latest result per kind',
  '  /review         the structural review gate: rounds, recorded findings, triage state,',
  '                  blockers (executor plans require a recorded review round before /accept)',
  '  /repair [dismiss <n> <reason>]',
  '                  the bounded-repair ledger: attempts (outcomes derived from evidence) and',
  '                  escalations. "dismiss <n> <reason>" closes OPEN escalation n as YOUR',
  '                  decision — recorded as evidence and kept as an acceptance caveat, never',
  '                  presented as a resolution',
  '  /preview [stop <id>]',
  '                  list this session\'s managed preview servers (pid, url, uptime, log tail);',
  '                  "stop <id>" stops one — a preview otherwise runs until session end or its TTL',
  '  /research       web research this session: every query sent, the sources that answered,',
  '                  the recorded findings, and what is left of the session budget',
  '  /remote         remote delivery this session: the configured remotes, which GitHub account',
  '                  would act, live observations, every remote read, and every remote MUTATION',
  '                  (what changed, whether it verified, and whether it overwrote anything)',
  '  /init           optional onboarding: create your global AGENT.md (machine-wide user',
  '                  instructions; a few skippable questions) and, when this project has none,',
  '                  a starter project AGENT.md. Never rewrites an existing file.',
  '  /grants         the durable machine grants ("always allow" records) active in THIS session',
  '                  — list and revoke with `agent grants [revoke <id>]`',
  '  /report         print the evidence report for this session',
  '  /map            print the workspace map the model receives',
  '  /quit           end the session (Ctrl+D on an empty line also works)',
  'keys: Ctrl+C interrupts the running turn; at the idle prompt press it twice to quit.',
  'note: shell commands ask — except provably read-only ones when the OS sandbox probe passed, which auto-run INSIDE it; command effects are never undoable.',
  'note: /cancel <task> ends one child; Ctrl+C aborts the whole turn (every task included).',
  'note: @plan <request> routes a request into plan mode (plan first, no execution until approved).',
  'note: @search <question> forces one bounded web lookup; @research <question> delegates a research subagent.',
].join('\n');

export type SlashOutcome = 'continue' | 'quit';

/** One derivation for /accept, /status, and the quit summary: plan state + the acceptance fold. */
export function sessionAcceptance(ctx: Pick<CommandContext, 'session' | 'layout'>): {
  state: ReturnType<typeof readPlanState>;
  acc: AcceptanceState;
} {
  const events = ctx.session.log.events;
  const state = readPlanState(ctx.layout, ctx.session.id, events);
  const graph = state.canonical?.graph ?? null;
  return { state, acc: computeAcceptance(state, graph !== null ? foldGraphState(graph, events) : null, events) };
}

/** One derivation for /review and the /status review line — the acceptance axis's exact fold
 *  (the requirement derives only from an APPROVED plan, same as computeAcceptance). */
export function sessionReview(ctx: Pick<CommandContext, 'session' | 'layout'>): ReviewState {
  const events = ctx.session.log.events;
  const state = readPlanState(ctx.layout, ctx.session.id, events);
  return foldReview(approvedCurrentGraph(state), events);
}

/**
 * The plan-task targets acceptance treats as repair-resolved BY EVIDENCE (completed with a
 * satisfied gate, or parent-owned) — the same predicate computeAcceptance builds (S21 review:
 * /repair and /status previously folded without it, so an escalation acceptance had already
 * released still displayed OPEN — two surfaces, one log, opposite answers).
 */
function resolvedRepairTargets(ctx: Pick<CommandContext, 'session' | 'layout'>): Set<string> {
  const events = ctx.session.log.events;
  const state = readPlanState(ctx.layout, ctx.session.id, events);
  const g = state.canonical?.graph ?? null;
  const gs = g !== null ? foldGraphState(g, events) : null;
  return new Set(
    (gs?.tasks ?? [])
      .filter((t) => (t.state === 'completed' && t.verification.status !== 'pending') || t.state === 'parent-owned')
      .map((t) => t.id),
  );
}

/** The one-line completion summary used by /status and the quit path. */
export function completionLine(ctx: Pick<CommandContext, 'session' | 'layout'>): string {
  const { acc } = sessionAcceptance(ctx);
  const acceptedBit =
    acc.accepted !== null
      ? ` · accepted (${acc.accepted.complete ? 'complete' : 'partial'})${acc.acceptedStale ? ' — work has happened since' : ''}`
      : ' · not accepted';
  return `completion: ${acc.summary}${acceptedBit}`;
}

/** The per-task check-gate label for /tasks (Session 12); empty when nothing is declared. */
export function gateLabel(t: PlanTaskState): string {
  const v = t.verification;
  if (v.status === 'none') return '';
  if (v.status === 'green') return ` · checks green (${v.satisfied.join(', ')})`;
  if (v.status === 'waived') return ` · checks satisfied, WAIVED: ${v.waived.join(', ')} (unsupported — not proof)`;
  return ` · checks PENDING: ${v.missing.join(', ')}`;
}

/** Parse `/commit` arguments: [-m "msg"] [--all] [--no-trailer]. Exported for tests. */
export function parseCommitArgs(arg: string): { all: boolean; noTrailer: boolean; message?: string; error?: string } {
  let all = false;
  let noTrailer = false;
  let message: string | undefined;
  const tokens = arg.match(/"[^"]*"|\S+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '--all') all = true;
    else if (t === '--no-trailer') noTrailer = true;
    else if (t === '-m') {
      const rest = tokens
        .slice(i + 1)
        .join(' ')
        .replace(/^"|"$/g, '');
      if (rest.length === 0) return { all, noTrailer, error: 'usage: /commit [-m "msg"] [--all] [--no-trailer] — -m needs a message' };
      message = rest;
      break;
    } else return { all, noTrailer, error: `unknown /commit argument: ${t}` };
  }
  return { all, noTrailer, ...(message !== undefined ? { message } : {}) };
}

export async function dispatchSlash(line: string, ctx: CommandContext): Promise<SlashOutcome> {
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');

  switch ((cmd ?? '').toLowerCase()) {
    case 'help':
      ctx.renderer.chromeLine(HELP);
      return 'continue';

    case 'status': {
      const s = ctx.session;
      let inTok = 0;
      let outTok = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let reasoningTok = 0;
      let turns = 0;
      for (const e of s.log.events) {
        if (e.type === 'assistant.message') {
          inTok += e.usage.inputTokens;
          outTok += e.usage.outputTokens;
          cacheRead += e.usage.cacheReadInputTokens ?? 0;
          cacheWrite += e.usage.cacheCreationInputTokens ?? 0;
          reasoningTok += e.usage.reasoningTokens ?? 0;
        } else if (e.type === 'user.message') turns++;
      }
      // Reasoning tokens are inside outputTokens (the Usage contract); shown only when a provider reported them.
      const reasoning = reasoningTok > 0 ? ` (incl. ${reasoningTok} reasoning)` : '';
      const cache = cacheRead + cacheWrite > 0 ? ` (cache: ${cacheRead} read / ${cacheWrite} written)` : '';
      ctx.renderer.chromeLine(
        [
          `session ${s.id} (${s.mode})`,
          `  workspace: ${sanitizeLine(s.workspaceRoot)}`,
          `  model: ${s.model} · provider: ${s.provider.name}`,
          `  user messages: ${turns} · tokens: ${inTok} in / ${outTok} out${reasoning}${cache}`,
          `  ${completionLine(ctx)}`,
          ...((): string[] => {
            // The review gate at a glance (Session 14): the same fold /review and acceptance read.
            const rv = sessionReview(ctx);
            if (rv.requirement.kind === 'none' && rv.rounds.length === 0 && rv.findings.length === 0) return [];
            const blocking = rv.findings.filter((f) => f.blocking).length;
            return [
              `  review: ${rv.requirement.kind === 'required' ? `required (${rv.requirement.source})` : rv.requirement.kind} · ${rv.rounds.filter((r) => r.qualifying).length}/${rv.rounds.length} qualifying round(s) · ${rv.findings.length} finding(s)${blocking > 0 ? ` · ${blocking} BLOCKING` : ''} (${rv.satisfied ? 'satisfied' : 'blocking /accept'}; /review)`,
            ];
          })(),
          ...((): string[] => {
            // The repair ledger at a glance (S21): open escalations were previously visible only
            // through a refused /accept — the one surface a user meets AFTER deciding to finish.
            // OPEN excludes evidence-resolved targets, the same closure acceptance applies.
            const ledger = foldRepairs(ctx.session.log.events);
            if (ledger.total === 0 && ledger.escalations.length === 0) return [];
            const resolved = resolvedRepairTargets(ctx);
            const openEsc = ledger.escalations.filter((e) => e.open && !resolved.has(e.target)).length;
            const dismissed = ledger.escalations.filter((e) => e.dismissed !== null).length;
            const unproven = ledger.attempts.filter((a) => a.outcome === 'open' && a.pendingChecks.length > 0).length;
            return [
              `  repairs: ${ledger.total} attempt(s) · ${ledger.escalations.length} escalation(s)` +
                `${openEsc > 0 ? ` — ${openEsc} OPEN` : ''}${dismissed > 0 ? ` — ${dismissed} dismissed` : ''}` +
                `${unproven > 0 ? ` · ${unproven} unproven attempt(s)` : ''} (/repair)`,
            ];
          })(),
          ...((): string[] => {
            const alive = ctx.previewTool?.active().filter((a) => a.handle.isAlive()) ?? [];
            return alive.length > 0
              ? [`  previews: ${alive.map((a) => `${a.previewId}${a.url !== null ? ` (${a.url})` : ''}`).join(', ')} — stopped at session end`]
              : [];
          })(),
          ...(s.gitFacts?.isRepo ? [`  git (at session start): ${sanitizeLine(s.gitFacts.detail)}`] : []),
          `  state: ${sanitizeLine(s.stateDir)}`,
        ].join('\n'),
      );
      return 'continue';
    }

    case 'accept': {
      const sub = arg.trim().toLowerCase();
      if (sub !== '' && sub !== 'confirm') {
        ctx.renderer.chromeLine('usage: /accept [confirm]');
        return 'continue';
      }
      const { state, acc } = sessionAcceptance(ctx);

      // Idempotence: re-accepting with no work since the last acceptance is a no-op, never a
      // duplicate consent event (the accept's own retirement is excluded from workSince).
      if (acc.accepted !== null && !workSince(ctx.session.log.events, acc.accepted.seq)) {
        // Crash-limbo repair (review F2): a kill between the accepted event and the plan
        // retirement leaves an approved-but-accepted plan that a re-typed /accept would
        // otherwise no-op past forever. Finish the interrupted cleanup now, idempotently.
        if (acc.accepted.complete && state.kind === 'canonical' && state.status === 'approved' && state.approvedAndCurrent) {
          const w = await setCanonicalStatus(ctx.layout, ctx.session.id, 'superseded', ctx.session.snapshots, ctx.session.clock);
          if (!('error' in w)) {
            ctx.session.log.append({ type: 'plan.discarded', planId: ctx.session.id, reason: 'accepted' });
            void (await writeUserView(ctx.layout, ctx.session.id, readCanonicalPlan(ctx.layout, ctx.session.id), ctx.session.snapshots));
            ctx.renderer.chromeLine('  completing the interrupted acceptance cleanup: plan retired (accepted → superseded)');
          }
        }
        ctx.renderer.chromeLine(
          `session already accepted (${acc.accepted.complete ? 'complete' : 'partial'}); nothing has changed since`,
        );
        return 'continue';
      }

      if (!acc.complete && sub !== 'confirm') {
        ctx.renderer.chromeLine(
          [
            'cannot accept as complete — unfinished work:',
            ...acc.unfinished.map((u) => `  - ${sanitizeLine(u)}`),
            'finish the work, or type "/accept confirm" to record a PARTIAL acceptance (the list above becomes the handoff).',
          ].join('\n'),
        );
        return 'continue';
      }

      // Delivery checkpoint (Session 14) — COMPLETE path, git repo only: capture the exact
      // accepted state as a hidden ref BEFORE the consent event, so the acceptance references
      // it. The ref SURVIVES the session (the durable audit anchor — the owed-prune fold keeps
      // the latest delivery ref by construction; a later acceptance supersedes it). Best-effort
      // by contract: a failure or declined untracked sweep becomes an honest chrome line and
      // the acceptance still records — a git hiccup must never hold user consent hostage.
      let delivery: { ref: string; oid: string } | null = null;
      if (acc.complete) {
        const g = ctx.session.gitFacts;
        if (g?.isRepo === true && g.gitPath !== null && g.repoRoot !== null) {
          const cctx: CheckpointContext = { gitPath: g.gitPath, repoRoot: g.repoRoot, workspaceRoot: ctx.session.workspaceRoot, stateDir: ctx.session.stateDir };
          // Crash-window idempotence: a kill between a prior delivery checkpoint and its
          // session.accepted leaves the checkpoint recorded but unconsumed. Reuse it when
          // nothing work-shaped happened since AND the ref genuinely exists (a phantom whose
          // update-ref failed must not be referenced) — never stack a second delivery ref.
          const prior = [...ctx.session.log.events].reverse().find((e) => e.type === 'harness.checkpoint' && e.kind === 'delivery');
          const priorReusable =
            prior !== undefined && prior.type === 'harness.checkpoint' && !workSince(ctx.session.log.events, prior.seq)
              ? (await listCheckpoints(cctx, ctx.session.id)).some((c) => c.ref === prior.ref)
              : false;
          if (prior !== undefined && prior.type === 'harness.checkpoint' && priorReusable) {
            delivery = { ref: prior.ref, oid: prior.oid };
            ctx.renderer.chromeLine(`  delivery checkpoint reused (interrupted acceptance repair): ${prior.ref}`);
          } else {
            const r = await createCheckpoint(cctx, ctx.session.id, {
              label: 'delivery (accepted)',
              onRefReady: (ref, oid) => ctx.session.log.append({ type: 'harness.checkpoint', kind: 'delivery', ref, oid }),
              confirmLargeUntracked: async (count) => {
                if (!ctx.question) return false;
                const a = await ctx.question(`  capture ${count} untracked files in the delivery checkpoint too? [y/N] `);
                return a !== null && /^y(es)?$/i.test(a.trim());
              },
            });
            for (const note of r.notes ?? []) ctx.renderer.chromeLine(`  note: ${sanitizeLine(note)}`);
            if (r.ok && r.ref !== undefined && r.oid !== undefined) delivery = { ref: r.ref, oid: r.oid };
            else {
              ctx.renderer.chromeLine(
                `  delivery checkpoint not captured: ${sanitizeLine(r.error ?? 'unknown error')} (acceptance proceeds; /checkpoint is the manual path)`,
              );
            }
          }
        } else {
          ctx.renderer.chromeLine('  delivery checkpoint: not a git repository — skipped (the event log remains the audit record)');
        }
      }

      // The recorded consent. complete=false only through the explicit confirm path.
      ctx.session.log.append({
        type: 'session.accepted',
        complete: acc.complete,
        summary: acc.summary,
        ...(acc.unfinished.length > 0 ? { unfinished: acc.unfinished } : {}),
        ...(delivery !== null ? { deliveryRef: delivery.ref, deliveryOid: delivery.oid } : {}),
      });
      ctx.pendingNotes.push(
        acc.complete
          ? 'the user ACCEPTED the session result as COMPLETE (/accept). Treat the delivered work as accepted; do not re-run plan tasks.'
          : `the user recorded a PARTIAL acceptance (/accept confirm) with ${acc.unfinished.length} known unfinished item(s). Do not silently resume that work — ask before continuing it.`,
      );

      // Cleanup (a): prune this session's owed harness refs now (idempotent; the quit path's
      // re-fold then finds nothing owed — the latest delivery ref survives by construction).
      if (ctx.pruneHarnessRefs !== undefined) {
        try {
          const pruneLine = await ctx.pruneHarnessRefs();
          if (pruneLine !== null) ctx.renderer.chromeLine(`  checkpoints: ${pruneLine}`);
        } catch (e) {
          // Best-effort hygiene — acceptance itself is already recorded — but a swallowed
          // throw left ZERO trace that a prune was ever attempted (the only silent catch on
          // this surface, found by the S14.5 pre-scan). The quit path retries; the CLI backstop
          // is always available.
          ctx.renderer.chromeLine(
            `  checkpoints: prune FAILED (${sanitizeLine((e as Error).message)}) — this session's refs remain under refs/agent-cli (retried at quit; agent checkpoint prune is the backstop)`,
          );
        }
      }

      // Cleanup (b): a COMPLETE acceptance retires the fully-executed approved plan via the
      // existing discard flow (status → superseded; the file stays on disk as the audit
      // trail; approval clears via the plan.discarded event). Partial accepts retire nothing.
      if (acc.complete && state.kind === 'canonical' && state.status === 'approved' && state.approvedAndCurrent) {
        const w = await setCanonicalStatus(ctx.layout, ctx.session.id, 'superseded', ctx.session.snapshots, ctx.session.clock);
        if ('error' in w) {
          ctx.renderer.chromeLine(`  plan not retired: ${sanitizeLine(w.error)} (acceptance itself is recorded)`);
        } else {
          ctx.session.log.append({ type: 'plan.discarded', planId: ctx.session.id, reason: 'accepted' });
          void (await writeUserView(ctx.layout, ctx.session.id, readCanonicalPlan(ctx.layout, ctx.session.id), ctx.session.snapshots));
          ctx.pendingNotes.push('the fully-executed plan was RETIRED (superseded) as part of the acceptance; a new update_plan write starts a fresh draft');
          ctx.renderer.chromeLine('  plan retired (accepted → superseded; the file remains on disk for reference)');
        }
      }

      ctx.renderer.chromeLine(`session accepted (${acc.complete ? 'complete' : 'partial'}) — ${sanitizeLine(acc.summary)}`);
      if (acc.complete) {
        // The delivery boundary suggestion (Session 14): commits stay user-typed and are never
        // a side effect — this is one line of guidance, not automation.
        ctx.renderer.chromeLine(
          delivery !== null
            ? `  delivery: checkpoint ${delivery.oid.slice(0, 12)} survives as the audit anchor (agent checkpoint list) — /commit turns the accepted work into a user-visible commit (optional)`
            : '  delivery: /commit turns the accepted work into a user-visible commit (optional)',
        );
      }
      return 'continue';
    }

    case 'tasks': {
      const events = ctx.session.log.events;
      const started = events.filter((e) => e.type === 'task.started');
      // Session 11: the plan-task DAG view — a pure fold of (canonical graph, events).
      const planGraph = readPlanState(ctx.layout, ctx.session.id, events).canonical?.graph ?? null;
      const graphLines: string[] = [];
      if (planGraph !== null) {
        const gs = foldGraphState(planGraph, events);
        graphLines.push(`plan tasks (${gs.summary}):`);
        for (const t of gs.tasks) {
          graphLines.push(
            `  ${t.id} [${t.role}] ${sanitizeLine(t.title)} — ${t.state}` +
              (t.blockedOn.length > 0 ? ` (on ${t.blockedOn.join(', ')})` : '') +
              gateLabel(t) +
              (t.childSessionId !== null ? ` · child ${sanitizeLine(t.childSessionId.slice(-4))}` : '') +
              (t.attempts > 1 ? ` · attempt ${t.attempts}` : '') +
              (t.note !== undefined ? ` · ${sanitizeLine(t.note)}` : ''),
          );
        }
        const cg = completionGateState(planGraph, events);
        if (cg.required.length > 0) {
          graphLines.push(
            `  completion gate: ${cg.required.join(', ')} — ` +
              (cg.pending.length > 0
                ? `PENDING since the last change: ${cg.pending.join(', ')}`
                : cg.waived.length > 0
                  ? `satisfied, with ${cg.waived.join(', ')} waived (unsupported)`
                  : 'green'),
          );
        }
        const ig = integrationGateState(planGraph, events);
        if (ig.required.length > 0 && ig.pending.length > 0) {
          graphLines.push(`  integration gate: PENDING since the last apply: ${ig.pending.join(', ')} — a new executor wave is blocked`);
        }
      }
      if (started.length === 0 && graphLines.length === 0) {
        ctx.renderer.chromeLine('no delegated tasks in this session');
        return 'continue';
      }
      if (graphLines.length > 0) ctx.renderer.chromeLine(graphLines.join('\n'));
      if (started.length === 0) return 'continue';
      const lines = started.map((s, i) => {
        if (s.type !== 'task.started') return '';
        // Join by childSessionId: one delegate call can start a parallel GROUP (V0.7), so
        // callId alone is ambiguous across the group's task.ended events.
        const ended = events.find((e) => e.type === 'task.ended' && e.childSessionId === s.childSessionId);
        const state =
          ended !== undefined && ended.type === 'task.ended'
            ? `${ended.status} · ${ended.steps} step(s) · ${ended.usage.inputTokens} in / ${ended.usage.outputTokens} out tok`
            : 'RUNNING or CRASHED (no task.ended recorded)';
        const planRef = s.planTaskId !== undefined ? ` (plan task ${sanitizeLine(s.planTaskId)})` : '';
        return `${i + 1}. ${s.role}${planRef} ${sanitizeLine(s.childSessionId)} — ${state} — inspect: agent report ${sanitizeLine(s.childSessionId)}`;
      });
      // Children's summed usage (V0.7.1): /status stays parent-only; this is the labeled sum.
      let childIn = 0;
      let childOut = 0;
      for (const e of events) {
        if (e.type === 'task.ended') {
          childIn += e.usage.inputTokens;
          childOut += e.usage.outputTokens;
        }
      }
      lines.push(`children total: ${childIn} in / ${childOut} out tok (not part of /status session totals)`);
      ctx.renderer.chromeLine(lines.join('\n'));
      return 'continue';
    }

    case 'plan': {
      const sub = arg.trim().toLowerCase();
      const state = readPlanState(ctx.layout, ctx.session.id, ctx.session.log.events);

      // Legacy markdown plans (resumed pre-Session-11 sessions) keep the V0.7 flow verbatim.
      if (state.kind === 'legacy') {
        const plan = state.legacy!;
        if (sub === '' || sub === 'show') {
          const taskLines = plan.tasks.map((t, i) => `  ${i + 1}. ${sanitizeLine(t.title)}${t.status !== null ? ` — ${sanitizeLine(t.status)}` : ''}`);
          ctx.renderer.chromeLine(
            [
              `plan ${sanitizeLine(plan.planId)} — status: ${plan.status}${plan.truncated ? ' (display truncated)' : ''} (legacy markdown plan)`,
              `  file (editable): ${sanitizeLine(plan.file)}`,
              `  sha256: ${plan.sha256 ?? 'unreadable'} · ${plan.bytes} bytes`,
              ...(taskLines.length > 0 ? ['  tasks:', ...taskLines] : []),
            ].join('\n'),
          );
          ctx.modelOut.write(plan.text + (plan.text.endsWith('\n') ? '' : '\n'));
          return 'continue';
        }
        if (sub === 'approve') {
          if (plan.status === 'approved') {
            ctx.renderer.chromeLine('plan is already approved');
            return 'continue';
          }
          const w = await setPlanStatus(ctx.layout, ctx.session.id, 'approved', ctx.session.snapshots, ctx.session.clock);
          if ('error' in w) {
            ctx.renderer.chromeLine(`cannot approve: ${w.error}`);
            return 'continue';
          }
          ctx.session.log.append({ type: 'plan.approved', planId: ctx.session.id, sha256: w.sha256 });
          ctx.pendingNotes.push(`the user APPROVED the plan (sha256 ${w.sha256.slice(0, 12)}); planned execution may begin`);
          ctx.renderer.chromeLine(`plan approved (sha256 ${w.sha256.slice(0, 12)}…) — recorded as consent evidence`);
          return 'continue';
        }
        if (sub === 'discard') {
          const w = await setPlanStatus(ctx.layout, ctx.session.id, 'superseded', ctx.session.snapshots, ctx.session.clock);
          if ('error' in w) {
            ctx.renderer.chromeLine(`cannot discard: ${w.error}`);
            return 'continue';
          }
          ctx.session.log.append({ type: 'plan.discarded', planId: ctx.session.id });
          ctx.pendingNotes.push('the user DISCARDED the plan; do not follow it — ask for direction if the next step is unclear');
          ctx.renderer.chromeLine('plan discarded (status: superseded; the file remains on disk for reference)');
          return 'continue';
        }
        ctx.renderer.chromeLine('usage: /plan [show | approve | discard]');
        return 'continue';
      }

      // Canonical structured plans (Session 11).
      if (sub === '' || sub === 'show') {
        if (state.kind === 'none') {
          ctx.renderer.chromeLine('no plan document for this session (ask for one, or use @plan <request>)');
          return 'continue';
        }
        const doc = state.canonical!;
        const approvalLine =
          state.approvedSha === null
            ? 'approval: none recorded — /plan approve to consent'
            : state.diverged
              ? `approval: INVALIDATED — the plan changed after approval (approved ${state.approvedSha.slice(0, 12)}, current ${state.currentSha?.slice(0, 12) ?? 'unreadable'}); re-approve with /plan approve`
              : doc.status !== 'approved'
                ? `approval: recorded for this content (sha ${state.approvedSha.slice(0, 12)}) but status is ${doc.status} — /plan approve to re-activate`
                : `approval: current (content sha ${state.approvedSha.slice(0, 12)} approved)`;
        const execLine =
          doc.graph !== null ? `  execution: ${foldGraphState(doc.graph, ctx.session.log.events).summary}` : null;
        ctx.renderer.chromeLine(
          [
            `plan ${sanitizeLine(doc.planId)} — status: ${doc.status}${doc.parseError !== undefined ? ` (${sanitizeLine(doc.parseError)})` : ''}`,
            `  ${approvalLine}`,
            ...(execLine !== null ? [sanitizeLine(execLine)] : []),
            `  canonical (editable JSON): ${sanitizeLine(doc.file)}`,
            `  content sha: ${doc.contentSha ?? 'unreadable'} · ${doc.bytes} bytes`,
          ].join('\n'),
        );
        // The full review view goes to the model-text stream (like /report, /diff); regenerate
        // the on-disk view opportunistically so it never lags the canonical file.
        void (await writeUserView(ctx.layout, ctx.session.id, doc, ctx.session.snapshots));
        ctx.modelOut.write(renderUserPlanView(doc).split('\n').map(sanitizeLine).join('\n') + '\n');
        return 'continue';
      }
      if (sub === 'approve') {
        if (state.kind === 'none') {
          ctx.renderer.chromeLine('no plan document to approve');
          return 'continue';
        }
        if (state.approvedAndCurrent) {
          ctx.renderer.chromeLine('plan is already approved (the approval matches the current content)');
          return 'continue';
        }
        const w = await setCanonicalStatus(ctx.layout, ctx.session.id, 'approved', ctx.session.snapshots, ctx.session.clock);
        if ('error' in w) {
          ctx.renderer.chromeLine(`cannot approve: ${sanitizeLine(w.error)}`);
          return 'continue';
        }
        // The consent record binds the CONTENT sha — status/timestamp flips are sha-neutral by
        // construction, so this approval survives exactly until the next semantic change.
        ctx.session.log.append({ type: 'plan.approved', planId: ctx.session.id, sha256: w.contentSha });
        void (await writeUserView(ctx.layout, ctx.session.id, readCanonicalPlan(ctx.layout, ctx.session.id), ctx.session.snapshots));
        ctx.pendingNotes.push(`the user APPROVED the plan (content sha ${w.contentSha.slice(0, 12)}); planned execution may begin`);
        ctx.renderer.chromeLine(`plan approved (content sha ${w.contentSha.slice(0, 12)}…) — recorded as consent evidence`);
        return 'continue';
      }
      if (sub === 'discard') {
        if (state.kind === 'none') {
          ctx.renderer.chromeLine('no plan document to discard');
          return 'continue';
        }
        const w = await setCanonicalStatus(ctx.layout, ctx.session.id, 'superseded', ctx.session.snapshots, ctx.session.clock);
        if ('error' in w) {
          ctx.renderer.chromeLine(`cannot discard: ${sanitizeLine(w.error)}`);
          return 'continue';
        }
        ctx.session.log.append({ type: 'plan.discarded', planId: ctx.session.id });
        void (await writeUserView(ctx.layout, ctx.session.id, readCanonicalPlan(ctx.layout, ctx.session.id), ctx.session.snapshots));
        ctx.pendingNotes.push('the user DISCARDED the plan; do not follow it — a new update_plan write starts a fresh draft');
        ctx.renderer.chromeLine('plan discarded (status: superseded; a new update_plan write starts a fresh draft)');
        return 'continue';
      }
      ctx.renderer.chromeLine('usage: /plan [show | approve | discard]');
      return 'continue';
    }

    case 'undo': {
      const target = arg.trim().toLowerCase() === 'all' ? 'all' : 'last';
      const outcome = applyUndo(ctx.session.log.events, ctx.session.snapshots, target);
      // The append renders the restored/refused lines via the log observer.
      ctx.session.log.append({ type: 'undo.applied', target: outcome.target, restored: outcome.restored, refused: outcome.refused });
      if (outcome.restored.length > 0) {
        ctx.pendingNotes.push(
          `the user ran /undo: ${outcome.restored.map((r) => r.path).join(', ')} ` +
            `restored to pre-change content. Re-read before editing them again.`,
        );
        ctx.renderer.chromeLine('  note: undo covers only file-tool changes; run_command side effects are not captured.');
      }
      return 'continue';
    }

    case 'diff': {
      const files = buildSessionDiff(
        ctx.session.log.events,
        ctx.session.snapshots,
        ctx.session.workspaceRoot,
        ctx.session.rules?.secretPatterns,
      );
      ctx.renderer.flush();
      // Diff lines are workspace bytes — untrusted content headed for a terminal; sanitize each line.
      ctx.modelOut.write(renderSessionDiff(files).split('\n').map(sanitizeLine).join('\n') + '\n');
      return 'continue';
    }

    case 'commit': {
      const g = ctx.session.gitFacts;
      if (!g?.isRepo || g.gitPath === null || g.repoRoot === null) {
        ctx.renderer.chromeLine('  /commit needs a git repository (this workspace is not inside one)');
        return 'continue';
      }
      const flags = parseCommitArgs(arg);
      if (flags.error) {
        ctx.renderer.chromeLine(`  ${flags.error}`);
        return 'continue';
      }
      const outcome = await runCommitFlow(
        { gitPath: g.gitPath, repoRoot: g.repoRoot, workspaceRoot: ctx.session.workspaceRoot, messageDir: ctx.session.stateDir },
        ctx.session.log.events,
        {
          scope: flags.all ? 'all' : 'session',
          ...(flags.message !== undefined ? { subject: flags.message } : {}),
          trailer: !flags.noTrailer,
          sessionId: ctx.session.id,
          io: {
            info: (line) => ctx.renderer.chromeLine(sanitizeLine(line)),
            question: ctx.question ?? null,
            assumeYes: false,
          },
        },
      );
      if (outcome.committed && outcome.result?.oid) {
        ctx.session.log.append({
          type: 'git.commit',
          oid: outcome.result.oid,
          subject: outcome.subject ?? '',
          files: outcome.result.files,
          scope: flags.all ? 'all' : 'session',
          trailer: !flags.noTrailer,
        });
        ctx.pendingNotes.push(`the user committed ${outcome.result.files.length} file(s) as ${outcome.result.oid.slice(0, 12)} ("${outcome.subject}")`);
      }
      return 'continue';
    }

    case 'checkpoint': {
      const g = ctx.session.gitFacts;
      if (!g?.isRepo || g.gitPath === null || g.repoRoot === null) {
        ctx.renderer.chromeLine('  /checkpoint needs a git repository (this workspace is not inside one)');
        return 'continue';
      }
      const cctx: CheckpointContext = { gitPath: g.gitPath, repoRoot: g.repoRoot, workspaceRoot: ctx.session.workspaceRoot, stateDir: ctx.session.stateDir };
      if (arg.trim().toLowerCase() === 'list') {
        const list = await listCheckpoints(cctx);
        if (list.length === 0) ctx.renderer.chromeLine('  no checkpoints in this repository');
        for (const c of list) ctx.renderer.chromeLine(`  ${c.oid.slice(0, 12)}  ${sanitizeLine(c.subject)}  (${c.createdAt})`);
        return 'continue';
      }
      const restoreMatch = /^restore\s+(\d+)$/i.exec(arg.trim());
      if (restoreMatch || /^restore\b/i.test(arg.trim())) {
        const n = restoreMatch ? Number(restoreMatch[1]) : NaN;
        if (!Number.isInteger(n) || n < 1) {
          ctx.renderer.chromeLine('  usage: /checkpoint restore <n>  (see /checkpoint list)');
          return 'continue';
        }
        const mine = await listCheckpoints(cctx, ctx.session.id);
        const ckpt = mine.find((c) => c.n === n);
        if (!ckpt) {
          ctx.renderer.chromeLine(`  no checkpoint ${n} for THIS session (use /checkpoint list; cross-session restore: agent checkpoint restore <n> --session <id>)`);
          return 'continue';
        }
        const r = await runRestoreFlow(cctx, ckpt, {
          snapshots: ctx.session.snapshots,
          appendEvent: (e) => ctx.session.log.append(e),
          callId: `git-restore-${ctx.session.log.events.length}`,
          info: (l) => ctx.renderer.chromeLine(sanitizeLine(l)),
          question: ctx.question ?? null,
          assumeYes: false,
        });
        if (r.performed && r.restored.length > 0) {
          ctx.pendingNotes.push(
            `the user restored ${r.restored.length} file(s) to checkpoint ${n} (${ckpt.oid.slice(0, 12)}). Re-read files before editing them again.`,
          );
        }
        return 'continue';
      }
      const label = arg.trim().length > 0 ? arg.trim() : undefined;
      const r = await createCheckpoint(cctx, ctx.session.id, {
        ...(label !== undefined ? { label } : {}),
        confirmLargeUntracked: async (count) => {
          if (!ctx.question) return false;
          const a = await ctx.question(`  capture ${count} untracked files too? (is something big not gitignored?) [y/N] `);
          return a !== null && /^y(es)?$/i.test(a.trim());
        },
      });
      for (const note of r.notes ?? []) ctx.renderer.chromeLine(`  note: ${sanitizeLine(note)}`);
      if (r.ok && r.ref && r.oid) {
        ctx.session.log.append({ type: 'git.checkpoint', ref: r.ref, oid: r.oid, label: label ?? null, filesChanged: r.filesChanged ?? 0 });
      } else {
        ctx.renderer.chromeLine(`  checkpoint not created: ${r.error}`);
      }
      return 'continue';
    }

    case 'research': {
      // Session 19. This surface is a privacy record as much as a status line: its first job is
      // to let a user see EXACTLY what text this session sent to a third party, and which
      // external sources shaped the answers they were given. Everything is derived from the
      // event log, so it says only what actually happened.
      // An absent credential does NOT hide the record. This surface exists so a user can audit
      // what was sent, and a resumed session without the key is exactly when they are most likely
      // to be asking (S19 review). The unavailability is reported as a line, not as a wall.
      const events = ctx.session.log.events;
      const searches = events.filter((e) => e.type === 'research.searched') as Extract<SessionEvent, { type: 'research.searched' }>[];
      const extracts = events.filter((e) => e.type === 'research.extracted') as Extract<SessionEvent, { type: 'research.extracted' }>[];
      const findings = events.filter((e) => e.type === 'research.findings') as Extract<SessionEvent, { type: 'research.findings' }>[];
      const usage = events.filter((e) => e.type === 'research.usage') as Extract<SessionEvent, { type: 'research.usage' }>[];
      const notes = findings.flatMap((f) => f.notes);

      const out: string[] = ['# Web research (this session)'];
      const spent = ctx.researchBudget?.spent;
      out.push(
        '',
        spent !== undefined
          ? `spent: ${String(spent.searches)} search(es), ${String(spent.extracts)} extract(s), ${String(spent.credits)} provider credit(s), ${String(spent.contentChars)} retrieved char(s)`
          : 'spend: unavailable',
        ctx.researchBudget !== undefined ? `remaining: ${ctx.researchBudget.remaining()}` : '',
      );

      // Queries the MAIN agent sent. A researcher child's queries live in its own log, named
      // below with the command that shows them — this surface never pretends to have read a log
      // it did not read.
      out.push('', `## Queries sent from this session (${String(searches.length)})`);
      if (searches.length === 0) out.push('(none)');
      for (const s of searches) {
        out.push(
          `- "${sanitizeLine(s.query)}" → ${sanitizeLine(s.provider)}: ${String(s.resultCount)} source(s)` +
            `${s.hosts.length > 0 ? ` from ${s.hosts.map((h) => sanitizeLine(h)).join(', ')}` : ''}` +
            ` (${String(s.credits)} credit(s), ${String(s.durationMs)}ms)`,
        );
        for (const r of s.refused) out.push(`    refused: ${sanitizeLine(r.url)} — ${sanitizeLine(r.reason)}`);
      }
      if (extracts.length > 0) {
        out.push('', `## Pages read in full (${String(extracts.length)} call(s))`);
        for (const x of extracts) {
          for (const u of x.urls) out.push(`- ${sanitizeLine(u)}`);
          for (const f of x.failed) out.push(`    NOT retrieved: ${sanitizeLine(f.url)} — ${sanitizeLine(f.reason)}`);
        }
      }
      if (usage.length > 0) {
        out.push('', `## Delegated research tasks (${String(usage.length)})`);
        for (const u of usage) {
          out.push(
            `- ${sanitizeLine(u.childSessionId)}: ${String(u.searches)} search(es), ${String(u.extracts)} extract(s), ` +
              `${String(u.credits)} credit(s) — its own queries: agent report ${sanitizeLine(u.childSessionId)}`,
          );
        }
      }
      out.push('', `## Recorded findings (${String(notes.length)})`);
      if (notes.length === 0) out.push('(none — anything the model said about the web that is not here was narration)');
      for (const n of notes) {
        out.push(
          `- [${sanitizeLine(n.noteId)}] ${sanitizeLine(n.claim)}`,
          `    ${n.corroboration} · ${n.confidence} confidence · retrieved ${sanitizeLine(n.retrievedAt)}`,
          `    why: ${sanitizeLine(n.relevance)}`,
          ...n.sources.map((s) => `    source: ${sanitizeLine(s)}`),
        );
      }
      out.push(
        '',
        'Research is CONTEXT, never verification: no finding here marks a file checked or satisfies a plan gate.',
        'Retrieved content is untrusted third-party text; claims above are the model\'s reading of it, not the harness\'s.',
      );
      ctx.renderer.flush();
      ctx.modelOut.write(`${out.filter((l) => l !== '').join('\n')}\n`);
      return 'continue';
    }

    case 'remote': {
      // Session 20. Like /research this is an audit surface first and a status line second: its
      // job is to let a user see exactly what this session looked at on a third party and — far
      // more importantly — exactly what it CHANGED there, derived entirely from the event log.
      const events = ctx.session.log.events;
      const context = events.filter((e) => e.type === 'remote.context').at(-1) as Extract<SessionEvent, { type: 'remote.context' }> | undefined;
      const reads = events.filter((e) => e.type === 'remote.inspected') as Extract<SessionEvent, { type: 'remote.inspected' }>[];
      const writes = events.filter((e) => e.type === 'remote.mutated') as Extract<SessionEvent, { type: 'remote.mutated' }>[];

      const out: string[] = ['# Remote delivery (this session)'];
      if (ctx.remoteUnavailable !== undefined) out.push('', `unavailable: ${sanitizeLine(ctx.remoteUnavailable)}`);
      if (context !== undefined) {
        out.push('', `local context: ${sanitizeLine(context.detail)}`);
        for (const r of context.remotes) {
          out.push(
            `- ${sanitizeLine(r.name)} → ${sanitizeLine(r.url)}` +
              `${r.slug !== null ? ` (${sanitizeLine(r.slug)})` : ''}${r.isGitHub ? '' : ' [not a GitHub host]'}` +
              `${r.hadCredentials ? ' [WARNING: URL embeds a credential — remove it]' : ''}`,
          );
        }
        if (context.ambiguity !== undefined) out.push(`- no default remote: ${sanitizeLine(context.ambiguity)}`);
        if (context.ghAuthStatusLeakRisk) {
          out.push(
            `- gh ${sanitizeLine(context.ghVersion ?? 'unknown')} predates the GHSA-cg6r-mpgc-h9mm fix: 'gh auth status' can print part of your token. ` +
              'Agent CLI reads the structured form and scrubs its output; other tools on this machine do not.',
          );
        }
        if (context.tokenEnvNotForwarded) {
          out.push('- GH_TOKEN/GITHUB_TOKEN is set in your shell and is deliberately NOT forwarded to child processes; gh uses its own stored credential.');
        }
        if (context.ghHostOverride !== undefined) out.push(`- GH_HOST override in force: ${sanitizeLine(context.ghHostOverride)}`);
        if (context.ghConfigDirOverride !== undefined) out.push('- GH_CONFIG_DIR override in force (a different gh account store).');
      }

      const identity = ctx.remoteState?.identities() ?? [];
      out.push('', '## Identity');
      if (identity.length === 0) out.push('(not established — no authorized `auth` read has happened this session)');
      for (const i of identity) {
        out.push(
          `- ${sanitizeLine(i.host)}: ${sanitizeLine(i.account)} · scopes ${i.scopes.length > 0 ? i.scopes.map((s) => sanitizeLine(s)).join(', ') : '(none reported)'} · credential in ${sanitizeLine(i.source)}`,
        );
      }
      if (ctx.remoteState !== undefined) {
        out.push(
          '',
          `allowance: ${ctx.remoteState.remaining('read')} remaining, ${ctx.remoteState.remaining('write')} remaining` +
            ` (spent ${String(ctx.remoteState.spend.reads)} read(s), ${String(ctx.remoteState.spend.writes)} mutation(s))`,
        );
        const obs = ctx.remoteState.observations();
        out.push('', `## Live observations (${String(obs.length)}; in-memory only — a resume must look again)`);
        if (obs.length === 0) out.push('(none)');
        for (const o of obs) {
          out.push(`- ${sanitizeLine(o.remoteName)}:${sanitizeLine(o.refName)} — ${sanitizeLine(describeRelation(o))} [id ${sanitizeLine(o.id)}]`);
        }
      }

      out.push('', `## Reads (${String(reads.length)})`);
      if (reads.length === 0) out.push('(none)');
      for (const r of reads) {
        out.push(
          `- ${sanitizeLine(r.operation)} ${sanitizeLine(r.host)}/${sanitizeLine(r.target)}${r.account !== undefined ? ` as ${sanitizeLine(r.account)}` : ''}` +
            ` — ${r.ok ? 'ok' : 'FAILED'}${r.itemCount !== undefined ? `, ${String(r.itemCount)} item(s)` : ''} (${String(r.durationMs)}ms)` +
            `${r.detail !== undefined ? ` — ${sanitizeLine(r.detail)}` : ''}`,
        );
      }

      // The section that matters. Mutations are listed even when they failed: "we tried to publish
      // and it was rejected" is exactly the kind of thing a status surface must not quietly drop.
      out.push('', `## Mutations (${String(writes.length)})`);
      if (writes.length === 0) out.push('(none — nothing on any remote was changed by this session)');
      for (const w of writes) {
        out.push(
          `- ${sanitizeLine(w.operation)} → ${sanitizeLine(w.exactTarget)} on ${sanitizeLine(w.host)}/${sanitizeLine(w.target)}` +
            `${w.account !== undefined ? ` as ${sanitizeLine(w.account)}` : ''}` +
            ` — ${w.ok ? (w.verified ? 'ok, VERIFIED against the remote' : 'ok but NOT VERIFIED') : 'FAILED'}` +
            `${w.overwrote ? ' [OVERWROTE remote state]' : ''}`,
          `    ${sanitizeLine(w.beforeOid ?? '(ref absent)')} → ${sanitizeLine(w.afterOid ?? '(unknown)')}${w.url !== undefined ? ` · ${sanitizeLine(w.url)}` : ''}` +
            `${w.detail !== undefined ? ` · ${sanitizeLine(w.detail)}` : ''}`,
        );
      }
      out.push(
        '',
        'Every mutation above is an individual `ask` that no session grant can satisfy, and a green local check is never one.',
        'The one exception is the flag that removes the human: under --dangerously-allow-all an ask is auto-allowed and',
        'recorded with source "dangerous-mode".',
      );
      ctx.renderer.flush();
      ctx.modelOut.write(`${out.filter((l) => l !== '').join('\n')}\n`);
      return 'continue';
    }

    case 'report': {
      const { md } = buildReport({
        events: ctx.session.log.events,
        approvedGraph: approvedCurrentGraph(readPlanState(ctx.layout, ctx.session.id, ctx.session.log.events)),
      });
      ctx.renderer.flush();
      ctx.modelOut.write(md + '\n');
      return 'continue';
    }

    case 'map': {
      ctx.renderer.flush();
      if (ctx.retrieval !== undefined && ctx.retrieval !== null) {
        // The ranked map the model received at assembly (re-rendered from the same in-memory
        // handle — no index write, no re-scan). render.ts sanitizes at interpolation.
        const r = renderRepoMap(ctx.retrieval);
        ctx.modelOut.write(r.text + `\n\n(${ctx.retrieval.inventory.files.length} files${r.truncated ? ', selective' : ''})\n`);
        return 'continue';
      }
      const map = await buildWorkspaceMapAuto(ctx.session.workspaceRoot, {}, ctx.session.gitFacts);
      ctx.modelOut.write(
        map.text.split('\n').map(sanitizeLine).join('\n') +
          `\n\n(${map.fileCount} files${map.truncated ? ', truncated' : ''})\n`,
      );
      return 'continue';
    }

    case 'review': {
      const rv = sessionReview(ctx);
      const lines: string[] = [];
      const reqLabel =
        rv.requirement.kind === 'required'
          ? `required (${rv.requirement.source === 'declared' ? 'declared by the plan' : 'derived: the approved plan has executor tasks'})`
          : rv.requirement.kind === 'waived'
            ? `WAIVED by the approved plan — ${sanitizeLine(rv.requirement.reason)} (recorded as an acceptance caveat)`
            : 'not required (no approved plan with executor tasks; recorded findings still bind)';
      lines.push(`adversarial review: ${reqLabel}`);
      if (rv.rounds.length === 0) {
        lines.push('  rounds: none recorded — one delegate_task call with 2-3 reviewer lenses records a round');
      }
      rv.rounds.forEach((r, i) => {
        lines.push(
          `  round ${i + 1}: ${r.captured}/${r.lenses} lens(es) captured, ${r.findingsCount} finding(s) — ${r.qualifying ? 'QUALIFYING' : `not qualifying (${sanitizeLine(r.note ?? '')})`}${r.deadLenses.length > 0 ? `; dead: ${r.deadLenses.join(', ')}` : ''}`,
        );
      });
      for (const f of rv.findings) {
        lines.push(
          `  ${sanitizeLine(f.finding.findingId)} [${f.finding.severity}] ${sanitizeLine(f.finding.title)} → ${f.status}${f.blocking ? ' (BLOCKING)' : ''}`,
        );
        for (const t of f.triage) {
          lines.push(`    triage ${t.action}${t.effective ? '' : ' (INEFFECTIVE)'}: ${sanitizeLine(t.evidence).slice(0, 120)}${t.note !== undefined ? ` — ${sanitizeLine(t.note)}` : ''}`);
        }
      }
      for (const b of rv.openBlockers) lines.push(`  BLOCKER: ${sanitizeLine(b)}`);
      for (const c of rv.caveats) lines.push(`  caveat: ${sanitizeLine(c)}`);
      lines.push(`  gate: ${rv.satisfied ? 'satisfied' : 'NOT satisfied — /accept will refuse COMPLETE'}`);
      ctx.renderer.chromeLine(lines.join('\n'));
      return 'continue';
    }

    case 'init': {
      await runInit(ctx, ctx.session.clock.iso());
      return 'continue';
    }

    case 'grants': {
      // Read-only view of standing authority IN THIS SESSION (the newest grants.loaded — a
      // resumed life re-loads and re-records). Mutation lives in `agent grants`, deliberately
      // outside the conversation: revoking authority should not require a session.
      const loaded = ctx.session.log.events.filter((e) => e.type === 'grants.loaded').at(-1);
      const lines: string[] = [];
      if (loaded === undefined || loaded.type !== 'grants.loaded') {
        lines.push('no durable machine grants were active when this session was assembled.');
      } else {
        lines.push(`durable machine grants active this session (loaded at assembly, recorded as grants.loaded):`);
        for (const g of loaded.entries) lines.push(`  ${g.id}  ${sanitizeLine(g.label)} · created ${g.createdAt}`);
      }
      // Grants minted mid-session by [a] are active in-session immediately and durably stored,
      // but grants.loaded is assembly-only — without this line, /grants right after an [a]
      // answered "none were active", which reads as "nothing was recorded" (S21 review).
      const minted = ctx.session.log.events.filter((e) => e.type === 'approval.resolved' && e.scope === 'machine').length;
      if (minted > 0) {
        lines.push(`plus ${minted} durable grant answer(s) recorded by [a] DURING this session — active now; \`agent grants\` lists the stored entries.`);
      }
      lines.push('list / revoke: agent grants [revoke <id>] — a revoke applies from the NEXT session assembly.');
      ctx.renderer.chromeLine(lines.join('\n'));
      return 'continue';
    }

    case 'repair': {
      // The bounded-repair ledger surface (S21): the user-side closure path for escalations.
      // A dismissal is the USER's typed decision — the recover tool has no dismiss action, so
      // consent stays here structurally. The fold re-derives everything; this case only appends.
      // Evidence-resolved escalations (acceptance's resolvedTargets) are excluded from the
      // dismissible OPEN list — this surface and /accept must not disagree about the same log,
      // and dismissing a self-resolved escalation would mint a needless permanent caveat.
      const ledger = foldRepairs(ctx.session.log.events);
      const resolvedByEvidence = resolvedRepairTargets(ctx);
      const openEscalations = ledger.escalations.filter((e) => e.open && !resolvedByEvidence.has(e.target));
      const sub = (rest[0] ?? '').toLowerCase();
      if (sub === 'dismiss') {
        const n = Number.parseInt(rest[1] ?? '', 10);
        const reason = rest.slice(2).join(' ').trim();
        if (!Number.isInteger(n) || n < 1 || n > openEscalations.length) {
          ctx.renderer.chromeLine(
            openEscalations.length === 0
              ? 'nothing to dismiss: no OPEN repair escalation is on record (/repair shows the ledger)'
              : `usage: /repair dismiss <n> <reason> — n is the OPEN escalation number /repair shows (1..${openEscalations.length})`,
          );
          return 'continue';
        }
        if (reason.length === 0) {
          ctx.renderer.chromeLine(
            'a dismissal needs a reason: it is recorded as evidence and shown as an acceptance caveat (e.g. /repair dismiss 1 verified by hand; timeout was environmental)',
          );
          return 'continue';
        }
        const esc = openEscalations[n - 1]!;
        ctx.session.log.append({
          type: 'repair.dismissed',
          escalationSeq: esc.seq,
          target: esc.target,
          failureClass: esc.failureClass,
          signature: esc.signature,
          reason: sanitizeLine(reason),
          source: 'user',
        });
        // Honest scope (S21 review): the DISMISSAL clears the escalation blocker only — an
        // unproven repair ATTEMPT for the same failure keeps its own blocker until its declared
        // regression checks pass, and the confirmation must not promise /accept more than that.
        const remainingAttempts = ledger.attempts.filter(
          (a) => a.signature === esc.signature && a.outcome === 'open' && a.pendingChecks.length > 0,
        ).length;
        ctx.renderer.chromeLine(
          `escalation on '${sanitizeLine(esc.target)}' (${esc.failureClass}) dismissed — recorded as evidence. The escalation no longer blocks /accept` +
            `${remainingAttempts > 0 ? `; NOTE: ${remainingAttempts} unproven repair attempt(s) for the same failure still block until their regression checks pass` : ''}` +
            ' and it will appear as an acceptance caveat, not as a resolution.',
        );
        ctx.pendingNotes.push(
          `the user DISMISSED the open repair escalation on '${sanitizeLine(esc.target)}' (${esc.failureClass}) with reason: ${sanitizeLine(reason)}. ` +
            'It no longer blocks acceptance and is recorded as a caveat. Do not re-escalate the same failure without new evidence.',
        );
        return 'continue';
      }
      const lines: string[] = [];
      if (ledger.total === 0 && ledger.escalations.length === 0) {
        lines.push('no repair activity this session (the recover tool records attempts and escalations here).');
      } else {
        lines.push(`repair ledger: ${ledger.total} attempt(s), ${ledger.escalations.length} escalation(s)`);
        for (const a of ledger.attempts) {
          lines.push(
            `  attempt ${a.attempt} on '${sanitizeLine(a.target)}' (${a.failureClass}) → ${a.outcome}` +
              `${a.outcome === 'open' && a.pendingChecks.length > 0 ? ` — UNPROVEN (pending: ${a.pendingChecks.join(', ')})` : ''}`,
          );
        }
        let n = 0;
        for (const esc of ledger.escalations) {
          if (esc.open && resolvedByEvidence.has(esc.target)) {
            // The same closure acceptance applies (resolvedTargets): the surfaces must agree.
            lines.push(`  escalation on '${sanitizeLine(esc.target)}' (${esc.failureClass}) — resolved by EVIDENCE (its plan task completed with a satisfied gate)`);
          } else if (esc.open) {
            n++;
            lines.push(`  [${n}] OPEN escalation on '${sanitizeLine(esc.target)}' (${esc.failureClass}) — ${sanitizeLine(esc.reason)}`);
          } else if (esc.dismissed !== null) {
            lines.push(`  escalation on '${sanitizeLine(esc.target)}' (${esc.failureClass}) — DISMISSED by you: ${sanitizeLine(esc.dismissed.reason)}`);
          } else {
            lines.push(`  escalation on '${sanitizeLine(esc.target)}' (${esc.failureClass}) — resolved by a proven repair`);
          }
        }
        if (n > 0) {
          lines.push('  dismiss an OPEN escalation you have verified or decided to accept: /repair dismiss <n> <reason>');
          lines.push('  (recorded as evidence and kept as an acceptance caveat — dismissed is not resolved)');
        }
      }
      ctx.renderer.chromeLine(lines.join('\n'));
      return 'continue';
    }

    case 'checks': {
      // What this workspace can actually be verified with, plus what has been verified so far.
      // Re-detected on demand so the surface never shows a stale project (an install or a new
      // tsconfig changes the answer, and the user asking is exactly when freshness matters).
      ctx.renderer.flush();
      const lines: string[] = [];
      if (ctx.checkTool !== undefined) {
        lines.push(...describeWorkspace(ctx.checkTool.refresh()));
      } else {
        lines.push('typed checks are unavailable in this session');
      }
      // The newest EVIDENCE per kind, not the newest verdict: a check that spawned and never
      // completed (crash mid-run) left the previous PASS standing here as "latest result",
      // while /report over the same log said "STARTED but never completed; no verdict". Two
      // surfaces, one log, opposite answers — and this one read stronger (S14.5 review).
      type Completed = Extract<(typeof ctx.session.log.events)[number], { type: 'check.completed' }>;
      // Keyed by (project, kind), not kind alone (Session 16): in a workspace holding `web/` and
      // `api/`, a green `test` in one is not a result for the other, and showing it as "the latest
      // test result" would be this surface asserting something the log never said.
      const latest = new Map<string, { seq: number; done: Completed | null; label: string }>();
      const openRuns = new Map<string, { seq: number; label: string }>();
      const labelOf = (projectId: string | undefined, kind: string): string =>
        projectId === undefined || projectId === '.' ? kind : `${kind} [${projectId}]`;
      for (const e of ctx.session.log.events) {
        if (e.type === 'check.started') {
          openRuns.set(`${e.callId}::${e.projectId ?? '.'}::${e.check}`, { seq: e.seq, label: labelOf(e.projectId, e.check) });
        } else if (e.type === 'check.completed') {
          const k = `${e.projectId ?? '.'}::${e.check}`;
          openRuns.delete(`${e.callId}::${k}`);
          latest.set(k, { seq: e.seq, done: e, label: labelOf(e.projectId, e.check) });
        }
      }
      for (const [key, run] of openRuns) {
        const k = key.slice(key.indexOf('::') + 2);
        const prior = latest.get(k);
        if (prior === undefined || run.seq > prior.seq) latest.set(k, { seq: run.seq, done: null, label: run.label });
      }
      lines.push('', latest.size > 0 ? 'latest result per kind:' : 'no checks have run in this session yet');
      for (const entry of latest.values()) {
        lines.push(
          entry.done === null
            ? `  ${entry.label}: NO VERDICT — started but never completed (the session ended while it ran); effects unknown, re-run it`
            : `  ${entry.label}: ${entry.done.status} — ${sanitizeLine(entry.done.summary)}`,
        );
      }
      lines.push(
        `browser checks: ${likelyBrowserAvailable() ? 'likely available (a system browser or Playwright cache is present; proven at the first flow)' : 'unavailable (no system Edge/Chrome or Playwright cache found)'}`,
      );
      // Setup evidence lives beside the checks it enables, but is labeled as a DIFFERENT thing:
      // "dependencies were installed" is never a line in the verification story.
      // Started-and-never-completed is the state this surface most needs to show: an install
      // SIGKILLed halfway leaves a half-written node_modules, and a migration killed halfway
      // leaves a database in an unknown shape. Listing only completions made exactly that case
      // invisible here while /report over the same log called the state UNKNOWN — the check
      // surface has said "NO VERDICT" for this since S14.5, and setup has to say it too.
      const setupStarts = new Map<string, { action: string; projectId: string }>();
      const setups: string[] = [];
      for (const e of ctx.session.log.events) {
        if (e.type === 'setup.started') setupStarts.set(e.callId, { action: e.action, projectId: e.projectId });
        else if (e.type === 'setup.completed') {
          setupStarts.delete(e.callId);
          setups.push(`  ${e.action} [${e.projectId}]: ${e.status} — ${sanitizeLine(e.summary)}`);
        }
      }
      for (const [, s] of setupStarts) {
        setups.push(`  ${s.action} [${s.projectId}]: NO VERDICT — it started and never completed; dependency or local data state is UNKNOWN, re-run it`);
      }
      if (setups.length > 0) lines.push('', 'project setup (not verification):', ...setups);
      // Document artifacts (Session 17) — products, labeled as such, never verification lines.
      const renders: string[] = [];
      let inspectedPages = 0;
      for (const e of ctx.session.log.events) {
        if (e.type === 'artifact.rendered') {
          renders.push(`  ${e.format} ${sanitizeLine(e.path)}: validation ${e.validation.status}${e.pages !== undefined ? ` (${String(e.pages)} page(s))` : ''}`);
        } else if (e.type === 'artifact.inspected') {
          inspectedPages += e.pages.length;
        }
      }
      if (renders.length > 0 || inspectedPages > 0) {
        lines.push('', 'document artifacts (products, not verification):', ...renders);
        if (inspectedPages > 0) lines.push(`  page images inspected: ${String(inspectedPages)}`);
      }
      lines.push('', `checks run this session: ${ctx.checkCaps?.checksRun ?? 0}/${CHECKS_PER_SESSION}`);
      if (ctx.setupCaps !== undefined) lines.push(`project setups this session: ${ctx.setupCaps.setupsRun}/${SETUPS_PER_SESSION}`);
      ctx.modelOut.write(lines.join('\n') + '\n');
      return 'continue';
    }

    case 'preview': {
      // The session's managed preview servers: live handles re-probed at render time, other
      // sessions' registry entries labeled and untouchable. `stop <id>` is user-typed consent.
      ctx.renderer.flush();
      if (ctx.previewTool === undefined) {
        ctx.renderer.chromeLine('managed previews are unavailable in this session');
        return 'continue';
      }
      const sub = arg.trim().split(/\s+/).filter((s) => s !== '');
      if (sub[0]?.toLowerCase() === 'stop') {
        const alive = ctx.previewTool.active().filter((a) => a.handle.isAlive());
        const id = sub[1] ?? (alive.length === 1 ? alive[0]!.previewId : undefined);
        if (id === undefined) {
          ctx.renderer.chromeLine(
            alive.length === 0 ? 'nothing to stop: no preview is running' : `usage: /preview stop <id>   (running: ${alive.map((a) => a.previewId).join(', ')})`,
          );
          return 'continue';
        }
        const r = await ctx.previewTool.stopById(id, 'stopped');
        ctx.renderer.chromeLine(r.ok ? `stopped ${id}` : `stop ${id}: ${sanitizeLine(r.detail)}`);
        if (r.ok) ctx.pendingNotes.push(`the user stopped preview ${id} via /preview stop`);
        return 'continue';
      }
      const lines: string[] = [];
      const active = ctx.previewTool.active();
      const alive = active.filter((a) => a.handle.isAlive());
      if (alive.length === 0) lines.push('no preview is running in this session');
      for (const a of alive) {
        const up = Date.now() - a.startedAtMs;
        lines.push(
          `${a.previewId}: ${a.readyObserved ? `ready at ${a.url ?? '?'}` : 'readiness never observed'} ` +
            `(pid ${a.handle.pid}, up ${up < 60_000 ? `${Math.round(up / 1000)}s` : `${Math.round(up / 60_000)}m`}) — ${sanitizeLine(a.command)}`,
        );
        for (const l of a.handle.tail(1024).split(/\r?\n/).filter((s) => s.trim() !== '').slice(-8)) {
          lines.push(`    | ${sanitizeLine(l)}`);
        }
        lines.push(`    log: ${a.handle.logFile}`);
      }
      const others = loadPreviewRegistry(previewsFile(ctx.layout.projectDir)).filter(
        (e) => e.ownerSessionId !== ctx.session.id,
      );
      for (const o of others) lines.push(`${o.previewId}: recorded by another session (pid ${o.pid}) — not managed here`);
      ctx.modelOut.write(lines.join('\n') + '\n');
      return 'continue';
    }

    case 'provider':
      return await cmdProvider(arg, ctx);

    case 'model':
      return await cmdModel(arg, ctx);

    case 'cancel':
      ctx.renderer.chromeLine('nothing to cancel: /cancel works MID-TURN (on a TTY) while a delegated task group is running');
      return 'continue';

    case 'quit':
    case 'exit':
      return 'quit';

    default:
      ctx.renderer.chromeLine(`unknown command: /${cmd ?? ''} — try /help`);
      return 'continue';
  }
}

// ── /provider and /model (Session 15) ──────────────────────────────────────────────────────

/**
 * Never let anything key-shaped enter the session log via a command argument. Positive validation
 * (S15 review finding): the earlier blocklist (`=`, `sk-` prefix, len > 64) missed real formats —
 * a GLM key is a 49-char `id.secret` pair with no `sk-` prefix — and on the /model path a missed
 * value would be persisted verbatim into `provider.changed`. Provider and model ids are short and
 * conservative (the longest shipped id is 26 chars), so ANYTHING that does not look like one is
 * refused; that is the safe direction for a value the user may have pasted by mistake.
 */
function looksLikeCredential(s: string): boolean {
  return !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/.test(s) || /^sk-/i.test(s) || s.length > 40;
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : `${Math.round(n / 1024)}K`;
}

function capsLine(provider: ProviderName, model: string): string {
  const caps = capsFor(provider, model);
  const bits = [
    `ctx ${fmtTokens(caps.contextTokens)}`,
    `out ${fmtTokens(caps.maxOutputTokens)} (default ${fmtTokens(caps.defaultMaxTokens)})`,
    caps.visionInput ? 'vision' : 'NO image input',
    caps.reasoning.mode === 'none'
      ? 'no reasoning'
      : `reasoning ${caps.reasoning.mode}${caps.reasoning.replay !== 'none' ? ' (round-tripped)' : ''}`,
    `caching ${caps.caching}`,
    caps.lifecycle !== 'ga' ? caps.lifecycle.toUpperCase() : '',
  ].filter((b) => b !== '');
  return bits.join(' · ');
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** The one mutation path both commands share: session fields → event → model note → chrome. */
function performSwitch(
  ctx: CommandContext,
  target: { providerName: ProviderName; provider: Session['provider']; model: string },
  meta: { keyEnv?: string; baseUrlHost?: string; verification: 'models-list' | 'presence-only' | 'unverified-network' },
): void {
  const from = { providerName: ctx.session.provider.name, model: ctx.session.model };
  ctx.session.provider = target.provider;
  ctx.session.model = target.model;
  ctx.session.maxTokens = defaultMaxTokensFor(target.providerName, target.model);
  ctx.session.contextBudget = contextBudgetFor(target.providerName, target.model);
  ctx.session.log.append({
    type: 'provider.changed',
    from,
    to: { providerName: target.providerName, model: target.model },
    source: 'user-command',
    ...(meta.keyEnv !== undefined ? { keyEnv: meta.keyEnv } : {}),
    ...(meta.baseUrlHost !== undefined ? { baseUrlHost: meta.baseUrlHost } : {}),
    verification: meta.verification,
  });
  const caps = capsFor(target.providerName, target.model);
  const caveats: string[] = [];
  if (!caps.visionInput) caveats.push('this model has NO image input — screenshots are recorded as evidence but not shown to you');
  if (caps.reasoning.mode === 'forced') caveats.push('thinking is always on for this model');
  ctx.pendingNotes.push(
    `the user switched the provider/model from ${from.providerName}·${from.model} to ` +
      `${target.providerName}·${target.model}. Reasoning from other models does not carry across and the prompt cache resets.` +
      (caveats.length > 0 ? ` ${caveats.join('; ')}.` : ''),
  );
  const transport = target.provider.describeTransport?.();
  ctx.renderer.chromeLine(
    `provider: ${from.providerName}·${from.model} → ${target.providerName}·${target.model}\n` +
      `  ${capsLine(target.providerName, target.model)}\n` +
      `  key check: ${meta.verification}${meta.baseUrlHost !== undefined ? ` · host: ${meta.baseUrlHost}` : ''}` +
      `${transport !== undefined ? ` · network: ${transport}` : ''} · prompt cache resets — recorded as provider.changed`,
  );
}

async function cmdProvider(arg: string, ctx: CommandContext): Promise<SlashOutcome> {
  const tokens = arg.trim().split(/\s+/).filter((s) => s !== '');
  if (tokens.some(looksLikeCredential)) {
    ctx.renderer.chromeLine('refused: credentials are env-only — never paste a key into the session (set the provider\'s *_API_KEY env var instead)');
    return 'continue';
  }
  if (ctx.registry === undefined) {
    ctx.renderer.chromeLine('provider switching is unavailable in this context');
    return 'continue';
  }
  const registry = ctx.registry;

  if (tokens.length === 0) {
    const cur = ctx.session.provider.name;
    const lines = [`providers (current: ${cur} · ${ctx.session.model}; catalog verified ${CATALOG_VERIFIED}):`];
    for (const name of registry.names()) {
      const a = registry.availability(name);
      const status = a.present ? `ready (${a.keyEnv} set)` : `no key — set ${a.info.keyEnvs.join(' or ')}`;
      const base = a.baseUrlOverridden ? ` · base ${safeHost(a.baseUrl) ?? a.baseUrl} (via ${a.info.baseUrlEnv})` : '';
      lines.push(`  ${name.padEnd(10)} ${status} · default ${a.info.defaultModel}${base}${name === cur ? '  ← current' : ''}`);
    }
    lines.push(`  ${'mock'.padEnd(10)} scripted test provider (start-time only: --provider mock --script <file>)`);
    lines.push('switch: /provider <name> [model] · models: /model · key sources: `agent providers`');
    ctx.renderer.chromeLine(lines.join('\n'));
    return 'continue';
  }

  const name = resolveProviderName(tokens[0]!);
  if (name === undefined) {
    ctx.renderer.chromeLine(`unknown provider: ${sanitizeLine(tokens[0]!)} (valid: anthropic, openai, deepseek, kimi, glm)`);
    return 'continue';
  }
  if (name === 'mock') {
    ctx.renderer.chromeLine('the mock provider is start-time only (--provider mock --script <file>)');
    return 'continue';
  }
  const modelArg = tokens[1];
  if (name === ctx.session.provider.name && modelArg === undefined) {
    ctx.renderer.chromeLine(`already on ${name} — use /model to change models`);
    return 'continue';
  }

  const a = registry.availability(name);
  if (!a.present) {
    ctx.renderer.chromeLine(
      `no key for ${name}: set ${a.info.keyEnvs.join(' or ')}${a.info.keyUrl !== undefined ? ` (get a key: ${a.info.keyUrl})` : ''}`,
    );
    return 'continue';
  }

  const model = modelArg ?? a.info.defaultModel;
  const owners = providersOfModel(model);
  if (owners.length > 0 && !owners.includes(name)) {
    ctx.renderer.chromeLine(`model '${sanitizeLine(model)}' belongs to provider '${owners[0]!}' — use /provider ${owners[0]!} ${model}`);
    return 'continue';
  }

  if (a.info.modelsPath !== undefined) {
    ctx.renderer.chromeLine(`validating ${a.keyEnv} against ${safeHost(a.baseUrl) ?? a.baseUrl}${a.info.modelsPath} (bounded)…`);
  }
  const validation = await registry.validateKey(name);
  if (!validation.ok) {
    ctx.renderer.chromeLine(`switch refused: ${sanitizeLine(validation.detail)}`);
    return 'continue';
  }
  if (validation.modelIds !== undefined && !validation.modelIds.includes(model)) {
    if (ctx.question === undefined) {
      ctx.renderer.chromeLine(`switch refused: model '${sanitizeLine(model)}' is not in the provider's live model list (${validation.modelIds.length} visible)`);
      return 'continue';
    }
    const answer = await ctx.question(`  model '${model}' is not in the provider's live model list — switch anyway? [y/N] `);
    if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
      ctx.renderer.chromeLine('switch declined — provider unchanged');
      return 'continue';
    }
  }
  if (owners.length === 0) {
    ctx.renderer.chromeLine(`note: model '${sanitizeLine(model)}' is not in the shipped catalog — conservative defaults in effect`);
  }

  let provider: Session['provider'];
  try {
    provider = registry.create(name);
  } catch (e) {
    ctx.renderer.chromeLine(`switch failed: ${sanitizeLine((e as Error).message)}`);
    return 'continue';
  }
  performSwitch(
    ctx,
    { providerName: name, provider, model },
    {
      ...(a.keyEnv !== undefined ? { keyEnv: a.keyEnv } : {}),
      ...(safeHost(a.baseUrl) !== undefined ? { baseUrlHost: safeHost(a.baseUrl)! } : {}),
      verification: validation.verification,
    },
  );
  return 'continue';
}

async function cmdModel(arg: string, ctx: CommandContext): Promise<SlashOutcome> {
  const id = arg.trim();
  if (id !== '' && looksLikeCredential(id)) {
    ctx.renderer.chromeLine('refused: that argument looks like a credential — /model takes a model id only');
    return 'continue';
  }
  const providerName = ctx.session.provider.name as ProviderName;

  if (id === '') {
    if (providerName === 'mock') {
      ctx.renderer.chromeLine(`current: ${ctx.session.model} (mock provider — any model id is accepted)`);
      return 'continue';
    }
    const lines = [`models for ${providerName} (current: ${ctx.session.model}; catalog verified ${CATALOG_VERIFIED}):`];
    for (const m of modelsFor(providerName)) {
      lines.push(`  ${m.id.padEnd(26)} ${capsLine(providerName, m.id)}${m.id === ctx.session.model ? '  ← current' : ''}`);
      for (const n of m.notes ?? []) lines.push(`  ${' '.repeat(26)}   ${n}`);
    }
    lines.push('switch: /model <id> · an id outside this list runs with conservative defaults after confirmation');
    ctx.renderer.flush();
    ctx.modelOut.write(lines.join('\n') + '\n');
    return 'continue';
  }

  if (id === ctx.session.model) {
    ctx.renderer.chromeLine(`already on ${id}`);
    return 'continue';
  }
  const owners = providersOfModel(id);
  if (providerName !== 'mock' && owners.length > 0 && !owners.includes(providerName)) {
    ctx.renderer.chromeLine(`model '${sanitizeLine(id)}' belongs to provider '${owners[0]!}' — use /provider ${owners[0]!} ${id}`);
    return 'continue';
  }

  let verification: 'models-list' | 'presence-only' | 'unverified-network' = 'presence-only';
  if (providerName !== 'mock' && owners.length === 0 && ctx.registry !== undefined) {
    // Uncataloged id: consult the live list where one exists before running blind.
    const validation = await ctx.registry.validateKey(providerName);
    // A definitive credential rejection refuses the switch here exactly as it does in /provider,
    // and a FAILED probe must never be recorded as 'models-list' — that is the strongest of the
    // three verification words standing for the weakest outcome (S15 review finding).
    if (!validation.ok) {
      ctx.renderer.chromeLine(`switch refused: ${sanitizeLine(validation.detail)}`);
      return 'continue';
    }
    verification = validation.verification;
    if (validation.modelIds !== undefined && !validation.modelIds.includes(id)) {
      if (ctx.question === undefined) {
        ctx.renderer.chromeLine(`switch refused: '${sanitizeLine(id)}' is in neither the shipped catalog nor the provider's live model list`);
        return 'continue';
      }
      const answer = await ctx.question(`  '${id}' is in neither the catalog nor the live model list — switch anyway? [y/N] `);
      if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
        ctx.renderer.chromeLine('switch declined — model unchanged');
        return 'continue';
      }
    }
    ctx.renderer.chromeLine(`note: model '${sanitizeLine(id)}' is not in the shipped catalog — conservative defaults in effect`);
  }

  performSwitch(ctx, { providerName, provider: ctx.session.provider, model: id }, { verification });
  return 'continue';
}
