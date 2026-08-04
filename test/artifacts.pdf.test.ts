import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderHtml } from '../src/artifacts/html-render.js';
import { renderPdf } from '../src/artifacts/pdf-render.js';
import { validatePdfAgainstSpec } from '../src/artifacts/validate.js';
import { parseDocSpec, type DocSpec } from '../src/artifacts/model.js';
import { createRenderDocumentTool, renderCapsFromEvents, RENDERS_PER_SESSION } from '../src/tools/artifact-render.js';
import { decide, Grants } from '../src/policy/engine.js';
import { likelyBrowserAvailable } from '../src/browser/probe.js';
import type { ArtifactEvidence, SessionEvent, ToolContext } from '../src/types.js';
import { pngFixture } from './artifacts.fixtures.js';

const run = (text: string, extra: Record<string, unknown> = {}) => ({ text, ...extra });

function spec(blocks: unknown[], extra: Record<string, unknown> = {}): DocSpec {
  const parsed = parseDocSpec(JSON.stringify({ version: 1, meta: { title: 'Pdf Fixture' }, ...extra, blocks }));
  if (!parsed.ok) throw new Error(`fixture spec invalid: ${parsed.errors.join('; ')}`);
  return parsed.spec;
}

describe('renderHtml self-containment', () => {
  it('emits no script/link/external-src — images are data: URIs; hostile text is escaped', () => {
    const s = spec(
      [
        { kind: 'heading', level: 1, runs: [run('<script>alert(1)</script>')] },
        { kind: 'paragraph', runs: [run('x', { link: 'https://example.com/a' })] },
        { kind: 'image', path: 'logo.png' },
      ],
      { header: { left: '{title}"</style><script>' } },
    );
    const out = renderHtml(s, new Map([['logo.png', pngFixture(10, 10)]]));
    expect(out.html).not.toContain('<script');
    expect(out.html).not.toContain('<link');
    expect(out.html).not.toMatch(/src="(?!data:)/);
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.headerTemplate).toBeDefined();
    expect(out.headerTemplate).not.toContain('<style');
    expect(out.headerTemplate).not.toContain('<script');
  });

  it('maps tokens to Chromium template classes with an explicit font size', () => {
    const s = spec([{ kind: 'paragraph', runs: [run('x')] }], { footer: { center: 'Page {pageNumber} of {totalPages}' } });
    const out = renderHtml(s, new Map());
    expect(out.footerTemplate).toContain('class="pageNumber"');
    expect(out.footerTemplate).toContain('class="totalPages"');
    expect(out.footerTemplate).toMatch(/font-size:\s*[1-9]/);
    expect(out.headerTemplate).toBeUndefined();
  });

  it('nests flat list levels into real list markup', () => {
    const s = spec([
      { kind: 'list', ordered: false, items: [{ runs: [run('a')] }, { runs: [run('b')], level: 1 }, { runs: [run('c')] }] },
    ]);
    const html = renderHtml(s, new Map()).html;
    expect(html).toMatch(/<ul><li>a<\/li><ul><li>b<\/li><\/ul><li>c<\/li><\/ul>/);
  });
});

