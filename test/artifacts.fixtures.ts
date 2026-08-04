/**
 * Synthetic document fixtures for the artifacts suites — built in memory so no binary blobs
 * live in the repo. The PDF builder computes real xref offsets, so the output is a genuinely
 * valid single-page PDF (pdf.js parses it), not a magic-bytes shell.
 */

import { zipDeterministic } from '../src/artifacts/zip.js';

const CT_DOCX =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="png" ContentType="image/png"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  '</Types>';

const CORE_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
  '<dc:title>Fixture Title</dc:title><dc:creator>Fixture Author</dc:creator>' +
  '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T03:04:05Z</dcterms:created>' +
  '</cp:coreProperties>';

const APP_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
  '<Application>Agent CLI Fixtures</Application></Properties>';

function p(style: string | null, ...runs: string[]): string {
  const pr = style === null ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  return `<w:p>${pr}${runs.join('')}</w:p>`;
}
const r = (t: string): string => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;

/** A small but realistic DOCX: headings, body, tabs/breaks, a hyperlink run, one 2×2 table. */
export function fixtureDocx(overrides: Record<string, Uint8Array | string> = {}): Uint8Array {
  const body =
    p('Heading1', r('Intro')) +
    p(null, r('First paragraph.')) +
    p('Heading2', r('Details')) +
    `<w:p><w:r><w:t>tab</w:t></w:r><w:r><w:tab/><w:t>after</w:t></w:r><w:r><w:br/><w:t>line2</w:t></w:r></w:p>` +
    `<w:p><w:hyperlink r:id="rId9"><w:r><w:t>linked text</w:t></w:r></w:hyperlink></w:p>` +
    '<w:tbl><w:tblPr/><w:tblGrid/>' +
    '<w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>alpha</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc></w:tr>' +
    '</w:tbl>' +
    p('Heading1', r('Conclusion'));
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body}<w:sectPr/></w:body></w:document>`;
  return zipDeterministic({
    '[Content_Types].xml': CT_DOCX,
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'word/document.xml': document,
    'word/header1.xml': '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    'word/footer1.xml': '<?xml version="1.0"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    'word/media/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'docProps/core.xml': CORE_XML,
    'docProps/app.xml': APP_XML,
    ...overrides,
  });
}

const CT_PPTX =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '</Types>';

function slide(title: string | null, body: string): string {
  const titleSp =
    title === null
      ? ''
      : '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
        `<p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const bodySp = `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    `<p:cSld><p:spTree>${titleSp}${bodySp}</p:spTree></p:cSld></p:sld>`
  );
}

/**
 * A two-slide PPTX whose DECLARED order (sldIdLst) is slide2.xml FIRST — readers that assume
 * file numbering get the order wrong, which is exactly what the order test pins. Slide2 also
 * carries speaker notes through its own rels.
 */
export function fixturePptx(overrides: Record<string, Uint8Array | string> = {}): Uint8Array {
  return zipDeterministic({
    '[Content_Types].xml': CT_PPTX,
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '</Relationships>',
    'ppt/presentation.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<p:sldIdLst><p:sldId id="256" r:id="rIdB"/><p:sldId id="257" r:id="rIdA"/></p:sldIdLst>' +
      '</p:presentation>',
    'ppt/_rels/presentation.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
      '<Relationship Id="rIdB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>' +
      '</Relationships>',
    'ppt/slides/slide1.xml': slide('Closing', 'Thanks everyone'),
    'ppt/slides/slide2.xml': slide('Opening', 'Welcome to the fixture'),
    'ppt/slides/_rels/slide2.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>' +
      '</Relationships>',
    'ppt/notesSlides/notesSlide1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Remember the demo login</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
    'docProps/core.xml': CORE_XML,
    ...overrides,
  });
}

const CT_XLSX =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '</Types>';

export function fixtureXlsx(): Uint8Array {
  return zipDeterministic({
    '[Content_Types].xml': CT_XLSX,
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheets><sheet name="Data" sheetId="1"/><sheet name="Summary" sheetId="2"/></sheets></workbook>',
    'docProps/core.xml': CORE_XML,
  });
}

/** A genuinely valid one-page PDF with real xref offsets; pdf.js extracts `text`. */
export function fixturePdf(text = 'Hello PDF'): Uint8Array {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '', // placeholder: content stream, built below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 24 Tf 72 720 Td (${text.replace(/[\\()]/g, '')}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n`;
  out += '0000000000 65535 f \n';
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** The OLE compound-container magic (legacy .doc/.ppt/.xls and encrypted OOXML). */
export function fixtureOleHeader(): Uint8Array {
  const bytes = new Uint8Array(1024);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  return bytes;
}
