import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSession, endSession, runTurn, type Session } from '../src/runtime/session.js';
import { createReviewTool } from '../src/tools/review.js';
import { decide, Grants } from '../src/policy/engine.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { ReviewFinding, Tool } from '../src/types.js';

/**
 * Session 14 — the review triage tool: call-level refusals keep the log clean (unknown ids,
 * severity-invalid accepts, unverifiable address refs record NOTHING), effective triage lands
 * as review.triage under the runtime callId, and the output reports the derived post-state.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'revtriage-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const finding = (id: string, severity: ReviewFinding['severity']): ReviewFinding => ({
  findingId: id,
  severity,
  title: 'XSS via innerHTML',
  paths: ['public/app.js'],
  evidence: 'read public/app.js:42 — unescaped interpolation',
  scenario: 'a crafted note executes script',
  confidence: 'high',
});

/** A session whose log is seeded with one review round (and optional fix evidence). */
function makeSession(script: ScriptTurn[], seed: { findings: ReviewFinding[]; withFix?: boolean }): Session {
  const session = startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock',
    mode: 'non-interactive',
    provider: new MockProvider(script),
    approver: autoDenyApprover,
    tools: [],
    saltHex: '00'.repeat(16),
    clock: fixedClock(0, 1),
    idGen: seededIdGen(),
  });
  session.tools = [
    createReviewTool({ events: () => session.log.events, planGraph: () => null }) as Tool,
  ];
  session.log.append({ type: 'file.mutated', callId: 'fix-call', path: path.join(ws, 'a.ts'), kind: 'modify', beforeSha256: 'a', afterSha256: 'b', createdDirs: [] });
  session.log.append({ type: 'task.started', callId: 'rev-call', role: 'reviewer', childSessionId: 'child-rev-0001', budget: { maxSteps: 1, timeoutMs: 1, maxOutputTokens: 1 } });
  session.log.append({
    type: 'task.ended',
    callId: 'rev-call',
    childSessionId: 'child-rev-0001',
    status: 'completed',
    steps: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    resultSha256: 'x',
    durationMs: 1,
  });
  session.log.append({ type: 'review.findings', callId: 'rev-call', childSessionId: 'child-rev-0001', findings: seed.findings });
  if (seed.withFix === true) {
    session.log.append({ type: 'check.completed', callId: 'chk', check: 'test', recipeId: 'npm-script:test', status: 'pass', exitCode: 0, durationMs: 1, summary: 'ok' });
  }
  return session;
}

const call = (input: Record<string, unknown>): ScriptTurn[] => [
  { say: 'triaging', calls: [{ name: 'review', input }] },
  { say: 'done' },
];

const EVIDENCE = 'read public/app.js:42 against the report — checked the actual rendering path';

