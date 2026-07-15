import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { caseFold } from '../shared/pathutil.js';
import { ConfigError } from '../shared/errors.js';
import { systemClock, type Clock } from '../shared/clock.js';

/**
 * The workspace-trust store: recorded user consent to operate in a folder. It lives at the
 * STATE ROOT (never inside any workspace) so no workspace content can influence it. Trust is
 * consent, not a sandbox — the store only remembers that the user said yes.
 */

export interface TrustRecord {
  /** Original-case real path, for display. */
  path: string;
  grantedAt: string;
  source: 'prompt' | 'command';
}

const TrustRecordSchema = z
  .object({
    path: z.string(),
    grantedAt: z.string(),
    source: z.enum(['prompt', 'command']),
  })
  .strict();

const TrustFileSchema = z
  .object({
    v: z.literal(1),
    entries: z.record(z.string(), TrustRecordSchema),
  })
  .strict();

type TrustFile = z.infer<typeof TrustFileSchema>;

function trustFilePath(stateRoot: string): string {
  return path.join(stateRoot, 'trust.json');
}
function auditPath(stateRoot: string): string {
  return path.join(stateRoot, 'trust.log');
}

/** Entries are keyed by the case-folded real path (readable in the file, stable across case). */
export function trustKey(workspaceReal: string): string {
  return caseFold(workspaceReal);
}

/**
 * Read the trust file. Missing → empty. Corrupt or unexpected shape → hard ConfigError: a broken
 * consent database must never silently read as "trusted" OR be silently rewritten.
 */
export function readTrustFile(stateRoot: string): TrustFile {
  const file = trustFilePath(stateRoot);
  if (!fs.existsSync(file)) return { v: 1, entries: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`trust store is corrupt (${file}): ${(e as Error).message}. Fix or remove it manually.`);
  }
  const result = TrustFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`trust store has an unexpected shape (${file}); fix or remove it manually`);
  }
  return result.data;
}

export function isTrusted(stateRoot: string, workspaceReal: string): boolean {
  return trustKey(workspaceReal) in readTrustFile(stateRoot).entries;
}

function writeTrustFile(stateRoot: string, data: TrustFile): void {
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(trustFilePath(stateRoot), JSON.stringify(data, null, 2) + '\n');
}

function audit(stateRoot: string, entry: Record<string, unknown>): void {
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.appendFileSync(auditPath(stateRoot), JSON.stringify(entry) + '\n');
}

export function grantTrust(
  stateRoot: string,
  workspaceReal: string,
  source: TrustRecord['source'],
  clock: Clock = systemClock,
): void {
  const data = readTrustFile(stateRoot);
  data.entries[trustKey(workspaceReal)] = { path: workspaceReal, grantedAt: clock.iso(), source };
  writeTrustFile(stateRoot, data);
  audit(stateRoot, { ts: clock.iso(), action: 'grant', path: workspaceReal, source });
}

/** Returns false when the workspace was not trusted to begin with. */
export function revokeTrust(stateRoot: string, workspaceReal: string, clock: Clock = systemClock): boolean {
  const data = readTrustFile(stateRoot);
  const key = trustKey(workspaceReal);
  if (!(key in data.entries)) return false;
  delete data.entries[key];
  writeTrustFile(stateRoot, data);
  audit(stateRoot, { ts: clock.iso(), action: 'revoke', path: workspaceReal });
  return true;
}

export function listTrusted(stateRoot: string): TrustRecord[] {
  return Object.values(readTrustFile(stateRoot).entries).sort((a, b) => a.path.localeCompare(b.path));
}
