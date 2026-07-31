import fs from 'node:fs';
import { writeDocAtomic } from '../memory/store.js';
import type { SnapshotStore } from '../store/snapshots.js';
import type { ProjectLayout } from '../store/layout.js';
import { topoOrder, type PlanGraph } from './schema.js';
import type { CheckKind } from '../types.js';
import type { CanonicalPlanDoc } from './canonical.js';
import type { GraphState } from './graph-state.js';

/**
 * Deterministic projections of the canonical plan (Session 11). Two views, one truth:
 * - the USER view — concise markdown for review and consent, regenerated to `plans/<id>.md`;
 * - the AGENT view — full execution detail (intents, dependencies, touches, verification,
 *   ready/blocked state) for the per-turn injection note.
 * Pure string builders; consumers sanitize per surface. The generated markdown file carries a
 * marker so it is never mistaken for (or silently clobbers) a user-authored legacy plan.
 */

export const GENERATED_VIEW_MARKER = '<!-- GENERATED VIEW';

function short(sha: string | null): string {
  return sha === null ? 'unknown' : sha.slice(0, 12);
}

function statusLine(doc: CanonicalPlanDoc): string {
  switch (doc.status) {
    case 'draft':
      return 'draft — awaiting /plan approve';
    case 'approved':
      return 'approved';
    case 'superseded':
      return 'superseded (discarded)';
    default:
      return `unknown${doc.parseError !== undefined ? ` — ${doc.parseError}` : ''}`;
  }
}

/** The concise user-facing review/consent view. */
export function renderUserPlanView(doc: CanonicalPlanDoc): string {
  const lines: string[] = [
    `${GENERATED_VIEW_MARKER} — regenerated from ${doc.planId}.plan.json (content sha ${short(doc.contentSha)}). Edits here are overwritten: amend by telling the agent, or edit the .plan.json; then re-approve with /plan approve. -->`,
    '',
    `# Plan ${doc.planId}`,
    '',
    `**Status:** ${statusLine(doc)}`,
  ];
  const g = doc.graph;
  if (g === null) {
    lines.push('', `The canonical plan graph is not currently readable${doc.parseError !== undefined ? `: ${doc.parseError}` : '.'}`);
    return lines.join('\n') + '\n';
  }
  lines.push('', `**Objective:** ${g.objective}`);
  if (g.approach !== undefined && g.approach.trim() !== '') lines.push('', `**Approach:** ${g.approach}`);

  // The `checks` column is not decoration: it is what blocks dependents and what /accept
  // measures, so the user must see it in the document whose content sha they approve.
  lines.push('', '## Tasks', '', '| id | title | role | depends on | risk | touches | checks |', '|---|---|---|---|---|---|---|');
  const order = topoOrder(g.tasks) ?? g.tasks.map((t) => t.id);
  const byId = new Map(g.tasks.map((t) => [t.id, t] as const));
  for (const id of order) {
    const t = byId.get(id);
    if (t === undefined) continue;
    const deps = t.dependsOn.length > 0 ? t.dependsOn.join(', ') : '—';
    const touches =
      t.touches.length === 0 ? '—' : t.touches.slice(0, 2).join(', ') + (t.touches.length > 2 ? ` (+${t.touches.length - 2})` : '');
    const flags = [t.risk !== 'low' ? t.risk : '', t.serial ? 'serial' : ''].filter((s) => s !== '').join(', ') || 'low';
    const checks = t.checks !== undefined && t.checks.length > 0 ? t.checks.join(', ') : '—';
    lines.push(`| ${t.id} | ${cell(t.title)} | ${t.role} | ${cell(deps)} | ${flags} | ${cell(touches)} | ${cell(checks)} |`);
  }
  if (g.gates !== undefined && ((g.gates.integration?.length ?? 0) > 0 || (g.gates.completion?.length ?? 0) > 0)) {
    lines.push('', '## Gates', '');
    if ((g.gates.integration?.length ?? 0) > 0) {
      lines.push(`- **integration** (after each apply, before the next executor wave): ${g.gates.integration!.join(', ')}`);
    }
    if ((g.gates.completion?.length ?? 0) > 0) {
      lines.push(`- **completion** (after the last change, before the session can be accepted): ${g.gates.completion!.join(', ')}`);
    }
  }
  // The review declaration is part of what the user approves — a waiver must be impossible to
  // miss in the projection whose sha the approval binds (Session 14). The derived default
  // (executor plans require a review round) renders too, so silence never means "no review".
  {
    const hasExecutor = g.tasks.some((t) => t.role === 'executor');
    if (g.review?.mode === 'waived') {
      lines.push('', '## Adversarial review', '', `- **WAIVED** — ${g.review.reason ?? '(no reason)'} _(recorded as an acceptance caveat)_`);
    } else if (g.review?.mode === 'required' || hasExecutor) {
      lines.push(
        '',
        '## Adversarial review',
        '',
        `- **required${g.review?.mode === 'required' ? ' (declared)' : ' (default for executor plans)'}** — a recorded reviewer round after integration, with critical/high findings resolved, gates /accept`,
      );
    }
  }

  const verified = g.tasks.filter((t) => t.verify.trim() !== '');
  if (verified.length > 0) {
    lines.push('', '## Verification');
    for (const t of verified) lines.push(`- **${t.id}**: ${t.verify}`);
  }
  if (g.risks !== undefined && g.risks.length > 0) {
    lines.push('', '## Risks');
    for (const r of g.risks) lines.push(`- ${r}`);
  }
  if (g.notes !== undefined && g.notes.trim() !== '') lines.push('', '## Notes', '', g.notes);
  lines.push('', '_Live execution status: /tasks. Full detail (intents, verification, dependencies): the agent view._');
  return lines.join('\n') + '\n';
}

