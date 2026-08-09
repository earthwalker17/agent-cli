import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSession, endSession, runTurn, type Session } from '../src/runtime/session.js';
import type { SubagentDeps } from '../src/runtime/subagent.js';
import { SEARCHES_PER_SESSION } from '../src/research/types.js';
import { createDelegateTool } from '../src/tools/delegate.js';
import { createWebSearchTool } from '../src/tools/web-search.js';
import { createWebExtractTool } from '../src/tools/web-extract.js';
import { createRecordSourceTool, type NoteAccumulator } from '../src/tools/record-source.js';
import { createResearchBudget, researchSpendFromEvents, type ResearchBudget } from '../src/tools/research-budget.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { autoDenyApprover, dangerousApprover } from '../src/runtime/approvals.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { ExtractOutcome, ResearchClient, SearchOutcome } from '../src/research/types.js';
import type { ApprovalRequest, SessionEvent, Tool } from '../src/types.js';
import type { WorkspaceMap } from '../src/workspace/map.js';

/**
 * The delegated research path end to end: a parent spawns a researcher child, the child searches
 * and records findings against the SAME budget, and the parent log ends up holding both the
 * structured findings and the spend record.
 *
 * The spend record is the whole reason this file exists. Every search the child runs is recorded
 * in the CHILD's log, which the parent's budget fold never reads — so without `research.usage` in
 * the parent log a resumed session would refill its allowance.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;
const MAP: WorkspaceMap = { text: 'a.txt\n', fileCount: 1, truncated: false, sha256: 'map-x' };

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'research-deleg-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello');
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const HIT: SearchOutcome = {
  query: 'zod v4',
  results: [{ title: 'Changelog', url: 'https://zod.dev/v4/changelog', host: 'zod.dev', score: 0.9, snippet: 'z.toJSONSchema is current.' }],
  credits: 1,
  responseTimeMs: 10,
  refused: [],
  droppedChars: 0,
};
const PAGE: ExtractOutcome = {
  pages: [{ url: 'https://zod.dev/v4/changelog', host: 'zod.dev', content: 'full changelog text', chars: 19, truncated: false }],
  failed: [],
  refused: [],
  credits: 1,
  responseTimeMs: 10,
  droppedChars: 0,
};

function fakeClient(): ResearchClient {
  return {
    host: 'api.tavily.com',
    describeTransport: () => 'direct (no proxy configured)',
    search: () => Promise.resolve(HIT),
    extract: () => Promise.resolve(PAGE),
  };
}

const NOTE = {
  claim: 'zod v4 ships z.toJSONSchema in core, replacing the community helper',
  sources: ['https://zod.dev/v4/changelog', 'https://github.com/colinhacks/zod/releases'],
  corroboration: 'corroborated',
  confidence: 'high',
  relevance: 'this project pins zod 4, so the old helper import cannot resolve',
};

function subagentDeps(childScripts: ScriptTurn[][], budget: ResearchBudget, withResearch = true): SubagentDeps {
  let i = 0;
  const client = fakeClient();
  return {
    layout,
    workspaceRoot: ws,
    model: 'mock-child',
    maxTokens: 1000,
    provider: new MockProvider([{ say: 'fallback' }]),
    map: MAP,
    clock: fixedClock(0, 1),
    idGen: seededIdGen(),
    providerForTask: () => new MockProvider(childScripts[i++] ?? [{ say: 'no script' }]),
    ...(withResearch
      ? {
          researchBudget: budget,
          researchToolsFor: (acc: NoteAccumulator) => {
            // Mirrors production: per-task state created fresh here, shared budget closed over.
            const taskSpend = { searches: 0, extracts: 0, credits: 0, contentChars: 0 };
            return {
              taskSpend,
              webSearch: createWebSearchTool({ client, budget, taskSpend }) as Tool,
              webExtract: createWebExtractTool({ client, budget, taskSpend }) as Tool,
              recordSource: createRecordSourceTool({ acc, today: () => '2026-08-07' }) as Tool,
            };
          },
        }
      : {}),
  };
}

function makeParent(parentScript: ScriptTurn[], childDeps: SubagentDeps, approve = true): Session {
  const parent = startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock-parent',
    mode: 'non-interactive',
    provider: new MockProvider(parentScript),
    // Spawning a researcher ASKS (external). dangerousApprover stands in for a human saying yes.
    approver: approve ? dangerousApprover : autoDenyApprover,
    tools: [],
    saltHex: '00'.repeat(16),
    clock: fixedClock(0, 1),
    idGen: seededIdGen(),
  });
  parent.tools = [createDelegateTool(childDeps, parent.id) as Tool];
  return parent;
}

/** Everything the MODEL actually saw this turn — the only place a tool refusal's reason lives. */
const wireText = (s: Session): string => JSON.stringify(s.messages);

