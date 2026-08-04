import { describe, it, expect } from 'vitest';
import { sha256 } from '../src/shared/hash.js';
import { parseDocSpec, type DocSpec } from '../src/artifacts/model.js';
import { imageInfo } from '../src/artifacts/img-dim.js';
import { renderDocx } from '../src/artifacts/docx-render.js';
import { validateDocxAgainstSpec } from '../src/artifacts/validate.js';
import { readDocx } from '../src/artifacts/docx-read.js';
import { identifyDocument } from '../src/artifacts/inspect.js';
import { openZipBounded, zipDeterministic } from '../src/artifacts/zip.js';
import { pngFixture } from './artifacts.fixtures.js';

const run = (text: string, extra: Record<string, unknown> = {}) => ({ text, ...extra });

function richSpec(): DocSpec {
  const parsed = parseDocSpec(
    JSON.stringify({
      version: 1,
      meta: { title: 'Quarterly Report', author: 'A. Author', language: 'en' },
      page: { size: 'A4', orientation: 'portrait' },
      header: { left: '{title}', right: '{date}' },
      footer: { center: 'Page {pageNumber} of {totalPages}' },
      styles: { theme: 'default', accentColor: '#2E5395' },
      blocks: [
        { kind: 'heading', level: 1, runs: [run('Introduction')] },
        { kind: 'paragraph', runs: [run('Plain, '), run('bold', { bold: true }), run(' and a '), run('link', { link: 'https://example.com/x' })] },
        { kind: 'list', ordered: true, items: [{ runs: [run('first')] }, { runs: [run('second')], level: 1 }] },
        { kind: 'heading', level: 2, runs: [run('Numbers')] },
        {
          kind: 'table',
          columnsPct: [40, 30, 30],
          rows: [
            [[run('Metric')], [run('Q1')], [run('Q2')]],
            [[run('Revenue')], [run('10')], [run('20')]],
          ],
        },
        { kind: 'image', path: 'logo.png', widthMm: 50, caption: 'The logo' },
        { kind: 'code', text: 'let x = 1;\n  x += 1;' },
        { kind: 'quote', runs: [run('A wise quote.')] },
        { kind: 'pageBreak' },
        { kind: 'heading', level: 1, runs: [run('Appendix')] },
      ],
    }),
  );
  if (!parsed.ok) throw new Error(`fixture spec invalid: ${parsed.errors.join('; ')}`);
  return parsed.spec;
}

const IMAGES = new Map([['logo.png', pngFixture(200, 100)]]);

