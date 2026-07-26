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
    for (const l of req.detail.split('\n').slice(0, 12)) lines.push(`    ${sanitizeLine(l)}`);
  }
  lines.push(`  reason: ${req.reason}`);
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
  const grantable = isGrantable(req.classification) && req.kind !== 'command' && req.kind !== 'check' && req.kind !== 'preview';
  const forwarded = req.taskContext !== undefined;
  const sPart =
    req.kind === 'check'
      ? // Count what it actually grants: one keystroke stores replay consent for EVERY command in
        // the batch, and a prompt that says "this command" while granting three is a lie.
        `   [s] allow re-runs of ${(req.checkCount ?? 1) > 1 ? `THESE ${String(req.checkCount)} EXACT commands` : 'THIS EXACT command'}`
      : req.kind === 'preview'
        ? // A preview [s] consents to RE-STARTS of the exact command(s) (body-bound, this session
          // only) — not to any other script, and not across sessions (grants are never restored).
          `   [s] allow re-starts of ${(req.checkCount ?? 1) > 1 ? `THESE ${String(req.checkCount)} EXACT commands` : 'THIS EXACT command'} this session`
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
