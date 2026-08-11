import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { dispatchSlash, type CommandContext } from '../src/repl/commands.js';
import { startSession, endSession, type Session } from '../src/runtime/session.js';
import { resolveLayout } from '../src/store/layout.js';
import { MockProvider } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { buildReport } from '../src/report/report.js';
import type { Renderer } from '../src/repl/render.js';

/**
 * Session 21 — the user-side closure path for repair escalations: /repair (ledger digest) and
 * /repair dismiss <n> <reason> (the recorded decision). The S20.5 live E2E demonstrated the
 * deadlock this closes: a session-targeted escalation of a non-auto-eligible class had NO
 * closure path, pinning a fully-green session at PARTIAL acceptance.
 */

let tmp: string;
let ws: string;
let state: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-repair-')));
  ws = path.join(tmp, 'ws');
  state = path.join(tmp, 'state');
  fs.mkdirSync(ws);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeRenderer(chrome: string[]): Renderer {
  return {
    onText: () => {},
    onCommandOutput: () => {},
    onEvent: () => {},
    beginTurn: () => {},
    endTurn: () => {},
    turnError: () => {},
    banner: () => {},
    chromeLine: (t) => chrome.push(t),
    flush: () => {},
  };
}

function makeSession(): Session {
  const layout = resolveLayout(ws, { ensure: true, env: { AGENT_CLI_STATE_DIR: state } });
  return startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock',
    mode: 'interactive',
    provider: new MockProvider([]),
    approver: autoDenyApprover,
    tools: [],
    saltHex: '00'.repeat(16),
  });
}

function ctxFor(session: Session, chrome: string[]): CommandContext {
  return {
    session,
    layout: resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: state } }),
    renderer: fakeRenderer(chrome),
    modelOut: new PassThrough(),
    pendingNotes: [],
  };
}

function escalate(session: Session, target = 'session'): number {
  session.log.append({
    type: 'repair.escalated',
    callId: 'c1',
    target,
    failureClass: 'timeout-resource',
    signature: 'sig-1',
    reason: 'executor hit the wall clock',
  });
  return session.log.events[session.log.events.length - 1]!.seq;
}

describe('/repair — the bounded-repair ledger surface (S21)', () => {
  it('digest with no activity says so; dismiss with nothing open refuses without appending', async () => {
    const session = makeSession();
    try {
      const chrome: string[] = [];
      const ctx = ctxFor(session, chrome);
      await dispatchSlash('/repair', ctx);
      expect(chrome.join('\n')).toContain('no repair activity this session');

      await dispatchSlash('/repair dismiss 1 whatever', ctx);
      expect(chrome.join('\n')).toContain('nothing to dismiss');
      expect(session.log.events.some((e) => e.type === 'repair.dismissed')).toBe(false);
    } finally {
      await endSession(session, 'completed');
    }
  });

  it('dismiss appends the event joined on the escalation seq, tells the model, and the digest flips', async () => {
    const session = makeSession();
    try {
      const escSeq = escalate(session);
      const chrome: string[] = [];
      const ctx = ctxFor(session, chrome);

      await dispatchSlash('/repair', ctx);
      expect(chrome.join('\n')).toContain("[1] OPEN escalation on 'session' (timeout-resource)");

      await dispatchSlash('/repair dismiss 1 verified by hand; the timeout was environmental', ctx);
      const dismissed = session.log.events.find((e) => e.type === 'repair.dismissed');
      expect(dismissed).toBeDefined();
      if (dismissed?.type !== 'repair.dismissed') throw new Error('unreachable');
      expect(dismissed.escalationSeq).toBe(escSeq);
      expect(dismissed.target).toBe('session');
      expect(dismissed.signature).toBe('sig-1');
      expect(dismissed.source).toBe('user');
      expect(dismissed.reason).toBe('verified by hand; the timeout was environmental');
      // The model learns via the next user message, attributably.
      expect(ctx.pendingNotes.join(' ')).toContain('DISMISSED');
      expect(ctx.pendingNotes.join(' ')).toContain('Do not re-escalate');
      // The confirmation is honest: caveat, not resolution.
      expect(chrome.join('\n')).toContain('acceptance caveat, not as a resolution');

      chrome.length = 0;
      await dispatchSlash('/repair', ctx);
      expect(chrome.join('\n')).toContain('DISMISSED by you: verified by hand');
      expect(chrome.join('\n')).not.toContain('[1] OPEN');
    } finally {
      await endSession(session, 'completed');
    }
  });

  it('dismiss refuses an empty reason and a stale index — nothing is appended', async () => {
    const session = makeSession();
    try {
      escalate(session);
      const chrome: string[] = [];
      const ctx = ctxFor(session, chrome);

      await dispatchSlash('/repair dismiss 1', ctx);
      expect(chrome.join('\n')).toContain('a dismissal needs a reason');

      await dispatchSlash('/repair dismiss 4 out of range', ctx);
      expect(chrome.join('\n')).toContain('n is the OPEN escalation number');

      expect(session.log.events.some((e) => e.type === 'repair.dismissed')).toBe(false);
    } finally {
      await endSession(session, 'completed');
    }
  });

  it('/status gains the repairs line; the report renders DISMISSED with the reason', async () => {
    const session = makeSession();
    try {
      escalate(session);
      const chrome: string[] = [];
      const ctx = ctxFor(session, chrome);
      await dispatchSlash('/status', ctx);
      expect(chrome.join('\n')).toContain('repairs: 0 attempt(s) · 1 escalation(s) — 1 OPEN');

      await dispatchSlash('/repair dismiss 1 accepted as environmental', ctx);
      chrome.length = 0;
      await dispatchSlash('/status', ctx);
      expect(chrome.join('\n')).toContain('1 dismissed');

      const { md } = buildReport({ events: session.log.events });
      expect(md).toContain('DISMISSED by the user: accepted as environmental');
      expect(md).toContain('closed, not resolved');
    } finally {
      await endSession(session, 'completed');
    }
  });
});
