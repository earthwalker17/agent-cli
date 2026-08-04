/**
 * DOCX summary reader: outline, flowed text, table shapes, header/footer presence, media, and
 * metadata, all bounded, with a coverage verdict. This reads ARBITRARY workspace files —
 * untrusted bytes — so nothing here throws for content reasons: a missing or malformed part
 * degrades coverage and says why.
 */

import { DEFAULT_READ_BOUNDS, type DocxSummary, type OutlineEntry, type ReadBounds, type TableSummary } from './types.js';
import type { OpenedZip } from './zip.js';
import { attr, childElements, directText, firstChild, parseXmlBounded, walkElements, type XmlElement } from './xml.js';
import { mediaInventory, readOoxmlMetadata } from './opc.js';

const CELL_CAP = 80;
const HEADING_STYLE = /^heading([1-9])$/i;

/** Text of one paragraph: runs' w:t plus explicit tabs/breaks, in document order. */
function paragraphText(p: XmlElement, cap: number): string {
  let out = '';
  for (const el of walkElements(p)) {
    if (el.name === 'w:t') out += directText(el);
    else if (el.name === 'w:tab') out += '\t';
    else if (el.name === 'w:br' || el.name === 'w:cr') out += '\n';
    if (out.length >= cap) return out.slice(0, cap);
  }
  return out;
}

function paragraphStyle(p: XmlElement): string | null {
  const pPr = firstChild(p, 'w:pPr');
  if (pPr === null) return null;
  const pStyle = firstChild(pPr, 'w:pStyle');
  return pStyle === null ? null : attr(pStyle, 'w:val');
}

function summarizeTable(tbl: XmlElement): TableSummary {
  const rows = childElements(tbl, 'w:tr');
  const cellText = (tc: XmlElement): string => {
    let out = '';
    for (const el of walkElements(tc)) {
      if (el.name === 'w:t') out += directText(el);
      if (out.length >= CELL_CAP) return `${out.slice(0, CELL_CAP)}…`;
    }
    return out;
  };
  const firstRowCells = rows.length > 0 ? childElements(rows[0]!, 'w:tc') : [];
  const sampleRows: string[][] = [];
  for (const row of rows.slice(1, 3)) {
    sampleRows.push(childElements(row, 'w:tc').map(cellText));
  }
  return {
    rows: rows.length,
    cols: firstRowCells.length,
    headerCells: firstRowCells.map(cellText),
    sampleRows,
  };
}

export function readDocx(zip: OpenedZip, bounds?: ReadBounds): DocxSummary {
  const b = { ...DEFAULT_READ_BOUNDS, ...bounds };
  const warnings: string[] = [];
  const coverageReasons: string[] = [];
  const metadata = readOoxmlMetadata(zip, warnings);
  const media = mediaInventory(zip, 'word/media/');
  const headerCount = zip.names.filter((n) => /^word\/header\d+\.xml$/.test(n)).length;
  const footerCount = zip.names.filter((n) => /^word\/footer\d+\.xml$/.test(n)).length;

  const base: Omit<DocxSummary, 'coverage' | 'coverageReasons'> = {
    kind: 'docx',
    metadata,
    outline: [],
    paragraphCount: 0,
    text: '',
    tables: [],
    headerCount,
    footerCount,
    media,
    warnings,
  };

  const docXml = zip.text('word/document.xml');
  if (docXml === null) {
    return { ...base, coverage: 'structural', coverageReasons: ['word/document.xml is missing; only package structure was read'] };
  }
  let doc;
  try {
    doc = parseXmlBounded(docXml, 'word/document.xml');
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
    return { ...base, coverage: 'structural', coverageReasons: ['word/document.xml could not be parsed; only package structure was read'] };
  }
  const body = ((): XmlElement | null => {
    const root = firstChild(doc, 'w:document');
    return root === null ? null : firstChild(root, 'w:body');
  })();
  if (body === null) {
    return { ...base, coverage: 'structural', coverageReasons: ['word/document.xml has no w:body; only package structure was read'] };
  }

  const outline: OutlineEntry[] = [];
  const tables: TableSummary[] = [];
  const textParts: string[] = [];
  let paragraphCount = 0;
  let collected = 0;
  let tableCount = 0;
  let textCapped = false;

  for (const el of childElements(body)) {
    if (el.name === 'w:p') {
      paragraphCount += 1;
      const style = paragraphStyle(el);
      const remaining = b.maxTextChars - collected;
      const text = paragraphText(el, Math.max(remaining, 120));
      const heading = style === null ? null : HEADING_STYLE.exec(style);
      if (heading !== null && text.trim().length > 0) {
        outline.push({ level: Number(heading[1]), text: text.trim().slice(0, 200) });
      }
      if (remaining > 0 && text.length > 0) {
        textParts.push(text.slice(0, remaining));
        collected += Math.min(text.length, remaining);
      } else if (text.length > 0) {
        textCapped = true;
      }
    } else if (el.name === 'w:tbl') {
      tableCount += 1;
      if (tables.length < b.maxTables) tables.push(summarizeTable(el));
    }
  }
  if (tableCount > tables.length) {
    coverageReasons.push(`${tableCount - tables.length} of ${tableCount} tables counted but not summarized (bound)`);
  }
  if (textCapped) {
    coverageReasons.push(`body text truncated at ${b.maxTextChars} chars`);
  }
  return {
    ...base,
    outline,
    paragraphCount,
    text: textParts.join('\n'),
    tables,
    coverage: coverageReasons.length > 0 ? 'partial' : 'full',
    coverageReasons,
  };
}
