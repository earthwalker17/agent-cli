import { describe, it, expect } from 'vitest';
import { buildReport } from '../src/report/report.js';
import { computeAcceptance } from '../src/runtime/acceptance.js';
import type { EventBody, SessionEvent } from '../src/types.js';
import type { PlanState } from '../src/plan/canonical.js';

let seq = 0;
function evt(body: EventBody): SessionEvent {
  return { v: 1, seq: ++seq, ts: 't', ...body } as SessionEvent;
}
function reset(): void {
  seq = 0;
}

function base(): SessionEvent[] {
  return [
    evt({ type: 'session.started', sessionId: 's1', workspaceRoot: 'C:/ws', model: 'm', mode: 'interactive', providerName: 'mock', argv: [] }),
  ];
}

function rendered(over: Partial<Extract<EventBody, { type: 'artifact.rendered' }>> = {}): EventBody {
  return {
    type: 'artifact.rendered',
    callId: 'a1',
    format: 'docx',
    path: 'report.docx',
    sha256: 'c'.repeat(64),
    bytes: 5_000,
    specPath: 'report.docspec.json',
    specSha256: 'd'.repeat(64),
    validation: { status: 'pass', findings: [], summary: 'parse-back validation passed (0 note(s))' },
    durationMs: 40,
    ...over,
  } as Extract<EventBody, { type: 'artifact.rendered' }>;
}

const NO_PLAN: PlanState = {
  kind: 'none',
  status: 'none',
  currentSha: null,
  approvedSha: null,
  diverged: false,
  approvedAndCurrent: false,
  canonical: null,
  legacy: null,
};

describe('report: the Document artifacts section', () => {
  it('renders artifacts with validation verdicts and the products-not-verification footer', () => {
    reset();
    const events = [
      ...base(),
      evt(rendered()),
      evt(rendered({ callId: 'a1', format: 'pdf', path: 'report.pdf', pages: 3, validation: { status: 'fail', findings: ['heading "X" is not findable in the printed text'], summary: 'printed-text validation FAILED: 1 finding(s)' } })),
      evt({
        type: 'artifact.inspected',
        callId: 'a2',
        path: 'report.pdf',
        sha256: 'e'.repeat(64),
        source: 'pdf',
        pages: [{ page: 1, imageSha256: 'f'.repeat(64), bytes: 120_000, mediaType: 'image/png' }],
        warnings: ['page 4 does not exist (document has 3)'],
      }),
    ];
    const { md, json } = buildReport({ events });
    expect(md).toContain('## Document artifacts');
    expect(md).toContain('rendered docx `report.docx`');
    expect(md).toContain('validation PASS');
    expect(md).toContain('validation FAILED');
    expect(md).toContain('heading "X" is not findable');
    expect(md).toContain('inspected `report.pdf`');
    expect(md).toContain('warning: page 4 does not exist');
    expect(md).toContain('Artifacts are PRODUCTS, not verification');
    expect(json.artifacts).toHaveLength(3);
  });

  it('an artifact.rendered NEVER marks a mutated file CHECKED — only a real check does', () => {
    reset();
    const events = [
      ...base(),
      evt({ type: 'file.mutated', callId: 'm1', path: 'report.docx', kind: 'create', beforeSha256: null, afterSha256: 'b', createdDirs: [] }),
      // The render "succeeded" strictly after the mutation — the exact shape that would launder
      // it into CHECKED if artifacts fed the passing-evidence correlation.
      evt(rendered()),
    ];
    const { md } = buildReport({ events });
    expect(md).toContain('UNCHECKED');
    expect(md).not.toMatch(/report\.docx[^\n]*\bCHECKED/);
  });
});

describe('acceptance: failing artifact validation is a loud caveat, never a blocker', () => {
  it('caveats the LATEST failing render per path; a later passing render clears it', () => {
    reset();
    const failing = [
      ...base(),
      evt(rendered({ validation: { status: 'fail', findings: ['outline mismatch'], summary: 'FAILED' } })),
    ];
    const state = computeAcceptance(NO_PLAN, null, failing);
    expect(state.caveats.join('\n')).toContain("artifact 'report.docx'");
    expect(state.caveats.join('\n')).toContain('failed deterministic validation');
    expect(state.unfinished.join('\n')).not.toContain('report.docx');

    reset();
    const recovered = [
      ...base(),
      evt(rendered({ validation: { status: 'fail', findings: ['outline mismatch'], summary: 'FAILED' } })),
      evt(rendered({ callId: 'a2' })),
    ];
    expect(computeAcceptance(NO_PLAN, null, recovered).caveats.join('\n')).not.toContain("artifact 'report.docx'");
  });
});
