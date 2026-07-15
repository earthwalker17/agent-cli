import readline from 'node:readline/promises';
import { sanitizeLine } from '../shared/text.js';
import { grantTrust, revokeTrust, listTrusted, isTrusted } from './store.js';
import { askConsent, trustPrompt } from './gate.js';

export interface TrustCommandValues {
  revoke?: boolean;
  list?: boolean;
}

/**
 * `agent trust [--revoke|--list]` — deliberate, persistent trust management. Running the command
 * IS the explicit consent act, so a non-TTY `agent trust` grants without a prompt (scripts that
 * want persistence must say so in their own source); on a TTY the full consent text is shown.
 */
export async function cmdTrust(values: TrustCommandValues, stateRoot: string, workspaceReal: string): Promise<number> {
  if (values.list) {
    const entries = listTrusted(stateRoot);
    if (entries.length === 0) {
      process.stdout.write('no trusted workspaces\n');
      return 0;
    }
    for (const e of entries) {
      process.stdout.write(`${sanitizeLine(e.path)}  (granted ${e.grantedAt}, via ${e.source})\n`);
    }
    return 0;
  }

  if (values.revoke) {
    if (revokeTrust(stateRoot, workspaceReal)) {
      process.stdout.write(`trust revoked: ${sanitizeLine(workspaceReal)}\n`);
      return 0;
    }
    process.stdout.write(`not trusted (nothing to revoke): ${sanitizeLine(workspaceReal)}\n`);
    return 0;
  }

  if (isTrusted(stateRoot, workspaceReal)) {
    process.stdout.write(`already trusted: ${sanitizeLine(workspaceReal)}\n`);
    return 0;
  }

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (await askConsent(rl, trustPrompt(workspaceReal))).trim().toLowerCase();
      if (answer !== 't' && answer !== 'y') {
        process.stdout.write('not trusted (declined)\n');
        return 1;
      }
    } finally {
      rl.close();
    }
  }
  grantTrust(stateRoot, workspaceReal, 'command');
  process.stdout.write(`trusted: ${sanitizeLine(workspaceReal)}\n`);
  return 0;
}