/** Escape pipes/newlines so model-authored text cannot break the markdown table shape. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** The detailed agent-facing projection, injected per turn (under the existing 12 KiB cap). */
export function renderAgentPlanView(doc: CanonicalPlanDoc, graphState?: GraphState): string {
  const g = doc.graph;
  const lines: string[] = [`PLAN (canonical; content sha ${short(doc.contentSha)}; status ${doc.status})`];
  if (g === null) {
    lines.push(`plan graph unreadable${doc.parseError !== undefined ? `: ${doc.parseError}` : ''}`);
    return lines.join('\n');
  }
  lines.push(`Objective: ${g.objective}`);
  if (g.approach !== undefined && g.approach.trim() !== '') lines.push(`Approach: ${g.approach}`);
  if (graphState !== undefined) lines.push(`Execution: ${graphState.summary}`);
  lines.push('Tasks (topological order):');
  const order = topoOrder(g.tasks) ?? g.tasks.map((t) => t.id);
  const byId = new Map(g.tasks.map((t) => [t.id, t] as const));
  for (const id of order) {
    const t = byId.get(id);
    if (t === undefined) continue;
    const state = graphState?.byId.get(id);
    const flags = [t.risk !== 'low' ? `risk ${t.risk}` : '', t.serial ? 'serial' : ''].filter((s) => s !== '');
    lines.push(`- ${t.id} [${[t.role, ...flags].join(', ')}]${state !== undefined ? ` (${state.state})` : ''} ${t.title}`);
    lines.push(`  intent: ${t.intent}`);
    if (t.dependsOn.length > 0) lines.push(`  dependsOn: ${t.dependsOn.join(', ')}`);
    if (t.touches.length > 0) lines.push(`  touches: ${t.touches.join(', ')}`);
    if (t.verify.trim() !== '') lines.push(`  verify: ${t.verify}`);
    if (t.checks !== undefined && t.checks.length > 0) {
      const v = state?.verification;
      const live =
        v === undefined || v.status === 'none'
          ? ''
          : v.status === 'green'
            ? ' — GREEN'
            : v.status === 'waived'
              ? ` — waived (unsupported): ${v.waived.join(', ')}`
              : ` — PENDING: ${v.missing.join(', ')}`;
      // Naming the project is load-bearing where it exists: "test passed" and "test passed IN
      // THE PROJECT THIS TASK OWNS" are different claims. Silent when unscoped — most plans have
      // one project, and annotating every line with "(unscoped)" would be noise, not honesty.
      const where = t.project !== undefined ? ` in project '${t.project}'` : '';
      lines.push(`  checks (gate dependents)${where}: ${t.checks.join(', ')}${live}`);
    }
    if (state?.note !== undefined) lines.push(`  note: ${state.note}`);
  }
  if (g.gates !== undefined) {
    // Gates DO carry the unscoped wording: there are at most two of these lines, and the failure
    // this names — a full-stack session accepted as complete on a green test in one half — is
    // exactly the one worth a few extra words at the consent boundary.
    const scope = (g.gates.projects?.length ?? 0) > 0 ? ` in EACH of: ${g.gates.projects!.join(', ')}` : ' in ANY project (unscoped)';
    if ((g.gates.integration?.length ?? 0) > 0) lines.push(`Gate (integration)${scope}: ${g.gates.integration!.join(', ')}`);
    if ((g.gates.completion?.length ?? 0) > 0) lines.push(`Gate (completion)${scope}: ${g.gates.completion!.join(', ')}`);
  }
  if (g.review?.mode === 'waived') {
    lines.push(`Review: WAIVED — ${g.review.reason ?? '(no reason)'} (acceptance will carry this as a caveat)`);
  } else if (g.review?.mode === 'required' || g.tasks.some((t) => t.role === 'executor')) {
    lines.push(
      `Review: required${g.review?.mode === 'required' ? ' (declared)' : ' (derived: executor plan)'} — run ONE bounded reviewer round (delegate_task, 2-3 reviewer lenses) after integration; triage every critical/high finding with the review tool before /accept`,
    );
  }
  if (g.risks !== undefined && g.risks.length > 0) lines.push(`Risks: ${g.risks.join(' | ')}`);
  if (g.notes !== undefined && g.notes.trim() !== '') lines.push(`Notes: ${g.notes}`);
  return lines.join('\n');
}