const spawn = (task = 'find the current zod json-schema API'): ScriptTurn[] => [
  { say: 'researching', calls: [{ name: 'delegate_task', input: { tasks: [{ role: 'researcher', task }] } }] },
  { say: 'done' },
];

describe('a researcher child searches, records, and reports through the parent log', () => {
  it('records findings with childSessionId#ordinal ids and the harness-stamped date', async () => {
    const budget = createResearchBudget();
    const parent = makeParent(
      spawn(),
      subagentDeps(
        [
          [
            { say: 'searching', calls: [{ name: 'web_search', input: { query: 'zod v4 json schema' } }] },
            { say: 'recording', calls: [{ name: 'record_source', input: NOTE }] },
            { say: 'zod 4 ships z.toJSONSchema in core. Confidence high, two sources.' },
          ],
        ],
        budget,
      ),
    );
    await runTurn(parent, 'research it');
    endSession(parent, 'completed');

    const ev = parent.log.events.find((e) => e.type === 'research.findings') as Extract<SessionEvent, { type: 'research.findings' }>;
    expect(ev).toBeDefined();
    expect(ev.notes).toHaveLength(1);
    expect(ev.notes[0]!.noteId).toBe(`${ev.childSessionId}#1`);
    expect(ev.notes[0]!.claim).toContain('z.toJSONSchema');
    expect(ev.notes[0]!.retrievedAt).toBe('2026-08-07');
    expect(ev.notes[0]!.sources).toHaveLength(2);
  });

  it('the CHILD holds the raw pages; the parent log holds only claims and provenance', async () => {
    const budget = createResearchBudget();
    const parent = makeParent(
      spawn(),
      subagentDeps(
        [
          [
            { say: 'searching', calls: [{ name: 'web_search', input: { query: 'zod v4' } }] },
            { say: 'reading', calls: [{ name: 'web_extract', input: { urls: ['https://zod.dev/v4/changelog'] } }] },
            { say: 'recording', calls: [{ name: 'record_source', input: NOTE }] },
            { say: 'answered' },
          ],
        ],
        budget,
      ),
    );
    await runTurn(parent, 'research it');
    endSession(parent, 'completed');

    // The parent never saw a research.searched / research.extracted event: those are the CHILD's.
    expect(parent.log.events.some((e) => e.type === 'research.searched')).toBe(false);
    expect(parent.log.events.some((e) => e.type === 'research.extracted')).toBe(false);
    // Nor the page text.
    const serialized = JSON.stringify(parent.log.events);
    expect(serialized).not.toContain('full changelog text');
    // But it does hold the claim and its sources.
    expect(serialized).toContain('z.toJSONSchema');
    expect(serialized).toContain('https://zod.dev/v4/changelog');
  });

  it('captures the task SPEND into the parent log so a resume cannot refill the budget', async () => {
    const budget = createResearchBudget();
    const parent = makeParent(
      spawn(),
      subagentDeps(
        [
          [
            { say: 's1', calls: [{ name: 'web_search', input: { query: 'zod v4 one' } }] },
            { say: 's2', calls: [{ name: 'web_search', input: { query: 'zod v4 two' } }] },
            { say: 'x', calls: [{ name: 'web_extract', input: { urls: ['https://zod.dev/v4/changelog'] } }] },
            { say: 'done' },
          ],
        ],
        budget,
      ),
    );
    await runTurn(parent, 'research it');
    endSession(parent, 'completed');

    const u = parent.log.events.find((e) => e.type === 'research.usage') as Extract<SessionEvent, { type: 'research.usage' }>;
    expect(u).toBeDefined();
    expect(u).toMatchObject({ searches: 2, extracts: 1, credits: 3 });
    expect(u.contentChars).toBeGreaterThan(0);

    // The live object agrees with what a fresh fold of the parent log would rebuild.
    expect(budget.spent).toMatchObject({ searches: 2, extracts: 1, credits: 3 });
    const rebuilt = researchSpendFromEvents(parent.log.events);
    expect(rebuilt).toEqual(budget.spent);
  });

  it('the group digest names the findings and flags single-source ones for the parent to verify', async () => {
    const budget = createResearchBudget();
    const parent = makeParent(
      spawn(),
      subagentDeps(
        [
          [
            { say: 'r1', calls: [{ name: 'record_source', input: { ...NOTE, corroboration: 'single-source', sources: ['https://zod.dev/a'] } }] },
            { say: 'reported' },
          ],
        ],
        budget,
      ),
    );
    await runTurn(parent, 'research it');
    endSession(parent, 'completed');

    const completed = parent.log.events.find((e) => e.type === 'tool.completed') as { outputPreview: string };
    expect(completed.outputPreview).toContain('1 source-backed finding(s) RECORDED');
    expect(completed.outputPreview).toContain('1 SINGLE-SOURCE');
    expect(completed.outputPreview).toContain('verify anything load-bearing yourself');
  });

  it('says so plainly when a researcher recorded nothing — prose is narration, not evidence', async () => {
    const budget = createResearchBudget();
    const parent = makeParent(
      spawn(),
      subagentDeps([[{ say: 'I found lots of authoritative sources confirming everything.' }]], budget),
    );
    await runTurn(parent, 'research it');
    endSession(parent, 'completed');

    const completed = parent.log.events.find((e) => e.type === 'tool.completed') as { outputPreview: string };
    expect(completed.outputPreview).toContain('ZERO findings recorded via record_source');
    expect(completed.outputPreview).toContain('narration, not sourced evidence');
  });
});

