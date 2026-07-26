import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/report/report.js';
import type { SessionEvent } from '../src/types.js';

/** Session 13 report sections: managed previews and browser flows, derived purely from events. */

let seq = 0;
const ev = (body: Record<string, unknown>): SessionEvent => ({ v: 1, seq: ++seq, ts: 't', ...body }) as unknown as SessionEvent;
const base = (): SessionEvent[] => {
  seq = 0;
  return [ev({ type: 'session.started', sessionId: 's1', workspaceRoot: 'C:\\ws', model: 'm', mode: 'interactive', providerName: 'mock', argv: [] })];
};

describe('## Preview processes (managed)', () => {
  it('renders start → ready → ended with the log pointer', () => {
    const events = [
      ...base(),
      ev({ type: 'preview.started', callId: 'c1', previewId: 'pv-1', recipeId: 'preview.script.dev', command: 'npm run dev', cwd: 'C:\\ws', pid: 4242 }),
      ev({ type: 'preview.ready', previewId: 'pv-1', url: 'http://127.0.0.1:5173/', port: 5173, waitedMs: 900, probeDetail: 'HTTP 200 on port parsed from server output 5173' }),
      ev({ type: 'preview.ended', previewId: 'pv-1', reason: 'stopped', exitCode: null, logFile: 'C:\\state\\previews\\s1-pv-1.log' }),
      ev({ type: 'session.ended', reason: 'user-quit' }),
    ];
    const { json, md } = buildReport({ events });
    expect(json.previews).toHaveLength(1);
    expect(json.previews![0]).toMatchObject({ previewId: 'pv-1', ready: true, url: 'http://127.0.0.1:5173/', neverEnded: false, end: { reason: 'stopped' } });
    expect(md).toContain('## Preview processes (managed)');
    expect(md).toContain('pv-1 — `npm run dev` [preview.script.dev; pid 4242]');
    expect(md).toContain('ready at http://127.0.0.1:5173/');
    expect(md).toContain('ended: stopped');
    expect(md).toContain('log: C:\\state\\previews\\s1-pv-1.log');
  });

  it('a started-never-ended preview renders the crash-orphan wording', () => {
    const events = [
      ...base(),
      ev({ type: 'preview.started', callId: 'c1', previewId: 'pv-x', recipeId: 'preview.script.dev', command: 'npm run dev', cwd: 'C:\\ws', pid: 7 }),
    ];
    const { json, md } = buildReport({ events });
    expect(json.previews![0]!.neverEnded).toBe(true);
    expect(md).toContain('NEVER ENDED in this log');
    expect(md).toContain("identity-verified sweep");
  });
});

describe('## Browser verification', () => {
  it('renders flows with typed failures, artifact pointers, counts, and the honesty footer', () => {
    const events = [
      ...base(),
      ev({
        type: 'browser.flow',
        callId: 'c2',
        flowName: 'add-item',
        previewId: 'pv-1',
        status: 'fail',
        steps: [
          { n: 1, kind: 'goto', target: '/', ok: true },
          { n: 2, kind: 'expect', target: 'text #list ~ milk', ok: false, failure: { class: 'assertion', detail: 'did not hold within 5000ms; last observed: (empty)' } },
        ],
        artifacts: [
          { kind: 'screenshot', sha256: 'a'.repeat(64), bytes: 20480, label: 'failure-step2', mediaType: 'image/png' },
          { kind: 'trace', sha256: 'b'.repeat(64), bytes: 40960, label: 'add-item-trace', mediaType: 'application/zip' },
        ],
        consoleErrors: ['boom'],
        pageErrors: [],
        failedRequests: ['GET /api — net::ERR'],
        offOriginRequests: ['https://fonts.example/x.woff'],
        finalUrl: 'http://127.0.0.1:5173/',
        traceOmittedBytes: 999,
      }),
    ];
    const { json, md } = buildReport({ events });
    expect(json.browserFlows).toHaveLength(1);
    expect(json.browserFlows![0]).toMatchObject({ flowName: 'add-item', status: 'fail', stepsOk: 1, stepsTotal: 2 });
    expect(md).toContain('## Browser verification (flows against the managed preview)');
    expect(md).toContain("flow 'add-item' vs pv-1 → FAIL (1/2 steps)");
    expect(md).toContain('step 2 (expect text #list ~ milk) FAILED [assertion]');
    expect(md).toContain(`screenshot 'failure-step2': objects/${'a'.repeat(64)} (20 KiB)`);
    expect(md).toContain('1 console error(s); 1 failed request(s); 1 off-origin request(s) (recorded, not confined)');
    expect(md).toContain('trace NOT stored');
    expect(md).toContain('typed step outcomes above are the functional evidence');
  });

  it('sections are absent without the events (additive shape preserved)', () => {
    const { json, md } = buildReport({ events: base() });
    expect(json.previews).toBeUndefined();
    expect(json.browserFlows).toBeUndefined();
    expect(md).not.toContain('## Preview processes');
    expect(md).not.toContain('## Browser verification');
  });
});
