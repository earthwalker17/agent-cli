import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readCanonicalPlan,
  writeCanonicalPlan,
  setCanonicalStatus,
  readPlanState,
  type CanonicalWriteResult,
} from '../src/plan/canonical.js';
import { PlanGraphSchema, planContentSha, type PlanGraph } from '../src/plan/schema.js';
import { writePlanBody } from '../src/plan/store.js';
import { writeUserView, GENERATED_VIEW_MARKER, renderUserPlanView, renderAgentPlanView } from '../src/plan/views.js';
import { SnapshotStore } from '../src/store/snapshots.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { sha256 } from '../src/shared/hash.js';
import { createUpdatePlanTool } from '../src/tools/update-plan.js';
import type { SessionEvent, ToolContext } from '../src/types.js';

/**
 * The canonical plan store: content-sha approval identity (wrapper flips are sha-neutral BY
 * CONSTRUCTION), the amendment contract (any semantic change → draft; superseded un-traps),
 * approve-refuses-invalid, lenient reads, blob archiving, and the one unified reader with its
 * legacy-markdown fallback for resumed pre-Session-11 sessions.
 */

let tmp: string;
let layout: ProjectLayout;
let snapshots: SnapshotStore;
const clock = fixedClock(Date.UTC(2026, 6, 23), 1000);

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-cplan-')));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
  snapshots = new SnapshotStore(layout.objectsDir);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeGraph(mutate?: (g: Record<string, unknown>) => void): PlanGraph {
  const raw: Record<string, unknown> = {
    objective: 'ship the feature',
    tasks: [
      { id: 't1', title: 'core module', intent: 'build it', role: 'executor', verify: 'unit tests pass', touches: ['src/core'] },
      { id: 't2', title: 'wire it', intent: 'integrate', role: 'executor', verify: 'e2e passes', dependsOn: ['t1'], touches: ['src/app'] },
    ],
  };
  mutate?.(raw);
  return PlanGraphSchema.parse(raw);
}

let seqCounter = 0;
const ev = (body: Record<string, unknown>): SessionEvent =>
  ({ v: 1, seq: ++seqCounter, ts: '2026-07-23T00:00:00.000Z', ...body }) as unknown as SessionEvent;

async function write(g: PlanGraph): Promise<CanonicalWriteResult> {
  const r = await writeCanonicalPlan(layout, 's-1', g, snapshots, clock);
  if ('error' in r) throw new Error(r.error);
  return r;
}

