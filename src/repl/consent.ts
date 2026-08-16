import { prepareCommit } from '../git/commit.js';
import { readPlanState } from '../plan/canonical.js';
import { foldGraphState } from '../plan/graph-state.js';
import { foldRepairs, type RepairLedger } from '../recovery/ledger.js';
import { lastWorkSeq } from '../runtime/acceptance.js';
import { sanitizeLine } from '../shared/text.js';
import type { SessionEvent } from '../types.js';
import {
  acceptSession,
  approvePlanCanonical,
  dismissEscalation,
  dispatchSlash,
  resolvedRepairTargets,
  sessionAcceptance,
  type CommandContext,
} from './commands.js';
import { askChoice, type PromptChoice } from './prompt-choice.js';

/**
 * Contextual consent (Session 21.5) — asking at the moment a decision is needed, instead of
 * requiring the user to remember a lifecycle command.
 *
 * The problem this closes is on the record. `planApprovalReminder` was written after a live run in
 * which the agent amended its own approved plan on the first step of a build turn, every isolated
 * executor spawn was silently refused, and the human found out ten minutes later when `/accept`
 * refused. The harness had said so — in the tool result, and again in the standing note every turn
 * — to the MODEL, which cannot type `/plan approve`. A line is a broadcast with no channel; a
 * question has an answer.
 *
 * Four rules hold the design together:
 *
 * 1. **TTY only.** On non-TTY input `io.question` ignores its `fresh` flag and consumes the
 *    driver's next queued line, so a prompt here would eat a scripted `/quit`. Piped and headless
 *    runs keep the explicit commands, which is why S21.5 DEMOTED `/accept` and `/plan approve`
 *    rather than removing them.
 * 2. **One prompt per turn boundary**, precedence B > A > D > C. Two consecutive consent questions
 *    is a wizard, and a wizard trains people to press Enter through it. Rarity buys the attention
 *    this design spends.
 * 3. **Once per state.** The memory is keyed on DERIVED state (a plan's content sha, the newest
 *    work seq, an escalation's seq), so a decline is remembered until the thing being asked about
 *    genuinely changes. Arming is derived; the decline is deliberately NOT persisted, because a
 *    decline appends nothing and inventing a `consent.declined` event would write a non-decision
 *    into the evidence log for `/report`, the journal and `computeAcceptance` to interpret.
 * 4. **Zero appends of its own.** Every affirmative answer calls the same extracted body the slash
 *    command calls, so the recorded evidence is byte-identical whether the user typed or answered.
 */

export interface ConsentGate {
  /** `streams.isTTY && mode === 'interactive'` — both, see rule 1 and the `--no-input` case. */
  enabled: boolean;
  /** False when the turn ended in the catch: C and D are suppressed, A and B still fire. */
  turnOk: boolean;
  /** A Ctrl+C'd turn rejects the provider call into the same catch. Never question an abort. */
  aborted: boolean;
  /**
   * S22 — which boundary this ask sits on (default 'turn'). Condition C's trigger was the
   * recorded S21.6 pressure: in a PLAN-LESS session `computeAcceptance` is complete after any
   * mutating turn, so the completion question re-armed on every one — the exact noise rule 2
   * exists to prevent. The delivery-shaped boundaries differ by session shape: an APPROVED PLAN
   * completing is a delivery boundary, so plan-carrying sessions keep the turn-boundary offer;
   * plan-less work has no such moment, so its one honest boundary is the user saying they are
   * done — the typed /quit (never EOF, never a double-Ctrl+C: walking away is not a consent
   * moment). B, A and D stay turn-only — approving a plan while leaving makes no sense.
   */
  boundary?: 'turn' | 'quit';
}

export interface ConsentAsker {
  maybeAsk(ctx: CommandContext, gate: ConsentGate): Promise<void>;
  /** Test seam: which state keys have been asked about in this process life. */
  askedKeys(): string[];
}

