import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSession, endSession, endReasonForTurn, runTurn, recordWorkspaceMap, type Session, type TurnResult } from '../src/runtime/session.js';
import { buildHandoffLines, runMemoryUpdate } from '../src/memory/update.js';
import { parseJournal } from '../src/memory/journal.js';
import { parseCodebase } from '../src/memory/codebase.js';
import { memoryDir } from '../src/memory/store.js';
import { toToolSchema } from '../src/tools/index.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { Provider, ProviderRequest, ProviderTurn } from '../src/types.js';

/** End-of-session memory update: gate, cache-prefix reuse, fallback, rolling write, events. */

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-update-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const NARRATIVE_JSON = JSON.stringify({
  objective: 'Build the widget',
  outcome: 'Widget written and verified.',
  decisions: ['kept it pure'],
  openIssues: [],
  nextSteps: ['wire it up'],
  codebaseUpdate: { text: '# Shape\n\nOne module.' },
});

function makeSession(script: ScriptTurn[], provider?: Provider): Session {
  const session = startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock-model',
    mode: 'non-interactive',
    provider: provider ?? new MockProvider(script),
    approver: autoDenyApprover,
    system: 'SYSTEM PROMPT',
    saltHex: '00'.repeat(16),
    clock: fixedClock(1_750_000_000_000, 1),
    idGen: seededIdGen(),
  });
  recordWorkspaceMap(session, { text: 'a.txt\n', fileCount: 1, truncated: false, sha256: 'map-sha' });
  return session;
}

const productiveTurns: ScriptTurn[] = [
  { say: 'writing', calls: [{ name: 'write_file', input: { path: 'f.txt', content: 'hello' } }] },
  { say: 'done', usage: { inputTokens: 5, outputTokens: 7 } },
];