describe('the budget is genuinely shared', () => {
  it('two sequential researcher tasks spend ONE allowance, not one each', async () => {
    const budget = createResearchBudget();
    const parent = makeParent(
      [
        { say: 'r1', calls: [{ name: 'delegate_task', input: { tasks: [{ role: 'researcher', task: 'first question about the api' }] } }] },
        { say: 'r2', calls: [{ name: 'delegate_task', input: { tasks: [{ role: 'researcher', task: 'second question about the api' }] } }] },
        { say: 'done' },
      ],
      subagentDeps(
        [
          [{ say: 's', calls: [{ name: 'web_search', input: { query: 'first query here' } }] }, { say: 'done' }],
          [{ say: 's', calls: [{ name: 'web_search', input: { query: 'second query here' } }] }, { say: 'done' }],
        ],
        budget,
      ),
    );
    await runTurn(parent, 'research twice');
    endSession(parent, 'completed');

    expect(budget.spent.searches).toBe(2);
    const usages = parent.log.events.filter((e) => e.type === 'research.usage') as Extract<SessionEvent, { type: 'research.usage' }>[];
    expect(usages).toHaveLength(2);
    // Each record is that task's OWN delta, not a running total.
    expect(usages.every((u) => u.searches === 1)).toBe(true);
  });

  it('PARALLEL researchers each record only their OWN spend, not the group\'s', async () => {
    // S19 review, reproduced: the delegate derived a task's spend by diffing the SHARED budget
    // around it. The whole group fans out under one Promise.all, so every sibling snapshotted the
    // same "before" and then subtracted it from a total containing the others' spend — two
    // researchers doing one search each produced live=2 but rebuilt-on-resume=4.
    const budget = createResearchBudget();
    const parent = makeParent(
      [
        {
          say: 'both',
          calls: [
            {
              name: 'delegate_task',
              input: {
                tasks: [
                  { role: 'researcher', task: 'first independent question about the api' },
                  { role: 'researcher', task: 'second independent question about the api' },
                ],
              },
            },
          ],
        },
        { say: 'done' },
      ],
      subagentDeps(
        [
          [{ say: 's', calls: [{ name: 'web_search', input: { query: 'first query here' } }] }, { say: 'done' }],
          [{ say: 's', calls: [{ name: 'web_search', input: { query: 'second query here' } }] }, { say: 'done' }],
        ],
        budget,
      ),
    );
    await runTurn(parent, 'research both');
    endSession(parent, 'completed');

    const usages = parent.log.events.filter((e) => e.type === 'research.usage') as Extract<SessionEvent, { type: 'research.usage' }>[];
    expect(usages).toHaveLength(2);
    for (const u of usages) expect(u.searches).toBe(1);
    // The live object and a fresh fold of the parent log must agree — that equality IS the
    // property, and it is exactly what the diff broke.
    expect(budget.spent.searches).toBe(2);
    expect(researchSpendFromEvents(parent.log.events)).toEqual(budget.spent);
  });

  it('a child cannot spend past an allowance the parent already drained', async () => {
    const budget = createResearchBudget();
    budget.chargeUsage({ searches: SEARCHES_PER_SESSION, extracts: 0, credits: 0, contentChars: 0 });
    const parent = makeParent(
      spawn(),
      subagentDeps([[{ say: 's', calls: [{ name: 'web_search', input: { query: 'anything at all' } }] }, { say: 'done' }]], budget),
    );
    await runTurn(parent, 'research it');
    endSession(parent, 'completed');

    // The child's own log would carry the denial; the parent's usage record shows zero spend.
    const u = parent.log.events.find((e) => e.type === 'research.usage') as Extract<SessionEvent, { type: 'research.usage' }>;
    expect(u).toMatchObject({ searches: 0, credits: 0 });
    expect(budget.spent.searches).toBe(SEARCHES_PER_SESSION);
  });
});