describe('parseDocSpec', () => {
  it('returns the COMPLETE error list with paths, nothing partial', () => {
    const res = parseDocSpec(
      JSON.stringify({
        version: 1,
        meta: {},
        blocks: [
          { kind: 'heading', level: 9, runs: [run('x')] },
          { kind: 'paragraph', runs: [run('ok', { color: 'red' })] },
        ],
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.length).toBeGreaterThanOrEqual(3);
    expect(res.errors.join('\n')).toContain('meta.title');
    expect(res.errors.join('\n')).toContain('blocks.0.level');
    expect(res.errors.join('\n')).toContain('#RRGGBB');
  });

  it('rejects ragged tables, columnsPct mismatches, absolute/URL image paths', () => {
    const bad = parseDocSpec(
      JSON.stringify({
        version: 1,
        meta: { title: 't' },
        blocks: [
          { kind: 'table', rows: [[[run('a')]], [[run('b')], [run('c')]]] },
          { kind: 'table', columnsPct: [50, 50], rows: [[[run('a')]]] },
          { kind: 'image', path: 'C:/x.png' },
          { kind: 'image', path: 'https://evil/x.png' },
        ],
      }),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const all = bad.errors.join('\n');
    expect(all).toContain('same number of cells');
    expect(all).toContain('columnsPct');
    expect(all.match(/spec-file-relative/g)?.length).toBe(2);
  });

  it('is not JSON → one honest error', () => {
    const res = parseDocSpec('{ not json');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toContain('not valid JSON');
  });
});

describe('imageInfo', () => {
  it('parses PNG dimensions', () => {
    expect(imageInfo(pngFixture(640, 480))).toMatchObject({ format: 'png', width: 640, height: 480 });
  });

  it('parses JPEG SOF dimensions across marker walks', () => {
    // FFD8, APP0 (16 bytes), SOF0 with h=120 w=240, then EOI-ish garbage.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x78, 0x00, 0xf0, 0x01, 0x01, 0x11, 0x00,
    ]);
    expect(imageInfo(jpeg)).toMatchObject({ format: 'jpeg', width: 240, height: 120 });
  });

  it('returns null for hostile or unknown bytes, never throwing', () => {
    expect(imageInfo(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(imageInfo(new TextEncoder().encode('GIF89a not supported'))).toBeNull();
    expect(imageInfo(pngFixture(0, 10))).toBeNull();
  });
});

describe('renderDocx', () => {
  it('is byte-deterministic: same spec + same images ⇒ same sha256', () => {
    const a = sha256(Buffer.from(renderDocx(richSpec(), IMAGES)));
    const b = sha256(Buffer.from(renderDocx(richSpec(), IMAGES)));
    expect(a).toBe(b);
  });

  it('emits no rsids and no live timestamps', () => {
    const bytes = renderDocx(richSpec(), IMAGES);
    const zip = openZipBounded(bytes);
    expect(zip.text('word/document.xml')).not.toContain('rsid');
    expect(zip.text('docProps/core.xml')).toContain('2001-01-01T00:00:00Z');
    expect(zip.text('docProps/core.xml')).not.toContain(String(new Date().getFullYear()));
  });

  it('round-trips through the pack’s own reader: outline, table, media, headers', () => {
    const id = identifyDocument(renderDocx(richSpec(), IMAGES));
    if (id.format !== 'docx' || id.zip === undefined) throw new Error('render did not identify as docx');
    const s = readDocx(id.zip);
    expect(s.outline).toEqual([
      { level: 1, text: 'Introduction' },
      { level: 2, text: 'Numbers' },
      { level: 1, text: 'Appendix' },
    ]);
    expect(s.tables[0]).toMatchObject({ rows: 2, cols: 3, headerCells: ['Metric', 'Q1', 'Q2'] });
    expect(s.media).toHaveLength(1);
    expect(s.headerCount).toBe(1);
    expect(s.footerCount).toBe(1);
    expect(s.text).toContain('Plain, bold and a link');
    expect(s.metadata).toMatchObject({ title: 'Quarterly Report', author: 'A. Author', application: 'Agent CLI' });
  });

  it('renders {pageNumber}/{totalPages}/{date} as real field codes', () => {
    const zip = openZipBounded(renderDocx(richSpec(), IMAGES));
    const footer = zip.text('word/footer1.xml')!;
    expect(footer).toContain('PAGE');
    expect(footer).toContain('NUMPAGES');
    expect(footer).toContain('fldChar');
    const header = zip.text('word/header1.xml')!;
    expect(header).toContain('DATE');
    expect(header).toContain('Quarterly Report');
  });

  it('escapes hostile spec text instead of letting it become markup', () => {
    const parsed = parseDocSpec(
      JSON.stringify({
        version: 1,
        meta: { title: 'safe' },
        blocks: [{ kind: 'paragraph', runs: [run('</w:t></w:r><w:evil w:val="x"/>')] }],
      }),
    );
    if (!parsed.ok) throw new Error('spec invalid');
    const zip = openZipBounded(renderDocx(parsed.spec, new Map()));
    const doc = zip.text('word/document.xml')!;
    expect(doc).not.toContain('<w:evil');
    const id = identifyDocument(renderDocx(parsed.spec, new Map()));
    if (id.format !== 'docx' || id.zip === undefined) throw new Error('bad render');
    expect(readDocx(id.zip).text).toContain('</w:t></w:r><w:evil w:val="x"/>');
  });
});

describe('validateDocxAgainstSpec', () => {
  it('passes a faithful render', () => {
    const report = validateDocxAgainstSpec(renderDocx(richSpec(), IMAGES), richSpec());
    expect(report.failures).toEqual([]);
    expect(report.status).toBe('pass');
  });

  it('catches a dropped heading, a wrong table shape, and a dangling style', () => {
    const spec = richSpec();
    const bytes = renderDocx(spec, IMAGES);
    const zip = openZipBounded(bytes);
    const entries: Record<string, Uint8Array | string> = {};
    for (const name of zip.names) entries[name] = zip.bytes(name)!;

    const doc = zip.text('word/document.xml')!;
    entries['word/document.xml'] = doc
      .replace('<w:pStyle w:val="Heading2"/>', '<w:pStyle w:val="HeadingGhost"/>') // drops H2 AND dangles a style
      .replace('<w:tr><w:tc><w:tcPr><w:tcW w:w="2000" w:type="pct"/></w:tcPr><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc>', '<w:tr>');
    const tampered = zipDeterministic(entries);

    const report = validateDocxAgainstSpec(tampered, spec);
    expect(report.status).toBe('fail');
    const all = report.failures.join('\n');
    expect(all).toContain('outline mismatch');
    expect(all).toContain('HeadingGhost');
  });

  it('fails when {pageNumber} is asked for but no PAGE field exists', () => {
    const spec = richSpec();
    const bytes = renderDocx(spec, IMAGES);
    const zip = openZipBounded(bytes);
    const entries: Record<string, Uint8Array | string> = {};
    for (const name of zip.names) entries[name] = zip.bytes(name)!;
    entries['word/footer1.xml'] = zip.text('word/footer1.xml')!.replaceAll('PAGE', 'XXXX');
    const report = validateDocxAgainstSpec(zipDeterministic(entries), spec);
    expect(report.failures.join('\n')).toContain('{pageNumber}');
  });

  it('refuses non-docx bytes structurally', () => {
    const report = validateDocxAgainstSpec(new TextEncoder().encode('nope'), richSpec());
    expect(report.status).toBe('fail');
    expect(report.failures[0]).toContain('do not identify as a DOCX');
  });
});
