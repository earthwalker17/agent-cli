import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLayout } from '../src/store/layout.js';
import { EventLog } from '../src/store/event-log.js';
import { ConfigError, CorruptLogError, SchemaVersionError, SessionLockedError } from '../src/shared/errors.js';
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