/** A plan whose approval a user has never given, with executor work waiting on it. */
export function planReadyForApproval(
  ctx: CommandContext,
): { objective: string; tasks: number; executors: number; contentSha: string } | null {
  try {
    const state = readPlanState(ctx.layout, ctx.session.id, ctx.session.log.events);
    if (state.kind !== 'canonical') return null;
    // Exactly one clause separates this from `planReapprovalNeeded`: there, an approval EXISTED
    // and no longer covers the plan; here, none was ever given. Keeping the difference to one
    // clause is what lets a reviewer verify the two are disjoint at a glance.
    if (state.approvedSha !== null) return null;
    if (state.status !== 'draft' && state.status !== 'approved') return null;
    const doc = state.canonical;
    if (doc === null || doc === undefined) return null;
    const graph = doc.graph ?? null;
    if (graph === null || doc.contentSha === null) return null;
    const executors = graph.tasks.filter((t) => t.role === 'executor');
    if (executors.length === 0) return null;
    return {
      objective: graph.objective,
      tasks: graph.tasks.length,
      executors: executors.length,
      contentSha: doc.contentSha,
    };
  } catch {
    return null;
  }
}

/**
 * The predicate behind the re-approval reminder. Shared by the off-TTY LINE and the on-TTY PROMPT
 * so one derivation drives both. Never throws: a plan problem must not end a turn.
 */
