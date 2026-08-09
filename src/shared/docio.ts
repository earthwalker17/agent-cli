import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { sha256 } from './hash.js';

/**
 * Document-file IO substrate: atomic replace + the minimal frontmatter the generated documents
 * share. Moved here from memory/store.ts (S20.5): the plan store consumed these from memory/
 * while memory/update.ts consumes the plan folds — a genuine module cycle whose two halves had
 * nothing to do with each other. This file carries NO memory semantics; memory/store.ts
 * re-exports it for its own consumers.
 */

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
