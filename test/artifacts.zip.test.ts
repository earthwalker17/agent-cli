import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { openZipBounded, zipDeterministic, ZIP_FIXED_MTIME } from '../src/artifacts/zip.js';
import { ArtifactError } from '../src/artifacts/errors.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(0x1b);
const CONTROL_CLASS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + ']');

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ArtifactError) return err.reason;
    throw err;
  }
  throw new Error('expected an ArtifactError');
}

describe('openZipBounded', () => {
  it('round-trips entries with utf-8 names and content', () => {
    const bytes = zipDeterministic({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<w:document>ü中文</w:document>',
      'word/media/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
    const z = openZipBounded(bytes);
    expect([...z.names].sort()).toEqual(['[Content_Types].xml', 'word/document.xml', 'word/media/image1.png']);
    expect(z.text('word/document.xml')).toBe('<w:document>ü中文</w:document>');
    expect(Array.from(z.bytes('word/media/image1.png')!)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(z.has('missing')).toBe(false);
    expect(z.bytes('missing')).toBeNull();
    expect(z.text('missing')).toBeNull();
  });

  it('skips directory placeholder entries rather than refusing them', () => {
    const bytes = zipSync({ 'word/': new Uint8Array(0), 'word/document.xml': enc('<a/>') });
    const z = openZipBounded(bytes);
    expect(z.names).toEqual(['word/document.xml']);
  });

  it('refuses hostile entry names, each with the zip-entry-name reason', () => {
    const hostile = ['../evil.xml', 'a/../../evil', '/abs.xml', 'C:evil', 'a\\b.xml', 'ctl' + BEL + '.xml'];
    for (const name of hostile) {
      const bytes = zipSync({ [name]: enc('x') });
      expect(reason(() => openZipBounded(bytes)), name).toBe('zip-entry-name');
    }
  });

  it('does not echo non-printable name bytes in the refusal message', () => {
    const bytes = zipSync({ ['bad' + ESC + '[31m.xml']: enc('x') });
    try {
      openZipBounded(bytes);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toMatch(CONTROL_CLASS);
      expect((err as Error).message).toContain('bad?[31m.xml');
    }
  });

  it('refuses past the entry-count bound', () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5; i++) entries[`f${i}.xml`] = enc('x');
    const bytes = zipSync(entries);
    expect(reason(() => openZipBounded(bytes, { maxEntries: 4 }))).toBe('zip-bounds');
    expect(openZipBounded(bytes, { maxEntries: 5 }).names.length).toBe(5);
  });

  it('refuses a declared per-entry size past the bound', () => {
    const bytes = zipSync({ 'big.bin': new Uint8Array(2048) });
    expect(reason(() => openZipBounded(bytes, { maxEntryBytes: 1024 }))).toBe('zip-bounds');
  });

  it('refuses a declared total past the bound', () => {
    const bytes = zipSync({ 'a.bin': new Uint8Array(700), 'b.bin': new Uint8Array(700) });
    expect(reason(() => openZipBounded(bytes, { maxEntryBytes: 1024, maxTotalBytes: 1024 }))).toBe('zip-bounds');
  });

  it('types unreadable bytes as zip-corrupt', () => {
    expect(reason(() => openZipBounded(enc('this is not a zip')))).toBe('zip-corrupt');
    // A plausible prefix (PK magic) with garbage after it must also refuse, not crash.
    expect(reason(() => openZipBounded(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])))).toBe('zip-corrupt');
  });
});

describe('zipDeterministic', () => {
  it('produces identical bytes for identical entries across calls', () => {
    const entries = { 'b.xml': '<b/>', 'a.xml': '<a/>', 'c/d.bin': new Uint8Array([1, 2, 3]) };
    const one = zipDeterministic(entries);
    const two = zipDeterministic({ ...entries });
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(true);
  });

  it('is insensitive to input key order (entries are sorted)', () => {
    const one = zipDeterministic({ 'a.xml': '<a/>', 'b.xml': '<b/>' });
    const two = zipDeterministic({ 'b.xml': '<b/>', 'a.xml': '<a/>' });
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(true);
  });

  it('stamps the fixed mtime into the local file header (no live clock reaches the bytes)', () => {
    const bytes = zipDeterministic({ 'a.xml': '<a/>' });
    // Local file header layout: sig(4) ver(2) flags(2) method(2) modTime(2) modDate(2) → offset 10.
    const dosTime = bytes[10]! | (bytes[11]! << 8);
    const dosDate = bytes[12]! | (bytes[13]! << 8);
    const m = ZIP_FIXED_MTIME;
    const expectedTime = (m.getHours() << 11) | (m.getMinutes() << 5) | (m.getSeconds() >> 1);
    const expectedDate = (((m.getFullYear() - 1980) & 0x7f) << 9) | ((m.getMonth() + 1) << 5) | m.getDate();
    expect(dosTime).toBe(expectedTime);
    expect(dosDate).toBe(expectedDate);
  });

  it('validates names on the write side too', () => {
    expect(reason(() => zipDeterministic({ '../up.xml': 'x' }))).toBe('zip-entry-name');
    expect(reason(() => zipDeterministic({ 'a\\b.xml': 'x' }))).toBe('zip-entry-name');
  });
});
