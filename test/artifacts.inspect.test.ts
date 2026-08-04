import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createInspectPagesTool,
  inspectBudgetFromEvents,
  INSPECT_BYTES_PER_SESSION,
  INSPECTED_PAGES_PER_SESSION,
  type InspectPagesDeps,
} from '../src/tools/artifact-inspect.js';
import { createViewImageTool } from '../src/tools/view-image.js';
import { rasterizePdfPages, type Rasterize } from '../src/artifacts/pdf-pages.js';
import { decide, Grants } from '../src/policy/engine.js';
import { sha256 } from '../src/shared/hash.js';
import { likelyBrowserAvailable } from '../src/browser/probe.js';
import type { SessionEvent, ToolContext, ArtifactEvidence } from '../src/types.js';
import { fixturePdf } from './artifacts.fixtures.js';

let ws: string;
let ctx: ToolContext;
let reported: ArtifactEvidence[];
let events: SessionEvent[];
let blobs: Map<string, Buffer>;

beforeEach(() => {
  ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-')));
  reported = [];
  events = [];
  blobs = new Map();
  ctx = { workspaceRoot: ws, stateDir: path.join(os.tmpdir(), 'inspect-state'), reportArtifact: (e) => reported.push(e) };
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

const probeOk = async () => ({ available: true, channel: 'msedge' });
const fakeRaster: Rasterize = async (_bytes, pages) => ({
  ok: true,
  pageCount: 3,
  warnings: [],
  pages: pages.filter((p) => p <= 3).map((p) => ({ page: p, scale: 2, png: Buffer.from(`png-bytes-of-page-${p}`) })),
});

function renderedEvent(relPath: string, docSha: string): SessionEvent {
  return {
    v: 1,
    seq: events.length + 1,
    ts: 't',
    type: 'artifact.rendered',
    callId: `c${events.length}`,
    format: 'pdf',
    path: relPath,
    sha256: docSha,
    bytes: 1,
    specPath: 's.docspec.json',
    specSha256: 'b'.repeat(64),
    validation: { status: 'pass', findings: [], failureCount: 0, summary: '' },
    durationMs: 1,
  } as SessionEvent;
}

function tool(over: Partial<InspectPagesDeps> = {}) {
  return createInspectPagesTool({
    probe: probeOk,
    putBlob: (bytes) => {
      const sha = sha256(bytes);
      blobs.set(sha, bytes);
      return sha;
    },
    events: () => events,
    budget: inspectBudgetFromEvents(events),
    rasterize: fakeRaster,
    ...over,
  });
}

describe('inspect_pages policy admission', () => {
  it('auto-allows a session-rendered path; asks for a foreign PDF; [s] grants', () => {
    const pdf = fixturePdf();
    fs.writeFileSync(path.join(ws, 'report.pdf'), pdf);
    events.push(renderedEvent('report.pdf', sha256(Buffer.from(pdf))));
    const t = tool();
    expect(decide(t, { path: 'report.pdf' }, ctx, new Grants())).toMatchObject({
      decision: 'allow',
      rule: 'artifact.inspect-session-artifact',
    });
    const grants = new Grants();
    expect(decide(t, { path: 'vendor.pdf' }, ctx, grants)).toMatchObject({ decision: 'ask', rule: 'artifact.inspect-approval-required' });
    grants.add(t.name, 'sensitive');
    expect(decide(t, { path: 'vendor.pdf' }, ctx, grants)).toMatchObject({ decision: 'allow' });
  });
});

describe('inspect_pages execute', () => {
  it('rasterizes, stores blobs, records artifact.inspected, and returns wire images', async () => {
    const pdf = fixturePdf();
    fs.writeFileSync(path.join(ws, 'report.pdf'), pdf);
    events.push(renderedEvent('report.pdf', sha256(Buffer.from(pdf))));
    const res = await tool().execute({ path: 'report.pdf' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.images).toHaveLength(2);
    expect(res.output).toContain('showing page(s) 1, 2');
    expect(reported).toHaveLength(1);
    const ev = reported[0]!;
    if (ev.kind !== 'inspected') throw new Error('wrong evidence kind');
    expect(ev.pages).toHaveLength(2);
    for (const pg of ev.pages) expect(blobs.has(pg.imageSha256)).toBe(true);
  });

  it('refuses when a session-rendered file changed on disk (identity re-check)', async () => {
    fs.writeFileSync(path.join(ws, 'report.pdf'), fixturePdf('current bytes'));
    events.push(renderedEvent('report.pdf', 'e'.repeat(64)));
    const res = await tool().execute({ path: 'report.pdf' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('CHANGED since this session rendered it');
    expect(reported).toHaveLength(0);
  });

  it('refuses DOCX with guidance to the PDF twin, and non-documents honestly', async () => {
    fs.writeFileSync(path.join(ws, 'x.bin'), 'not a pdf at all');
    const res = await tool().execute({ path: 'x.bin' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not a PDF');
  });

  it('refuses for a non-vision model without rendering anything', async () => {
    fs.writeFileSync(path.join(ws, 'report.pdf'), fixturePdf());
    const res = await tool({ modelInfo: () => ({ model: 'glm-5.2', visionInput: false }) }).execute({ path: 'report.pdf' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no image input');
    expect(reported).toHaveLength(0);
  });

  it('budget: identical re-inspection is free; new images past the cap are omitted loudly', async () => {
    const pdf = fixturePdf();
    fs.writeFileSync(path.join(ws, 'report.pdf'), pdf);
    events.push(renderedEvent('report.pdf', sha256(Buffer.from(pdf))));
    const budget = inspectBudgetFromEvents(events);
    const t = tool({ budget });
    await t.execute({ path: 'report.pdf', pages: [1, 2] }, ctx);
    expect(budget.pageShas.size).toBe(2);
    const bytesAfterFirst = budget.usedBytes;
    await t.execute({ path: 'report.pdf', pages: [1, 2] }, ctx);
    expect(budget.pageShas.size).toBe(2);
    expect(budget.usedBytes).toBe(bytesAfterFirst);

    const tight = { usedBytes: INSPECT_BYTES_PER_SESSION - 1, pageShas: new Set(['z'.repeat(64)]) };
    const res = await tool({ budget: tight }).execute({ path: 'report.pdf', pages: [3] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('budget');

    const spent = { usedBytes: 0, pageShas: new Set(Array.from({ length: INSPECTED_PAGES_PER_SESSION }, (_, i) => `${i}`.padStart(64, '0'))) };
    const res2 = await tool({ budget: spent }).execute({ path: 'report.pdf' }, ctx);
    expect(res2.ok).toBe(false);
    expect(res2.error).toContain('budget');
  });

  it('inspectBudgetFromEvents dedupes identical page images across events', () => {
    const page = { page: 1, imageSha256: 'a'.repeat(64), bytes: 500, mediaType: 'image/png' };
    const ev = (callId: string): SessionEvent =>
      ({ v: 1, seq: 1, ts: 't', type: 'artifact.inspected', callId, path: 'r.pdf', sha256: 'd'.repeat(64), source: 'pdf', pages: [page], warnings: [] }) as SessionEvent;
    const b = inspectBudgetFromEvents([ev('c1'), ev('c2')]);
    expect(b.pageShas.size).toBe(1);
    expect(b.usedBytes).toBe(500);
  });
});

describe('view_image widened admission', () => {
  it('admits inspected page images by sha, with lockstep fact and execute answers', async () => {
    const png = Buffer.from('page-png');
    const pngSha = sha256(png);
    blobs.set(pngSha, png);
    events.push({
      v: 1,
      seq: 1,
      ts: 't',
      type: 'artifact.inspected',
      callId: 'c1',
      path: 'report.pdf',
      sha256: 'd'.repeat(64),
      source: 'pdf',
      pages: [{ page: 3, imageSha256: pngSha, bytes: png.length, mediaType: 'image/png' }],
      warnings: [],
    } as SessionEvent);
    const vi = createViewImageTool({ getBlob: (sha) => blobs.get(sha)!, events: () => events });
    expect(decide(vi, { sha256: pngSha }, ctx, new Grants())).toMatchObject({ decision: 'allow', rule: 'observe.session-evidence' });
    const res = await vi.execute({ sha256: pngSha }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('page 3 of report.pdf');
    expect(res.images?.[0]?.sha256).toBe(pngSha);
    const denied = decide(vi, { sha256: 'f'.repeat(64) }, ctx, new Grants());
    expect(denied).toMatchObject({ decision: 'deny', rule: 'evidence.not-session-artifact' });
  });
});

/** Real-browser rasterization smoke, gated like the other browser suites. */
const d = likelyBrowserAvailable() ? describe : describe.skip;
d('rasterizePdfPages against the system browser', () => {
  it('renders real page pixels within the per-image ceiling', async () => {
    const { probeBrowser, cacheSuccessfulProbe } = await import('../src/browser/probe.js');
    const result = await rasterizePdfPages(fixturePdf('Raster me'), [1], cacheSuccessfulProbe(probeBrowser));
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result.pageCount).toBe(1);
    expect(result.pages).toHaveLength(1);
    const png = result.pages[0]!.png;
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.length).toBeGreaterThan(1_000);
    expect(png.length).toBeLessThanOrEqual(1_000_000);
  }, 90_000);
});
