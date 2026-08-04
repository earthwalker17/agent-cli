/**
 * Bounded XML access for OOXML parts, over @rgrove/parse-xml (strict, zero-dep, order-faithful
 * — order is what tables and runs mean), plus the escaping helpers generation uses.
 *
 * Parsing is for UNTRUSTED workspace bytes: size-capped, typed errors, and the parser is a
 * non-executing DOM reader (no entities beyond the XML 1.0 predefined five, no DTD fetch).
 * Callers must keep `XmlError.excerpt` (raw document bytes) out of harness-attributed lines;
 * the wrapper's own messages carry only line/column numbers.
 *
 * Generation never builds a DOM: renderers write template strings and MUST route every
 * interpolated value through `xmlEscapeText` / `xmlEscapeAttr`, which also drop code points
 * XML 1.0 cannot carry at all (Word refuses a document containing a raw 0x08 — escaping it as
 * an entity would not help).
 */

import { parseXml, XmlDocument, XmlElement, XmlError, XmlText } from '@rgrove/parse-xml';
import { ArtifactError } from './errors.js';

export { XmlDocument, XmlElement, XmlText };

/** Large enough for real-world document.xml parts; a bound, not a target. */
export const MAX_XML_CHARS = 32 * 1024 * 1024;

export function parseXmlBounded(xml: string, what: string, maxChars = MAX_XML_CHARS): XmlDocument {
  if (xml.length > maxChars) {
    throw new ArtifactError(`${what}: XML exceeds ${maxChars} chars (${xml.length})`, 'xml-bounds');
  }
  try {
    return parseXml(xml);
  } catch (err) {
    if (err instanceof XmlError) {
      // Deliberately no `excerpt`: the message may travel further than the file's bytes should.
      throw new ArtifactError(`${what}: not well-formed XML (line ${err.line}, column ${err.column})`, 'xml-parse');
    }
    throw new ArtifactError(`${what}: XML parse failed: ${err instanceof Error ? err.message : String(err)}`, 'xml-parse');
  }
}

/** Direct child elements, optionally filtered by (prefixed) name. */
export function childElements(parent: XmlDocument | XmlElement, name?: string): XmlElement[] {
  const kids = parent instanceof XmlDocument ? parent.children : parent.children;
  const out: XmlElement[] = [];
  for (const node of kids) {
    if (node instanceof XmlElement && (name === undefined || node.name === name)) out.push(node);
  }
  return out;
}

export function firstChild(parent: XmlDocument | XmlElement, name: string): XmlElement | null {
  for (const node of parent.children) {
    if (node instanceof XmlElement && node.name === name) return node;
  }
  return null;
}

/** Depth-first descendant elements, optionally filtered by name. Document order. */
export function* walkElements(root: XmlDocument | XmlElement, name?: string): Generator<XmlElement> {
  for (const node of root.children) {
    if (node instanceof XmlElement) {
      if (name === undefined || node.name === name) yield node;
      yield* walkElements(node, name);
    }
  }
}

export function attr(el: XmlElement, name: string): string | null {
  return Object.hasOwn(el.attributes, name) ? el.attributes[name]! : null;
}

/** Concatenated text of DIRECT text children only (a w:t's own content, not descendants'). */
export function directText(el: XmlElement): string {
  let out = '';
  for (const node of el.children) {
    if (node instanceof XmlText) out += node.text;
  }
  return out;
}

/**
 * True for code points XML 1.0 can carry: #x9 #xA #xD, #x20–#xD7FF, #xE000–#xFFFD,
 * #x10000–#x10FFFF. Everything else (and lone surrogates) is silently dropped by the escapers.
 */
function isXmlChar(cp: number): boolean {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function stripInvalid(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (isXmlChar(cp)) out += ch;
  }
  return out;
}

/** Escape for element text content. */
export function xmlEscapeText(s: string): string {
  return stripInvalid(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape for a double-quoted attribute value. Tab/newline become character references —
 * attribute-value normalization would otherwise fold them to spaces on re-parse.
 */
export function xmlEscapeAttr(s: string): string {
  return stripInvalid(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}
