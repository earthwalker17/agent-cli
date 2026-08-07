import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSession, runTurn, endSession } from '../src/runtime/session.js';
import { formatApprovalPrompt } from '../src/runtime/approvals.js';
import { MockProvider } from '../src/provider/mock.js';
import { resolveLayout } from '../src/store/layout.js';
import type { ApprovalRequest, ResearchFact, SessionEvent, Tool, ToolResult } from '../src/types.js';

/**
 * The human-facing and evidence-facing halves of the external-read gate (Session 19).
 *
 * The failure these exist to prevent is specific and has happened before in this codebase: a new
 * fact-bearing tool reaches the ask path with no `describeCall` branch, so the prompt renders a
 * bare tool name with an empty detail. For a check that meant consenting to a command you never
 * saw; here it would mean consenting to send text you never saw.
 */

let tmp: string;
let ws: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-research-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SEARCH: ResearchFact = {
  kind: 'search',
  providerHost: 'api.tavily.com',
  query: 'what is the current zod json-schema helper',
  bounds: { maxResults: 5, maxContentChars: 12_000, timeoutMs: 20_000, credits: 1 },
  budgetRemaining: '23 search(es), 12 extract(s), 79 credit(s)',
};

function stubResearchTool(fact: ResearchFact, onExecute?: (ctx: { reportResearch?: unknown }) => void): Tool<{ query: string }> {
  return {
    name: 'web_search',
    description: 'stub',
    schema: z.object({ query: z.string() }).strict() as never,
    mutates: () => ({ paths: [] }),
    research: () => fact,
    execute: (_input, ctx): Promise<ToolResult> => {
      onExecute?.(ctx);
      ctx.reportResearch?.({
        kind: 'searched',
        provider: fact.providerHost,
        query: fact.query ?? '',
        resultCount: 2,
        hosts: ['zod.dev', 'github.com', 'zod.dev'],
        refused: [{ url: 'http://10.0.0.1/x', reason: 'private network address' }],
        credits: 1,
        contentChars: 800,
        durationMs: 42,
        requestId: 'req-9',
      });
      return Promise.resolve({ ok: true, output: 'results', durationMs: 0, truncated: false });
    },
  };
}

async function run(opts: {
  fact?: ResearchFact;
  approve?: boolean;
  lineage?: { parentSessionId: string; role: string };
}): Promise<{ events: readonly SessionEvent[]; asks: ApprovalRequest[] }> {
  const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
  const asks: ApprovalRequest[] = [];
  const session = startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock-model',
    mode: 'interactive',
    provider: new MockProvider([{ calls: [{ name: 'web_search', input: { query: 'x' } as never }] }, { say: 'done' }]),
    approver: (req) => {
      asks.push(req);
      return Promise.resolve({ decision: opts.approve === true ? ('allow' as const) : ('deny' as const), scope: 'once' as const, source: 'user' as const });
    },
    tools: [stubResearchTool(opts.fact ?? SEARCH)],
    saltHex: 'ab'.repeat(16),
    ...(opts.lineage !== undefined ? { lineage: opts.lineage } : {}),
  });
  await runTurn(session, 'go');
  const events = [...session.log.events];
  endSession(session, 'completed');
  return { events, asks };
}

