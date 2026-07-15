import readline from 'node:readline/promises';
import { resolveStateRoot } from '../store/layout.js';
import { askConsent, ensureTrusted, type TrustDecision } from '../trust/gate.js';
import type { CliValues } from './context.js';

/**
 * The trust gate for every session-starting command (one-shot and REPL). The consent prompt is
 * offered only on a REAL TTY — a piped "t" answered into a prompt nobody read is not consent, so
 * forced-interactive (piped) runs must pass --trust-this-workspace or pre-record consent with
 * `agent trust`.
 */
export async function checkTrust(values: CliValues, ws: string): Promise<TrustDecision> {
  const stateRoot = resolveStateRoot();
  const trustFlag = values['trust-this-workspace'] === true;
  if (!process.stdin.isTTY || values['no-input']) {
    return await ensureTrusted({ workspaceReal: ws, stateRoot, trustFlag });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    // askConsent settles on Ctrl+D/Ctrl+C too ('' = declined) — a dangling question promise
    // would otherwise drain the event loop and exit 0, which a script reads as success.
    return await ensureTrusted({ workspaceReal: ws, stateRoot, trustFlag, question: (q) => askConsent(rl, q) });
  } finally {
    rl.close();
  }
}
