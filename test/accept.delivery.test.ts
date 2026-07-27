import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { runRepl } from '../src/repl/repl.js';
import { dispatchSlash, type CommandContext } from '../src/repl/commands.js';
import { startSession, endSession, type Session } from '../src/runtime/session.js';
import { resolveLayout } from '../src/store/layout.js';
import { EventLog } from '../src/store/event-log.js';
import { findGitOnPath, runGit } from '../src/git/client.js';
import { createCheckpoint, type CheckpointContext } from '../src/git/checkpoint.js';
import { MockProvider } from '../src/provider/mock.js';
import { createNoneSandbox } from '../src/sandbox/none.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { workSince } from '../src/runtime/acceptance.js';
import type { Renderer } from '../src/repl/render.js';
import type { CliValues } from '../src/cli/context.js';
import type { ScriptTurn } from '../src/provider/mock.js';
import type { GitFacts } from '../src/git/types.js';
import type { SessionEvent } from '../src/types.js';

/**
 * Session 14 — the delivery checkpoint at the /accept COMPLETE boundary: created BEFORE the
 * session.accepted append (event-before-ref, so the acceptance can reference it), SURVIVES the
 * session-end prune as the durable audit anchor, superseded-then-pruned by a later acceptance,
 * idempotently reused across the crash window, and never a hostage-taker (failures caveat,
 * acceptance still records).
 */

const REAL_GIT = findGitOnPath(process.env, process.platform);
const hasGit = REAL_GIT !== null;

let tmp: string;
let ws: string;
let state: string;
let savedStateDir: string | undefined;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-deliv-')));
  ws = path.join(tmp, 'ws');
  state = path.join(tmp, 'state');
  fs.mkdirSync(ws);
  savedStateDir = process.env['AGENT_CLI_STATE_DIR'];
  process.env['AGENT_CLI_STATE_DIR'] = state;
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env['AGENT_CLI_STATE_DIR'];
  else process.env['AGENT_CLI_STATE_DIR'] = savedStateDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function git(cwd: string, ...argv: string[]) {
  return runGit({ gitPath: REAL_GIT!, argv, cwd });
}

async function initWsRepo(): Promise<void> {
  expect((await git(ws, 'init', '-q', '-b', 'main')).ok).toBe(true);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'base\n');
  expect((await git(ws, 'add', '-A', '--', '.')).ok).toBe(true);
  expect((await git(ws, '-c', 'user.name=T', '-c', 'user.email=t@e.c', 'commit', '-q', '-m', 'base')).ok).toBe(true);
}

async function drive(script: ScriptTurn[], lines: string[]): Promise<{ code: number; chromeOut: string; events: SessionEvent[] }> {
  const scriptFile = path.join(tmp, 'script.json');
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  const values: CliValues = { C: ws, provider: 'mock', script: scriptFile, interactive: true, 'trust-this-workspace': true };
  const input = new PassThrough();
  const chromeChunks: Buffer[] = [];
  const modelOut = new PassThrough();
  modelOut.resume();
  const chromeOut = new PassThrough();
  chromeOut.on('data', (c: Buffer) => chromeChunks.push(c));
  input.write(lines.join(''));
  input.end();
  const code = await runRepl(values, { streams: { input, modelOut, chromeOut, isTTY: false }, sandbox: createNoneSandbox('test') });
  const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: state } });
  let events: SessionEvent[] = [];
  const files = fs.readdirSync(layout.sessionsDir).filter((f) => f.endsWith('.jsonl'));
  if (files.length > 0) events = EventLog.readLenient(layout.sessionFile(files[0]!.slice(0, -6))).events;
  return { code, chromeOut: Buffer.concat(chromeChunks).toString('utf8'), events };
}

function wsGitFacts(): GitFacts {
  return {
    isRepo: true,
    gitPath: REAL_GIT!,
    gitVersion: 'git version 2.40.0',
    repoRoot: ws,
    workspaceIsRepoRoot: true,
    branch: 'main',
    detached: false,
    unborn: false,
    head: null,
    upstream: null,
    ahead: null,
    behind: null,
    dirtyCount: null,
    untrackedCount: null,
    probeFailed: false,
    detail: 'test facts',
  };
}

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
    gitFacts: wsGitFacts(),
  });
}

function acceptCtx(session: Session, chrome: string[]): CommandContext {
  return {
    session,
    layout: resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: state } }),
    renderer: fakeRenderer(chrome),
    modelOut: new PassThrough(),
    pendingNotes: [],
    question: async () => 'y',
  };
}

