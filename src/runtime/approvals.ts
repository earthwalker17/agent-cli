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
  const cls = req.kind === 'command' ? `[shell command — labeled ${req.classification}]` : `[${req.classification}]`;
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
  // [s] is shown only when a session grant can actually be stored — offering a no-op option
  // on a non-grantable class would misrepresent what pressing it does.
  lines.push(
    isGrantable(req.classification)
      ? '  [y] allow once   [s] allow for the rest of this session   [n] deny   [q] deny & stop'
      : req.taskContext !== undefined
        ? '  [y] allow once   [n] deny   [q] deny & stop THIS TASK (the rest of the turn continues)'
        : '  [y] allow once   [n] deny   [q] deny & stop',
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
