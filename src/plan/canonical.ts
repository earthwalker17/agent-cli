import fs from 'node:fs';
import { writeDocAtomic } from '../shared/docio.js';
import { sha256 } from '../shared/hash.js';
import type { SessionEvent } from '../types.js';
import type { SnapshotStore } from '../store/snapshots.js';
import type { ProjectLayout } from '../store/layout.js';
import type { Clock } from '../shared/clock.js';
import { systemClock } from '../shared/clock.js';
import { PlanGraphSchema, planContentSha, validatePlanGraph, type PlanGraph } from './schema.js';
import { readPlan, planApprovalSha, type PlanDoc, type PlanStatus } from './store.js';

/**
 * The CANONICAL plan store (Session 11): one structured JSON document per session at
 * `<projectDir>/plans/<planId>.plan.json`, wrapping the schema-validated plan graph.
 *
 * Contract, load-bearing:
 * - THE FILE'S CURRENT BYTES ARE TRUTH; the harness re-reads before every use. The user may
 *   hand-edit the JSON; an edit that no longer parses + validates degrades the plan to status
 *   'unknown' (gated downstream), never to a crash.
 * - Approval binds `planContentSha` — the deterministic serialization of the `plan` sub-object
 *   only. The harness-owned wrapper fields (`status`, `updated`) are sha-neutral by
 *   construction, so /plan approve approves exactly the content sha the user reviewed, and a
 *   later status flip can never invalidate it. Blob-archive pointers (`prevSha256`) remain
 *   RAW-BYTES shas — a different purpose (recovery of exact bytes).
 * - AMENDMENT INVALIDATES APPROVAL structurally: a model write keeps 'approved' only when the
 *   content sha is unchanged (a semantic no-op); any semantic change — and any write over a
 *   'superseded' plan — starts a fresh 'draft' requiring a new /plan approve.
 * - Model writes flow ONLY through the policy-gated update_plan tool and can never set status;
 *   only the user's /plan approve|discard commands do.
 * - The legacy markdown store (`plan/store.ts`) stays intact for resumed pre-Session-11
 *   sessions; `readPlanState` is the ONE reader every consumer uses, preferring canonical.
 */

export interface CanonicalPlanDoc {
  planId: string;
  file: string;
  exists: boolean;
  /** 'unknown' = file exists but does not parse/validate (still shown where possible, gated). */
  status: PlanStatus | 'unknown';
  /** Content identity (sha256 of canonicalJson(plan)); null when the graph is unusable. */
  contentSha: string | null;
  /** The parsed, normalized graph; null when parse or validation failed. */
  graph: PlanGraph | null;
  /** Why the graph is null, for honest display. */
  parseError?: string;
  /** Wrapper `updated` stamp when present. */
  updated: string | null;
  bytes: number;
}

export interface CanonicalWriteResult {
  contentSha: string;
  /** sha256 of the raw file bytes actually written (evidence of exact bytes on disk). */
  fileSha256: string;
  bytes: number;
  /** Raw-bytes sha of the replaced file (blob-archived), or null for a first write. */
  prevSha256: string | null;
  status: PlanStatus;
}

export function readCanonicalPlan(layout: ProjectLayout, planId: string): CanonicalPlanDoc {
  const file = layout.canonicalPlanFile(planId);
  const base: CanonicalPlanDoc = {
    planId,
    file,
    exists: false,
    status: 'unknown',
    contentSha: null,
    graph: null,
    updated: null,
    bytes: 0,
  };
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return base;
  }
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return { ...base, exists: true, bytes: raw.length, parseError: `not valid JSON: ${(e as Error).message}` };
  }
  const w = wrapper as Record<string, unknown>;
  const rawStatus = w?.['status'];
  const status: CanonicalPlanDoc['status'] =
    rawStatus === 'draft' || rawStatus === 'approved' || rawStatus === 'superseded' ? rawStatus : 'unknown';
  const updated = typeof w?.['updated'] === 'string' ? (w['updated'] as string) : null;
  const withMeta = { ...base, exists: true, bytes: raw.length, status, updated };
  if (typeof w !== 'object' || w === null || !('plan' in w)) {
    return { ...withMeta, status: 'unknown', parseError: 'missing "plan" field' };
  }
  if (w['version'] !== 1) {
    return { ...withMeta, status: 'unknown', parseError: `unsupported plan file version: ${String(w['version'])}` };
  }
  const parsed = PlanGraphSchema.safeParse(w['plan']);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
    return { ...withMeta, status: 'unknown', parseError: `plan graph invalid: ${issues.join('; ')}` };
  }
  const v = validatePlanGraph(parsed.data);
  if (!v.ok || v.graph === undefined) {
    return { ...withMeta, status: 'unknown', parseError: `plan graph invalid: ${v.errors.join('; ')}` };
  }
  return { ...withMeta, graph: v.graph, contentSha: planContentSha(v.graph) };
}

/**
 * Write the plan graph from the model (update_plan). The caller validates for error REPORTING;
 * this re-validates defensively so the store can never persist an invalid graph. Status follows
 * the amendment contract: 'approved' survives only a semantic no-op; everything else — first
 * write, amendment, or a write over a discarded ('superseded') plan — is a fresh 'draft'.
 */