export function planReapprovalNeeded(
  ctx: CommandContext,
): { why: string; waiting: string[]; contentSha: string | null } | null {
  try {
    const state = readPlanState(ctx.layout, ctx.session.id, ctx.session.log.events);
    if (state.kind !== 'canonical' || state.approvedAndCurrent) return null;
    if (state.status === 'superseded') return null;
    // A plan that was NEVER approved is the ordinary post-planning state — the model has just
    // written it and is presenting it in the same breath. The dangerous state is narrower: an
    // approval EXISTED and no longer covers the plan, which a user cannot see coming because
    // nothing about the screen changed when it happened. The never-approved case is covered by
    // `planReadyForApproval` above, as a question rather than a warning.
    if (state.approvedSha === null) return null;
    const graph = state.canonical?.graph ?? null;
    if (graph === null) return null;
    const executors = graph.tasks.filter((t) => t.role === 'executor');
    if (executors.length === 0) return null;
    const fold = foldGraphState(graph, ctx.session.log.events);
    const waiting = executors.filter((t) => fold.byId.get(t.id)?.state !== 'completed').map((t) => t.id);
    if (waiting.length === 0) return null;
    return {
      why: state.diverged
        ? 'the plan changed after you approved it, so the approval no longer covers it'
        : `the plan is ${state.status}`,
      waiting,
      contentSha: state.currentSha ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Whether there is a RESULT worth recording consent about.
 *
 * Required, not defensive: `computeAcceptance` returns `complete: true` for a session with no plan
 * and no captures, so without this every turn of an ordinary conversation would end by asking
 * "accept the session?" — the exact noise trap this whole design exists to avoid. It changes
 * nothing about `/accept` itself; a typed `/accept` in a conversation-only session still records.
 * The harness simply declines to VOLUNTEER the question.
 */
function acceptanceIsMeaningful(ctx: CommandContext, events: readonly SessionEvent[]): boolean {
  const state = readPlanState(ctx.layout, ctx.session.id, events);
  if (state.kind === 'canonical' && state.status === 'approved') return true;
  return events.some((e) => e.type === 'file.mutated' || e.type === 'task.applied' || e.type === 'git.commit');
}

/** A session a typed `/accept` would accept cleanly right now — neither a no-op nor a refusal. */
export function completionReady(ctx: CommandContext): { summary: string; caveats: string[]; key: string } | null {
  try {
    const { acc } = sessionAcceptance(ctx);
    if (!acc.complete) return null;
    // Precisely the negation of /accept's idempotence guard.
    if (acc.accepted !== null && !acc.acceptedStale) return null;
    if (!acceptanceIsMeaningful(ctx, ctx.session.log.events)) return null;
    return { summary: acc.summary, caveats: acc.caveats, key: `accept:${lastWorkSeq(ctx.session.log.events)}` };
  } catch {
    return null;
  }
}

/** The newest escalation that is open and not resolved by evidence — the one the agent stopped on. */
export function openEscalation(
  ctx: CommandContext,
): { esc: RepairLedger['escalations'][number]; ledger: RepairLedger } | null {
  try {
    const ledger = foldRepairs(ctx.session.log.events);
    const resolved = resolvedRepairTargets(ctx);
    const open = ledger.escalations.filter((e) => e.open && !resolved.has(e.target));
    const esc = open.at(-1);
    return esc === undefined ? null : { esc, ledger };
  } catch {
    return null;
  }
}

/**
 * Whether an "accept and commit" is worth offering, and for how many files (Session 21.6).
 *
 * The commit is the one delivery action a human genuinely owns — the model has no path to it, by
 * an invariant this session deliberately did not widen — and until now the acceptance boundary
 * announced it as a printed line. That is the same broadcast-with-no-channel `planApprovalReminder`
 * was, one surface over.
 *
 * It is folded INTO the completion prompt rather than asked after it. `acceptSession` is called
 * from inside condition C's own affirmative branch, so a prompt appended there would be two
 * consecutive consent questions — exactly the wizard rule 2 forbids. One prompt, one answer.
 *
 * Offered only when a commit would actually succeed: a repository, attributable paths, and no
 * blockers. Offering an action that refuses the moment it is chosen is worse than not offering it.
 * Never throws — a git problem must not cost the user the acceptance question.
 */
async function commitOffer(ctx: CommandContext): Promise<{ files: number } | null> {
  try {
    const g = ctx.session.gitFacts;
    if (g?.isRepo !== true || g.gitPath === null || g.repoRoot === null) return null;
    const preview = await prepareCommit(
      { gitPath: g.gitPath, repoRoot: g.repoRoot, workspaceRoot: ctx.session.workspaceRoot, messageDir: ctx.session.stateDir },
      ctx.session.log.events,
      'session',
    );
    if (preview.blockers.length > 0) return null;
    const files = preview.stagePaths?.length ?? 0;
    return files > 0 ? { files } : null;
  } catch {
    return null;
  }
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function createConsentAsker(): ConsentAsker {
  // One process life, one Set. See rule 3 on why this is not an event.
  const asked = new Set<string>();

  async function askOnce<K extends string>(
    ctx: CommandContext,
    header: string,
    choices: readonly PromptChoice<K>[],
    declineLabel: string,
    /** Keys that print something and re-ask; each may be used once per prompt. */
    review: Partial<Record<K, string>>,
  ): Promise<K | null> {
    const ask = ctx.question;
    if (ask === undefined) return null;
    const spent = new Set<K>();
    for (;;) {
      // S22: the select surface when the REPL wired one (TTY), the line grammar otherwise.
      // Both return the same PromptAnswer contract, so everything downstream — review keys,
      // anti-nag, null-means-do-nothing — is indifferent to which surface answered.
      const answer =
        ctx.askSelect !== undefined
          ? await ctx.askSelect(header, choices, declineLabel)
          : await askChoice(ask, header, choices, declineLabel);
      if (answer.key === null) return null;
      const cmd = review[answer.key];
      if (cmd !== undefined && !spent.has(answer.key)) {
        spent.add(answer.key);
        await dispatchSlash(cmd, ctx);
        continue; // re-ask once; a view that loops forever is the nag by another door
      }
      if (cmd !== undefined) return null; // asked to look twice — stop rather than badger
      return answer.key;
    }
  }

  return {
    askedKeys: () => [...asked],

    async maybeAsk(ctx: CommandContext, gate: ConsentGate): Promise<void> {
      if (!gate.enabled || gate.aborted || ctx.question === undefined) return;
      const boundary = gate.boundary ?? 'turn';

      // Precedence B > A > D > C, at most ONE prompt per boundary. A condition whose key has
      // already been asked FALLS THROUGH to the next one rather than ending the boundary —
      // otherwise a declined plan prompt would permanently mask the escalation and completion
      // prompts standing behind it, and the user would never be asked about them at all.
      // At the QUIT boundary only C is evaluated (see the gate's boundary doc).
      //
      // ── B: an approval existed and no longer covers the plan ────────────────────────────────
      const reapprove = boundary === 'turn' ? planReapprovalNeeded(ctx) : null;
      const reapproveKey = `plan-reapprove:${reapprove?.contentSha ?? 'unreadable'}`;
      if (reapprove !== null && !asked.has(reapproveKey)) {
        asked.add(reapproveKey);
        const picked = await askOnce(
          ctx,
          [
            `plan: ${reapprove.why}.`,
            `isolated executor task(s) ${reapprove.waiting.join(', ')} CANNOT run until you re-approve.`,
          ].join('\n'),
          [
            { key: 'y', label: 're-approve the current plan' },
            { key: 'v', label: 'show the plan first' },
            { key: 'n', label: 'not now' },
          ] as const,
          'not now',
          { v: '/plan' },
        );
        if (picked === 'y') {
          await approvePlanCanonical(ctx, readPlanState(ctx.layout, ctx.session.id, ctx.session.log.events));
        }
        return;
      }

      // ── A: a plan is ready and has never been approved ──────────────────────────────────────
      const ready = boundary === 'turn' ? planReadyForApproval(ctx) : null;
      const readyKey = `plan-ready:${ready?.contentSha ?? 'unreadable'}`;
      if (ready !== null && !asked.has(readyKey)) {
        asked.add(readyKey);
        const picked = await askOnce(
          ctx,
          [
            `plan ready: ${clip(sanitizeLine(ready.objective), 120)}`,
            `${ready.tasks} task(s), ${ready.executors} isolated executor task(s) that CANNOT run until you approve.`,
          ].join('\n'),
          [
            { key: 'y', label: 'approve' },
            { key: 'v', label: 'show the plan first' },
            { key: 'n', label: 'not now' },
          ] as const,
          'not now',
          { v: '/plan' },
        );
        if (picked === 'y') {
          await approvePlanCanonical(ctx, readPlanState(ctx.layout, ctx.session.id, ctx.session.log.events));
        }
        return;
      }

      if (!gate.turnOk) return;

      // ── D: an open escalation blocks acceptance, and only the user can close it ─────────────
      const escalated = boundary === 'turn' ? openEscalation(ctx) : null;
      const escalationKey = `escalation:${escalated?.esc.seq ?? 0}`;
      if (escalated !== null && !asked.has(escalationKey)) {
        {
          asked.add(escalationKey);
          const picked = await askOnce(
            ctx,
            [
              `repair: the agent stopped and escalated '${sanitizeLine(escalated.esc.target)}' (${escalated.esc.failureClass})`,
              clip(sanitizeLine(escalated.esc.reason), 160),
              'This blocks accepting the session; only you can close it.',
            ].join('\n'),
            // The affirmative key is `d`, not `y`, and the break in uniformity is deliberate:
            // there is no "yes" to an escalation, and letting a dismissal share a muscle-memory
            // letter with "approve the plan" is how one gets closed that was meant to be read.
            [
              { key: 'r', label: 'show the repair ledger' },
              { key: 'd', label: 'dismiss it (a reason is required)' },
              { key: 'n', label: 'leave it open' },
            ] as const,
            'leave it open',
            { r: '/repair' },
          );
          if (picked === 'd') {
            const reason = await ctx.question(
              '\n  reason (recorded as evidence and kept as an acceptance caveat)\n  > ',
            );
            // Empty or EOF appends nothing — the same refusal the typed command gives.
            if (reason !== null && reason.trim().length > 0) {
              dismissEscalation(ctx, escalated.esc, reason.trim(), escalated.ledger);
            } else {
              ctx.renderer.chromeLine('  not dismissed: a reason is required (nothing was recorded)');
            }
          }
          return;
        }
      }

      // ── C: the session is finishable ────────────────────────────────────────────────────────
      // At the TURN boundary, only where an approved plan makes completion a delivery boundary;
      // plan-less sessions are asked once, at the typed /quit (S22 — the recorded S21.6 nag).
      // Legacy plans count: a resumed pre-canonical session with an approved plan kept its
      // turn-boundary offer before S22 and keeps it now (review finding).
      let planCarrying = false;
      try {
        const st = readPlanState(ctx.layout, ctx.session.id, ctx.session.log.events);
        planCarrying = (st.kind === 'canonical' || st.kind === 'legacy') && st.status === 'approved';
      } catch {
        // An unreadable plan state must not become a completion question at the turn boundary;
        // at the typed /quit the session reads as plan-less and the header claims accordingly.
        if (boundary === 'turn') return;
      }
      if (boundary === 'turn' && !planCarrying) return;
      const done = completionReady(ctx);
      if (done !== null && !asked.has(done.key)) {
        asked.add(done.key);
        const offer = await commitOffer(ctx);
        const picked = await askOnce(
          ctx,
          [
            // The plan sentence must not print for a PLAN-LESS quit-boundary session — there is
            // no plan and no gates, and the derived summary right below would contradict it.
            planCarrying
              ? 'session: everything the plan declares is done and the gates are green.'
              : "session: this session's work is ready to accept.",
            clip(sanitizeLine(done.summary), 200),
            // Caveats print BEFORE the keys. A "complete" that hides waived gates is the exact
            // overclaim `computeAcceptance` maintains a caveat list to prevent, and a
            // one-keystroke accept must not be the surface that first hides them.
            ...done.caveats.slice(0, 4).map((c) => `caveat: ${clip(sanitizeLine(c), 160)}`),
            ...(done.caveats.length > 4 ? [`(${done.caveats.length - 4} more — /status)`] : []),
          ].join('\n'),
          [
            { key: 'y', label: 'accept the session' },
            ...(offer !== null ? [{ key: 'c' as const, label: `commit the ${String(offer.files)} file(s) this session changed, then accept` }] : []),
            { key: 'd', label: 'show what changed' },
            { key: 'n', label: 'not yet' },
          ] as readonly PromptChoice<'y' | 'c' | 'd' | 'n'>[],
          'not yet',
          { d: '/diff' },
        );
        if (picked === 'y' || picked === 'c') {
          // COMMIT FIRST, then accept — the order is the fix for a real defect, not a preference.
          // `git.commit` is a member of `WORK_EVENT_TYPES`, so accepting and then committing makes
          // the acceptance stale the instant the harness's own recommended answer completes: the
          // prompt re-arms, `/status` reports "work has happened since", and the journal writes
          // that sentence into durable cross-session memory about a session whose only post-accept
          // event was the delivery it just performed. Recording the acceptance LAST keeps it the
          // final word, and the delivery checkpoint then captures the committed tree.
          //
          // The commit runs through the SAME slash body a user would type, which is what keeps the
          // recorded evidence byte-identical either way — and it keeps its own preview and
          // confirmation, so this answer routes to the decision rather than replacing it.
          if (picked === 'c') {
            const before = ctx.session.log.events.length;
            await dispatchSlash('/commit', ctx);
            // The answer promised commit-THEN-accept. A commit cancelled at its message or
            // confirm prompt (or refused by a blocker) appended no `git.commit`, and recording
            // the acceptance anyway would mint `session.accepted` for a delivery that never
            // happened. The state key was already marked asked, so this stays nag-free.
            if (!ctx.session.log.events.slice(before).some((e) => e.type === 'git.commit')) {
              ctx.renderer.chromeLine(
                '  not accepted: the commit did not complete — /accept records the acceptance when you are ready',
              );
              return;
            }
          }
          await acceptSession(ctx, { confirm: false });
        }
      }
    },
  };
}
