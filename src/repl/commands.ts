import { applyUndo } from '../runtime/undo.js';
import { buildReport } from '../report/report.js';
import { buildSessionDiff, renderSessionDiff } from '../report/diff.js';
import { runCommitFlow } from '../git/commit.js';
import { createCheckpoint, listCheckpoints, runRestoreFlow, type CheckpointContext } from '../git/checkpoint.js';
import { buildWorkspaceMapAuto } from '../workspace/map.js';
import { renderRepoMap } from '../retrieval/render.js';
import type { RetrievalHandle } from '../retrieval/rank.js';
import { readPlan, setPlanStatus } from '../plan/store.js';
import { readCanonicalPlan, readPlanState, setCanonicalStatus } from '../plan/canonical.js';
import { foldGraphState } from '../plan/graph-state.js';
import { computeAcceptance, workSince, type AcceptanceState } from '../runtime/acceptance.js';
import { renderUserPlanView, writeUserView } from '../plan/views.js';
import { sanitizeLine } from '../shared/text.js';
import { CHECKS_PER_SESSION, describeProject, type CheckCaps, type RunCheckTool } from '../tools/run-check.js';
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
  /** Session 11.5: /accept runs the task-base ref prune immediately (the assembled closure). */
  pruneTaskBaseRefs?: () => Promise<string | null>;
  /** Session 12: the typed-check tool instance; /checks renders its (refreshed) project snapshot. */
  checkTool?: RunCheckTool;
  /** Session 12: the events-rebuilt check counters, for the /checks budget line. */
  checkCaps?: CheckCaps;
}

export const HELP = [
  'commands:',
  '  /help           this help',
  '  /status         session, model, workspace, token usage',
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
  '                  fully executed and every capture integrated, records the acceptance, prunes',
  '                  task-base refs, and retires a completed plan. With unfinished work, /accept',
  '                  lists it and "/accept confirm" records a partial acceptance instead.',
  '  /checks         what this project can be verified with, and the latest result per kind',
  '  /report         print the evidence report for this session',
  '  /map            print the workspace map the model receives',
  '  /quit           end the session (Ctrl+D on an empty line also works)',
  'keys: Ctrl+C interrupts the running turn; at the idle prompt press it twice to quit.',
  'note: shell commands always ask; their effects are never undoable.',
  'note: /cancel <task> ends one child; Ctrl+C aborts the whole turn (every task included).',
  'note: @plan <request> routes a request into plan mode (plan first, no execution until approved).',
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

/** The one-line completion summary used by /status and the quit path. */
export function completionLine(ctx: Pick<CommandContext, 'session' | 'layout'>): string {
  const { acc } = sessionAcceptance(ctx);
  const acceptedBit =
    acc.accepted !== null
      ? ` · accepted (${acc.accepted.complete ? 'complete' : 'partial'})${acc.acceptedStale ? ' — work has happened since' : ''}`
      : ' · not accepted';
  return `completion: ${acc.summary}${acceptedBit}`;
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
      let turns = 0;
      for (const e of s.log.events) {
        if (e.type === 'assistant.message') {
          inTok += e.usage.inputTokens;
          outTok += e.usage.outputTokens;
          cacheRead += e.usage.cacheReadInputTokens ?? 0;
          cacheWrite += e.usage.cacheCreationInputTokens ?? 0;
        } else if (e.type === 'user.message') turns++;
      }
      const cache = cacheRead + cacheWrite > 0 ? ` (cache: ${cacheRead} read / ${cacheWrite} written)` : '';
      ctx.renderer.chromeLine(
        [
          `session ${s.id} (${s.mode})`,
          `  workspace: ${sanitizeLine(s.workspaceRoot)}`,
          `  model: ${s.model} · provider: ${s.provider.name}`,
          `  user messages: ${turns} · tokens: ${inTok} in / ${outTok} out${cache}`,
          `  ${completionLine(ctx)}`,
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

      // The recorded consent. complete=false only through the explicit confirm path.
      ctx.session.log.append({
        type: 'session.accepted',
        complete: acc.complete,
        summary: acc.summary,
        ...(acc.unfinished.length > 0 ? { unfinished: acc.unfinished } : {}),
      });
      ctx.pendingNotes.push(
        acc.complete
          ? 'the user ACCEPTED the session result as COMPLETE (/accept). Treat the delivered work as accepted; do not re-run plan tasks.'
          : `the user recorded a PARTIAL acceptance (/accept confirm) with ${acc.unfinished.length} known unfinished item(s). Do not silently resume that work — ask before continuing it.`,
      );

      // Cleanup (a): prune this session's task-base refs now (idempotent; the quit path's
      // prune then finds an empty owed list).
      if (ctx.pruneTaskBaseRefs !== undefined) {
        try {
          const pruneLine = await ctx.pruneTaskBaseRefs();
          if (pruneLine !== null) ctx.renderer.chromeLine(`  checkpoints: ${pruneLine}`);
        } catch {
          /* best-effort hygiene — acceptance itself is already recorded */
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
              (t.childSessionId !== null ? ` · child ${sanitizeLine(t.childSessionId.slice(-4))}` : '') +
              (t.attempts > 1 ? ` · attempt ${t.attempts}` : '') +
              (t.note !== undefined ? ` · ${sanitizeLine(t.note)}` : ''),
          );
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
      const files = buildSessionDiff(ctx.session.log.events, ctx.session.snapshots, ctx.session.workspaceRoot);
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
      if (r.ok && r.ref && r.oid) {
        ctx.session.log.append({ type: 'git.checkpoint', ref: r.ref, oid: r.oid, label: label ?? null, filesChanged: r.filesChanged ?? 0 });
      } else {
        ctx.renderer.chromeLine(`  checkpoint not created: ${r.error}`);
      }
      return 'continue';
    }

    case 'report': {
      const { md } = buildReport({ events: ctx.session.log.events });
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

    case 'checks': {
      // What this workspace can actually be verified with, plus what has been verified so far.
      // Re-detected on demand so the surface never shows a stale project (an install or a new
      // tsconfig changes the answer, and the user asking is exactly when freshness matters).
      ctx.renderer.flush();
      const lines: string[] = [];
      if (ctx.checkTool !== undefined) {
        lines.push(...describeProject(ctx.checkTool.refresh()));
      } else {
        lines.push('typed checks are unavailable in this session');
      }
      const latest = new Map<string, Extract<(typeof ctx.session.log.events)[number], { type: 'check.completed' }>>();
      for (const e of ctx.session.log.events) if (e.type === 'check.completed') latest.set(e.check, e);
      lines.push('', latest.size > 0 ? 'latest result per kind:' : 'no checks have run in this session yet');
      for (const [kind, e] of latest) {
        lines.push(`  ${kind}: ${e.status} — ${sanitizeLine(e.summary)}`);
      }
      lines.push('', `checks run this session: ${ctx.checkCaps?.checksRun ?? 0}/${CHECKS_PER_SESSION}`);
      ctx.modelOut.write(lines.join('\n') + '\n');
      return 'continue';
    }

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