/**
 * Regenerate the user-view markdown file beside the canonical plan. If the existing `<id>.md`
 * is NOT a generated view (a legacy user-authored plan from a resumed pre-Session-11 session),
 * its bytes are blob-archived before the overwrite — user-authored content is never silently
 * destroyed. Failures are returned, never thrown: a broken view write must not block the plan.
 */
export async function writeUserView(
  layout: ProjectLayout,
  planId: string,
  doc: CanonicalPlanDoc,
  snapshots: SnapshotStore,
): Promise<{ sha256: string; bytes: number; archivedLegacySha256: string | null } | { error: string }> {
  const file = layout.planFile(planId);
  let archivedLegacySha256: string | null = null;
  try {
    let prior: Buffer | null = null;
    try {
      prior = fs.readFileSync(file);
    } catch {
      prior = null;
    }
    if (prior !== null && !prior.toString('utf8').startsWith(GENERATED_VIEW_MARKER)) {
      archivedLegacySha256 = snapshots.putBlob(prior);
    }
    const w = await writeDocAtomic(file, renderUserPlanView(doc));
    return { sha256: w.sha256, bytes: w.bytes, archivedLegacySha256 };
  } catch (e) {
    return { error: `user-view write failed: ${(e as Error).message}` };
  }
}

/** Structural graph summary for the plan.updated event (report/resume render without the file). */
export function graphSummary(graph: PlanGraph): { id: string; role: string; dependsOn: string[]; checks?: CheckKind[] }[] {
  // `checks` rides along (Session 12, additive) so the report — a PURE fold over events that must
  // never read the plan file — can render declared gates beside the check runs that satisfied them.
  return graph.tasks.map((t) => ({
    id: t.id,
    role: t.role,
    dependsOn: [...t.dependsOn],
    ...(t.checks !== undefined && t.checks.length > 0 ? { checks: [...t.checks] } : {}),
  }));
}
