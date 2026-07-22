import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPlan, writePlanBody, setPlanStatus, PLAN_READ_CAP_CHARS } from '../src/plan/store.js';
import { SnapshotStore } from '../src/store/snapshots.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { sha256 } from '../src/shared/hash.js';

/**
 * The plan document store: current bytes are truth, model writes never change status, prior
 * bytes are blob-archived, and a malformed plan can never block anything (reads never throw).
 */

let tmp: string;
let layout: ProjectLayout;
let snapshots: SnapshotStore;
const clock = fixedClock(Date.UTC(2026, 6, 22), 1000);

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-plan-')));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
  snapshots = new SnapshotStore(layout.objectsDir);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const BODY = '# Plan: demo\n\ncontext paragraph\n\n## Task 1: build the thing\nStatus: pending\nDependsOn: none\nVerify: npm test\n\n## Task 2: check it\nStatus: pending\nDependsOn: 1\nVerify: run the app\n';

describe('plan store roundtrip', () => {
  it('first write creates a draft with harness-owned frontmatter; readPlan parses it back', async () => {
    const w = await writePlanBody(layout, 's-1', BODY, snapshots, clock);
    expect(w.status).toBe('draft');
    expect(w.prevSha256).toBeNull();

    const p = readPlan(layout, 's-1');
    expect(p).toMatchObject({ exists: true, status: 'draft', planId: 's-1', truncated: false });
    expect(p.sha256).toBe(w.sha256);
    expect(p.text).toContain('plan: s-1');
    expect(p.text).toContain('## Task 1: build the thing');
    expect(p.tasks).toEqual([
      { title: 'Task 1: build the thing', status: 'pending' },
      { title: 'Task 2: check it', status: 'pending' },
    ]);
  });

  it('a model rewrite preserves status and archives the prior bytes as a blob', async () => {
    await writePlanBody(layout, 's-1', BODY, snapshots, clock);
    const approved = await setPlanStatus(layout, 's-1', 'approved', snapshots, clock);
    expect('error' in approved).toBe(false);

    const beforeRewrite = fs.readFileSync(layout.planFile('s-1'));
    const w2 = await writePlanBody(layout, 's-1', BODY + '\n## Task 3: extra\nStatus: pending\n', snapshots, clock);
    // Model writes can NEVER change status — only /plan approve|discard do.
    expect(w2.status).toBe('approved');
    expect(readPlan(layout, 's-1').status).toBe('approved');
    // The replaced bytes are recoverable from the content-addressed archive.
    expect(w2.prevSha256).toBe(sha256(beforeRewrite));
    expect(snapshots.getBlob(w2.prevSha256!).equals(beforeRewrite)).toBe(true);
  });

  it('a leading frontmatter block in the model body is stripped (the harness re-stamps its own)', async () => {
    await writePlanBody(layout, 's-1', '---\nstatus: approved\nplan: hijack\n---\nreal body\n', snapshots, clock);
    const p = readPlan(layout, 's-1');
    expect(p.status).toBe('draft'); // the model cannot smuggle an approval through its body
    expect(p.text).toContain('real body');
    expect(p.text).not.toContain('hijack');
  });

  it('setPlanStatus preserves the body byte-verbatim and refuses when no plan exists', async () => {
    await writePlanBody(layout, 's-1', BODY, snapshots, clock);
    const before = readPlan(layout, 's-1');
    const w = await setPlanStatus(layout, 's-1', 'approved', snapshots, clock);
    expect('error' in w).toBe(false);
    const after = readPlan(layout, 's-1');
    expect(after.status).toBe('approved');
    // Same body, different frontmatter: the sha changes but the task content is untouched.
    expect(after.text.split('---\n')[2]).toBe(before.text.split('---\n')[2]);

    const missing = await setPlanStatus(layout, 's-none', 'approved', snapshots, clock);
    expect('error' in missing && missing.error).toContain('no plan document');
  });
});

describe('plan store leniency (a broken plan never blocks)', () => {
  it('readPlan on a missing file is a clean non-existent doc', () => {
    expect(readPlan(layout, 'nope')).toMatchObject({ exists: false, status: 'unknown', sha256: null });
  });

  it('a user-mangled frontmatter reads as status unknown, content intact', async () => {
    await writePlanBody(layout, 's-1', BODY, snapshots, clock);
    fs.writeFileSync(layout.planFile('s-1'), 'not frontmatter at all\n## Task 1: still here\nStatus: doing it\n');
    const p = readPlan(layout, 's-1');
    expect(p).toMatchObject({ exists: true, status: 'unknown' });
    expect(p.tasks).toEqual([{ title: 'Task 1: still here', status: 'doing it' }]);
  });

  it('an oversize plan is truncated for display with the raw file untouched', async () => {
    const big = '# Plan\n' + 'x'.repeat(PLAN_READ_CAP_CHARS + 1000);
    await writePlanBody(layout, 's-1', big, snapshots, clock);
    const p = readPlan(layout, 's-1');
    expect(p.truncated).toBe(true);
    expect(p.text.length).toBe(PLAN_READ_CAP_CHARS);
    expect(fs.readFileSync(layout.planFile('s-1'), 'utf8').length).toBeGreaterThan(PLAN_READ_CAP_CHARS);
  });

  it('user edits win: whatever bytes are on disk are what readPlan reports', async () => {
    await writePlanBody(layout, 's-1', BODY, snapshots, clock);
    const userVersion = '---\nplan: s-1\nstatus: draft\n---\n\n# My own plan\n## Task 1: the user knows best\nStatus: pending\n';
    fs.writeFileSync(layout.planFile('s-1'), userVersion);
    const p = readPlan(layout, 's-1');
    expect(p.sha256).toBe(sha256(userVersion));
    expect(p.tasks[0]!.title).toContain('the user knows best');
  });
});
