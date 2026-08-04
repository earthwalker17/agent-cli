import { describe, it, expect } from 'vitest';
import { identifyDocument } from '../src/artifacts/inspect.js';
import { zipDeterministic } from '../src/artifacts/zip.js';
import { readDocx } from '../src/artifacts/docx-read.js';
import { readPptx } from '../src/artifacts/pptx-read.js';
import { readPdf } from '../src/artifacts/pdf-read.js';
import { readXlsx } from '../src/artifacts/xlsx-read.js';
import { fixtureDocx, fixtureOleHeader, fixturePdf, fixturePptx, fixtureXlsx } from './artifacts.fixtures.js';

describe('identifyDocument', () => {
  it('identifies the four formats from bytes, never the extension', () => {
    expect(identifyDocument(fixtureDocx()).format).toBe('docx');
    expect(identifyDocument(fixturePptx()).format).toBe('pptx');
    expect(identifyDocument(fixtureXlsx()).format).toBe('xlsx');
    expect(identifyDocument(fixturePdf()).format).toBe('pdf');
  });

  it('refuses an OLE container as legacy-or-encrypted, by magic', () => {
    const id = identifyDocument(fixtureOleHeader());
    expect(id.format).toBe('unsupported');
    expect((id as { reason: string }).reason).toMatch(/legacy binary Office|password-protected/);
  });

  it('refuses unrecognized bytes WITHOUT echoing any content', () => {
    const id = identifyDocument(new TextEncoder().encode('API_KEY=TOPSECRET-VALUE-12345\n'));
    expect(id.format).toBe('unsupported');
    const reason = (id as { reason: string }).reason;
    expect(reason).not.toContain('TOPSECRET');
    expect(reason).toContain('not a recognized document format');
  });

  it('refuses a zip that is not an OOXML document, with the structural reason', () => {
    const plain = zipDeterministic({ 'readme.txt': 'hi' });
    expect((identifyDocument(plain) as { reason: string }).reason).toContain('[Content_Types].xml');
    const wrongMain = zipDeterministic({
      '[Content_Types].xml':
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Override PartName="/x.xml" ContentType="application/other"/></Types>',
    });
    expect((identifyDocument(wrongMain) as { reason: string }).reason).toContain('main part is not');
  });
});

describe('readDocx', () => {
  const zip = () => {
    const id = identifyDocument(fixtureDocx());
    if (id.format !== 'docx' || id.zip === undefined) throw new Error('fixture broke');
    return id.zip;
  };

  it('extracts outline, text flow (tabs/breaks/hyperlink runs), tables, counts, and metadata', () => {
    const s = readDocx(zip());
    expect(s.coverage).toBe('full');
    expect(s.outline).toEqual([
      { level: 1, text: 'Intro' },
      { level: 2, text: 'Details' },
      { level: 1, text: 'Conclusion' },
    ]);
    expect(s.paragraphCount).toBe(6);
    expect(s.text).toContain('tab\tafter\nline2');
    expect(s.text).toContain('linked text');
    expect(s.tables).toHaveLength(1);
    expect(s.tables[0]).toMatchObject({ rows: 2, cols: 2, headerCells: ['Name', 'Value'], sampleRows: [['alpha', '1']] });
    expect(s.headerCount).toBe(1);
    expect(s.footerCount).toBe(1);
    expect(s.media).toHaveLength(1);
    expect(s.metadata).toMatchObject({ title: 'Fixture Title', author: 'Fixture Author', application: 'Agent CLI Fixtures' });
  });

  it('degrades to partial with reasons at the text bound', () => {
    const s = readDocx(zip(), { maxTextChars: 10 });
    expect(s.coverage).toBe('partial');
    expect(s.coverageReasons.join(' ')).toContain('truncated');
  });

  it('degrades to structural when document.xml is malformed — metadata still read', () => {
    const noDoc = identifyDocument(fixtureDocx({ 'word/document.xml': '<w:document' }));
    if (noDoc.format !== 'docx' || noDoc.zip === undefined) throw new Error('fixture broke');
    const s = readDocx(noDoc.zip);
    expect(s.coverage).toBe('structural');
    expect(s.metadata.title).toBe('Fixture Title');
    expect(s.coverageReasons.join(' ')).toContain('could not be parsed');
  });
});

describe('readPptx', () => {
  it('orders slides by sldIdLst (not file numbering), extracts titles, body, and notes', () => {
    const id = identifyDocument(fixturePptx());
    if (id.format !== 'pptx' || id.zip === undefined) throw new Error('fixture broke');
    const s = readPptx(id.zip);
    expect(s.coverage).toBe('full');
    expect(s.slideCount).toBe(2);
    // Declared order puts slide2.xml (Opening) first.
    expect(s.slides.map((x) => x.title)).toEqual(['Opening', 'Closing']);
    expect(s.slides[0]!.text).toContain('Welcome to the fixture');
    expect(s.slides[0]!.notes).toBe('Remember the demo login');
    expect(s.slides[1]!.notes).toBeUndefined();
    expect(s.metadata.title).toBe('Fixture Title');
  });

  it('falls back to file numbering WITH a warning when the rels are unreadable', () => {
    const id = identifyDocument(fixturePptx({ 'ppt/_rels/presentation.xml.rels': '<broken' }));
    if (id.format !== 'pptx' || id.zip === undefined) throw new Error('fixture broke');
    const s = readPptx(id.zip);
    expect(s.slides.map((x) => x.title)).toEqual(['Closing', 'Opening']);
    expect(s.warnings.join(' ')).toContain('file numbering');
  });
});

describe('readXlsx', () => {
  it('is structural on purpose: sheet names and metadata only', () => {
    const id = identifyDocument(fixtureXlsx());
    if (id.format !== 'xlsx' || id.zip === undefined) throw new Error('fixture broke');
    const s = readXlsx(id.zip);
    expect(s.coverage).toBe('structural');
    expect(s.sheetNames).toEqual(['Data', 'Summary']);
    expect(s.coverageReasons.join(' ')).toContain('outside the documents pack scope');
  });
});

describe('readPdf', () => {
  it('extracts page count, text, and metadata from a real (synthetic) PDF', async () => {
    const s = await readPdf(fixturePdf('Hello PDF'));
    expect(s.coverage).toBe('full');
    expect(s.pageCount).toBe(1);
    expect(s.pages[0]!.text).toContain('Hello PDF');
  });

  it('degrades structurally when the body is unreadable, never throwing', async () => {
    const s = await readPdf(new TextEncoder().encode('%PDF-1.4\nthis is not really a pdf'));
    expect(s.coverage).toBe('structural');
    expect(s.pageCount).toBe(0);
    expect(s.coverageReasons.join(' ')).toContain('could not be opened');
  });
});
