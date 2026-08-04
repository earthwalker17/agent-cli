/**
 * Format identification for document artifacts — MAGIC BYTES plus the OOXML content-types part,
 * never the file extension (a renamed `.env` must fail the sniff, and its refusal must not echo
 * a byte of the file: these messages travel into tool output and evidence).
 */

import { openZipBounded, type OpenedZip } from './zip.js';
import { ArtifactError } from './errors.js';
import { firstChild, parseXmlBounded, walkElements } from './xml.js';

export type DocumentFormat = 'docx' | 'pptx' | 'xlsx' | 'pdf';

export type Identified =
  | { format: DocumentFormat; zip?: OpenedZip }
  | { format: 'unsupported'; reason: string };

const OOXML_MAIN_TYPES: readonly { format: DocumentFormat; contentType: string }[] = [
  { format: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' },
  { format: 'pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' },
  { format: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' },
];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

/**
 * Identify a document from its bytes. Returns an OpenedZip alongside OOXML formats so callers
 * do not unzip twice (the bounded unzip is the expensive step).
 */
export function identifyDocument(bytes: Uint8Array): Identified {
  // %PDF-
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { format: 'pdf' };

  // OLE compound container: legacy binary Office (.doc/.ppt/.xls) AND encrypted OOXML both live
  // here; telling them apart needs an OLE reader this pack deliberately does not carry.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return {
      format: 'unsupported',
      reason:
        'OLE compound container — a legacy binary Office file (.doc/.ppt/.xls) or a password-protected Office document; neither is supported',
    };
  }

  // PK zip → OOXML candidate.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    let zip: OpenedZip;
    try {
      zip = openZipBounded(bytes);
    } catch (err) {
      if (err instanceof ArtifactError) {
        return { format: 'unsupported', reason: `zip container refused: ${err.message}` };
      }
      throw err;
    }
    const ct = zip.text('[Content_Types].xml');
    if (ct === null) {
      return { format: 'unsupported', reason: 'a zip archive without [Content_Types].xml — not an OOXML document' };
    }
    let doc;
    try {
      doc = parseXmlBounded(ct, '[Content_Types].xml');
    } catch {
      return { format: 'unsupported', reason: '[Content_Types].xml is not well-formed XML' };
    }
    const types = firstChild(doc, 'Types');
    if (types === null) return { format: 'unsupported', reason: '[Content_Types].xml has no Types root' };
    const declared = new Set<string>();
    for (const el of walkElements(types)) {
      if (el.name === 'Override') {
        const t = el.attributes['ContentType'];
        if (t !== undefined) declared.add(t);
      }
    }
    for (const { format, contentType } of OOXML_MAIN_TYPES) {
      if (declared.has(contentType)) return { format, zip };
    }
    return { format: 'unsupported', reason: 'an OOXML/OPC package whose main part is not a Word, PowerPoint, or Excel document' };
  }

  // Deliberately no byte echo: the sniff refusal for a renamed secret must not leak content.
  return {
    format: 'unsupported',
    reason: 'not a recognized document format (no OOXML zip, OLE container, or PDF header found)',
  };
}
