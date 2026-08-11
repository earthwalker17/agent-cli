import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addGrant, grantIdFor, grantsFile, grantsLogFile, grantsForWorkspace, readGrants, revokeGrant } from '../src/store/grants.js';
import { ConfigError } from '../src/shared/errors.js';
import { DURABLE_CLASS_ELIGIBLE, isDurableClassEligible } from '../src/policy/engine.js';

/**
 * Session 21 — the durable-grants store: trust.json's consent discipline (corrupt = hard error,
 * never rewritten) plus registry-locked atomic writes and an append-only audit. Exact identity
 * only: a grant is one replay sha or one (tool, class) pair from the closed eligibility set.
 */

let stateRoot: string;

beforeEach(() => {
  stateRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-grants-')));
});
afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

const NOW = '2026-08-11T12:00:00.000Z';
const WS_KEY = 'c:\\users\\a\\project';

describe('the durable-grants store', () => {
  it('missing store reads empty; a grant creates the file, an audit line, and round-trips', async () => {
    expect(readGrants(stateRoot)).toEqual([]);
    const entry = await addGrant(stateRoot, { kind: 'class', workspaceKey: null, tool: 'web_search', cls: 'external', label: 'always allow bounded web searches' }, NOW);
    expect(entry.id).toMatch(/^[0-9a-f]{12}$/);
    const back = readGrants(stateRoot);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ kind: 'class', tool: 'web_search', cls: 'external', workspaceKey: null, createdAt: NOW });
    const audit = fs.readFileSync(grantsLogFile(stateRoot), 'utf8').trim().split('\n');
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!)).toMatchObject({ action: 'grant', id: entry.id });
  });

  it('re-granting the same identity is idempotent (insert-or-replace by stable id)', async () => {
    const a = await addGrant(stateRoot, { kind: 'class', workspaceKey: null, tool: 'remote_status', cls: 'external', label: 'v1' }, NOW);
    const b = await addGrant(stateRoot, { kind: 'class', workspaceKey: null, tool: 'remote_status', cls: 'external', label: 'v2' }, '2026-08-12T00:00:00.000Z');
    expect(b.id).toBe(a.id);
    const entries = readGrants(stateRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe('v2');
  });

  it('revoke removes and audits; revoking an unknown id is a null, never an error', async () => {
    const entry = await addGrant(stateRoot, { kind: 'check-replay', workspaceKey: WS_KEY, replayKey: 'abc'.repeat(20), label: 'npm run test @api' }, NOW);
    expect(await revokeGrant(stateRoot, 'ffffffffffff', NOW)).toBeNull();
    const removed = await revokeGrant(stateRoot, entry.id, NOW);
    expect(removed?.id).toBe(entry.id);
    expect(readGrants(stateRoot)).toEqual([]);
    const audit = fs.readFileSync(grantsLogFile(stateRoot), 'utf8').trim().split('\n');
    expect(audit.map((l) => (JSON.parse(l) as { action: string }).action)).toEqual(['grant', 'revoke']);
  });

  it('corrupt or unexpected-shape stores are hard ConfigErrors and are NEVER rewritten', async () => {
    fs.writeFileSync(grantsFile(stateRoot), 'not json');
    expect(() => readGrants(stateRoot)).toThrow(ConfigError);
    await expect(addGrant(stateRoot, { kind: 'class', workspaceKey: null, tool: 'web_search', cls: 'external', label: 'x' }, NOW)).rejects.toThrow(ConfigError);
    expect(fs.readFileSync(grantsFile(stateRoot), 'utf8')).toBe('not json');

    // A shape that parses but does not validate — e.g. a hand-minted 'sensitive' class grant —
    // is refused the same way: the schema itself is the eligibility belt for classes.
    fs.writeFileSync(
      grantsFile(stateRoot),
      JSON.stringify({ v: 1, entries: [{ v: 1, kind: 'class', id: 'aaaaaaaaaaaa', workspaceKey: null, tool: 'read_file', cls: 'sensitive', label: 'nope', createdAt: NOW }] }),
    );
    expect(() => readGrants(stateRoot)).toThrow(ConfigError);
  });

  it('grantsForWorkspace: machine-wide class grants apply everywhere; replay grants only to their workspace', async () => {
    await addGrant(stateRoot, { kind: 'class', workspaceKey: null, tool: 'web_search', cls: 'external', label: 'machine-wide' }, NOW);
    await addGrant(stateRoot, { kind: 'check-replay', workspaceKey: WS_KEY, replayKey: 'k1', label: 'this ws' }, NOW);
    await addGrant(stateRoot, { kind: 'check-replay', workspaceKey: 'd:\\other', replayKey: 'k2', label: 'other ws' }, NOW);
    const entries = readGrants(stateRoot);
    const here = grantsForWorkspace(entries, WS_KEY);
    expect(here.map((e) => e.label).sort()).toEqual(['machine-wide', 'this ws']);
  });

  it('S21 review: a batch persists under ONE write — all keys present, one audit line each', async () => {
    const { addGrants } = await import('../src/store/grants.js');
    const stored = await addGrants(
      stateRoot,
      [
        { kind: 'check-replay', workspaceKey: WS_KEY, replayKey: 'k1', label: 'batch a' },
        { kind: 'check-replay', workspaceKey: WS_KEY, replayKey: 'k2', label: 'batch b' },
        { kind: 'check-replay', workspaceKey: WS_KEY, replayKey: 'k3', label: 'batch c' },
      ],
      NOW,
    );
    expect(stored).toHaveLength(3);
    expect(readGrants(stateRoot)).toHaveLength(3);
    const audit = fs.readFileSync(grantsLogFile(stateRoot), 'utf8').trim().split('\n');
    expect(audit).toHaveLength(3);
  });

  it('grant ids are derived from identity, so the same rule from two prompts collides on purpose', () => {
    const a = grantIdFor({ kind: 'class', workspaceKey: null, tool: 'web_search', cls: 'external', label: 'one wording' });
    const b = grantIdFor({ kind: 'class', workspaceKey: null, tool: 'web_search', cls: 'external', label: 'another wording' });
    expect(a).toBe(b);
    const c = grantIdFor({ kind: 'class', workspaceKey: 'somewhere', tool: 'web_search', cls: 'external', label: 'scoped' });
    expect(c).not.toBe(a);
  });
});

describe('durable-class eligibility (the closed set)', () => {
  it('exactly the three read-only-external consents are eligible — pinned as a consent bound', () => {
    expect([...DURABLE_CLASS_ELIGIBLE].sort()).toEqual(['delegate_task::external', 'remote_status::external', 'web_search::external']);
  });

  it('the ineligible surfaces stay ineligible', () => {
    expect(isDurableClassEligible('remote_push', 'external')).toBe(false); // a publish asks EVERY time
    expect(isDurableClassEligible('remote_release', 'external')).toBe(false);
    expect(isDurableClassEligible('run_command', 'external')).toBe(false);
    expect(isDurableClassEligible('read_file', 'sensitive')).toBe(false); // standing read-anything is too broad
    expect(isDurableClassEligible('inspect_pages', 'sensitive')).toBe(false); // pixels cannot be redacted
    expect(isDurableClassEligible('project_setup', 'external')).toBe(false); // install replay deferred
    expect(isDurableClassEligible('delegate_task', 'reversible')).toBe(false); // executor spawns ask every time
  });
});
