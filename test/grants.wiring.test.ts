import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatApprovalPrompt, createInteractiveApprover } from '../src/runtime/approvals.js';
import { startSession, endSession, runTurn, type Session } from '../src/runtime/session.js';
import { TOOLS } from '../src/tools/index.js';
import { MockProvider } from '../src/provider/mock.js';
import { resolveLayout } from '../src/store/layout.js';
import { addGrant } from '../src/store/grants.js';
import { trustKey } from '../src/trust/store.js';
import type { ApprovalRequest, Approver, PersistGrantRecord } from '../src/types.js';

/**
 * Session 21 — durable-grant wiring: the [a] option appears exactly where a durable grant would
 * actually be stored; an unoffered 'a' is a deny; a 'machine' answer persists through the seam
 * BEFORE the approval event is recorded, and a failed/unavailable persist downgrades HONESTLY
 * to 'session' with the reason on the event.
 */

let tmp: string;
let ws: string;
let state: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-gw-')));
  ws = path.join(tmp, 'ws');
  state = path.join(tmp, 'state');
  fs.mkdirSync(ws);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function req(over: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    callId: 'c1',
    tool: 'web_search',
    classification: 'external',
    kind: 'research',
    summary: 'web_search: "zod v4"',
    detail: 'query: zod v4',
    reason: 'sends the query to api.tavily.com',
    ...over,
  };
}

describe('the [a] offer (prompt surface)', () => {
  it('shows for the three eligible class asks and for checks; prints the literal rule and the revoke path', () => {
    const research = formatApprovalPrompt(req({}), true);
    expect(research).toContain('[a] ALWAYS allow bounded web searches on this machine');
    expect(research).toContain('stored rule: web_search::external');
    expect(research).toContain('revoke: agent grants');

    const spawn = formatApprovalPrompt(req({ tool: 'delegate_task' }), true);
    expect(spawn).toContain('research-subagent spawns');
    expect(spawn).toContain('stored rule: delegate_task::external');

    const remoteRead = formatApprovalPrompt(req({ tool: 'remote_status', kind: 'remote-read' }), true);
    expect(remoteRead).toContain('ALWAYS allow remote READS');
    expect(remoteRead).toContain('never a push, tag or release');

    const check = formatApprovalPrompt(req({ tool: 'run_check', classification: 'reversible', kind: 'check', checkCount: 2 }), true);
    expect(check).toContain('[a] ALWAYS allow re-runs of THESE 2 EXACT commands in this workspace on this machine');
    expect(check).toContain('a changed script or command re-asks');
  });

  it('never shows when not offered, on forwarded asks, or on ineligible surfaces', () => {
    // Not offered (non-TTY / dangerous contexts pass offerDurable=false).
    expect(formatApprovalPrompt(req({}), false)).not.toContain('[a]');
    // Forwarded child ask: durable authority is not minted from inside a delegation.
    expect(formatApprovalPrompt(req({ taskContext: { childSessionId: 'ch1', role: 'executor' } }), true)).not.toContain('[a]');
    // Remote WRITE (external classification, deliberately ineligible).
    expect(formatApprovalPrompt(req({ tool: 'remote_push', kind: 'remote-write' }), true)).not.toContain('[a]');
    // Setup (install) — replay durability deferred.
    expect(formatApprovalPrompt(req({ tool: 'project_setup', kind: 'setup', checkCount: 1 }), true)).not.toContain('[a]');
    // Sensitive reads — standing read-anything is too broad (kindless request shape).
    const { kind: _dropped, ...sensitiveRead } = req({ tool: 'read_file', classification: 'sensitive' });
    expect(formatApprovalPrompt(sensitiveRead as ApprovalRequest, true)).not.toContain('[a]');
    // A migration (setup, no replay keys) and a preview keep their existing shapes.
    expect(formatApprovalPrompt(req({ tool: 'preview', kind: 'preview', checkCount: 1 }), true)).not.toContain('[a]');
  });

  it("an unoffered 'a' answer is a DENY, never a silent scope upgrade", async () => {
    const answers = ['a'];
    const approver = createInteractiveApprover({ question: async () => answers.shift() ?? 'n' }, undefined, { offerDurable: false });
    const outcome = await approver(req({}));
    expect(outcome).toMatchObject({ decision: 'deny', scope: 'once' });
  });

  it("an offered 'a' resolves allow/machine; eligibility is per-request even with offerDurable on", async () => {
    const approver = createInteractiveApprover({ question: async () => 'a' }, undefined, { offerDurable: true });
    expect(await approver(req({}))).toMatchObject({ decision: 'allow', scope: 'machine', source: 'user' });
    // Same approver, ineligible request: 'a' stays a deny.
    expect(await approver(req({ tool: 'remote_push', kind: 'remote-write' }))).toMatchObject({ decision: 'deny' });
  });
});

