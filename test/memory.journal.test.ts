import { describe, expect, it } from 'vitest';
import { buildEntry, parseJournal, rollJournal, type Narrative } from '../src/memory/journal.js';
import { isStale, parseCodebase, stampCodebase } from '../src/memory/codebase.js';
import type { ReportJson } from '../src/report/report.js';

/** Pure journal/codebase format machinery — no I/O anywhere in these tests. */

function fixtureReport(overrides: Partial<ReportJson> = {}): ReportJson {
  return {
    session: {
      id: 's1',
      workspaceRoot: 'C:\\ws',
      model: 'mock',
      mode: 'interactive',
      providerName: 'mock',
      endedReason: 'user-quit',
      resumes: 0,
      usage: { inputTokens: 10, outputTokens: 200, cacheReadInputTokens: 500, cacheCreationInputTokens: 50 },
    },
    tasks: ['build the widget\nwith details'],
    actions: [],
    filesChanged: [
      { path: 'a.ts', kind: 'create', beforeSha256: null, afterSha256: 'x', snapshotRecorded: true, checked: true, checkedBy: 'npm test', linesAdded: 100, linesRemoved: 2 },
      { path: 'b.ts', kind: 'modify', beforeSha256: 'y', afterSha256: 'z', snapshotRecorded: true, checked: false, linesAdded: 20, linesRemoved: 6 },
    ],
    commands: [
      { command: 'npm test', ok: true, exitCode: 0, durationMs: 100 },
      { command: 'npm run build', ok: false, exitCode: 1, durationMs: 50 },
    ],
    approvals: [],
    undos: [],
    gitCommits: [{ oid: 'abcdef0123456789', subject: 'feat: widget', files: 2, scope: 'session', trailer: true }],
    gitCheckpoints: [],
    taskBaseCheckpoints: [],
    gitRestores: [],
    tasksDelegated: [],
    integrity: { truncatedTail: false },
    ...overrides,
  };
}

const NARRATIVE: Narrative = {
  objective: 'Build the widget module',
  outcome: 'Widget built and 12 tests pass.',
  decisions: ['Used plain functions over a class'],
  openIssues: ['b.ts is UNCHECKED'],
  nextSteps: ['Wire the widget into the CLI'],
};

function entryFor(id: string, narrative: Narrative | null = NARRATIVE): ReturnType<typeof buildEntry> {
  return buildEntry({
    sessionId: id,
    endedAt: '2026-07-20T10:00:00.000Z',
    endedReason: 'user-quit',
    report: fixtureReport(),
    logPath: `C:\\state\\sessions\\${id}.jsonl`,
    narrative,
  });
}

describe('journal entries', () => {
  it('builds a stable entry: labeled model sections + derived evidence (golden)', () => {
    const e = entryFor('20260720-100000-aaaa');
    expect(e.heading).toBe('## Session 20260720-100000-aaaa (2026-07-20) — Build the widget module');
    expect(e.body).toBe(
      [
        '### Summary (model-written)',
        'Widget built and 12 tests pass.',
        '',
        '### Decisions (model-written)',
        '- Used plain functions over a class',
        '',
        '### Open issues (model-written)',
        '- b.ts is UNCHECKED',
        '',
        '### Next steps (model-written)',
        '- Wire the widget into the CLI',
        '',
        '### Evidence (derived from the session log)',
        '- files changed: 2 (+120/−8; 1 CHECKED, 1 UNCHECKED)',
        '- commands run: 2 (1 exited 0)',
        '- commits: abcdef01 "feat: widget"',
        '- tokens: 10 in / 200 out (cache: 500 read / 50 written)',
        '- ended: user-quit',
        '- session log: C:\\state\\sessions\\20260720-100000-aaaa.jsonl',
        '',
      ].join('\n'),
    );
  });

  it('skeleton entry (no narrative) states unavailability, keeps evidence, titles from the task', () => {
    const e = entryFor('20260720-100000-bbbb', null);
    expect(e.heading).toContain('— build the widget');
    expect(e.body).toContain('narrative unavailable');
    expect(e.body).not.toContain('model-written');
    expect(e.body).toContain('### Evidence (derived from the session log)');
  });
});

