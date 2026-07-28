import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLayout } from '../src/store/layout.js';
import { EventLog } from '../src/store/event-log.js';
import { ConfigError, CorruptLogError, FreshLogCollisionError, SchemaVersionError, SessionLockedError } from '../src/shared/errors.js';
import { fixedClock } from '../src/shared/clock.js';
import type { EventBody } from '../src/types.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-store-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const started: EventBody = {
  type: 'session.started',
  sessionId: 's1',
  workspaceRoot: 'C:\\ws',
  model: 'm',
  mode: 'non-interactive',
  providerName: 'mock',
  argv: [],
};

describe('resolveLayout', () => {
  it('places state under AGENT_CLI_STATE_DIR, outside the workspace', () => {
    const ws = path.join(tmp, 'workspace');
    fs.mkdirSync(ws);
    const state = path.join(tmp, 'state');
    const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: state }, ensure: true });
    expect(layout.stateRoot).toBe(path.resolve(state));
    expect(layout.projectDir.startsWith(path.resolve(state))).toBe(true);
    expect(fs.existsSync(layout.sessionsDir)).toBe(true);
    expect(fs.existsSync(layout.objectsDir)).toBe(true);
  });

  it('is stable across repeated calls for the same workspace', () => {
    const ws = path.join(tmp, 'workspace');
    fs.mkdirSync(ws);
    const env = { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') };
    expect(resolveLayout(ws, { env }).projectDir).toBe(resolveLayout(ws, { env }).projectDir);
  });

  it('refuses when the state dir resolves inside the workspace', () => {
    const ws = path.join(tmp, 'workspace');
    fs.mkdirSync(ws);
    const inside = path.join(ws, '.agent-cli');
    expect(() => resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: inside } })).toThrow(ConfigError);
  });

  it('refuses a state dir that is inside the workspace under a DIFFERENT spelling of the path', () => {
    // CI-found (Windows runner): the workspace was realpath'd while the state root was only
    // path.resolve'd, so the same directory spelled two ways compared unequal and the guard did
    // not fire. On the runner that was an 8.3 short path (RUNNER~1 vs runneradmin); here we
    // reproduce it with a symlink, which is the same hole on any platform. If the guard ever
    // regresses, the harness writes its audit/recovery substrate inside the workspace.
    const ws = path.join(tmp, 'ws-real');
    fs.mkdirSync(ws);
    const alias = path.join(tmp, 'ws-alias');
    try {
      fs.symlinkSync(ws, alias, 'junction');
    } catch {
      return; // symlink/junction creation can require privileges; the assertion below needs one
    }
    // `alias/.agent-cli` IS `ws/.agent-cli`, spelled through the link and not yet existing.
    expect(() => resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(alias, '.agent-cli') } })).toThrow(ConfigError);
  });
});

