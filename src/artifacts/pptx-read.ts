/**
 * PPTX summary reader: slide order, titles, body text, speaker notes, media, metadata — all
 * bounded, structural-honest. Slide ORDER comes from the presentation's declared sldIdLst
 * resolved through its relationship map (slideN.xml numbering is a convention, not the order);
 * when either part is unreadable the reader falls back to numeric order WITH a warning.
 */

import { DEFAULT_READ_BOUNDS, type PptxSummary, type ReadBounds, type SlideSummary } from './types.js';
import type { OpenedZip } from './zip.js';
import { attr, childElements, directText, firstChild, parseXmlBounded, walkElements, type XmlElement } from './xml.js';
import { mediaInventory, readOoxmlMetadata, readRelationships } from './opc.js';

const SLIDE_TEXT_CAP = 4_000;
const NOTES_CAP = 2_000;

/** Declared slide order: presentation.xml sldIdLst r:id → rels target. */
function slideOrder(zip: OpenedZip, warnings: string[]): string[] {
  const fallback = (): string[] =>
    zip.names
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));

  const presXml = zip.text('ppt/presentation.xml');
  if (presXml === null) {
    warnings.push('ppt/presentation.xml missing; slide order assumed from file numbering');
    return fallback();
  }
  const rels = readRelationships(zip, 'ppt/_rels/presentation.xml.rels', 'ppt', warnings);
  if (rels.size === 0) {
    warnings.push('presentation relationships unreadable; slide order assumed from file numbering');
    return fallback();
  }
  try {
    const doc = parseXmlBounded(presXml, 'ppt/presentation.xml');
    const root = firstChild(doc, 'p:presentation');
    const list = root === null ? null : firstChild(root, 'p:sldIdLst');
    if (list === null) {
      warnings.push('presentation.xml has no sldIdLst; slide order assumed from file numbering');
      return fallback();
    }
    const ordered: string[] = [];
    for (const sldId of childElements(list, 'p:sldId')) {
      const rid = attr(sldId, 'r:id');
      const target = rid === null ? undefined : rels.get(rid);
      if (target !== undefined && zip.has(target)) ordered.push(target);
    }
    if (ordered.length === 0) {
      warnings.push('sldIdLst resolved no slides; slide order assumed from file numbering');
      return fallback();
    }
    return ordered;
  } catch {
    warnings.push('presentation.xml unreadable; slide order assumed from file numbering');
    return fallback();
  }
}

/** A shape's visible text: its a:t runs, paragraph breaks between a:p blocks. */
function shapeText(sp: XmlElement, cap: number): string {
  const parts: string[] = [];
  for (const para of walkElements(sp, 'a:p')) {
    let line = '';
    for (const t of walkElements(para, 'a:t')) line += directText(t);
    parts.push(line);
    if (parts.join('\n').length >= cap) break;
  }
  return parts.join('\n').slice(0, cap).trim();
}

function isTitleShape(sp: XmlElement): boolean {
  for (const ph of walkElements(sp, 'p:ph')) {
    const type = attr(ph, 'type');
    if (type === 'title' || type === 'ctrTitle') return true;
  }
  return false;
}

function readSlide(zip: OpenedZip, slidePath: string, index: number, warnings: string[]): SlideSummary {
  const out: SlideSummary = { index, text: '' };
  const xml = zip.text(slidePath);
  if (xml === null) return out;
  let doc;
  try {
    doc = parseXmlBounded(xml, slidePath);
  } catch {
    warnings.push(`${slidePath} unreadable; slide ${index} has no extracted text`);
    return out;
  }
  const bodyParts: string[] = [];
  const root = childElements(doc)[0];
  if (root !== undefined) {
    for (const sp of walkElements(root, 'p:sp')) {
      const text = shapeText(sp, SLIDE_TEXT_CAP);
      if (text.length === 0) continue;
      if (out.title === undefined && isTitleShape(sp)) out.title = text.slice(0, 200);
      else bodyParts.push(text);
    }
  }
  out.text = bodyParts.join('\n').slice(0, SLIDE_TEXT_CAP);

  // Speaker notes via the slide's own relationship part.
  const m = /^ppt\/slides\/(slide\d+\.xml)$/.exec(slidePath);
  if (m !== null) {
    const rels = readRelationships(zip, `ppt/slides/_rels/${m[1]}.rels`, 'ppt/slides', warnings);
    for (const target of rels.values()) {
      if (!/notesSlide\d+\.xml$/.test(target) || !zip.has(target)) continue;
      try {
        const notesDoc = parseXmlBounded(zip.text(target)!, target);
        const notesRoot = childElements(notesDoc)[0];
        if (notesRoot !== undefined) {
          let notes = '';
          for (const t of walkElements(notesRoot, 'a:t')) {
            notes += directText(t);
            if (notes.length >= NOTES_CAP) break;
          }
          // Notes placeholders carry the slide number too; only real content counts.
          const trimmed = notes.slice(0, NOTES_CAP).trim();
          if (trimmed.length > 0) out.notes = trimmed;
        }
      } catch {
        warnings.push(`${target} unreadable; notes for slide ${index} omitted`);
      }
      break;
    }
  }
  return out;
}

export function readPptx(zip: OpenedZip, bounds?: ReadBounds): PptxSummary {
  const b = { ...DEFAULT_READ_BOUNDS, ...bounds };
  const warnings: string[] = [];
  const coverageReasons: string[] = [];
  const metadata = readOoxmlMetadata(zip, warnings);
  const media = mediaInventory(zip, 'ppt/media/');
  const order = slideOrder(zip, warnings);

  const slides: SlideSummary[] = [];
  let collected = 0;
  for (const [i, slidePath] of order.entries()) {
    if (slides.length >= b.maxUnits || collected >= b.maxTextChars) {
      coverageReasons.push(`${order.length - slides.length} of ${order.length} slides counted but not extracted (bound)`);
      break;
    }
    const slide = readSlide(zip, slidePath, i + 1, warnings);
    collected += slide.text.length + (slide.notes?.length ?? 0);
    slides.push(slide);
  }

  return {
    kind: 'pptx',
    metadata,
    slideCount: order.length,
    slides,
    media,
    warnings,
    coverage: coverageReasons.length > 0 ? 'partial' : order.length === 0 ? 'structural' : 'full',
    coverageReasons: order.length === 0 ? ['no slides found in the package'] : coverageReasons,
  };
}
