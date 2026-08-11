import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { sha256 } from '../shared/hash.js';
import { ConfigError } from '../shared/errors.js';
import { withRegistryLock } from '../shared/registry-lock.js';

/**
 * Durable machine grants (Session 21): the ONE explicit exception to "authority is not durable".
 * A user who answers `[a]` at an eligible approval prompt records a grant here; every later
 * assembly loads the matching entries into the session's in-memory Grants and appends a
 * `grants.loaded` event, so standing authority is visible in the evidence of every session it
 * touches. Nothing else ever writes this file.
 *
 * Design lineage (S21 external research): the two-file split (a machine-written store apart
 * from the hand-edited config) is the mature pattern; Codex's #22181 — a vague "don't ask
 * again" that minted a machine-wide program-name allow — is why every entry here binds an
 * EXACT identity (a replay sha or one (tool, class) pair from a closed eligibility set), the
 * prompt prints the literal rule + scope before writing, and prefixes/patterns do not exist.
 *
 * Store discipline is trust.json's (a consent DB must never be silently rebuilt): a corrupt or
 * unexpected-shape file is a hard ConfigError, never rewritten, never read as granted. Unlike
 * trust, writes are registry-locked + atomic — grants persist mid-session while other sessions
 * may be doing the same.
 */

export const GRANTS_SCHEMA_VERSION = 1 as const;

const CheckReplayGrantSchema = z
  .object({
    v: z.literal(GRANTS_SCHEMA_VERSION),
    kind: z.literal('check-replay'),
    id: z.string().regex(/^[0-9a-f]{12}$/),
    /** trustKey(workspaceReal) — the SAME derivation trust uses, so the two stores agree. */
    workspaceKey: z.string().min(1),
    /** The exact engine replay key: sha256(recipeId + command + bodySha + projectId). */
    replayKey: z.string().min(1),
    /** Human-readable description shown by `agent grants` and in grants.loaded. */
    label: z.string().min(1).max(300),
    createdAt: z.string().min(1),
  })
  .strict();

const ClassGrantSchema = z
  .object({
    v: z.literal(GRANTS_SCHEMA_VERSION),
    kind: z.literal('class'),
    id: z.string().regex(/^[0-9a-f]{12}$/),
    /** null = machine-wide (every workspace the user has separately trusted). */
    workspaceKey: z.union([z.string().min(1), z.null()]),
    tool: z.string().min(1),
    /** Deliberately ONLY 'external': no durable grant may mint 'sensitive' (or any other class). */
    cls: z.literal('external'),
    label: z.string().min(1).max(300),
    createdAt: z.string().min(1),
  })
  .strict();

const GrantEntrySchema = z.discriminatedUnion('kind', [CheckReplayGrantSchema, ClassGrantSchema]);
const GrantsFileSchema = z.object({ v: z.literal(GRANTS_SCHEMA_VERSION), entries: z.array(GrantEntrySchema) }).strict();

export type DurableGrant = z.infer<typeof GrantEntrySchema>;
export type DurableClassGrant = z.infer<typeof ClassGrantSchema>;
export type DurableCheckReplayGrant = z.infer<typeof CheckReplayGrantSchema>;

export function grantsFile(stateRoot: string): string {
  return path.join(stateRoot, 'grants.json');
}

export function grantsLogFile(stateRoot: string): string {
  return path.join(stateRoot, 'grants.log');
}

/** Stable identity: re-granting the same thing replaces, never duplicates. */
export function grantIdFor(spec: GrantSpec): string {
  const identity = spec.kind === 'check-replay' ? spec.replayKey : `${spec.tool}::${spec.cls}`;
  return sha256(`${spec.kind}\n${spec.workspaceKey ?? '<machine>'}\n${identity}`).slice(0, 12);
}

export type GrantSpec =
  | { kind: 'check-replay'; workspaceKey: string; replayKey: string; label: string }
  | { kind: 'class'; workspaceKey: string | null; tool: string; cls: 'external'; label: string };

