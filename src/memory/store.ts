import fs from 'node:fs';
import path from 'node:path';
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

// The atomic write + frontmatter substrate moved to shared/docio.ts (S20.5 — the plan store
// consumed them from here while memory/update.ts consumes the plan folds: a module cycle whose
// halves had nothing to do with each other). Re-exported so memory-side consumers keep one
// import site per concept.
export { parseFrontmatter, serializeFrontmatter, writeDocAtomic } from '../shared/docio.js';