function makeSession(approver: Approver, persistGrant?: (r: PersistGrantRecord) => Promise<void>): Session {
  const layout = resolveLayout(ws, { ensure: true, env: { AGENT_CLI_STATE_DIR: state } });
  const session = startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock',
    mode: 'interactive',
    provider: new MockProvider([
      // One out-of-workspace read → a sensitive ask through the REAL policy engine.
      { say: 'reading', calls: [{ name: 'read_file', input: { path: path.join(tmp, 'outside.txt') } }] },
      { say: 'done' },
    ]),
    approver,
    tools: [...TOOLS],
    saltHex: '00'.repeat(16),
  });
  if (persistGrant !== undefined) session.persistGrant = persistGrant;
  return session;
}

const machineApprover: Approver = async () => ({ decision: 'allow', scope: 'machine', source: 'user' });

describe('the runtime storage site (machine scope)', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside bytes');
  });

  it('persists through the seam, then records scope machine; the session grant stores too', async () => {
    const records: PersistGrantRecord[] = [];
    const session = makeSession(machineApprover, async (r) => {
      records.push(r);
    });
    try {
      await runTurn(session, 'read it');
      const ev = session.log.events.find((e) => e.type === 'approval.resolved');
      expect(ev).toMatchObject({ scope: 'machine', decision: 'allow' });
      expect(records).toEqual([{ kind: 'class', tool: 'read_file', cls: 'sensitive' }]);
      expect(session.grants.has('read_file', 'sensitive')).toBe(true);
    } finally {
      await endSession(session, 'completed');
    }
  });

  it('no seam (tests/children) → recorded scope downgrades to session with the honest detail', async () => {
    const session = makeSession(machineApprover);
    try {
      await runTurn(session, 'read it');
      const ev = session.log.events.find((e) => e.type === 'approval.resolved');
      expect(ev).toMatchObject({ scope: 'session', decision: 'allow' });
      expect(ev !== undefined && ev.type === 'approval.resolved' ? ev.detail : '').toContain('kept as a session grant');
      expect(session.grants.has('read_file', 'sensitive')).toBe(true); // the user still consented session-wide
    } finally {
      await endSession(session, 'completed');
    }
  });

  it('a THROWING seam (locked store, ineligible identity) downgrades the record the same way', async () => {
    const session = makeSession(machineApprover, async () => {
      throw new Error('not durable-eligible: read_file::sensitive');
    });
    try {
      await runTurn(session, 'read it');
      const ev = session.log.events.find((e) => e.type === 'approval.resolved');
      expect(ev).toMatchObject({ scope: 'session' });
      expect(ev !== undefined && ev.type === 'approval.resolved' ? ev.detail : '').toContain('durable grant NOT stored');
    } finally {
      await endSession(session, 'completed');
    }
  });
});

describe('the production seam (assembly closure semantics, exercised via the store)', () => {
  it('workspace keying uses the trust derivation, so grants and trust can never disagree about identity', async () => {
    const key = trustKey(fs.realpathSync.native(ws));
    await addGrant(state, { kind: 'check-replay', workspaceKey: key, replayKey: 'k-1', label: 'npm run test' }, '2026-08-11T00:00:00.000Z');
    // A DIFFERENT casing of the same real path folds to the same key — trustKey's contract.
    expect(trustKey(fs.realpathSync.native(ws).toUpperCase())).toBe(key);
  });
});
