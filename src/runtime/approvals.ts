import readline from 'node:readline/promises';
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

/** Render an approval request as a human-readable block for the terminal. */
export function formatApprovalPrompt(req: ApprovalRequest): string {
  const lines = [
    '',
    `  ⚠ approval required  [${req.classification}]  ${req.tool}`,
    `  ${req.summary}`,
  ];
  if (req.detail && req.detail !== req.summary) {
    for (const l of req.detail.split('\n').slice(0, 12)) lines.push(`    ${l}`);
  }
  lines.push(`  reason: ${req.reason}`);
  if (req.noUndoWarning) lines.push('  ⚠ this action is NOT undoable');
  lines.push('  [y] allow once   [s] allow for the rest of this session   [n] deny   [q] deny & stop');
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
 */
export function createInteractiveApprover(io?: { question: (q: string) => Promise<string> }): Approver {
  return async (req: ApprovalRequest): Promise<ApprovalOutcome> => {
    const prompt = formatApprovalPrompt(req) + '\n  > ';
    if (io) return parseAnswer(await io.question(prompt));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return parseAnswer(await rl.question(prompt));
    } finally {
      rl.close();
    }
  };
}