export async function writeCanonicalPlan(
  layout: ProjectLayout,
  planId: string,
  graph: PlanGraph,
  snapshots: SnapshotStore,
  clock: Clock = systemClock,
): Promise<CanonicalWriteResult | { error: string }> {
  const v = validatePlanGraph(graph);
  if (!v.ok || v.graph === undefined) return { error: `invalid plan graph: ${v.errors.join('; ')}` };
  const prior = readCanonicalPlan(layout, planId);
  const contentSha = planContentSha(v.graph);
  const status: PlanStatus =
    prior.exists && prior.status === 'approved' && prior.contentSha === contentSha ? 'approved' : 'draft';
  const prevSha256 = archivePriorBytes(layout.canonicalPlanFile(planId), snapshots);
  const w = await writeDocAtomic(layout.canonicalPlanFile(planId), composeWrapper(planId, status, v.graph, clock));
  return { contentSha, fileSha256: w.sha256, bytes: w.bytes, prevSha256, status };
}

/**
 * User-commanded status change (/plan approve|discard) on the canonical file.
 * - approve REFUSES a file that does not parse + validate: the user cannot consent to bytes
 *   that do not form a reviewable plan (the refusal carries the exact reason).
 * - discard only needs parseable JSON (the plan value is preserved verbatim, even if invalid —
 *   discarding a broken plan must work).
 */
export async function setCanonicalStatus(
  layout: ProjectLayout,
  planId: string,
  status: PlanStatus,
  snapshots: SnapshotStore,
  clock: Clock = systemClock,
): Promise<(CanonicalWriteResult & { graph: PlanGraph | null }) | { error: string }> {
  const file = layout.canonicalPlanFile(planId);
  const doc = readCanonicalPlan(layout, planId);
  if (!doc.exists) return { error: 'no canonical plan document exists for this session' };
  if (status === 'approved' && doc.graph === null) {
    return { error: `cannot approve: ${doc.parseError ?? 'plan graph is invalid'}` };
  }
  let planValue: unknown;
  if (doc.graph !== null) {
    planValue = doc.graph;
  } else {
    // Preserve the raw plan value verbatim for non-approve status changes on a broken graph.
    try {
      const wrapper = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      planValue = wrapper['plan'];
    } catch {
      return { error: 'plan file is not valid JSON — fix or delete it before changing status' };
    }
  }
  const prevSha256 = archivePriorBytes(file, snapshots);
  const body = JSON.stringify({ version: 1, planId, status, updated: clock.iso(), plan: planValue }, null, 2) + '\n';
  const w = await writeDocAtomic(file, body);
  return {
    contentSha: doc.contentSha ?? '',
    fileSha256: w.sha256,
    bytes: w.bytes,
    prevSha256,
    status,
    graph: doc.graph,
  };
}

/**
 * The ONE plan reader every consumer uses (injection note, delegate gate, /plan, report
 * context). Prefers the canonical JSON document; degrades to the legacy markdown store for
 * resumed pre-Session-11 sessions (where approval bound the raw file bytes, so strict sha
 * equality still works); 'none' when neither exists.
 */
export interface PlanState {
  kind: 'none' | 'canonical' | 'legacy';
  status: PlanStatus | 'unknown' | 'none';
  /** Current content identity: canonical → content sha; legacy → raw file sha; null = unusable. */
  currentSha: string | null;
  /** The sha the user last approved (from events); null = no live approval. */
  approvedSha: string | null;
  /** True when an approval exists but the current content no longer matches it. */
  diverged: boolean;
  /** True exactly when executor groups may run: status approved AND sha-equal with the approval. */
  approvedAndCurrent: boolean;
  canonical: CanonicalPlanDoc | null;
  legacy: PlanDoc | null;
}

/**
 * The review/acceptance gate's graph filter, spelled ONCE (S14.5 — three call sites wrote the
 * same triple predicate independently, each carrying a comment that the derivations must never
 * disagree): only an APPROVED-AND-CURRENT canonical plan's graph may drive requirement
 * derivation. A diverged file must not drive it — a hand-inserted `review: {mode:'waived'}`
 * would otherwise render "WAIVED by the approved plan" for content the user never approved.
 */
export function approvedCurrentGraph(state: PlanState): PlanGraph | null {
  return state.kind === 'canonical' && state.status === 'approved' && state.approvedAndCurrent ? (state.canonical?.graph ?? null) : null;
}

export function readPlanState(layout: ProjectLayout, planId: string, events: readonly SessionEvent[]): PlanState {
  const approvedSha = planApprovalSha(events);
  const canonical = readCanonicalPlan(layout, planId);
  if (canonical.exists) {
    const currentSha = canonical.contentSha;
    const diverged = approvedSha !== null && currentSha !== approvedSha;
    return {
      kind: 'canonical',
      status: canonical.status,
      currentSha,
      approvedSha,
      diverged,
      approvedAndCurrent: canonical.status === 'approved' && approvedSha !== null && currentSha === approvedSha,
      canonical,
      legacy: null,
    };
  }
  const legacy = readPlan(layout, planId);
  if (legacy.exists) {
    const currentSha = legacy.sha256;
    const diverged = approvedSha !== null && currentSha !== approvedSha;
    return {
      kind: 'legacy',
      status: legacy.status,
      currentSha,
      approvedSha,
      diverged,
      approvedAndCurrent: legacy.status === 'approved' && approvedSha !== null && currentSha === approvedSha,
      canonical: null,
      legacy,
    };
  }
  return {
    kind: 'none',
    status: 'none',
    currentSha: null,
    approvedSha,
    diverged: false,
    approvedAndCurrent: false,
    canonical: null,
    legacy: null,
  };
}

function archivePriorBytes(file: string, snapshots: SnapshotStore): string | null {
  try {
    return snapshots.putBlob(fs.readFileSync(file));
  } catch {
    return null; // first write, or unreadable prior — recorded as null, never fatal
  }
}

function composeWrapper(planId: string, status: PlanStatus, graph: PlanGraph, clock: Clock): string {
  return JSON.stringify({ version: 1, planId, status, updated: clock.iso(), plan: graph }, null, 2) + '\n';
}
