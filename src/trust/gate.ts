import { isInside } from '../shared/pathutil.js';
import { sanitizeLine } from '../shared/text.js';
import { ConfigError } from '../shared/errors.js';
import { isTrusted, grantTrust } from './store.js';

/**
 * The workspace-trust gate: the consent check that must pass before the harness reads ANY byte
 * of a workspace (config, .gitignore, the map) or sends anything to a model provider.
 *
 * What trust means, exactly: the user consented to the agent operating in this folder — reading
 * files here into the model, and creating/editing files here under the normal policy rules.
 * What it does NOT mean: any form of isolation. Trust is recorded consent, not a sandbox.
 */

export type TrustSource = 'store' | 'prompt-remember' | 'prompt-once' | 'flag';

export type TrustDecision = { trusted: true; source: TrustSource } | { trusted: false; reason: string };

export interface TrustGateOptions {
  workspaceReal: string;
  stateRoot: string;
  /** --trust-this-workspace: explicit per-invocation consent. Never persisted. */
  trustFlag: boolean;
  /**
   * Prompt io for the consent question. Callers must supply this ONLY when a human is actually
   * present (a real TTY) — a piped "t" answered into a prompt nobody read is not consent, so
   * forced-interactive (piped) runs must use the explicit flag instead.
   */
  question?: (q: string) => Promise<string>;
}

export function trustPrompt(workspaceReal: string): string {
  return [
    '',
    'This folder is not yet trusted by Agent CLI:',
    '',
    `    ${sanitizeLine(workspaceReal)}`,
    '',
    'Trusting it means you consent to the agent:',
    '  - reading files in this folder and sending their contents to the model provider;',
    '  - creating and editing files in this folder without per-file approval (file-tool',
    '    writes are snapshotted first and can usually be undone with "agent undo");',
    '  - asking you first for every shell command, every read outside this folder, and',
    '    every secret-looking file. Approved shell commands run with your full user',
    '    privileges and their effects are NOT undoable.',
    '',
    'Trust is recorded consent, NOT a sandbox. There is no OS-level isolation.',
    '',
    '  [t] trust and remember   [o] proceed once (not recorded)   [anything else] quit',
    '  > ',
  ].join('\n');
}

/**
 * Ask one consent question on a readline that may be closed (Ctrl+D) or interrupted (Ctrl+C)
 * while pending. Any of those resolves to '' → "declined": the question promise must never be
 * left unsettled, or the process would drain its event loop and exit 0 — a silent success in
 * the eyes of a calling script.
 */
export async function askConsent(
  rl: { question(q: string): Promise<string>; once(ev: string, cb: () => void): unknown },
  q: string,
): Promise<string> {
  return await new Promise<string>((resolve) => {
    rl.question(q).then(resolve, () => resolve(''));
    rl.once('close', () => resolve(''));
    rl.once('SIGINT', () => resolve(''));
  });
}

/**
 * Decide whether this run may operate in the workspace. Ordering is load-bearing: the
 * state-root-inside-workspace refusal comes FIRST, because a state root planted inside an
 * untrusted folder would let that folder's own trust.json grant itself consent.
 */
export async function ensureTrusted(opts: TrustGateOptions): Promise<TrustDecision> {
  if (isInside(opts.workspaceReal, opts.stateRoot)) {
    throw new ConfigError(
      `state dir (${opts.stateRoot}) resolves inside the workspace (${opts.workspaceReal}); ` +
        `the trust/audit substrate must live outside the workspace. Set AGENT_CLI_STATE_DIR elsewhere.`,
    );
  }

  if (isTrusted(opts.stateRoot, opts.workspaceReal)) return { trusted: true, source: 'store' };
  if (opts.trustFlag) return { trusted: true, source: 'flag' }; // this invocation only; never persisted

  if (!opts.question) {
    return {
      trusted: false,
      reason:
        'workspace is not trusted and no one can be asked. Run interactively to review the ' +
        'consent prompt, run "agent trust" to record consent, or pass --trust-this-workspace ' +
        'for this invocation only.',
    };
  }

  const answer = (await opts.question(trustPrompt(opts.workspaceReal))).trim().toLowerCase();
  if (answer === 't') {
    grantTrust(opts.stateRoot, opts.workspaceReal, 'prompt');
    return { trusted: true, source: 'prompt-remember' };
  }
  if (answer === 'o') return { trusted: true, source: 'prompt-once' };
  return { trusted: false, reason: 'user declined the trust prompt' };
}