describe('runMemoryUpdate', () => {
  it('happy path: narrative recorded with usage, journal + codebase written, events ordered', async () => {
    const session = makeSession([...productiveTurns, { say: NARRATIVE_JSON, usage: { inputTokens: 3, outputTokens: 42 } }]);
    await runTurn(session, 'make f.txt');
    await runMemoryUpdate(session, { layout, enabled: true, endedReason: 'user-quit' });
    endSession(session, 'user-quit');

    const types = session.log.events.map((e) => e.type);
    const tail = types.slice(types.indexOf('memory.narrative'));
    // journal (written) → lessons (skipped: none proposed) → codebase (written) → end.
    expect(tail).toEqual(['memory.narrative', 'memory.updated', 'memory.updated', 'memory.updated', 'session.ended']);
    expect(session.log.events.filter((e) => e.type === 'memory.updated').map((e) => (e.type === 'memory.updated' ? `${e.doc}:${e.status}` : ''))).toEqual([
      'journal:written',
      'lessons:skipped',
      'codebase:written',
    ]);

    const narrative = session.log.events.find((e) => e.type === 'memory.narrative');
    expect(narrative).toMatchObject({ status: 'ok', usage: { inputTokens: 3, outputTokens: 42 } });

    const journalText = fs.readFileSync(path.join(memoryDir(layout.projectDir), 'JOURNAL.md'), 'utf8');
    const parsed = parseJournal(journalText);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.sessionId).toBe(session.id);
    expect(parsed.entries[0]!.body).toContain('Widget written and verified.');
    expect(parsed.entries[0]!.body).toContain('### Evidence (derived from the session log)');
    expect(parsed.entries[0]!.body).toContain('- files changed: 1');
    expect(parsed.fields?.['last-session']).toBe(session.id);

    const codebase = parseCodebase(fs.readFileSync(path.join(memoryDir(layout.projectDir), 'CODEBASE.md'), 'utf8'));
    expect(codebase.stamp?.sessionId).toBe(session.id);
    expect(codebase.stamp?.mapSha256).toBe('map-sha'); // bound to what THIS session recorded
    expect(codebase.body).toContain('One module.');
  });

  it('proposed lessons land in LESSONS.md (provenance-stamped); slug reuse UPDATES; user entries survive', async () => {
    // Pre-seed: one existing entry the model will update by reusing its slug, one hand-edited
    // entry it never names — the latter must survive byte-verbatim.
    const dir = memoryDir(layout.projectDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'LESSONS.md'),
      '---\ndoc: lessons\n---\n## old-slug — stale title\n\nold body\n\n*(session s-0, 2026-08-01)*\n\n## hand-edit — user wisdom\n\nMY OWN NOTES stay exactly as typed.\n',
    );
    const withLessons = JSON.stringify({
      ...JSON.parse(NARRATIVE_JSON),
      codebaseUpdate: null,
      lessons: [
        { slug: 'old-slug', title: 'sharper title', body: 'the updated body, learned again this session' },
        { slug: 'vitest-hang', title: 'vitest hangs on orphaned grandchildren', body: 'kill the tree, then drain bounded — never await close unconditionally.' },
      ],
    });
    const session = makeSession([...productiveTurns, { say: withLessons }]);
    await runTurn(session, 'make f.txt');
    await runMemoryUpdate(session, { layout, enabled: true, endedReason: 'user-quit' });
    endSession(session, 'user-quit');

    expect(session.log.events.find((e) => e.type === 'memory.updated' && e.doc === 'lessons')).toMatchObject({ status: 'written' });
    const text = fs.readFileSync(path.join(dir, 'LESSONS.md'), 'utf8');
    // New + updated entries lead (newest first), stamped with THIS session's identity.
    expect(text.indexOf('## old-slug — sharper title')).toBeGreaterThan(-1);
    expect(text.indexOf('## vitest-hang')).toBeLessThan(text.indexOf('## hand-edit'));
    expect(text).toContain('the updated body, learned again this session');
    expect(text).not.toContain('old body');
    expect(text).toContain(`*(session ${session.id}, `);
    // The untouched user entry survives byte-verbatim.
    expect(text).toContain('MY OWN NOTES stay exactly as typed.');
  });

  it('a narrative WITHOUT the lessons key still succeeds (optional by design — older-model shape)', async () => {
    const session = makeSession([...productiveTurns, { say: NARRATIVE_JSON }]);
    await runTurn(session, 'make f.txt');
    await runMemoryUpdate(session, { layout, enabled: true, endedReason: 'user-quit' });
    endSession(session, 'user-quit');
    expect(session.log.events.find((e) => e.type === 'memory.narrative')).toMatchObject({ status: 'ok' });
    expect(session.log.events.find((e) => e.type === 'memory.updated' && e.doc === 'lessons')).toMatchObject({ status: 'skipped' });
    expect(fs.existsSync(path.join(memoryDir(layout.projectDir), 'LESSONS.md'))).toBe(false);
  });

  it('narrative failure (script exhausted) degrades to a skeleton entry, honestly marked', async () => {
    const session = makeSession([...productiveTurns]);
    await runTurn(session, 'make f.txt');
    await runMemoryUpdate(session, { layout, enabled: true, endedReason: 'completed' });
    endSession(session, 'completed');

    expect(session.log.events.find((e) => e.type === 'memory.narrative')).toMatchObject({ status: 'failed' });
    const journal = session.log.events.filter((e) => e.type === 'memory.updated').find((e) => e.type === 'memory.updated' && e.doc === 'journal');
    expect(journal).toMatchObject({ status: 'written' });

    const text = fs.readFileSync(path.join(memoryDir(layout.projectDir), 'JOURNAL.md'), 'utf8');
    expect(text).toContain('narrative unavailable');
    expect(text).not.toContain('model-written');
    expect(text).toContain('### Evidence');
    // No codebase update without a narrative.
    expect(fs.existsSync(path.join(memoryDir(layout.projectDir), 'CODEBASE.md'))).toBe(false);
  });

  it('unproductive session: gate skips — no provider call, no files, skip events', async () => {
    const session = makeSession([{ say: 'just chat' }]);
    await runTurn(session, 'hello');
    await runMemoryUpdate(session, { layout, enabled: true, endedReason: 'user-quit' });
    endSession(session, 'user-quit');

    expect(session.log.events.find((e) => e.type === 'memory.narrative')).toMatchObject({ status: 'skipped' });
    expect(fs.existsSync(path.join(memoryDir(layout.projectDir), 'JOURNAL.md'))).toBe(false);
  });

  it('disabled by config: skip recorded with the reason', async () => {
    const session = makeSession([...productiveTurns]);
    await runTurn(session, 'make f.txt');
    await runMemoryUpdate(session, { layout, enabled: false, endedReason: 'user-quit' });
    endSession(session, 'user-quit');

    const narrative = session.log.events.find((e) => e.type === 'memory.narrative');
    expect(narrative).toMatchObject({ status: 'skipped' });
    expect(narrative && 'detail' in narrative ? narrative.detail : '').toContain('disabled');
    expect(fs.existsSync(path.join(memoryDir(layout.projectDir), 'JOURNAL.md'))).toBe(false);
  });

  it('quit-again after resume replaces the session entry instead of duplicating it', async () => {
    const session = makeSession([...productiveTurns, { say: NARRATIVE_JSON }, { say: NARRATIVE_JSON }]);
    await runTurn(session, 'make f.txt');
    await runMemoryUpdate(session, { layout, enabled: true, endedReason: 'user-quit' });
    await runMemoryUpdate(session, { layout, enabled: true, endedReason: 'user-quit' });
    endSession(session, 'user-quit');

    const text = fs.readFileSync(path.join(memoryDir(layout.projectDir), 'JOURNAL.md'), 'utf8');
    expect(parseJournal(text).entries.filter((e) => e.sessionId === session.id)).toHaveLength(1);
  });

  it('reuses the EXACT cached prefix: same system, same tools, elided history + one instruction', async () => {
    const requests: ProviderRequest[] = [];
    const inner = new MockProvider([...productiveTurns, { say: NARRATIVE_JSON }]);
    const spy: Provider = {
      name: 'mock',
      complete(req, onText, signal): Promise<ProviderTurn> {
        requests.push(req);
        return inner.complete(req, onText, signal);
      },
    };
    const session = makeSession([], spy);
    await runTurn(session, 'make f.txt');
    await runMemoryUpdate(session, { layout, enabled: true, endedReason: 'user-quit' });
    endSession(session, 'user-quit');

    const last = requests.at(-1)!;
    const turnReq = requests.at(-2)!;
    expect(last.system).toBe(session.system);
    expect(last.tools).toEqual(session.tools.map(toToolSchema));
    // The prior conversation is byte-identical to what the last turn request sent (the cached
    // prefix), with exactly one extra trailing user message (the instruction).
    expect(last.messages.slice(0, turnReq.messages.length + 1)).toEqual([...turnReq.messages, last.messages.at(-2)]);
    const instruction = last.messages.at(-1)!;
    expect(instruction.role).toBe('user');
    expect(JSON.stringify(instruction.content)).toContain('ONLY a JSON object');
  });

  it('S20.5: the narrative view keeps the STICKY elisions — a raised budget must not restore outputs', async () => {
    // Divergence only appears when derivation inputs change after the last turn (a /model switch
    // raising the budget, image aging): without the sticky set the narrative request re-derived
    // from scratch, RESTORED previously-elided outputs, and re-billed the whole suffix uncached
    // while contradicting the log's context.compacted record.
    fs.writeFileSync(path.join(ws, 'big.txt'), 'B'.repeat(3000));
    const requests: ProviderRequest[] = [];
    const inner = new MockProvider([
      { say: 'r1', calls: [{ name: 'read_file', input: { path: 'big.txt' } }] },
      { say: 'writing', calls: [{ name: 'write_file', input: { path: 'f.txt', content: 'hello' } }] },
      { say: 'done' },
      { say: NARRATIVE_JSON },
    ]);
    const spy: Provider = {
      name: 'mock',
      complete(req, onText, signal): Promise<ProviderTurn> {
        requests.push(req);
        return inner.complete(req, onText, signal);
      },
    };
    const session = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'non-interactive',
      provider: spy,
      approver: autoDenyApprover,
      system: 'SYSTEM PROMPT',
      saltHex: '00'.repeat(16),
      clock: fixedClock(1_750_000_000_000, 1),
      idGen: seededIdGen(),
      contextBudget: { triggerChars: 2000, targetChars: 100, keepLastSteps: 0 },
    });
    recordWorkspaceMap(session, { text: 'a.txt\n', fileCount: 1, truncated: false, sha256: 'map-sha' });
    await runTurn(session, 'read big then write');
    expect((session.elidedCallIds ?? new Set()).size).toBeGreaterThan(0);
    // Simulate the /model switch: a budget under which fresh derivation would elide NOTHING.
    session.contextBudget = { triggerChars: 1_000_000, targetChars: 500_000, keepLastSteps: 0 };
    await runMemoryUpdate(session, { layout, enabled: true, endedReason: 'user-quit' });
    endSession(session, 'user-quit');

    const last = requests.at(-1)!; // the narrative request
    const results = last.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(results.some((b) => b.type === 'tool_result' && typeof b.content === 'string' && b.content.includes('[elided'))).toBe(true);
    expect(results.some((b) => b.type === 'tool_result' && typeof b.content === 'string' && b.content.includes('B'.repeat(3000)))).toBe(false);
  });

  it('refuses to overwrite an unreadable existing journal', async () => {
    fs.mkdirSync(path.join(memoryDir(layout.projectDir), 'JOURNAL.md'), { recursive: true }); // a directory
    const session = makeSession([...productiveTurns, { say: NARRATIVE_JSON }]);
    await runTurn(session, 'make f.txt');
    await runMemoryUpdate(session, { layout, enabled: true, endedReason: 'user-quit' });
    endSession(session, 'user-quit');

    const journalEvents = session.log.events.filter((e) => e.type === 'memory.updated' && e.doc === 'journal');
    expect(journalEvents[0]).toMatchObject({ status: 'failed' });
    expect(journalEvents[0] && 'detail' in journalEvents[0]! ? journalEvents[0]!.detail : '').toContain('refusing to overwrite');
  });
});

