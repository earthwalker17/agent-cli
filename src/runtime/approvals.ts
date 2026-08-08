import readline from 'node:readline/promises';
import { sanitizeLine } from '../shared/text.js';
import { isGrantable } from '../policy/engine.js';
import type { ApprovalOutcome, ApprovalRequest, Approver } from '../types.js';

/** Non-interactive mode: every `ask` becomes a recorded denial (fails safe). */
export const autoDenyApprover: Approver = async () => ({
  decision: 'deny',
  scope: 'once',
  source: 'non-interactive',
});

/** --dangerously-allow-all: every `ask` becomes an allow (loud, and logged as such). */
export const dangerousApprover: Approver = async () => ({
  decision: 'allow',
  scope: 'once',
  source: 'dangerous-mode',
});

/**
 * Render an approval request as a human-readable block for the terminal. The summary/detail come
 * from UNTRUSTED model output (the proposed command string); they are sanitized so embedded
 * ANSI/bidi/control characters cannot visually rewrite the very prompt that gates execution.
 */
/** Detail lines rendered before truncation. Kept small so a prompt stays readable at a glance. */
const DETAIL_LINE_CAP = 12;

export function formatApprovalPrompt(req: ApprovalRequest): string {
  // For a shell command the class is only a best-effort LABEL (string matching over untrusted
  // model output, bypassable by design) — the header must say so, not present it as a verdict
  // that visually contradicts the NOT-undoable warning ("[observe]" next to "NOT undoable").
  const cls =
    req.kind === 'command'
      ? `[shell command — labeled ${req.classification}]`
      : req.kind === 'check'
        ? '[typed check — harness-resolved command]'
        : req.kind === 'preview'
          ? '[preview server — harness-resolved command; KEEPS RUNNING]'
          : req.kind === 'setup'
            ? // The third distinct consequence: an install fetches and RUNS third-party code;
              // a migration writes local data nothing here can undo. The class is real, not a
              // best-effort label, so it belongs in the header beside the shape.
              `[project setup — harness-resolved command; ${req.classification}]`
            : req.kind === 'research'
              ? // The fourth distinct consequence, and the only one that is not about running
                // something HERE. Nothing on this machine changes — text goes OUT. The header says
                // LEAVE THIS MACHINE because "[external]" alone reads like a severity label, and
                // the question the human is actually answering is "may this text be sent there".
                // Worded to cover both doors: a direct search, and spawning the subagent that will
                // run many of them.
                '[web research — queries LEAVE THIS MACHINE; read-only, nothing here is written]'
              : req.kind === 'remote-read'
                ? // Session 20, the fifth consequence. Like research it leaves the machine, and
                  // unlike research it AUTHENTICATES — it tells a third party which account is
                  // looking. The header says so, because "[external]" does not.
                  '[remote READ — contacts the remote under your existing credential; nothing here is written]'
                : req.kind === 'remote-write'
                  ? // The sixth, and the only one in this harness that changes state on a machine
                    // the user does not own. The header leads with the verb and with what cannot be
                    // taken back; the detail lines below carry the exact destination and effect.
                    // `destructive` appears in the header only when the effect really is one, so
                    // the word keeps meaning something.
                    `[remote WRITE — changes state on the remote; NOT undoable from here${req.classification === 'destructive' ? '; OVERWRITES remote state' : ''}]`
                  : `[${req.classification}]`;
  const lines = [
    '',
    `  ⚠ approval required  ${cls}  ${req.tool}`,
  ];
  // Forwarded child asks carry the task identity: the human must know WHICH agent is asking
  // and that a command would run inside that task's isolated worktree — not the workspace.
  if (req.taskContext !== undefined) {
    lines.push(`  from delegated task: ${sanitizeLine(req.taskContext.role)} (child session ${sanitizeLine(req.taskContext.childSessionId)})`);
    if (req.kind === 'command') {
      lines.push('  the command would run in the task\'s ISOLATED WORKTREE — but approved commands run UNSANDBOXED with full privilege (reads/network are not confined to the worktree)');
    }
  }
  lines.push(`  ${sanitizeLine(req.summary)}`);
  if (req.detail && req.detail !== req.summary) {
    const all = req.detail.split('\n');
    for (const l of all.slice(0, DETAIL_LINE_CAP)) lines.push(`    ${sanitizeLine(l)}`);
    // The cap drops the TAIL, and the tail is where the composed command and the allowance live.
    // Silently eliding them let a detail line count — which a tool can inflate from model-authored
    // text — evict the lines a human most needs (S20 review). Truncation is now visible.
    if (all.length > DETAIL_LINE_CAP) {
      lines.push(`    ⚠ ${String(all.length - DETAIL_LINE_CAP)} further detail line(s) NOT shown — see the reason below and /report for the full record`);
    }
  }
  // The reason embeds untrusted model text for command asks (analyzeCommand quotes the
  // executable and offending arguments), so it needs the same escaping as every other line —
  // a bidi override here would reverse the very line stating that approved commands run
  // unsandboxed and un-undoable (S14.5 review finding).
  lines.push(`  reason: ${sanitizeLine(req.reason)}`);
  if (req.noUndoWarning) lines.push('  ⚠ this action is NOT undoable');
  // [s] is shown only when a session grant would actually be STORED: the class must be
  // grantable AND the request must not be a shell command — grant enforcement refuses
  // command-bearing tools (a command's class is a best-effort label over untrusted text,
  // never a fact to key standing permission on). The live V0.7 E2E surfaced the old gap: an
  // 'external'-labeled forwarded command offered a no-op [s]. Forwarded asks always explain
  // that [q] stops THAT task only, and a forwarded [s] grant lives and dies with the child.
  // A typed check offers a DIFFERENT [s] (Session 12): consent to re-run those exact
  // harness-resolved commands, never a class-scoped session grant. Distinct wording matters —
  // the two consents cover different things and must not read as the same promise.
  // 'setup' joins the exclusion for the same reason as 'check'/'preview': its consent lives in the
  // replay store, not in a class-scoped grant. Note an install IS classified `external`, which IS
  // grantable — so without this exclusion a session grant keyed (project_setup, external) would be
  // stored and then never read, standing authority won by a label. The [s] below is offered off
  // the KEYS instead, which is what makes a migration (no keys) show no [s] at all.
  // 'remote-write' joins the exclusion, and for the strongest reason on the list (Session 20). A
  // non-overwriting publish is classified `external`, which IS grantable — so without this the
  // prompt would offer `[s]` for "allow for the rest of this session" on an operation whose whole
  // design is that it asks every single time. The engine never consults a grant in that branch and
  // the runtime never stores one; this is the third place the same sentence is written, because a
  // consent surface that disagrees with itself is how standing authority gets won by accident.
  const grantable =
    isGrantable(req.classification) &&
    req.kind !== 'command' &&
    req.kind !== 'check' &&
    req.kind !== 'preview' &&
    req.kind !== 'setup' &&
    req.kind !== 'remote-write';
  const forwarded = req.taskContext !== undefined;
  const sPart =
    req.kind === 'setup'
      ? req.checkCount === undefined
        ? '' // migrate/seed, or an unhashable lockfile: nothing would be stored, so nothing is offered
        : '   [s] allow re-runs of THIS EXACT install while the lockfile is unchanged'
      : req.kind === 'check'
      ? // Count what it actually grants: one keystroke stores replay consent for EVERY command in
        // the batch, and a prompt that says "this command" while granting three is a lie.
        `   [s] allow re-runs of ${(req.checkCount ?? 1) > 1 ? `THESE ${String(req.checkCount)} EXACT commands` : 'THIS EXACT command'}`
      : req.kind === 'preview'
        ? // A preview [s] consents to RE-STARTS of the exact command(s) (body-bound, this session
          // only) — not to any other script, and not across sessions (grants are never restored).
          `   [s] allow re-starts of ${(req.checkCount ?? 1) > 1 ? `THESE ${String(req.checkCount)} EXACT commands` : 'THIS EXACT command'} this session`
        : req.kind === 'research'
          ? // A research [s] IS a real class-scoped grant (unlike check/preview/setup, whose
            // consent lives in the replay store), so it is offered — but the wording must name
            // what actually bounds it. "Allow for the rest of this session" would read as an open
            // line to the internet; the truth is that the session research budget is the ceiling,
            // and the reason line above states what remains of it.
            '   [s] allow further research this session, within the session budget'
          : req.kind === 'remote-read'
            ? // A remote-read [s] IS a real class-scoped grant, bounded by the session read
              // allowance the reason line above states. The wording names what it does NOT cover,
              // because "allow remote access this session" is exactly the sentence a user would
              // later believe had covered the push.
              '   [s] allow further remote READS this session (never a push, tag or release)'
            : grantable
            ? forwarded
              ? '   [s] allow for the rest of THIS TASK'
              : '   [s] allow for the rest of this session'
            : '';
  lines.push(
    `  [y] allow once${sPart}   [n] deny   ` +
      (forwarded ? '[q] deny & stop THIS TASK (the rest of the turn continues)' : '[q] deny & stop'),
  );
  return lines.join('\n');
}