describe('render_document policy + execute (no browser needed)', () => {
  let ws: string;
  let ctx: ToolContext;
  let events: SessionEvent[];
  let reported: ArtifactEvidence[];
  const probeUnavailable = async () => ({ available: false, reason: 'test: none' });

  beforeEach(() => {
    ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'render-doc-')));
    reported = [];
    events = [];
    ctx = {
      workspaceRoot: ws,
      stateDir: path.join(os.tmpdir(), 'render-doc-state'),
      reportArtifact: (e) => reported.push(e),
    };
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  function writeSpec(name: string, content: unknown): void {
    fs.writeFileSync(path.join(ws, name), JSON.stringify(content));
  }

  const tool = () => createRenderDocumentTool({ probe: probeUnavailable, caps: renderCapsFromEvents(events) });

  it('classifies as artifact.render (reversible, snapshot) with relative fact outputs resolved by the engine', () => {
    const d = decide(tool(), { spec_path: 'report.docspec.json' }, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'allow', rule: 'artifact.render', requiresSnapshot: true });
    expect(d.reason).toContain('HEADLESS');
    const docxOnly = decide(tool(), { spec_path: 'report.docspec.json', formats: ['docx'] }, ctx, new Grants());
    expect(docxOnly.reason).not.toContain('HEADLESS');
  });

  it('renders a DOCX, records artifact.rendered with a pass validation, and states the PDF skip honestly', async () => {
    writeSpec('report.docspec.json', {
      version: 1,
      meta: { title: 'T' },
      blocks: [{ kind: 'heading', level: 1, runs: [run('Hello')] }],
    });
    const res = await tool().execute({ spec_path: 'report.docspec.json' }, ctx);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(ws, 'report.docx'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'report.pdf'))).toBe(false);
    expect(res.output).toContain('validation: PASS');
    expect(res.output).toContain('PDF: SKIPPED');
    expect(res.output).toContain('no system browser');
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ kind: 'rendered', format: 'docx', path: 'report.docx', validation: { status: 'pass' } });
  });

  it('returns the COMPLETE spec error list and writes nothing', async () => {
    writeSpec('bad.docspec.json', { version: 1, meta: {}, blocks: [{ kind: 'heading', level: 7, runs: [run('x')] }] });
    const res = await tool().execute({ spec_path: 'bad.docspec.json' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('meta.title');
    expect(res.error).toContain('blocks.0.level');
    expect(fs.readdirSync(ws)).toEqual(['bad.docspec.json']);
    expect(reported).toHaveLength(0);
  });

  it('refuses out-of-workspace, secret-named, missing, and undecodable image references — complete list, nothing written', async () => {
    fs.writeFileSync(path.join(ws, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(ws, 'junk.png'), 'not a png');
    writeSpec('imgs.docspec.json', {
      version: 1,
      meta: { title: 'T' },
      blocks: [
        { kind: 'image', path: '../outside.png' },
        { kind: 'image', path: '.env' },
        { kind: 'image', path: 'missing.png' },
        { kind: 'image', path: 'junk.png' },
      ],
    });
    const res = await tool().execute({ spec_path: 'imgs.docspec.json' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('outside the workspace');
    expect(res.error).toContain('secret-named');
    expect(res.error).toContain('not found');
    expect(res.error).toContain('not a readable PNG or JPEG');
    expect(fs.existsSync(path.join(ws, 'imgs.docx'))).toBe(false);
    expect(reported).toHaveLength(0);
  });

  it('enforces the session render budget, rebuilt from events by distinct callId', async () => {
    const mk = (callId: string): SessionEvent =>
      ({
        v: 1,
        seq: 1,
        ts: 't',
        type: 'artifact.rendered',
        callId,
        format: 'docx',
        path: 'x.docx',
        sha256: 'a'.repeat(64),
        bytes: 1,
        specPath: 's',
        specSha256: 'b'.repeat(64),
        validation: { status: 'pass', findings: [], failureCount: 0, summary: '' },
        durationMs: 1,
      }) as SessionEvent;
    // Two formats under ONE callId = one render.
    events = [mk('c1'), mk('c1'), mk('c2')];
    expect(renderCapsFromEvents(events).renders).toBe(2);
    events = Array.from({ length: RENDERS_PER_SESSION }, (_, i) => mk(`c${i}`));
    writeSpec('r.docspec.json', { version: 1, meta: { title: 'T' }, blocks: [{ kind: 'paragraph', runs: [run('x')] }] });
    const res = await tool().execute({ spec_path: 'r.docspec.json', formats: ['docx'] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('render budget');
  });

  it('rejects hostile out_basename at the schema', () => {
    const parsed = createRenderDocumentTool({ probe: probeUnavailable, caps: { renders: 0 } }).schema.safeParse({
      spec_path: 's.docspec.json',
      out_basename: '..\\evil',
    });
    expect(parsed.success).toBe(false);
    for (const bad of ['a/b', 'CON', 'x.', ' x']) {
      expect(
        createRenderDocumentTool({ probe: probeUnavailable, caps: { renders: 0 } }).schema.safeParse({ spec_path: 's', out_basename: bad }).success,
        bad,
      ).toBe(false);
    }
  });
});

/** REAL browser print + parse-back — gated like the other browser suites (skip without one). */
const hasBrowser = likelyBrowserAvailable();
const d = hasBrowser ? describe : describe.skip;

d('renderPdf against the system browser', () => {
  it('prints, paginates, and validates: headings findable, footer text printed, page count real', async () => {
    const s = spec(
      [
        { kind: 'heading', level: 1, runs: [run('Alpha Section')] },
        { kind: 'paragraph', runs: [run('First page body.')] },
        { kind: 'pageBreak' },
        { kind: 'heading', level: 1, runs: [run('Beta Section')] },
        {
          kind: 'table',
          rows: [
            [[run('H1')], [run('H2')]],
            [[run('a')], [run('b')]],
          ],
        },
      ],
      { footer: { center: 'Page {pageNumber} of {totalPages}' } },
    );
    const { probeBrowser, cacheSuccessfulProbe } = await import('../src/browser/probe.js');
    const printed = await renderPdf(s, renderHtml(s, new Map()), cacheSuccessfulProbe(probeBrowser));
    expect(printed.ok).toBe(true);
    if (!printed.ok) return;
    expect(printed.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const { report, extras } = await validatePdfAgainstSpec(new Uint8Array(printed.bytes), s);
    expect(extras.pageCount).toBe(2);
    expect(report.failures).toEqual([]);
    expect(report.status).toBe('pass');
  }, 90_000);

  it('validation FAILS loudly when the footer never prints (seeded: no templates passed)', async () => {
    const s = spec([{ kind: 'paragraph', runs: [run('body')] }], { footer: { center: 'Footer-Sentinel {pageNumber}' } });
    const rendered = renderHtml(s, new Map());
    // Seed the defect: drop the footer template the spec asked for.
    const { probeBrowser, cacheSuccessfulProbe } = await import('../src/browser/probe.js');
    const printed = await renderPdf(s, { html: rendered.html }, cacheSuccessfulProbe(probeBrowser));
    expect(printed.ok).toBe(true);
    if (!printed.ok) return;
    const { report } = await validatePdfAgainstSpec(new Uint8Array(printed.bytes), s);
    expect(report.status).toBe('fail');
    expect(report.failures.join(' ')).toContain('Footer-Sentinel');
  }, 90_000);
});