describe('EventLog append/replay', () => {
  it('appends monotonic seqs and reads them back', () => {
    const file = path.join(tmp, 's.jsonl');
    const lock = path.join(tmp, 's.lock');
    const log = EventLog.open({ file, lockFile: lock, clock: fixedClock(0, 1) });
    const e1 = log.append(started);
    const e2 = log.append({ type: 'user.message', text: 'hi' });
    log.close();
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    const read = EventLog.readLenient(file);
    expect(read.events.map((e) => e.type)).toEqual(['session.started', 'user.message']);
    expect(read.events[1]).toMatchObject({ seq: 2, type: 'user.message', text: 'hi' });
  });

  it('continues seq numbering when reopening an existing log', () => {
    const file = path.join(tmp, 's.jsonl');
    const lock = path.join(tmp, 's.lock');
    let log = EventLog.open({ file, lockFile: lock });
    log.append(started);
    log.close();
    log = EventLog.open({ file, lockFile: lock });
    expect(log.events.length).toBe(1);
    expect(log.append({ type: 'user.message', text: 'again' }).seq).toBe(2);
    log.close();
  });

  it('repairs a partial trailing line and appends cleanly', () => {
    const file = path.join(tmp, 's.jsonl');
    const lock = path.join(tmp, 's.lock');
    // One good line + a partial (crash mid-append, no trailing newline).
    fs.writeFileSync(file, JSON.stringify({ v: 1, seq: 1, ts: 't', ...started }) + '\n' + '{"v":1,"seq":2,"ts":"t","ty');
    const log = EventLog.open({ file, lockFile: lock });
    expect(log.repairedTail).toBe(true);
    expect(log.events.length).toBe(1);
    log.append({ type: 'user.message', text: 'ok' });
    log.close();
    const read = EventLog.readLenient(file);
    expect(read.corruptAt).toBeUndefined();
    expect(read.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('refuses to open a log with mid-file corruption', () => {
    const file = path.join(tmp, 's.jsonl');
    const lock = path.join(tmp, 's.lock');
    fs.writeFileSync(file, JSON.stringify({ v: 1, seq: 1, ts: 't', ...started }) + '\n' + 'NOT JSON\n');
    expect(() => EventLog.open({ file, lockFile: lock })).toThrow(CorruptLogError);
    // Lock must have been released so a report/retry is possible.
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('rejects a log written by a newer schema version', () => {
    const file = path.join(tmp, 's.jsonl');
    const lock = path.join(tmp, 's.lock');
    fs.writeFileSync(file, JSON.stringify({ v: 2, seq: 1, ts: 't', ...started }) + '\n');
    expect(() => EventLog.open({ file, lockFile: lock })).toThrow(SchemaVersionError);
  });

  it('lenient read surfaces corruption without throwing', () => {
    const file = path.join(tmp, 's.jsonl');
    fs.writeFileSync(file, JSON.stringify({ v: 1, seq: 1, ts: 't', ...started }) + '\n' + 'broken\n');
    const read = EventLog.readLenient(file);
    expect(read.events.length).toBe(1);
    expect(read.corruptAt).toEqual({ line: 2, kind: 'json' });
  });
});

describe('EventLog liveness and observation', () => {
  it('events is live: appends through this instance appear immediately', () => {
    const file = path.join(tmp, 's.jsonl');
    const lock = path.join(tmp, 's.lock');
    const log = EventLog.open({ file, lockFile: lock });
    expect(log.events.length).toBe(0);
    log.append(started);
    log.append({ type: 'user.message', text: 'hi' });
    expect(log.events.length).toBe(2);
    expect(log.events[1]).toMatchObject({ type: 'user.message', text: 'hi' });
    log.close();
  });

  it('a reopened log stays live past the opened snapshot', () => {
    const file = path.join(tmp, 's.jsonl');
    const lock = path.join(tmp, 's.lock');
    let log = EventLog.open({ file, lockFile: lock });
    log.append(started);
    log.close();
    log = EventLog.open({ file, lockFile: lock });
    expect(log.events.length).toBe(1);
    log.append({ type: 'user.message', text: 'later' });
    expect(log.events.length).toBe(2);
    log.close();
  });

  it('onAppend fires after the write with the stamped event', () => {
    const file = path.join(tmp, 's.jsonl');
    const lock = path.join(tmp, 's.lock');
    const log = EventLog.open({ file, lockFile: lock });
    const seen: { seq: number; persisted: boolean }[] = [];
    log.onAppend = (e) => {
      // At observation time the event must already be on disk.
      const onDisk = fs.readFileSync(file, 'utf8').includes(`"seq":${e.seq}`);
      seen.push({ seq: e.seq, persisted: onDisk });
    };
    log.append(started);
    log.append({ type: 'user.message', text: 'x' });
    expect(seen).toEqual([
      { seq: 1, persisted: true },
      { seq: 2, persisted: true },
    ]);
    log.close();
  });

  it('a throwing observer never fails the append', () => {
    const file = path.join(tmp, 's.jsonl');
    const lock = path.join(tmp, 's.lock');
    const log = EventLog.open({ file, lockFile: lock });
    log.onAppend = () => {
      throw new Error('renderer exploded');
    };
    expect(() => log.append(started)).not.toThrow();
    expect(log.events.length).toBe(1);
    log.close();
    expect(EventLog.readLenient(file).events.length).toBe(1);
  });
});

describe('EventLog expectFresh (structural collision refusal)', () => {
  it('creates the log atomically and appends normally when the id is genuinely fresh', () => {
    const file = path.join(tmp, 'fresh.jsonl');
    const lock = path.join(tmp, 'fresh.lock');
    const log = EventLog.open({ file, lockFile: lock, expectFresh: true });
    expect(fs.existsSync(file)).toBe(true);
    log.append(started);
    log.close();
    expect(EventLog.readLenient(file).events.length).toBe(1);
  });

  it('refuses an existing log WITHOUT touching the live sibling session lock', () => {
    const file = path.join(tmp, 'dup.jsonl');
    const lock = path.join(tmp, 'dup.lock');
    // A live sibling session in THIS process owns this id: its log and same-pid lock exist.
    const sibling = EventLog.open({ file, lockFile: lock, expectFresh: true });
    sibling.append(started);
    const lockBytes = fs.readFileSync(lock, 'utf8');

    // A colliding expectFresh open must throw BEFORE any lock interaction — the old reclaim
    // path would have stolen (then released) the sibling's same-pid lock and merged evidence.
    expect(() => EventLog.open({ file, lockFile: lock, expectFresh: true })).toThrow(FreshLogCollisionError);
    expect(fs.readFileSync(lock, 'utf8')).toBe(lockBytes); // sibling lock untouched
    expect(EventLog.readLenient(file).events.length).toBe(1); // sibling evidence unmerged
    sibling.append({ type: 'user.message', text: 'still mine' }); // sibling still writable
    sibling.close();
  });

  it('cleans up the created file when a live foreign process holds a stale-id lock', () => {
    const file = path.join(tmp, 'ghost.jsonl');
    const lock = path.join(tmp, 'ghost.lock');
    // A crashed-elsewhere scenario: lock exists (live foreign pid) but the log was never written.
    fs.writeFileSync(lock, JSON.stringify({ pid: 424242, startedAt: 't', token: 'x' }));
    expect(() => EventLog.open({ file, lockFile: lock, expectFresh: true, isAlive: () => true })).toThrow(
      SessionLockedError,
    );
    expect(fs.existsSync(file)).toBe(false); // no empty-file residue
  });
});

describe('EventLog locking', () => {
  it('refuses when a live foreign process holds the lock', () => {
    const file = path.join(tmp, 's.jsonl');
    const lock = path.join(tmp, 's.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: 424242, startedAt: 't', token: 'x' }));
    expect(() => EventLog.open({ file, lockFile: lock, isAlive: () => true })).toThrow(SessionLockedError);
  });

  it('reclaims a stale lock from a dead process', () => {
    const file = path.join(tmp, 's.jsonl');
    const lock = path.join(tmp, 's.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: 424242, startedAt: 't', token: 'x' }));
    const log = EventLog.open({ file, lockFile: lock, isAlive: () => false });
    expect(log.stoleLock).toBe(true);
    log.append(started);
    log.close();
    expect(fs.existsSync(lock)).toBe(false);
  });
});