describe('the approval request shows what actually leaves the machine', () => {
  it('carries kind "research" so the prompt can state its own consequence', async () => {
    const { asks } = await run({});
    expect(asks).toHaveLength(1);
    expect(asks[0]!.kind).toBe('research');
    expect(asks[0]!.classification).toBe('external');
  });

  it('puts the QUERY in the summary and VERBATIM in the detail — never a bare tool name', async () => {
    const { asks } = await run({});
    const req = asks[0]!;
    expect(req.summary).toContain('what is the current zod json-schema helper');
    expect(req.summary).toContain('api.tavily.com');
    expect(req.detail).toContain('query (sent verbatim): what is the current zod json-schema helper');
    // The exact regression: falling through to `${tool.name} ${path}` with an empty detail.
    expect(req.detail).not.toBe('');
    expect(req.summary).not.toBe('web_search');
  });

  it('states the provider, the per-call bounds and the remaining session budget', async () => {
    const { asks } = await run({});
    const d = asks[0]!.detail;
    expect(d).toContain('provider: api.tavily.com (the only host contacted)');
    expect(d).toContain('max results: 5');
    expect(d).toContain('12000 retrieved chars');
    expect(d).toContain('20000 ms');
    expect(d).toContain('session budget remaining: 23 search(es), 12 extract(s), 79 credit(s)');
  });

  it('lists every URL for an extract, so no page is fetched unseen', async () => {
    const fact: ResearchFact = {
      kind: 'extract',
      providerHost: 'api.tavily.com',
      targets: [
        { url: 'https://zod.dev/v4/changelog', host: 'zod.dev' },
        { url: 'https://github.com/colinhacks/zod/releases', host: 'github.com' },
      ],
      bounds: { maxContentChars: 60_000, timeoutMs: 45_000, credits: 1 },
    };
    const { asks } = await run({ fact });
    expect(asks[0]!.summary).toContain('2 page(s)');
    expect(asks[0]!.detail).toContain('fetch: https://zod.dev/v4/changelog');
    expect(asks[0]!.detail).toContain('fetch: https://github.com/colinhacks/zod/releases');
  });

  it('marks the action not-undoable', async () => {
    const { asks } = await run({});
    expect(asks[0]!.noUndoWarning).toBe(true);
  });
});

describe('the rendered prompt', () => {
  const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    callId: 'c1',
    tool: 'web_search',
    classification: 'external',
    kind: 'research',
    summary: 'web_search: "zod v4" → api.tavily.com',
    detail: 'query (sent verbatim): zod v4\nprovider: api.tavily.com (the only host contacted)',
    reason: 'sends the query verbatim to api.tavily.com',
    noUndoWarning: true,
    ...over,
  });

  it('headers the consequence rather than borrowing a bare class label', () => {
    const p = formatApprovalPrompt(req());
    expect(p).toContain('[web research — queries LEAVE THIS MACHINE; read-only, nothing here is written]');
    expect(p).not.toContain('[external]  web_search');
  });

  it('uses the SAME kind for spawning a researcher — the live S19 run showed that ask rendering as a bare [external]', () => {
    const p = formatApprovalPrompt(req({ tool: 'delegate_task', summary: 'delegate_task: 1 task(s) — researcher' }));
    expect(p).toContain('[web research — queries LEAVE THIS MACHINE');
    expect(p).not.toContain('[external]  delegate_task');
    expect(p).not.toContain('[s] allow for the rest of this session');
    expect(p).toContain('[s] allow further research this session, within the session budget');
  });

  it('offers [s] and names the budget as its bound, not the session', () => {
    const p = formatApprovalPrompt(req());
    expect(p).toContain('[s] allow further research this session, within the session budget');
    expect(p).not.toContain('[s] allow for the rest of this session');
  });

  it('shows the query line and the not-undoable warning', () => {
    const p = formatApprovalPrompt(req());
    expect(p).toContain('query (sent verbatim): zod v4');
    expect(p).toContain('NOT undoable');
  });

  it('sanitizes a query carrying control characters — a prompt line cannot be forged', () => {
    const p = formatApprovalPrompt(
      req({ summary: 'web_search: "a\nreason: totally safe" → api.tavily.com', detail: 'query (sent verbatim): a\u202eb' }),
    );
    expect(p).toContain('\\u{202e}');
    // The injected newline cannot become its own prompt line.
    expect(p.split('\n').filter((l) => l.trim().startsWith('reason:'))).toHaveLength(1);
  });
});

