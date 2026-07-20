import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { sha256 } from '../shared/hash.js';

/**
 * On-disk substrate for the harness-managed project memory documents. Reads NEVER throw (memory
 * is context — a broken doc must not block a session), writes are atomic (same-dir temp +
 * rename) so a crash can never leave a torn document, and every result carries the identity
 * facts (sha256/bytes) the memory.* evidence events record.
 */

export type MemoryDocName = 'AGENT.md' | 'JOURNAL.md' | 'CODEBASE.md';

export interface MemoryDoc {
  name: MemoryDocName;
  /** Absolute path the doc was read from (or would live at). */
  file: string;
  /** 'oversize' means loaded but truncated to the cap (text present, truncated: true). */
  status: 'ok' | 'missing' | 'oversize' | 'unreadable';
  /** Capped content; '' when missing/unreadable. Presentation adds truncation markers. */
  text: string;
  /** sha256 of the RAW file bytes (identity evidence), null when missing/unreadable. */
  sha256: string | null;
  /** Raw size on disk in bytes (0 when missing/unreadable). */
  bytes: number;
  truncated: boolean;
}

export function memoryDir(projectDir: string): string {
  return path.join(projectDir, 'memory');
}

/** Read a memory doc, capped at capChars of decoded text. Never throws. */
export function readDocCapped(file: string, name: MemoryDocName, capChars: number): MemoryDoc {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return { name, file, status: missing ? 'missing' : 'unreadable', text: '', sha256: null, bytes: 0, truncated: false };
  }
  let text: string;
  try {
    text = raw.toString('utf8');
  } catch {
    return { name, file, status: 'unreadable', text: '', sha256: sha256(raw), bytes: raw.length, truncated: false };
  }
  const oversize = text.length > capChars;
  return {
    name,
    file,
    status: oversize ? 'oversize' : 'ok',
    text: oversize ? text.slice(0, capChars) : text,
    sha256: sha256(raw),
    bytes: raw.length,
    truncated: oversize,
  };
}

/**
 * Atomically replace `file` with `text`: write a random-suffixed temp in the SAME directory, then
 * rename over the target (one retry after 50ms for the Windows EPERM/EACCES class — AV scanners
 * and editors briefly hold destinations open). Throws on final failure; callers degrade honestly.
 */
export async function writeDocAtomic(file: string, text: string): Promise<{ sha256: string; bytes: number }> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  const bytes = Buffer.from(text, 'utf8');
  fs.writeFileSync(tmp, bytes);
  try {
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES') throw err;
      await sleep(50);
      fs.renameSync(tmp, file);
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
    throw err;
  }
  return { sha256: sha256(bytes), bytes: bytes.length };
}

/**
 * Minimal frontmatter shared by the generated docs: a leading `---` block of `key: value` lines
 * (values are single-line ISO stamps / ids / hashes — never multi-line, never quoted).
 */
export function parseFrontmatter(text: string): { fields: Record<string, string> | null; body: string } {
  if (!text.startsWith('---\n')) return { fields: null, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { fields: null, body: text };
  const fields: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return { fields, body: text.slice(end + '\n---\n'.length) };
}

export function serializeFrontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n`;
}
