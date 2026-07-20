import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryDir, parseFrontmatter, readDocCapped, serializeFrontmatter, writeDocAtomic } from '../src/memory/store.js';
import { sha256 } from '../src/shared/hash.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-store-'));
}

describe('memory store', () => {
  it('memoryDir lives under the project dir', () => {
    expect(memoryDir('C:\\state\\projects\\p')).toBe(path.join('C:\\state\\projects\\p', 'memory'));
  });

  it('readDocCapped: missing file → status missing, never throws', () => {
    const doc = readDocCapped(path.join(tmp(), 'JOURNAL.md'), 'JOURNAL.md', 1000);
    expect(doc.status).toBe('missing');
    expect(doc.text).toBe('');
    expect(doc.sha256).toBeNull();
    expect(doc.truncated).toBe(false);
  });

  it('readDocCapped: unreadable target (a directory) → status unreadable, never throws', () => {
    const dir = tmp();
    const doc = readDocCapped(dir, 'AGENT.md', 1000);
    expect(doc.status).toBe('unreadable');
    expect(doc.text).toBe('');
  });

  it('readDocCapped: over-cap file → oversize, truncated text, sha of the RAW bytes', () => {
    const file = path.join(tmp(), 'AGENT.md');
    const raw = 'x'.repeat(500);
    fs.writeFileSync(file, raw);
    const doc = readDocCapped(file, 'AGENT.md', 100);
    expect(doc.status).toBe('oversize');
    expect(doc.truncated).toBe(true);
    expect(doc.text).toBe('x'.repeat(100));
    expect(doc.bytes).toBe(500);
    expect(doc.sha256).toBe(sha256(Buffer.from(raw)));
  });

  it('readDocCapped: in-cap file → ok, full text', () => {
    const file = path.join(tmp(), 'CODEBASE.md');
    fs.writeFileSync(file, 'hello\n');
    const doc = readDocCapped(file, 'CODEBASE.md', 1000);
    expect(doc.status).toBe('ok');
    expect(doc.text).toBe('hello\n');
    expect(doc.truncated).toBe(false);
  });

  it('writeDocAtomic creates parents, writes, overwrites, and leaves no temp files', async () => {
    const dir = tmp();
    const file = path.join(dir, 'memory', 'JOURNAL.md');
    const first = await writeDocAtomic(file, 'v1');
    expect(fs.readFileSync(file, 'utf8')).toBe('v1');
    expect(first.sha256).toBe(sha256(Buffer.from('v1')));

    await writeDocAtomic(file, 'v2 — replaced');
    expect(fs.readFileSync(file, 'utf8')).toBe('v2 — replaced');

    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('frontmatter round-trips and tolerates absent/unterminated blocks', () => {
    const fm = serializeFrontmatter({ doc: 'journal', updated: '2026-07-20T00:00:00Z' });
    const { fields, body } = parseFrontmatter(`${fm}body text\n`);
    expect(fields).toEqual({ doc: 'journal', updated: '2026-07-20T00:00:00Z' });
    expect(body).toBe('body text\n');

    expect(parseFrontmatter('no frontmatter\n').fields).toBeNull();
    expect(parseFrontmatter('---\nunterminated: yes\n').fields).toBeNull();
    expect(parseFrontmatter('---\nunterminated: yes\n').body).toBe('---\nunterminated: yes\n');
  });
});