describe.skipIf(!hasGit)('/accept delivery checkpoint (Session 14) — full REPL boundary', () => {
  it('COMPLETE accept captures a delivery ref BEFORE the consent event; the ref SURVIVES the quit prune', async () => {
    await initWsRepo();
    const r = await drive([{ say: 'hi' }], ['hello\n', '/accept\n', '/quit\n']);
    expect(r.code).toBe(0);

    const hc = r.events.find((e) => e.type === 'harness.checkpoint');
    expect(hc).toBeDefined();
    if (hc?.type !== 'harness.checkpoint') throw new Error('unreachable');
    expect(hc.kind).toBe('delivery');
    expect(hc.callId).toBeUndefined(); // /accept is a REPL command, not a tool call

    const accepted = r.events.find((e) => e.type === 'session.accepted');
    expect(accepted).toBeDefined();
    if (accepted?.type !== 'session.accepted') throw new Error('unreachable');
    expect(accepted.complete).toBe(true);
    // Event-before-ref AND checkpoint-before-consent: the acceptance references the checkpoint.
    expect(hc.seq).toBeLessThan(accepted.seq);
    expect(accepted.deliveryRef).toBe(hc.ref);
    expect(accepted.deliveryOid).toBe(hc.oid);

    // The delivery suggestion stays guidance, never automation.
    expect(r.chromeOut).toContain('/commit turns the accepted work into a user-visible commit (optional)');
    expect(r.chromeOut).toContain(hc.oid.slice(0, 12));

    // The quit prune ran (it is wired for every repo session) and KEPT the delivery anchor:
    // exactly one surviving ref under refs/agent-cli, and it is the delivery checkpoint.
    const refs = (await git(ws, 'for-each-ref', '--format=%(refname)', 'refs/agent-cli/')).stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(refs).toEqual([hc.ref]);
    // No pruned event names the delivery ref.
    for (const e of r.events) {
      if (e.type === 'git.checkpoint.pruned') expect(e.refs).not.toContain(hc.ref);
    }
  });

  it('a later acceptance supersedes: the old delivery ref is owed-pruned, the new one survives', async () => {
    await initWsRepo();
    const r = await drive(
      [{ say: 'hi' }, { say: 'changed', calls: [{ name: 'write_file', input: { path: 'a.txt', content: 'v2\n' } }] }, { say: 'done' }],
      ['hello\n', '/accept\n', 'change it\n', '/accept\n', '/quit\n'],
    );
    expect(r.code).toBe(0);

    const deliveries = r.events.filter((e) => e.type === 'harness.checkpoint');
    expect(deliveries).toHaveLength(2);
    const [d1, d2] = deliveries;
    if (d1?.type !== 'harness.checkpoint' || d2?.type !== 'harness.checkpoint') throw new Error('unreachable');

    const accepts = r.events.filter((e) => e.type === 'session.accepted');
    expect(accepts).toHaveLength(2);
    const second = accepts[1]!;
    if (second.type !== 'session.accepted') throw new Error('unreachable');
    expect(second.deliveryRef).toBe(d2.ref);

    // Quit prune: d1 superseded → pruned; d2 is the durable anchor → survives.
    const refs = (await git(ws, 'for-each-ref', '--format=%(refname)', 'refs/agent-cli/')).stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(refs).toEqual([d2.ref]);
    const pruned = r.events.filter((e) => e.type === 'git.checkpoint.pruned' && e.kind === 'delivery');
    expect(pruned).toHaveLength(1);
    if (pruned[0]?.type === 'git.checkpoint.pruned') expect(pruned[0].refs).toContain(d1.ref);
  });

  it('a partial acceptance (/accept confirm) creates NO delivery checkpoint', async () => {
    await initWsRepo();
    // A draft plan makes the session unfinished; confirm records a partial acceptance.
    const PLAN = { objective: 'obj', tasks: [{ id: 't1', title: 'x', intent: 'y', role: 'executor', verify: 'v' }] };
    const r = await drive(
      [{ say: 'planned', calls: [{ name: 'update_plan', input: { plan: PLAN } }] }, { say: 'ok' }],
      ['plan it\n', '/accept\n', '/accept confirm\n', '/quit\n'],
    );
    const accepted = r.events.find((e) => e.type === 'session.accepted');
    if (accepted?.type !== 'session.accepted') throw new Error('no acceptance recorded');
    expect(accepted.complete).toBe(false);
    expect(accepted.deliveryRef).toBeUndefined();
    expect(r.events.filter((e) => e.type === 'harness.checkpoint')).toHaveLength(0);
    expect((await git(ws, 'for-each-ref', 'refs/agent-cli/')).stdout.trim()).toBe('');
  });
});

