import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grantTrust, revokeTrust, isTrusted, listTrusted, readTrustFile } from '../src/trust/store.js';
import { ensureTrusted, trustPrompt } from '../src/trust/gate.js';
import { sanitizeLine } from '../src/shared/text.js';
import { ConfigError } from '../src/shared/errors.js';

let tmp: string;
let state: string;
let ws: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-trust-')));
  state = path.join(tmp, 'state');
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('trust store', () => {
  it('grant → trusted, revoke → untrusted, with an audit trail', () => {
    expect(isTrusted(state, ws)).toBe(false);
    grantTrust(state, ws, 'prompt');
    expect(isTrusted(state, ws)).toBe(true);
    expect(listTrusted(state)).toHaveLength(1);
    expect(listTrusted(state)[0]).toMatchObject({ path: ws, source: 'prompt' });

    expect(revokeTrust(state, ws)).toBe(true);
    expect(isTrusted(state, ws)).toBe(false);
    expect(revokeTrust(state, ws)).toBe(false);

    const audit = fs.readFileSync(path.join(state, 'trust.log'), 'utf8').trim().split('\n');
    expect(audit).toHaveLength(2);
    expect(JSON.parse(audit[0]!)).toMatchObject({ action: 'grant', path: ws });
    expect(JSON.parse(audit[1]!)).toMatchObject({ action: 'revoke', path: ws });
  });

  it('trust is keyed case-insensitively on Windows paths', () => {
    grantTrust(state, ws, 'command');
    const flipped = ws.charAt(0).toUpperCase() === ws.charAt(0) ? ws.toLowerCase() : ws.toUpperCase();
    if (process.platform === 'win32') {
      expect(isTrusted(state, flipped)).toBe(true);
    }
  });

  it('a corrupt trust.json is a hard error, never silently trusted or rewritten', () => {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'trust.json'), '{not json');
    expect(() => isTrusted(state, ws)).toThrow(ConfigError);
    expect(() => grantTrust(state, ws, 'prompt')).toThrow(ConfigError);
    expect(fs.readFileSync(path.join(state, 'trust.json'), 'utf8')).toBe('{not json');
  });

  it('an unexpected shape is also refused', () => {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'trust.json'), JSON.stringify({ v: 1, entries: { x: { path: 5 } } }));
    expect(() => readTrustFile(state)).toThrow(ConfigError);
  });
});

describe('trust gate', () => {
  it('refuses fail-safe when untrusted and nobody can be asked', async () => {
    const d = await ensureTrusted({ workspaceReal: ws, stateRoot: state, trustFlag: false });
    expect(d.trusted).toBe(false);
  });

  it('--trust-this-workspace proceeds for this invocation only, never persisting', async () => {
    const d = await ensureTrusted({ workspaceReal: ws, stateRoot: state, trustFlag: true });
    expect(d).toEqual({ trusted: true, source: 'flag' });
    expect(isTrusted(state, ws)).toBe(false);
  });

  it('recorded trust wins without any prompt', async () => {
    grantTrust(state, ws, 'command');
    const d = await ensureTrusted({
      workspaceReal: ws,
      stateRoot: state,
      trustFlag: false,
      question: async () => {
        throw new Error('must not be asked');
      },
    });
    expect(d).toEqual({ trusted: true, source: 'store' });
  });

  it('prompt answers: t persists, o proceeds once, anything else declines', async () => {
    const t = await ensureTrusted({ workspaceReal: ws, stateRoot: state, trustFlag: false, question: async () => 't' });
    expect(t).toEqual({ trusted: true, source: 'prompt-remember' });
    expect(isTrusted(state, ws)).toBe(true);
    revokeTrust(state, ws);

    const o = await ensureTrusted({ workspaceReal: ws, stateRoot: state, trustFlag: false, question: async () => 'o' });
    expect(o).toEqual({ trusted: true, source: 'prompt-once' });
    expect(isTrusted(state, ws)).toBe(false);

    const n = await ensureTrusted({ workspaceReal: ws, stateRoot: state, trustFlag: false, question: async () => 'nope' });
    expect(n.trusted).toBe(false);
    expect(isTrusted(state, ws)).toBe(false);
  });

  it('a state root planted inside the workspace cannot self-grant trust', async () => {
    // Attacker-staged folder: contains its own trust.json granting itself.
    const planted = path.join(ws, '.state');
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(
      path.join(planted, 'trust.json'),
      JSON.stringify({ v: 1, entries: { [ws.toLowerCase()]: { path: ws, grantedAt: 't', source: 'command' } } }),
    );
    await expect(ensureTrusted({ workspaceReal: ws, stateRoot: planted, trustFlag: false })).rejects.toThrow(
      ConfigError,
    );
  });

  it('the consent prompt sanitizes spoofing-capable path characters', () => {
    const evil = 'C:\\safe‮\\cod.eslaf';
    const prompt = trustPrompt(evil);
    expect(prompt).not.toContain('‮');
    expect(prompt).toContain('\\u{202e}');
  });
});

describe('sanitizeLine', () => {
  it('escapes bidi, zero-width, and control characters; flattens newlines', () => {
    expect(sanitizeLine('a‮b')).toBe('a\\u{202e}b');
    expect(sanitizeLine('a​b')).toBe('a\\u{200b}b');
    const esc = String.fromCharCode(0x1b);
    expect(sanitizeLine(`a${esc}[31mred`)).toBe('a\\u{1b}[31mred');
    expect(sanitizeLine('two\nlines')).toBe('two lines');
    expect(sanitizeLine('中文 path ok')).toBe('中文 path ok');
  });
});