describe('review triage tool', () => {
  it('verify records the triage under the runtime callId; the finding STILL BLOCKS', async () => {
    const s = makeSession(call({ finding: 'child-rev-0001#1', action: 'verify', evidence: EVIDENCE }), {
      findings: [finding('child-rev-0001#1', 'critical')],
    });
    await runTurn(s, 'triage it');
    const tri = s.log.events.find((e) => e.type === 'review.triage');
    expect(tri).toMatchObject({ findingId: 'child-rev-0001#1', action: 'verify', evidence: EVIDENCE });
    const req = s.log.events.find((e) => e.type === 'tool.requested' && e.tool === 'review');
    expect(tri?.type === 'review.triage' && req?.type === 'tool.requested' && tri.callId === req.callId).toBe(true);
    expect(JSON.stringify(s.messages)).toContain('STILL BLOCKING');
    endSession(s, 'completed');
  });

  it('refute clears the block and the output labels it an unverified model claim', async () => {
    const s = makeSession(call({ finding: 'child-rev-0001#1', action: 'refute', evidence: EVIDENCE }), {
      findings: [finding('child-rev-0001#1', 'critical')],
    });
    await runTurn(s, 'triage it');
    const msg = JSON.stringify(s.messages);
    expect(msg).toContain('now refuted');
    expect(msg).toContain('unverified model claim');
    expect(msg).toContain('No review blockers remain');
    endSession(s, 'completed');
  });

  it("accept on a critical is REFUSED as a call — nothing recorded, consent named as the user's", async () => {
    const s = makeSession(call({ finding: 'child-rev-0001#1', action: 'accept', evidence: EVIDENCE }), {
      findings: [finding('child-rev-0001#1', 'critical')],
    });
    await runTurn(s, 'triage it');
    expect(s.log.events.find((e) => e.type === 'review.triage')).toBeUndefined();
    const msg = JSON.stringify(s.messages);
    expect(msg).toContain('invalid for a critical finding');
    expect(msg).toContain('/accept confirm');
    endSession(s, 'completed');
  });

  it('accept on a medium records the limitation caveat', async () => {
    const s = makeSession(call({ finding: 'child-rev-0001#1', action: 'accept', evidence: EVIDENCE }), {
      findings: [finding('child-rev-0001#1', 'medium')],
    });
    await runTurn(s, 'triage it');
    expect(s.log.events.find((e) => e.type === 'review.triage')).toMatchObject({ action: 'accept' });
    expect(JSON.stringify(s.messages)).toContain('accepted limitation');
    endSession(s, 'completed');
  });

  it('address with a ghost ref is REFUSED (nothing recorded); a real callId ref clears', async () => {
    const bad = makeSession(call({ finding: 'child-rev-0001#1', action: 'address', evidence: EVIDENCE, refs: ['ghost-call'] }), {
      findings: [finding('child-rev-0001#1', 'critical')],
    });
    await runTurn(bad, 'triage it');
    expect(bad.log.events.find((e) => e.type === 'review.triage')).toBeUndefined();
    expect(JSON.stringify(bad.messages)).toContain('ghost-call');
    endSession(bad, 'completed');

    const good = makeSession(call({ finding: 'child-rev-0001#1', action: 'address', evidence: EVIDENCE, refs: ['fix-call'] }), {
      findings: [finding('child-rev-0001#1', 'critical')],
    });
    await runTurn(good, 'triage it');
    expect(good.log.events.find((e) => e.type === 'review.triage')).toMatchObject({ action: 'address', refs: ['fix-call'] });
    expect(JSON.stringify(good.messages)).toContain('now addressed');
    endSession(good, 'completed');
  });

  it('address accepts a passing check recipeId; address without refs is refused', async () => {
    const s = makeSession(call({ finding: 'child-rev-0001#1', action: 'address', evidence: EVIDENCE, refs: ['npm-script:test'] }), {
      findings: [finding('child-rev-0001#1', 'high')],
      withFix: true,
    });
    await runTurn(s, 'triage it');
    expect(s.log.events.find((e) => e.type === 'review.triage')).toMatchObject({ refs: ['npm-script:test'] });
    endSession(s, 'completed');

    const noRefs = makeSession(call({ finding: 'child-rev-0001#1', action: 'address', evidence: EVIDENCE }), {
      findings: [finding('child-rev-0001#1', 'high')],
    });
    await runTurn(noRefs, 'triage it');
    expect(noRefs.log.events.find((e) => e.type === 'review.triage')).toBeUndefined();
    expect(JSON.stringify(noRefs.messages)).toContain("'address' requires refs");
    endSession(noRefs, 'completed');
  });

  it('an unknown finding id is refused, naming the known ids', async () => {
    const s = makeSession(call({ finding: 'nope#7', action: 'refute', evidence: EVIDENCE }), {
      findings: [finding('child-rev-0001#1', 'low')],
    });
    await runTurn(s, 'triage it');
    expect(s.log.events.find((e) => e.type === 'review.triage')).toBeUndefined();
    expect(JSON.stringify(s.messages)).toContain('child-rev-0001#1');
    endSession(s, 'completed');
  });

  it('policy: observe/auto-allow (events only — the recover precedent), pinned structurally', () => {
    const tool = createReviewTool({ events: () => [], planGraph: () => null }) as Tool;
    expect(tool.command).toBeUndefined();
    expect(tool.delegates).toBeUndefined();
    expect(tool.planDoc).toBeUndefined();
    expect(tool.check).toBeUndefined();
    expect(tool.browser).toBeUndefined();
    expect(tool.evidenceRead).toBeUndefined();
    const d = decide(tool, { finding: 'x#1', action: 'verify', evidence: 'e'.repeat(30) }, { workspaceRoot: ws, stateDir: path.join(tmp, 'state') }, new Grants());
    expect(d).toMatchObject({ decision: 'allow', classification: 'observe' });
  });
});