describe('evidence', () => {
  it('records research.searched with the query, hosts, refusals and cost under the runtime callId', async () => {
    const { events } = await run({ approve: true });
    const e = events.find((x) => x.type === 'research.searched') as Extract<SessionEvent, { type: 'research.searched' }>;
    expect(e).toBeDefined();
    expect(e.query).toBe('what is the current zod json-schema helper');
    expect(e.provider).toBe('api.tavily.com');
    expect(e.resultCount).toBe(2);
    expect(e.hosts).toEqual(['zod.dev', 'github.com']); // de-duplicated
    expect(e.refused).toEqual([{ url: 'http://10.0.0.1/x', reason: 'private network address' }]);
    expect(e.credits).toBe(1);
    expect(e.contentChars).toBe(800);
    expect(e.requestId).toBe('req-9');
    // The runtime binds the callId; a tool cannot produce evidence for another call.
    const requested = events.find((x) => x.type === 'tool.requested') as { callId: string };
    expect(e.callId).toBe(requested.callId);
  });

  it('records the policy decision before the ask, and nothing external happens on a denial', async () => {
    const { events } = await run({ approve: false });
    const decision = events.find((x) => x.type === 'policy.decision') as { rule: string; classification: string };
    expect(decision).toMatchObject({ rule: 'research.approval-required', classification: 'external' });
    expect(events.some((x) => x.type === 'research.searched')).toBe(false);
    const completed = events.find((x) => x.type === 'tool.completed') as { ok: boolean };
    expect(completed.ok).toBe(false);
  });

  it('a researcher child needs no approver: the call allows on lineage and still records', async () => {
    const { events, asks } = await run({ lineage: { parentSessionId: 'parent-1', role: 'researcher' } });
    expect(asks).toHaveLength(0); // never asked — there is no human on a child session
    const decision = events.find((x) => x.type === 'policy.decision') as { rule: string; decision: string };
    expect(decision).toMatchObject({ rule: 'research.delegated-role', decision: 'allow' });
    expect(events.some((x) => x.type === 'research.searched')).toBe(true);
  });

  it('an explorer child does NOT get that admission — it asks, and the auto-deny answer refuses', async () => {
    const { events } = await run({ lineage: { parentSessionId: 'parent-1', role: 'explorer' } });
    const decision = events.find((x) => x.type === 'policy.decision') as { rule: string };
    expect(decision.rule).toBe('research.approval-required');
    expect(events.some((x) => x.type === 'research.searched')).toBe(false);
  });

  it('bounds a hostile provider string at the emit site rather than trusting it', async () => {
    const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
    const long = 'q'.repeat(5_000);
    const tool: Tool<{ query: string }> = {
      name: 'web_search',
      description: 'stub',
      schema: z.object({ query: z.string() }).strict() as never,
      mutates: () => ({ paths: [] }),
      research: () => SEARCH,
      execute: (_i, ctx): Promise<ToolResult> => {
        ctx.reportResearch?.({
          kind: 'searched',
          provider: 'api.tavily.com',
          query: long,
          resultCount: 1,
          hosts: Array.from({ length: 50 }, (_v, n) => `h${String(n)}.example`),
          refused: Array.from({ length: 40 }, (_v, n) => ({ url: `https://r${String(n)}.example`, reason: 'x'.repeat(500) })),
          credits: 1,
          contentChars: 1,
          durationMs: 1,
        });
        return Promise.resolve({ ok: true, output: 'ok', durationMs: 0, truncated: false });
      },
    };
    const session = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'interactive',
      provider: new MockProvider([{ calls: [{ name: 'web_search', input: { query: 'x' } as never }] }, { say: 'done' }]),
      approver: () => Promise.resolve({ decision: 'allow' as const, scope: 'once' as const, source: 'user' as const }),
      tools: [tool],
      saltHex: 'ab'.repeat(16),
    });
    await runTurn(session, 'go');
    const e = session.log.events.find((x) => x.type === 'research.searched') as Extract<SessionEvent, { type: 'research.searched' }>;
    endSession(session, 'completed');
    expect(e.query.length).toBeLessThanOrEqual(1_001);
    expect(e.hosts.length).toBeLessThanOrEqual(20);
    expect(e.refused.length).toBeLessThanOrEqual(10);
    expect(e.refused[0]!.reason.length).toBeLessThanOrEqual(201);
  });
});
