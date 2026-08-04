import { describe, it, expect } from 'vitest';
import {
  attr,
  childElements,
  directText,
  firstChild,
  parseXmlBounded,
  walkElements,
  xmlEscapeAttr,
  xmlEscapeText,
} from '../src/artifacts/xml.js';
import { ArtifactError } from '../src/artifacts/errors.js';

const WML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:tbl xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr>
  <w:tr><w:tc><w:p><w:r><w:t xml:space="preserve">A1 </w:t></w:r><w:r><w:t>bold</w:t></w:r></w:p></w:tc></w:tr>
  <w:tr><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>`;

describe('parseXmlBounded + helpers', () => {
  it('parses WordprocessingML preserving element order and attributes', () => {
    const doc = parseXmlBounded(WML, 'test part');
    const tbl = firstChild(doc, 'w:tbl');
    expect(tbl).not.toBeNull();
    const kids = childElements(tbl!).map((e) => e.name);
    expect(kids).toEqual(['w:tblPr', 'w:tr', 'w:tr']);
    const tblW = firstChild(firstChild(tbl!, 'w:tblPr')!, 'w:tblW')!;
    expect(attr(tblW, 'w:w')).toBe('5000');
    expect(attr(tblW, 'w:type')).toBe('pct');
    expect(attr(tblW, 'missing')).toBeNull();
  });

  it('walkElements yields document-order descendants; run order and preserved space survive', () => {
    const doc = parseXmlBounded(WML, 'test part');
    const texts = [...walkElements(doc, 'w:t')].map((t) => directText(t));
    expect(texts).toEqual(['A1 ', 'bold', 'B1']);
  });

  it('decodes predefined and numeric entities', () => {
    const doc = parseXmlBounded('<a>&amp;&lt;&gt;&#x41;&#66;</a>', 'entities');
    expect(directText(firstChild(doc, 'a')!)).toBe('&<>AB');
  });

  it('refuses oversize input with xml-bounds', () => {
    try {
      parseXmlBounded('<a></a>', 'big part', 5);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactError);
      expect((err as ArtifactError).reason).toBe('xml-bounds');
    }
  });

  it('types malformed XML as xml-parse with position but WITHOUT a raw excerpt', () => {
    try {
      parseXmlBounded('<a><secret>hunter2</wrong>', 'evil part');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactError);
      expect((err as ArtifactError).reason).toBe('xml-parse');
      expect((err as Error).message).toMatch(/line \d+, column \d+/);
      expect((err as Error).message).not.toContain('hunter2');
    }
  });
});

describe('escaping', () => {
  it('xmlEscapeText escapes markup and round-trips through the parser', () => {
    const hostile = `a & b <w:evil w:val="x"/> ]]> 'quotes' "dquotes"`;
    const escaped = xmlEscapeText(hostile);
    expect(escaped).not.toContain('<w:evil');
    const doc = parseXmlBounded(`<t>${escaped}</t>`, 'roundtrip');
    expect(directText(firstChild(doc, 't')!)).toBe(hostile);
  });

  it('xmlEscapeAttr escapes quotes and preserves tabs/newlines through attribute normalization', () => {
    const hostile = 'a"b\'c<d>&e\tf\ng';
    const doc = parseXmlBounded(`<t v="${xmlEscapeAttr(hostile)}"/>`, 'attr roundtrip');
    expect(attr(firstChild(doc, 't')!, 'v')).toBe(hostile);
  });

  it('drops code points XML 1.0 cannot carry (raw control chars, lone surrogates)', () => {
    const bel = String.fromCharCode(7);
    const loneSurrogate = String.fromCharCode(0xd800);
    expect(xmlEscapeText(`a${bel}b${loneSurrogate}c`)).toBe('abc');
    expect(xmlEscapeAttr(`a${bel}b`)).toBe('ab');
    // Tab, LF, CR are legal and kept by the TEXT escaper verbatim.
    expect(xmlEscapeText('a\tb\nc')).toBe('a\tb\nc');
  });

  it('escaped hostile content parses as exactly one text node (no element smuggling)', () => {
    const doc = parseXmlBounded(`<t>${xmlEscapeText('<x/><y></y>')}</t>`, 'smuggle');
    expect(childElements(firstChild(doc, 't')!)).toEqual([]);
  });
});