describe('journal roll', () => {
  it('creates, then replaces by session id (a resumed session updates its own entry)', () => {
    const t1 = rollJournal(parseJournal(''), entryFor('s-1'), '2026-07-20T10:00:00Z');
    const p1 = parseJournal(t1);
    expect(p1.entries.map((e) => e.sessionId)).toEqual(['s-1']);
    expect(p1.fields?.['last-session']).toBe('s-1');

    const replaced = { ...entryFor('s-1'), body: 'REPLACED BODY\n' };
    const t2 = rollJournal(parseJournal(t1), replaced, '2026-07-20T11:00:00Z');
    const p2 = parseJournal(t2);
    expect(p2.entries.map((e) => e.sessionId)).toEqual(['s-1']);
    expect(p2.entries[0]!.body).toContain('REPLACED BODY');
    expect(t2.match(/## Session s-1 /g)).toHaveLength(1);
  });

  it('preserves a user preamble and hand-edits inside kept-full entries byte-verbatim', () => {
    const t1 = rollJournal(parseJournal(''), entryFor('s-1'), '2026-07-20T10:00:00Z');
    // The user edits the file between sessions: a custom preamble and a note inside the entry.
    const edited = t1
      .replace(/> Harness-managed[^]*?outrank anything recorded here\.\n/, 'MY OWN PREAMBLE — do not lose this.\n')
      .replace('### Evidence', 'USER NOTE: check the widget again.\n\n### Evidence');
    const t2 = rollJournal(parseJournal(edited), entryFor('s-2'), '2026-07-21T10:00:00Z');
    expect(t2).toContain('MY OWN PREAMBLE — do not lose this.');
    expect(t2).toContain('USER NOTE: check the widget again.');
    const p2 = parseJournal(t2);
    expect(p2.entries.map((e) => e.sessionId)).toEqual(['s-2', 's-1']);
  });

  it('compresses beyond keepFull and drops oldest under the cap with an honest marker', () => {
    let text = '';
    for (let i = 1; i <= 4; i++) {
      text = rollJournal(parseJournal(text), entryFor(`s-${i}`), `2026-07-2${i}T10:00:00Z`);
    }
    const p = parseJournal(text);
    expect(p.entries.map((e) => e.sessionId)).toEqual(['s-4', 's-3', 's-2', 's-1']);
    // Newest 2 full, older compressed.
    expect(p.entries[0]!.body).toContain('### Evidence');
    expect(p.entries[1]!.body).toContain('### Evidence');
    expect(p.entries[2]!.body).toMatch(/^\(compressed\)/);
    expect(p.entries[3]!.body).toMatch(/^\(compressed\)/);
    // Compressed stubs keep the evidence pointer.
    expect(p.entries[2]!.body).toContain('- session log:');

    // A tiny budget forces dropping the oldest stubs entirely — with a marker that survives
    // even a final hard slice (it leads the entries rather than trailing them).
    const capped = rollJournal(parseJournal(text), entryFor('s-5'), '2026-07-25T10:00:00Z', { maxChars: 1400 });
    expect(capped.length).toBeLessThanOrEqual(1500);
    expect(capped).toContain('older session entr');
    expect(parseJournal(capped).entries[0]!.sessionId).toBe('s-5');
  });
});

describe('codebase stamping', () => {
  it('stamp → parse round-trips and detects staleness by map digest', () => {
    const stamped = stampCodebase('# Shape\n\nModules…', {
      sessionId: 's-1',
      updatedAt: '2026-07-20T10:00:00Z',
      mapSha256: 'digest-a',
      inventorySha256: null,
      head: 'abc123',
    });
    const { stamp, body } = parseCodebase(stamped);
    expect(stamp).toEqual({ sessionId: 's-1', updatedAt: '2026-07-20T10:00:00Z', mapSha256: 'digest-a', inventorySha256: null, head: 'abc123' });
    expect(body).toContain('# Shape');
    expect(body).toContain('NOT');

    expect(isStale(stamp, 'digest-a')).toBe(false);
    expect(isStale(stamp, 'digest-b')).toBe(true);
    expect(isStale(null, 'digest-a')).toBe(true);
    expect(isStale(parseCodebase('no frontmatter').stamp, 'x')).toBe(true);
  });

  it('inventory-digest stamps round-trip and win the staleness comparison (Session 10)', () => {
    const stamped = stampCodebase('# Shape', {
      sessionId: 's-2',
      updatedAt: 'u',
      mapSha256: 'text-digest',
      inventorySha256: 'inv-digest',
      head: null,
    });
    expect(stamped).toContain('inventory-digest: inv-digest');
    const { stamp } = parseCodebase(stamped);
    expect(stamp?.inventorySha256).toBe('inv-digest');
    // Inventory compare wins when both sides have one; map text is then irrelevant.
    expect(isStale(stamp, 'other-text', 'inv-digest')).toBe(false);
    expect(isStale(stamp, 'text-digest', 'other-inv')).toBe(true);
    // Without a current inventory digest, the legacy compare still applies.
    expect(isStale(stamp, 'text-digest')).toBe(false);
    expect(isStale(stamp, 'other-text')).toBe(true);
  });
});