describe('canonical plan roundtrip and amendment contract', () => {
  it('first write is a draft; read returns the normalized graph and its content sha', async () => {
    const w = await write(makeGraph());
    expect(w.status).toBe('draft');
    expect(w.prevSha256).toBeNull();
    const doc = readCanonicalPlan(layout, 's-1');
    expect(doc).toMatchObject({ exists: true, status: 'draft', planId: 's-1' });
    expect(doc.contentSha).toBe(w.contentSha);
    expect(doc.graph!.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('approve flips status WITHOUT changing the content sha (the V0.7 quirk, structurally fixed)', async () => {
    const w = await write(makeGraph());
    const a = await setCanonicalStatus(layout, 's-1', 'approved', snapshots, clock);
    expect('error' in a).toBe(false);
    const doc = readCanonicalPlan(layout, 's-1');
    expect(doc.status).toBe('approved');
    expect(doc.contentSha).toBe(w.contentSha); // status is outside the hashed content
  });

  it('a semantic no-op rewrite keeps approved; any amendment flips to draft', async () => {
    await write(makeGraph());
    await setCanonicalStatus(layout, 's-1', 'approved', snapshots, clock);

    const same = await write(makeGraph());
    expect(same.status).toBe('approved'); // byte-different file possible, content identical

    const amended = await write(makeGraph((g) => ((g['tasks'] as { title: string }[])[0]!.title = 'renamed')));
    expect(amended.status).toBe('draft'); // approval invalidated structurally
    expect(readCanonicalPlan(layout, 's-1').status).toBe('draft');
  });

  it('superseded un-traps: a model write after discard starts a fresh draft', async () => {
    await write(makeGraph());
    await setCanonicalStatus(layout, 's-1', 'superseded', snapshots, clock);
    const w = await write(makeGraph((g) => (g['objective'] = 'new direction')));
    expect(w.status).toBe('draft');
  });

  it('prior bytes are blob-archived on every write and status change', async () => {
    await write(makeGraph());
    const before = fs.readFileSync(layout.canonicalPlanFile('s-1'));
    const w2 = await write(makeGraph((g) => (g['objective'] = 'v2')));
    expect(w2.prevSha256).toBe(sha256(before));
    expect(snapshots.getBlob(w2.prevSha256!).equals(before)).toBe(true);
  });

  it('hand-edits that only reformat or reorder keys are approval-neutral', async () => {
    const w = await write(makeGraph());
    await setCanonicalStatus(layout, 's-1', 'approved', snapshots, clock);
    // Rewrite the file with different formatting and key order, same semantic content.
    const wrapper = JSON.parse(fs.readFileSync(layout.canonicalPlanFile('s-1'), 'utf8')) as Record<string, unknown>;
    const reordered = { plan: wrapper['plan'], updated: wrapper['updated'], status: wrapper['status'], planId: wrapper['planId'], version: wrapper['version'] };
    fs.writeFileSync(layout.canonicalPlanFile('s-1'), JSON.stringify(reordered));
    const doc = readCanonicalPlan(layout, 's-1');
    expect(doc.contentSha).toBe(w.contentSha);
    expect(doc.status).toBe('approved');
  });
});

describe('canonical plan leniency and consent guards', () => {
  it('unparseable JSON reads as status unknown with contentSha null (gated downstream)', async () => {
    await write(makeGraph());
    fs.writeFileSync(layout.canonicalPlanFile('s-1'), '{ not json');
    const doc = readCanonicalPlan(layout, 's-1');
    expect(doc).toMatchObject({ exists: true, status: 'unknown', contentSha: null, graph: null });
    expect(doc.parseError).toContain('not valid JSON');
  });

  it('a schema-valid but semantically-invalid hand-edit (cycle) degrades to unknown', async () => {
    await write(makeGraph());
    const wrapper = JSON.parse(fs.readFileSync(layout.canonicalPlanFile('s-1'), 'utf8')) as {
      plan: { tasks: { id: string; dependsOn: string[] }[] };
    };
    wrapper.plan.tasks[0]!.dependsOn = ['t2']; // t1 -> t2 -> t1
    fs.writeFileSync(layout.canonicalPlanFile('s-1'), JSON.stringify(wrapper));
    const doc = readCanonicalPlan(layout, 's-1');
    expect(doc.status).toBe('unknown');
    expect(doc.parseError).toContain('dependency cycle');
  });

  it('approve REFUSES an invalid plan with the reason; discard still works on invalid-but-JSON', async () => {
    await write(makeGraph());
    const wrapper = JSON.parse(fs.readFileSync(layout.canonicalPlanFile('s-1'), 'utf8')) as {
      plan: { tasks: { dependsOn: string[] }[] };
    };
    wrapper.plan.tasks[0]!.dependsOn = ['ghost'];
    fs.writeFileSync(layout.canonicalPlanFile('s-1'), JSON.stringify(wrapper));

    const a = await setCanonicalStatus(layout, 's-1', 'approved', snapshots, clock);
    expect('error' in a && a.error).toContain('cannot approve');

    const d = await setCanonicalStatus(layout, 's-1', 'superseded', snapshots, clock);
    expect('error' in d).toBe(false);
    // The invalid plan value is preserved verbatim through the discard.
    const after = JSON.parse(fs.readFileSync(layout.canonicalPlanFile('s-1'), 'utf8')) as {
      status: string;
      plan: { tasks: { dependsOn: string[] }[] };
    };
    expect(after.status).toBe('superseded');
    expect(after.plan.tasks[0]!.dependsOn).toEqual(['ghost']);
  });

  it('status changes refuse cleanly on a missing or non-JSON file', async () => {
    const missing = await setCanonicalStatus(layout, 's-none', 'approved', snapshots, clock);
    expect('error' in missing && missing.error).toContain('no canonical plan');

    fs.mkdirSync(path.dirname(layout.canonicalPlanFile('s-1')), { recursive: true });
    fs.writeFileSync(layout.canonicalPlanFile('s-1'), 'garbage');
    const broken = await setCanonicalStatus(layout, 's-1', 'superseded', snapshots, clock);
    expect('error' in broken && broken.error).toContain('not valid JSON');
  });
});

describe('readPlanState — the one unified reader', () => {
  it('prefers canonical, computes approvedAndCurrent from events + content sha', async () => {
    const w = await write(makeGraph());
    await setCanonicalStatus(layout, 's-1', 'approved', snapshots, clock);
    const events = [ev({ type: 'plan.approved', planId: 's-1', sha256: w.contentSha })];
    const st = readPlanState(layout, 's-1', events);
    expect(st).toMatchObject({ kind: 'canonical', status: 'approved', diverged: false, approvedAndCurrent: true });

    // Amend → sha changes → diverged, no longer approvedAndCurrent.
    await write(makeGraph((g) => (g['objective'] = 'changed')));
    const st2 = readPlanState(layout, 's-1', events);
    expect(st2).toMatchObject({ kind: 'canonical', status: 'draft', diverged: true, approvedAndCurrent: false });
  });

  it('falls back to the legacy markdown store with raw-bytes sha semantics', async () => {
    await writePlanBody(layout, 's-old', '# legacy plan\n', snapshots, clock);
    const raw = fs.readFileSync(layout.planFile('s-old'));
    const st = readPlanState(layout, 's-old', [ev({ type: 'plan.approved', planId: 's-old', sha256: sha256(raw) })]);
    expect(st.kind).toBe('legacy');
    expect(st.currentSha).toBe(sha256(raw));
    // Legacy approve-events bound post-rewrite bytes, so equality still means current.
    expect(st.diverged).toBe(false);
  });

  it('reports none when neither store has a document', () => {
    const st = readPlanState(layout, 's-1', []);
    expect(st).toMatchObject({ kind: 'none', status: 'none', currentSha: null, approvedAndCurrent: false });
  });
});

describe('plan views', () => {
  it('user view renders the task table in topo order and escapes table-breaking text', async () => {
    await write(makeGraph((g) => ((g['tasks'] as { title: string }[])[1]!.title = 'wire | it\nup')));
    const doc = readCanonicalPlan(layout, 's-1');
    const md = renderUserPlanView(doc);
    expect(md.startsWith(GENERATED_VIEW_MARKER)).toBe(true);
    expect(md).toContain('| t1 |');
    expect(md).toContain('wire \\| it up'); // pipe escaped, newline flattened
    expect(md.indexOf('| t1 |')).toBeLessThan(md.indexOf('| t2 |'));
    expect(md).toContain('**t1**: unit tests pass'); // verification is part of the consent surface
  });

  it('agent view carries intents, deps, touches, verify', async () => {
    await write(makeGraph());
    const view = renderAgentPlanView(readCanonicalPlan(layout, 's-1'));
    expect(view).toContain('- t2 [executor]');
    expect(view).toContain('dependsOn: t1');
    expect(view).toContain('verify: e2e passes');
    expect(view).toContain('content sha');
  });

  it('writeUserView archives a legacy user-authored md before overwriting; generated views are not archived', async () => {
    // A legacy plan exists at <id>.md (resumed old session), then the canonical flow writes a view.
    await writePlanBody(layout, 's-1', '# the user wrote this\n', snapshots, clock);
    const legacyBytes = fs.readFileSync(layout.planFile('s-1'));
    await write(makeGraph());
    const doc = readCanonicalPlan(layout, 's-1');

    const r1 = await writeUserView(layout, 's-1', doc, snapshots);
    expect('error' in r1).toBe(false);
    if (!('error' in r1)) {
      expect(r1.archivedLegacySha256).toBe(sha256(legacyBytes));
      expect(snapshots.getBlob(r1.archivedLegacySha256!).equals(legacyBytes)).toBe(true);
    }

    const r2 = await writeUserView(layout, 's-1', doc, snapshots);
    expect(!('error' in r2) && r2.archivedLegacySha256).toBeNull(); // generated → no archive needed
  });
});

describe('update_plan names the completed tasks an amendment re-opens (S16.5b)', () => {
  // The definition-identity rule re-queues a COMPLETED task whose prose changed — the
  // conservative direction — but the model habitually resubmits the whole graph and used to
  // learn which tasks it re-opened only when /accept listed them as queued.
  const completedT1Events = (): SessionEvent[] => [
    ev({ callId: 'c1', type: 'task.started', role: 'executor', planTaskId: 't1', childSessionId: 'k1' }),
    ev({ callId: 'c1', type: 'task.changes', childSessionId: 'k1', files: [{ relPath: 'src/core/a.ts', kind: 'modify', afterSha256: 'a', beforeSha256: 'b', bytes: 1 }], omittedCount: 0 }),
    ev({ callId: 'c1', type: 'task.ended', childSessionId: 'k1', status: 'completed' }),
    ev({ callId: 'c1', type: 'task.applied', childSessionId: 'k1', applied: ['src/core/a.ts'], refused: [] }),
  ];
  const ctx = (): ToolContext => ({ workspaceRoot: path.join(tmp, 'ws'), stateDir: layout.projectDir });

  it('warns with the re-opened task ids; an additive amendment stays silent', async () => {
    const events = completedT1Events();
    const tool = createUpdatePlanTool({ layout, snapshots, planId: 's-1', clock, events: () => events });
    // execute() receives the ZOD-PARSED input in production (defaults applied) — mirror that.
    const raw = PlanGraphSchema.parse({
      objective: 'ship the feature',
      tasks: [
        { id: 't1', title: 'core module', intent: 'build it', role: 'executor', verify: 'unit tests pass', touches: ['src/core'] },
        { id: 't2', title: 'wire it', intent: 'integrate', role: 'executor', verify: 'e2e passes', dependsOn: ['t1'], touches: ['src/app'] },
      ],
    });
    const first = await tool.execute({ plan: raw } as never, ctx());
    expect(first.ok).toBe(true);
    expect(first.output).not.toContain('RE-OPENED');

    // A cosmetic rewrite of the COMPLETED t1 — exactly the kimi full-graph-resubmit habit.
    const amended = { ...raw, tasks: [{ ...raw.tasks[0]!, title: 'core module (done)' }, raw.tasks[1]!] };
    const second = await tool.execute({ plan: amended } as never, ctx());
    expect(second.ok).toBe(true);
    expect(second.output).toContain('COMPLETED task(s) t1');
    expect(second.output).toContain('RE-OPENED');

    // Additive change over the CURRENT prior (new task; t1/t2 byte-identical to what is on
    // disk now — the second write): nothing is re-opened, no warning.
    const additive = PlanGraphSchema.parse({ ...amended, tasks: [...amended.tasks, { id: 't3', title: 'polish', intent: 'p', role: 'main', verify: 'reads well' }] });
    const third = await tool.execute({ plan: additive } as never, ctx());
    expect(third.ok).toBe(true);
    expect(third.output).not.toContain('RE-OPENED');
  });
});
