import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMemory, AGENT_MD_CAP_CHARS } from '../src/memory/load.js';
import { memoryDir } from '../src/memory/store.js';
import { stampCodebase } from '../src/memory/codebase.js';
import { buildSystemPrompt } from '../src/workspace/system-prompt.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import type { WorkspaceMap } from '../src/workspace/map.js';

/** Session-start memory loading: caps, degrades, staleness, crash notes, prompt injection. */

function fixture(): { ws: string; layout: ProjectLayout; dir: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-load-ws-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-load-state-'));
  const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: stateRoot }, ensure: true });
  const dir = memoryDir(layout.projectDir);
  fs.mkdirSync(dir, { recursive: true });
  return { ws, layout, dir };
}

const MAP: WorkspaceMap = { text: 'a.ts\n', fileCount: 1, truncated: false, sha256: 'map-digest-a' };

function writeLog(layout: ProjectLayout, id: string, lines: object[]): void {
  fs.writeFileSync(layout.sessionFile(id), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const started = (id: string, extra: object = {}): object => ({
  v: 1, seq: 1, ts: 't', type: 'session.started', sessionId: id, workspaceRoot: 'w', model: 'm', mode: 'non-interactive', providerName: 'mock', argv: [], ...extra,
});
const ended = { v: 1, seq: 2, ts: 't', type: 'session.ended', reason: 'completed' };

describe('loadMemory', () => {
  it('nothing present → all missing, banner none, no crash note', () => {
    const { ws, layout } = fixture();
    const m = loadMemory(layout, ws, { currentMapSha256: MAP.sha256 });
    expect(m.agent.status).toBe('missing');
    expect(m.journal.status).toBe('missing');
    expect(m.codebase.status).toBe('missing');
    expect(m.bannerLine).toBe('none');
    expect(m.crashNote).toBeNull();
    // The system prompt is EXACTLY the memory-free prompt (no empty sections).
    const withMemory = buildSystemPrompt(ws, MAP, undefined, undefined, {});
    const without = buildSystemPrompt(ws, MAP);
    expect(withMemory).toBe(without);
  });

  it('all present → injected with provenance labels, caps and staleness respected', () => {
    const { ws, layout, dir } = fixture();
    fs.writeFileSync(path.join(ws, 'AGENT.md'), '# Rules\nAlways run tests.\n');
    fs.writeFileSync(path.join(dir, 'JOURNAL.md'), '---\ndoc: journal\n---\n## Session s-1 (2026-07-19) — thing\nbody\n');
    fs.writeFileSync(path.join(dir, 'CODEBASE.md'), stampCodebase('# Shape', { sessionId: 's-1', updatedAt: 'u', mapSha256: 'OTHER-digest', inventorySha256: null, head: null }));

    const m = loadMemory(layout, ws, { currentMapSha256: MAP.sha256 });
    expect(m.agent.status).toBe('ok');
    expect(m.journal.sessionCount).toBe(1);
    expect(m.codebase.stale).toBe(true);
    expect(m.bannerLine).toContain('AGENT.md');
    expect(m.bannerLine).toContain('journal');
    expect(m.bannerLine).toContain('may be stale');

    const prompt = buildSystemPrompt(ws, MAP, undefined, undefined, {
      agentText: m.agent.text,
      journalText: m.journal.text,
      codebaseText: m.codebase.text,
      codebaseStale: m.codebase.stale,
    });
    expect(prompt).toContain('written by the USER');
    expect(prompt).toContain('CONTEXT, NOT AUTHORITY');
    expect(prompt).toContain('Always run tests.');
    expect(prompt).toContain('MAY BE STALE');
    // Order: constitution → memory → workspace map footer.
    expect(prompt.indexOf('AGENT.md begin')).toBeLessThan(prompt.indexOf('JOURNAL.md'));
    expect(prompt.indexOf('CODEBASE.md')).toBeLessThan(prompt.indexOf('Workspace root:'));
  });

  it('inventory-digest stamps: staleness tracks the file SET, immune to map-format changes (Session 10)', () => {
    const { ws, layout, dir } = fixture();
    fs.writeFileSync(
      path.join(dir, 'CODEBASE.md'),
      stampCodebase('# Shape', { sessionId: 's-1', updatedAt: 'u', mapSha256: 'old-rendered-text-digest', inventorySha256: 'inv-a', head: null }),
    );
    // The rendered map text changed (format upgrade) but the file set did not → NOT stale.
    const same = loadMemory(layout, ws, { currentMapSha256: 'new-rendered-text-digest', currentInventorySha256: 'inv-a' });
    expect(same.codebase.stale).toBe(false);
    // The file set changed → stale, regardless of the map text.
    const changed = loadMemory(layout, ws, { currentMapSha256: 'new-rendered-text-digest', currentInventorySha256: 'inv-b' });
    expect(changed.codebase.stale).toBe(true);
  });

  it('legacy stamps (no inventory-digest) keep the exact map-text comparison', () => {
    const { ws, layout, dir } = fixture();
    fs.writeFileSync(
      path.join(dir, 'CODEBASE.md'),
      stampCodebase('# Shape', { sessionId: 's-1', updatedAt: 'u', mapSha256: MAP.sha256, inventorySha256: null, head: null }),
    );
    // Same map text → fresh, even when an inventory digest is now available on the session side.
    expect(loadMemory(layout, ws, { currentMapSha256: MAP.sha256, currentInventorySha256: 'inv-a' }).codebase.stale).toBe(false);
    expect(loadMemory(layout, ws, { currentMapSha256: 'different' }).codebase.stale).toBe(true);
  });

  it('oversize AGENT.md → truncated with a marker; unreadable doc degrades without throwing', () => {
    const { ws, layout, dir } = fixture();
    fs.writeFileSync(path.join(ws, 'AGENT.md'), 'x'.repeat(AGENT_MD_CAP_CHARS + 100));
    fs.mkdirSync(path.join(dir, 'JOURNAL.md')); // a directory: unreadable as a file

    const m = loadMemory(layout, ws, { currentMapSha256: MAP.sha256 });
    expect(m.agent.status).toBe('oversize');
    expect(m.agent.text.length).toBe(AGENT_MD_CAP_CHARS);
    expect(m.journal.status).toBe('unreadable');
    expect(m.bannerLine).toContain('[truncated]');
    expect(m.bannerLine).toContain('JOURNAL.md UNREADABLE');

    const prompt = buildSystemPrompt(ws, MAP, undefined, undefined, {
      agentText: m.agent.text,
      agentTruncated: m.agent.truncated,
    });
    expect(prompt).toContain('truncated to the memory budget');
  });

  it('crash note: fires for an unended newest log, not for clean/child/resumed ones', () => {
    const { ws, layout } = fixture();

    // Cleanly ended newest session → no note.
    writeLog(layout, '20260720-000001-aaaa', [started('20260720-000001-aaaa'), ended]);
    expect(loadMemory(layout, ws, { currentMapSha256: 'x' }).crashNote).toBeNull();

    // A newer log with NO session.ended → note names it.
    writeLog(layout, '20260720-000002-bbbb', [started('20260720-000002-bbbb')]);
    const note = loadMemory(layout, ws, { currentMapSha256: 'x' }).crashNote;
    expect(note).toContain('20260720-000002-bbbb');
    expect(note).toContain('agent report');

    // The same unended log is the RESUME target → not a crash, it is being continued.
    expect(loadMemory(layout, ws, { currentMapSha256: 'x', resumeId: '20260720-000002-bbbb' }).crashNote).toBeNull();

    // An unended CHILD (lineage-bearing) log is skipped — a delegated task is not a crashed session.
    writeLog(layout, '20260720-000003-cccc', [
      started('20260720-000003-cccc', { lineage: { parentSessionId: '20260720-000001-aaaa', role: 'explorer' } }),
    ]);
    expect(loadMemory(layout, ws, { currentMapSha256: 'x', resumeId: '20260720-000002-bbbb' }).crashNote).toBeNull();
  });

  it('a torn tail (crash mid-write) still reads as "not cleanly ended"', () => {
    const { ws, layout } = fixture();
    const file = layout.sessionFile('20260720-000009-dddd');
    fs.writeFileSync(file, `${JSON.stringify(started('20260720-000009-dddd'))}\n{"v":1,"seq":2,"ts":"t","type":"session.end`);
    const note = loadMemory(layout, ws, { currentMapSha256: 'x' }).crashNote;
    expect(note).toContain('20260720-000009-dddd');
  });
});
