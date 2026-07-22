import fs from 'node:fs';
import { parseFrontmatter, writeDocAtomic } from '../memory/store.js';
import { sha256 } from '../shared/hash.js';
import type { SessionEvent } from '../types.js';
import type { SnapshotStore } from '../store/snapshots.js';
import type { ProjectLayout } from '../store/layout.js';
import type { Clock } from '../shared/clock.js';
import { systemClock } from '../shared/clock.js';

/**
 * The plan document store (V0.7): explicit temporary local state for plan mode, one markdown
 * file per plan at `<projectDir>/plans/<planId>.md` (planId = the owning session id).
 *
 * Contract, load-bearing:
 * - THE FILE'S CURRENT BYTES ARE TRUTH. The user may edit it at any time with any editor;
 *   the harness re-reads it before every use and never caches authority.
 * - The plan is CONTEXT, NOT AUTHORITY: injection labeling (repl) states verbatim that the
 *   current user request and observable repository state outrank it.
 * - The model writes it ONLY through the policy-gated update_plan tool, and model writes never
 *   change `status` — only the user's /plan approve|discard commands do.
 * - Reads never throw (a malformed plan must never block a session); writes are atomic; prior
 *   bytes are archived as content-addressed blobs so plan history stays reviewable.
 */

export type PlanStatus = 'draft' | 'approved' | 'superseded';

/** Read cap — a plan beyond this is truncated for display/injection (raw file kept intact). */
export const PLAN_READ_CAP_CHARS = 48 * 1024;
/** Injection cap — the per-turn note carries at most this much plan text. */
export const PLAN_INJECT_CAP_CHARS = 12 * 1024;

export interface PlanDoc {
  planId: string;
  file: string;
  exists: boolean;
  /** 'unknown' = file exists but the status field is missing/unparseable (still shown, still draft-gated). */
  status: PlanStatus | 'unknown';
  /** sha256 of the RAW file bytes; null when absent/unreadable. */
  sha256: string | null;
  bytes: number;
  /** Capped decoded text (frontmatter included); '' when absent/unreadable. */
  text: string;
  truncated: boolean;
  /** Lenient `## Task N` heading extraction for compact summaries; display-only, never authority. */
  tasks: { title: string; status: string | null }[];
}

/**
 * The sha the user last approved, from the session's events: `plan.approved` binds the exact
 * bytes; `plan.discarded` clears the binding. Null = no live recorded approval. Shared by the
 * per-turn injection note and the executor-spawn approval prompt (V0.7.1) so both surfaces
 * derive divergence from ONE rule.
 */
export function planApprovalSha(events: readonly SessionEvent[]): string | null {
  let approvedSha: string | null = null;
  for (const e of events) {
    if (e.type === 'plan.approved') approvedSha = e.sha256;
    else if (e.type === 'plan.discarded') approvedSha = null;
  }
  return approvedSha;
}

export function readPlan(layout: ProjectLayout, planId: string): PlanDoc {
  const file = layout.planFile(planId);
  const base: PlanDoc = { planId, file, exists: false, status: 'unknown', sha256: null, bytes: 0, text: '', truncated: false, tasks: [] };
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return base;
  }
  let text: string;
  try {
    text = raw.toString('utf8');
  } catch {
    return { ...base, exists: true, sha256: sha256(raw), bytes: raw.length };
  }
  const truncated = text.length > PLAN_READ_CAP_CHARS;
  const capped = truncated ? text.slice(0, PLAN_READ_CAP_CHARS) : text;
  const { fields } = parseFrontmatter(text);
  const rawStatus = fields?.['status'];
  const status: PlanDoc['status'] =
    rawStatus === 'draft' || rawStatus === 'approved' || rawStatus === 'superseded' ? rawStatus : 'unknown';
  return {
    planId,
    file,
    exists: true,
    status,
    sha256: sha256(raw),
    bytes: raw.length,
    text: capped,
    truncated,
    tasks: extractTasks(capped),
  };
}

/** Lenient `## Task …` extraction, pairing each heading with a following `Status:` line if any. */
function extractTasks(text: string): { title: string; status: string | null }[] {
  const tasks: { title: string; status: string | null }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && tasks.length < 50; i++) {
    const m = /^##\s+(task\b.*)$/i.exec(lines[i]!.trim());
    if (m === null) continue;
    let status: string | null = null;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      if (/^##\s/.test(lines[j]!)) break;
      const s = /^[-*\s]*status\s*:\s*(.+)$/i.exec(lines[j]!.trim());
      if (s !== null) {
        status = s[1]!.trim();
        break;
      }
    }
    tasks.push({ title: m[1]!.trim(), status });
  }
  return tasks;
}

export interface PlanWriteResult {
  sha256: string;
  bytes: number;
  /** sha256 of the replaced file's bytes (archived as a blob), or null for a first write. */
  prevSha256: string | null;
  status: PlanStatus | 'unknown';
}

/**
 * Write the plan BODY from the model (update_plan). The harness owns the frontmatter: the
 * existing status is PRESERVED (model writes can never approve/discard — only the user's
 * commands change status); a first write starts as 'draft'. Prior bytes are blob-archived.
 */
export async function writePlanBody(
  layout: ProjectLayout,
  planId: string,
  body: string,
  snapshots: SnapshotStore,
  clock: Clock = systemClock,
): Promise<PlanWriteResult> {
  const prior = readPlan(layout, planId);
  const status: PlanStatus = prior.exists && (prior.status === 'approved' || prior.status === 'superseded') ? prior.status : 'draft';
  const prevSha256 = archivePrior(layout, planId, snapshots);
  const content = composePlan(planId, status, stripFrontmatter(body), clock);
  const w = await writeDocAtomic(layout.planFile(planId), content);
  return { sha256: w.sha256, bytes: w.bytes, prevSha256, status };
}

/** User-commanded status change (/plan approve|discard). Body preserved byte-verbatim. */
export async function setPlanStatus(
  layout: ProjectLayout,
  planId: string,
  status: PlanStatus,
  snapshots: SnapshotStore,
  clock: Clock = systemClock,
): Promise<PlanWriteResult | { error: string }> {
  const prior = readPlan(layout, planId);
  if (!prior.exists) return { error: 'no plan document exists for this session' };
  if (prior.sha256 === null) return { error: 'plan document is unreadable' };
  // Re-read the FULL raw text (readPlan caps for display; a status rewrite must not truncate).
  let full: string;
  try {
    full = fs.readFileSync(layout.planFile(planId), 'utf8');
  } catch (e) {
    return { error: `cannot read plan document: ${(e as Error).message}` };
  }
  const prevSha256 = archivePrior(layout, planId, snapshots);
  const content = composePlan(planId, status, stripFrontmatter(full), clock);
  const w = await writeDocAtomic(layout.planFile(planId), content);
  return { sha256: w.sha256, bytes: w.bytes, prevSha256, status };
}

function archivePrior(layout: ProjectLayout, planId: string, snapshots: SnapshotStore): string | null {
  try {
    const bytes = fs.readFileSync(layout.planFile(planId));
    return snapshots.putBlob(bytes);
  } catch {
    return null; // first write, or unreadable prior — recorded as null, never fatal
  }
}

function composePlan(planId: string, status: PlanStatus, body: string, clock: Clock): string {
  return ['---', `plan: ${planId}`, `status: ${status}`, `updated: ${clock.iso()}`, '---', '', body.trimStart()].join('\n');
}

/** Drop a leading frontmatter block if the input carries one (the harness re-stamps its own). */
function stripFrontmatter(text: string): string {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 4);
  return end === -1 ? text : text.slice(end + 5);
}