describe('spawning is gated, and refused honestly when research is unavailable', () => {
  it('the SPAWN ask carries kind "research" so the prompt states what it really grants', async () => {
    // Found in the live S19 run: the spawn is decided in the DELEGATION branch, so delegate_task
    // carries no research fact and the ask rendered as a bare "[external] delegate_task" offering
    // "[s] allow for the rest of this session" — the generic wording, for standing consent to
    // spawn researchers. The kind now derives from the rule as well as the fact.
    const budget = createResearchBudget();
    const asks: ApprovalRequest[] = [];
    const parent = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-parent',
      mode: 'non-interactive',
      provider: new MockProvider(spawn()),
      approver: (req) => {
        asks.push(req);
        return Promise.resolve({ decision: 'deny' as const, scope: 'once' as const, source: 'user' as const });
      },
      tools: [],
      saltHex: '00'.repeat(16),
      clock: fixedClock(0, 1),
      idGen: seededIdGen(),
    });
    parent.tools = [createDelegateTool(subagentDeps([[{ say: 'x' }]], budget), parent.id) as Tool];
    await runTurn(parent, 'research it');
    endSession(parent, 'completed');

    expect(asks).toHaveLength(1);
    expect(asks[0]!.kind).toBe('research');
    expect(asks[0]!.classification).toBe('external');
  });

  it('a denied spawn starts no child and records no research evidence', async () => {
    const budget = createResearchBudget();
    const parent = makeParent(spawn(), subagentDeps([[{ say: 'never runs' }]], budget), false);
    await runTurn(parent, 'research it');
    endSession(parent, 'completed');

    const decision = parent.log.events.find((e) => e.type === 'policy.decision') as { rule: string; classification: string };
    expect(decision).toMatchObject({ rule: 'task.research-role', classification: 'external' });
    expect(parent.log.events.some((e) => e.type === 'task.started')).toBe(false);
    expect(parent.log.events.some((e) => e.type === 'research.findings')).toBe(false);
    expect(budget.spent.searches).toBe(0);
  });

  it('refuses the group with a named cure when no credential is configured — nothing spawns', async () => {
    const budget = createResearchBudget();
    const parent = makeParent(spawn(), subagentDeps([[{ say: 'never runs' }]], budget, false));
    await runTurn(parent, 'research it');
    endSession(parent, 'completed');

    const completed = parent.log.events.find((e) => e.type === 'tool.completed') as { ok: boolean };
    expect(completed.ok).toBe(false);
    // A refused tool's REASON travels on the wire, not in `tool.completed.outputPreview` (which
    // records `output`, empty for a refusal) — so the model's own view is where to assert it.
    expect(wireText(parent)).toContain('TAVILY_API_KEY');
    expect(wireText(parent)).toContain('Nothing was spawned');
    expect(wireText(parent)).toContain('rather than presenting recalled information as current');
    expect(parent.log.events.some((e) => e.type === 'task.started')).toBe(false);
  });
});