describe('endReasonForTurn', () => {
  const base: TurnResult = { finalText: '', stopReason: 'end_turn', denials: 0, steps: 1, stopped: false, aborted: false };
  it('maps aborted → aborted (never user-quit — the memory gate depends on it)', () => {
    expect(endReasonForTurn({ ...base, stopped: true, aborted: true }, 20)).toBe('aborted');
    expect(endReasonForTurn({ ...base, stopped: true, steps: 20, aborted: true }, 20)).toBe('aborted');
  });
  it('maps steps-exhausted / deny-stop / clean end', () => {
    expect(endReasonForTurn({ ...base, stopped: true, steps: 20 }, 20)).toBe('max-steps');
    expect(endReasonForTurn({ ...base, stopped: true }, 20)).toBe('user-quit');
    expect(endReasonForTurn(base, 20)).toBe('completed');
  });

  it('S20.5: a deny-stop on the FINAL allowed step is user-quit, never max-steps', () => {
    // The two can coincide (steps+1 === maxSteps); the explicit cause must win, or the human's
    // intervention reads as budget exhaustion — and a child's counts toward the retry ceiling.
    expect(endReasonForTurn({ ...base, stopped: true, steps: 20, userStopped: true }, 20)).toBe('user-quit');
  });
});

describe('buildHandoffLines (Session 11.5 — the deterministic handoff)', () => {
  function sessionWith(events: Record<string, unknown>[], mode: 'interactive' | 'non-interactive' = 'interactive'): Session {
    const s = makeSession([]);
    (s as { mode: string }).mode = mode;
    for (const e of events) s.log.append(e as never);
    return s;
  }
  const capture = (child: string) => ({
    type: 'task.changes',
    callId: 'c',
    childSessionId: child,
    baseOid: 'b',
    files: [{ relPath: 'a.ts', kind: 'modify', baseSha256: 'x', blobSha256: 'y', bytes: 1 }],
  });

  it('complete, not accepted, interactive: says so and emits NO resume pointer for done work', () => {
    const s = sessionWith([]);
    const lines = buildHandoffLines(layout, s);
    expect(lines[0]).toBe('- accepted: no — work is complete but was not accepted');
    expect(lines.some((l) => l.startsWith('- resume:'))).toBe(false);
    endSession(s, 'completed');
  });

  it('incomplete work lists the blockers and the resume pointer', () => {
    const s = sessionWith([capture('c-1111')]);
    const lines = buildHandoffLines(layout, s);
    expect(lines[0]).toContain('1 unfinished item(s)');
    expect(lines.some((l) => l.includes('not applied'))).toBe(true);
    expect(lines.some((l) => l === `- resume: agent resume ${s.id}`)).toBe(true);
    endSession(s, 'completed');
  });

  it('a STALE acceptance is annotated and the LIVE unfinished list governs (review F1)', () => {
    const s = sessionWith([
      { type: 'session.accepted', complete: true, summary: 'complete — no plan' },
      capture('c-2222'), // work AFTER the acceptance leaves it stale and the session incomplete
    ]);
    const lines = buildHandoffLines(layout, s);
    expect(lines[0]).toContain('accepted: yes (complete)');
    expect(lines[0]).toContain('work has happened SINCE the acceptance');
    expect(lines.some((l) => l.includes('not applied'))).toBe(true); // live blockers, not the frozen []
    expect(lines.some((l) => l.startsWith('- resume:'))).toBe(true);
    endSession(s, 'completed');
  });

  it('one-shot sessions say acceptance is not applicable', () => {
    const s = sessionWith([], 'non-interactive');
    const lines = buildHandoffLines(layout, s);
    expect(lines[0]).toBe('- accepted: not applicable (one-shot session — /accept is a REPL boundary)');
    endSession(s, 'completed');
  });
});