describe.skipIf(!hasGit)('/accept delivery checkpoint — crash-window idempotence (dispatchSlash)', () => {
  it('reuses a recorded-but-unconsumed delivery checkpoint when nothing work-shaped happened since', async () => {
    await initWsRepo();
    const session = makeSession();
    try {
      // The crash state: a delivery checkpoint landed (event + real ref) but the kill arrived
      // before session.accepted. Exactly what /accept leaves behind at that instant.
      const cctx: CheckpointContext = { gitPath: REAL_GIT!, repoRoot: ws, workspaceRoot: ws, stateDir: session.stateDir };
      const prior = await createCheckpoint(cctx, session.id, {
        label: 'delivery (accepted)',
        onRefReady: (ref, oid) => session.log.append({ type: 'harness.checkpoint', kind: 'delivery', ref, oid }),
      });
      expect(prior.ok).toBe(true);

      const chrome: string[] = [];
      await dispatchSlash('/accept', acceptCtx(session, chrome));

      expect(chrome.join('\n')).toContain('delivery checkpoint reused (interrupted acceptance repair)');
      // ONE delivery event (the prior); no second checkpoint stacked.
      expect(session.log.events.filter((e) => e.type === 'harness.checkpoint')).toHaveLength(1);
      const accepted = session.log.events.find((e) => e.type === 'session.accepted');
      if (accepted?.type !== 'session.accepted') throw new Error('no acceptance recorded');
      expect(accepted.deliveryRef).toBe(prior.ref);
      expect(accepted.deliveryOid).toBe(prior.oid);
    } finally {
      endSession(session, 'completed');
    }
  });

  it('a PHANTOM delivery record (ref never landed) is not reused — a real checkpoint is created instead', async () => {
    await initWsRepo();
    const session = makeSession();
    try {
      const phantomRef = `refs/agent-cli/checkpoints/${session.id}/7`;
      session.log.append({ type: 'harness.checkpoint', kind: 'delivery', ref: phantomRef, oid: 'a'.repeat(40) });

      const chrome: string[] = [];
      await dispatchSlash('/accept', acceptCtx(session, chrome));

      expect(chrome.join('\n')).not.toContain('reused');
      const deliveries = session.log.events.filter((e) => e.type === 'harness.checkpoint');
      expect(deliveries).toHaveLength(2); // the phantom + the real one
      const accepted = session.log.events.find((e) => e.type === 'session.accepted');
      if (accepted?.type !== 'session.accepted') throw new Error('no acceptance recorded');
      expect(accepted.deliveryRef).toBeDefined();
      expect(accepted.deliveryRef).not.toBe(phantomRef);
      expect((await git(ws, 'show-ref', '--verify', accepted.deliveryRef!)).ok).toBe(true);
    } finally {
      endSession(session, 'completed');
    }
  });

  it('a checkpoint failure caveats and the acceptance still records (consent is never hostage to git)', async () => {
    await initWsRepo();
    const session = makeSession();
    try {
      // Force createCheckpoint failure: plant the loose-ref lock for the n this session would use.
      const lock = path.join(ws, '.git', 'refs', 'agent-cli', 'checkpoints', session.id, '1.lock');
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, '');

      const chrome: string[] = [];
      await dispatchSlash('/accept', acceptCtx(session, chrome));

      expect(chrome.join('\n')).toContain('delivery checkpoint not captured');
      const accepted = session.log.events.find((e) => e.type === 'session.accepted');
      if (accepted?.type !== 'session.accepted') throw new Error('no acceptance recorded');
      expect(accepted.complete).toBe(true);
      expect(accepted.deliveryRef).toBeUndefined();
    } finally {
      endSession(session, 'completed');
    }
  });
});

describe('harness.checkpoint is NOT work-shaped (the F4 pin)', () => {
  it('a harness.checkpoint after an acceptance never marks it stale', () => {
    const ev = (seq: number, body: Record<string, unknown>): SessionEvent =>
      ({ v: 1, seq, ts: '2026-01-01T00:00:00Z', ...body }) as unknown as SessionEvent;
    const events = [
      ev(1, { type: 'session.accepted', complete: true, summary: 's' }),
      ev(2, { type: 'harness.checkpoint', kind: 'delivery', ref: 'refs/x', oid: 'a'.repeat(40) }),
      ev(3, { type: 'git.checkpoint.pruned', kind: 'delivery', refs: [], failed: [] }),
    ];
    expect(workSince(events, 1)).toBe(false);
  });
});