function parseAnswer(answer: string): ApprovalOutcome {
  switch (answer.trim().toLowerCase()[0]) {
    case 'y':
      return { decision: 'allow', scope: 'once', source: 'user' };
    case 's':
      return { decision: 'allow', scope: 'session', source: 'user' };
    case 'q':
      return { decision: 'deny-stop', scope: 'once', source: 'user' };
    default:
      return { decision: 'deny', scope: 'once', source: 'user' };
  }
}

/**
 * Interactive approver. `io.question` is injectable so tests can drive it without a TTY; the
 * default uses readline on stdin/stdout. The prompt fully pauses the loop (strictly sequential).
 * `signal` (the one-shot's turn-abort controller, V0.7.1): Ctrl+C during a pending default-
 * readline question resolves it as deny-stop instead of leaving the prompt hanging — the REPL
 * path (io) has its own interrupt wiring and ignores it.
 */
export function createInteractiveApprover(io?: { question: (q: string) => Promise<string> }, signal?: AbortSignal): Approver {
  return async (req: ApprovalRequest): Promise<ApprovalOutcome> => {
    const prompt = formatApprovalPrompt(req) + '\n  > ';
    if (io) return parseAnswer(await io.question(prompt));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(prompt, signal !== undefined ? { signal } : {});
      return parseAnswer(answer);
    } catch (err) {
      if (signal?.aborted) return { decision: 'deny-stop', scope: 'once', source: 'user' };
      throw err;
    } finally {
      rl.close();
    }
  };
}