/**
 * Read the store. Missing = empty (the file exists only once something was granted); corrupt or
 * unexpected shape = hard ConfigError naming the file — the caller decides how loudly to fail,
 * but this function never guesses and never rewrites.
 */
export function readGrants(stateRoot: string): DurableGrant[] {
  const file = grantsFile(stateRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`durable-grants store is corrupt (not JSON): ${file} — fix or remove it manually; it will not be rewritten`);
  }
  const result = GrantsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`durable-grants store has an unexpected shape: ${file} — fix or remove it manually; it will not be rewritten`);
  }
  return result.data.entries;
}

function saveAtomic(file: string, entries: readonly DurableGrant[]): void {
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify({ v: GRANTS_SCHEMA_VERSION, entries }, null, 2)}\n`);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

function appendAudit(stateRoot: string, record: object): void {
  try {
    fs.appendFileSync(grantsLogFile(stateRoot), `${JSON.stringify(record)}\n`);
  } catch {
    /* the audit line is best-effort; the store write is the consent record */
  }
}

/**
 * Insert-or-replace a BATCH by stable id under ONE lock and ONE atomic write (S21 review: a
 * check batch's keys persisted one write per key, so a mid-batch failure left grants the
 * consent record then denied storing — a record that lies about standing authority). All or
 * nothing: either every spec lands in the store or none does.
 */
export async function addGrants(stateRoot: string, specs: readonly GrantSpec[], nowIso: string): Promise<DurableGrant[]> {
  if (specs.length === 0) return [];
  const file = grantsFile(stateRoot);
  return withRegistryLock(file, () => {
    let next = readGrants(stateRoot); // corrupt store throws INSIDE the lock — never rewritten
    const out: DurableGrant[] = [];
    for (const spec of specs) {
      const id = grantIdFor(spec);
      const entry: DurableGrant =
        spec.kind === 'check-replay'
          ? { v: GRANTS_SCHEMA_VERSION, kind: 'check-replay', id, workspaceKey: spec.workspaceKey, replayKey: spec.replayKey, label: spec.label, createdAt: nowIso }
          : { v: GRANTS_SCHEMA_VERSION, kind: 'class', id, workspaceKey: spec.workspaceKey, tool: spec.tool, cls: spec.cls, label: spec.label, createdAt: nowIso };
      next = [...next.filter((e) => e.id !== id), entry];
      out.push(entry);
    }
    saveAtomic(file, next);
    for (const entry of out) {
      appendAudit(stateRoot, { ts: nowIso, action: 'grant', id: entry.id, kind: entry.kind, label: entry.label, workspaceKey: entry.workspaceKey });
    }
    return out;
  });
}

/** Insert-or-replace by stable id under the registry lock. Returns the stored entry. */
export async function addGrant(stateRoot: string, spec: GrantSpec, nowIso: string): Promise<DurableGrant> {
  const [entry] = await addGrants(stateRoot, [spec], nowIso);
  return entry!;
}

/** Remove by id under the registry lock. Returns the removed entry, or null when absent. */
export async function revokeGrant(stateRoot: string, id: string, nowIso: string): Promise<DurableGrant | null> {
  const file = grantsFile(stateRoot);
  return withRegistryLock(file, () => {
    const entries = readGrants(stateRoot);
    const found = entries.find((e) => e.id === id) ?? null;
    if (found === null) return null;
    saveAtomic(
      file,
      entries.filter((e) => e.id !== id),
    );
    appendAudit(stateRoot, { ts: nowIso, action: 'revoke', id, kind: found.kind, label: found.label, workspaceKey: found.workspaceKey });
    return found;
  });
}

/** The entries that apply to one workspace: its own plus every machine-wide class grant. */
export function grantsForWorkspace(entries: readonly DurableGrant[], workspaceKey: string): DurableGrant[] {
  return entries.filter((e) => e.workspaceKey === null || e.workspaceKey === workspaceKey);
}
