/**
 * Deterministic artifact validators. Two severities, deliberately separate:
 *
 * - STRUCTURAL findings (`failures`) — the artifact does not contain what the spec says
 *   (missing heading, wrong table shape, dangling relationship). These set validation
 *   status 'fail' and are worth blocking on.
 * - LAYOUT findings (`notes`) — heuristics about how it might look. A heuristic must never
 *   become an acceptance-visible failure; the first false positive would turn a guess into a
 *   gate (design-critique finding, folded in).
 *
 * Everything here is pure over bytes + spec and model-free — this is exactly the verification
 * a non-vision session still gets in full.
 */

import type { DocSpec } from './model.js';
import { openZipBounded } from './zip.js';
import { attr, childElements, firstChild, parseXmlBounded, walkElements } from './xml.js';
import { readDocx } from './docx-read.js';
import { identifyDocument } from './inspect.js';

export interface ValidationReport {
  status: 'pass' | 'fail';
  /** Structural spec↔artifact mismatches; any entry ⇒ status 'fail'. */
  failures: string[];
  /** Layout/quality observations; informational, never blocking. */
  notes: string[];
}

const specRunsText = (runs: readonly { text: string }[]): string => runs.map((r) => r.text).join('').trim();

/** Parse the rendered DOCX back and check it CONTAINS what the spec claims. */
export function validateDocxAgainstSpec(bytes: Uint8Array, spec: DocSpec): ValidationReport {
  const failures: string[] = [];
  const notes: string[] = [];
  const done = (): ValidationReport => ({ status: failures.length > 0 ? 'fail' : 'pass', failures, notes });

  const id = identifyDocument(bytes);
  if (id.format !== 'docx' || id.zip === undefined) {
    failures.push('rendered bytes do not identify as a DOCX');
    return done();
  }
  const zip = id.zip;
  const summary = readDocx(zip);
  if (summary.coverage === 'structural') {
    failures.push(`rendered document.xml is unreadable: ${summary.coverageReasons.join('; ')}`);
    return done();
  }

  // Outline must EQUAL the spec's headings, in order.
  const wantOutline = spec.blocks
    .filter((b) => b.kind === 'heading')
    .map((b) => ({ level: b.level, text: specRunsText(b.runs).slice(0, 200) }));
  const gotOutline = summary.outline.map((o) => ({ level: o.level, text: o.text }));
  if (JSON.stringify(wantOutline) !== JSON.stringify(gotOutline)) {
    failures.push(
      `outline mismatch: spec has ${wantOutline.length} heading(s) [${wantOutline.map((h) => `H${h.level} ${h.text}`).join(' | ')}], ` +
        `artifact has ${gotOutline.length} [${gotOutline.map((h) => `H${h.level} ${h.text}`).join(' | ')}]`,
    );
  }

  // Table shapes.
  const wantTables = spec.blocks.filter((b) => b.kind === 'table');
  if (summary.tables.length !== wantTables.length) {
    failures.push(`table count mismatch: spec ${wantTables.length}, artifact ${summary.tables.length}`);
  } else {
    for (const [i, want] of wantTables.entries()) {
      const got = summary.tables[i]!;
      const wantCols = want.rows[0]!.length;
      if (got.rows !== want.rows.length || got.cols !== wantCols) {
        failures.push(`table ${i + 1} shape mismatch: spec ${want.rows.length}×${wantCols}, artifact ${got.rows}×${got.cols}`);
      }
    }
  }

  // Relationship integrity: every r:embed and r:id used in document.xml must resolve; every
  // referenced style and numId must exist. A dangling reference renders as a broken picture or
  // dead numbering in Word — structural, not cosmetic.
  const docXml = zip.text('word/document.xml')!;
  const relsXml = zip.text('word/_rels/document.xml.rels');
  const relIds = new Set<string>();
  if (relsXml !== null) {
    try {
      const relsDoc = parseXmlBounded(relsXml, 'document.xml.rels');
      const root = firstChild(relsDoc, 'Relationships');
      if (root !== null) {
        for (const rel of childElements(root, 'Relationship')) {
          const relId = attr(rel, 'Id');
          if (relId !== null) relIds.add(relId);
          const target = attr(rel, 'Target');
          if (target !== null && attr(rel, 'TargetMode') !== 'External' && !zip.has(`word/${target}`)) {
            failures.push(`relationship ${relId ?? '?'} targets missing part word/${target}`);
          }
        }
      }
    } catch {
      failures.push('word/_rels/document.xml.rels is unreadable');
    }
  } else {
    failures.push('word/_rels/document.xml.rels is missing');
  }

  const styleIds = new Set<string>();
  const stylesXml = zip.text('word/styles.xml');
  if (stylesXml !== null) {
    try {
      const stylesDoc = parseXmlBounded(stylesXml, 'styles.xml');
      for (const style of walkElements(stylesDoc, 'w:style')) {
        const sid = attr(style, 'w:styleId');
        if (sid !== null) styleIds.add(sid);
      }
    } catch {
      failures.push('word/styles.xml is unreadable');
    }
  } else {
    failures.push('word/styles.xml is missing');
  }

  const numIds = new Set<string>();
  const numberingXml = zip.text('word/numbering.xml');
  if (numberingXml !== null) {
    try {
      const numberingDoc = parseXmlBounded(numberingXml, 'numbering.xml');
      for (const num of walkElements(numberingDoc, 'w:num')) {
        const nid = attr(num, 'w:numId');
        if (nid !== null) numIds.add(nid);
      }
    } catch {
      failures.push('word/numbering.xml is unreadable');
    }
  }

  try {
    const docTree = parseXmlBounded(docXml, 'document.xml');
    let drawings = 0;
    for (const el of walkElements(docTree)) {
      if (el.name === 'a:blip') {
        drawings += 1;
        const embed = attr(el, 'r:embed');
        if (embed === null || !relIds.has(embed)) failures.push(`image ${drawings} has a dangling r:embed`);
      } else if (el.name === 'w:hyperlink') {
        const rid = attr(el, 'r:id');
        if (rid !== null && !relIds.has(rid)) failures.push('a hyperlink r:id does not resolve');
      } else if (el.name === 'w:pStyle' || el.name === 'w:rStyle') {
        const sid = attr(el, 'w:val');
        if (sid !== null && !styleIds.has(sid)) failures.push(`referenced style "${sid}" is not defined in styles.xml`);
      } else if (el.name === 'w:numId') {
        const nid = attr(el, 'w:val');
        if (nid !== null && !numIds.has(nid)) failures.push(`referenced numbering instance ${nid} is not defined`);
      }
    }
    const wantImages = spec.blocks.filter((b) => b.kind === 'image').length;
    if (drawings !== wantImages) failures.push(`image count mismatch: spec ${wantImages}, artifact ${drawings}`);
  } catch {
    failures.push('word/document.xml failed to re-parse during validation');
  }

  // Header/footer presence + the PAGE field when the spec asked for page numbers.
  if (spec.header !== undefined && summary.headerCount === 0) failures.push('spec declares a header; artifact has none');
  if (spec.footer !== undefined && summary.footerCount === 0) failures.push('spec declares a footer; artifact has none');
  const wantsPageNumbers = [spec.header, spec.footer].some(
    (hf) => hf !== undefined && Object.values(hf).some((v) => typeof v === 'string' && v.includes('{pageNumber}')),
  );
  if (wantsPageNumbers) {
    const hfParts = zip.names.filter((n) => /^word\/(header|footer)\d+\.xml$/.test(n));
    const hasPageField = hfParts.some((n) => (zip.text(n) ?? '').includes('PAGE'));
    if (!hasPageField) failures.push('spec uses {pageNumber} but no PAGE field exists in any header/footer part');
  }

  // Layout notes (never failures): emptiness signals a spec problem worth seeing early.
  if (summary.text.trim().length === 0 && wantTables.length === 0) notes.push('document body has no text content');

  return done();
}
