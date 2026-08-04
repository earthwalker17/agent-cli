/**
 * Bounded, in-memory zip access for OOXML containers (docx/pptx) over fflate.
 *
 * Read side: every entry name is validated and every size is capped BEFORE bytes are handed to
 * callers, and nothing is ever extracted to disk — entries live only as in-memory buffers keyed
 * by validated names, so the zip-slip class is structurally impossible here, not defended
 * against. Declared sizes from the central directory gate what gets inflated; the ACTUAL
 * inflated sizes are re-checked afterwards because headers are attacker-controlled bytes.
 *
 * Write side: deterministic by construction — entries sorted by name, a FIXED mtime (fflate
 * would otherwise stamp the current time, and DOS timestamps have 2-second resolution: two
 * renders straddling a tick would differ), fixed compression level. Same entries in, same
 * bytes out; the DOCX determinism contract rests on this. (DOS times encode LOCAL time, so
 * byte-equality is per-machine — the determinism the render evidence claims — not portable
 * across timezones.)
 */

import { unzipSync, zipSync } from 'fflate';
import { ArtifactError } from './errors.js';

export const MAX_ZIP_ENTRIES = 2_000;
export const MAX_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024;

/** Bounds are parameters so tests exercise refusal without 50 MiB fixtures. */
export interface ZipBounds {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

export interface OpenedZip {
  /** Validated file-entry names in archive (central directory) order. Directories excluded. */
  readonly names: readonly string[];
  has(name: string): boolean;
  /** Decompressed bytes for an entry, or null when absent. */
  bytes(name: string): Uint8Array | null;
  /** UTF-8 decode of an entry (lenient — OOXML parts are UTF-8 by spec), or null when absent. */
  text(name: string): string | null;
}

const DRIVE_PREFIX = /^[a-zA-Z]:/;

/**
 * Refuse names that could ever be misread as filesystem instructions or smuggle control bytes
 * into output. Names are keys into an in-memory map, but they flow onward into summaries and
 * evidence; hostile forms are refused at the boundary, once.
 */
function validateEntryName(name: string): void {
  const printable = name.replace(/[^\x20-\x7e]/g, '?');
  const refuse = (why: string): never => {
    throw new ArtifactError(`zip entry name ${why}: "${printable.slice(0, 120)}"`, 'zip-entry-name');
  };
  if (name.length === 0) refuse('is empty');
  if (name.length > 260) refuse('is longer than 260 chars');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) refuse('contains control characters');
  if (name.includes('\\')) refuse('contains a backslash');
  if (name.startsWith('/')) refuse('is absolute');
  if (DRIVE_PREFIX.test(name)) refuse('carries a drive prefix');
  if (name.split('/').some((seg) => seg === '..')) refuse('contains a ".." segment');
}

export function openZipBounded(data: Uint8Array, bounds?: ZipBounds): OpenedZip {
  const maxEntries = bounds?.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxEntryBytes = bounds?.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES;
  const maxTotalBytes = bounds?.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;

  let entryCount = 0;
  let declaredTotal = 0;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(data, {
      filter: (info) => {
        // Directory placeholder entries carry no content; skip rather than refuse.
        if (info.name.endsWith('/') && info.originalSize === 0) return false;
        validateEntryName(info.name);
        entryCount += 1;
        if (entryCount > maxEntries) {
          throw new ArtifactError(`zip has more than ${maxEntries} entries`, 'zip-bounds');
        }
        if (info.originalSize > maxEntryBytes) {
          throw new ArtifactError(
            `zip entry "${info.name.slice(0, 120)}" declares ${info.originalSize} bytes (cap ${maxEntryBytes})`,
            'zip-bounds',
          );
        }
        declaredTotal += info.originalSize;
        if (declaredTotal > maxTotalBytes) {
          throw new ArtifactError(`zip declares more than ${maxTotalBytes} total decompressed bytes`, 'zip-bounds');
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ArtifactError) throw err;
    throw new ArtifactError(`not a readable zip archive: ${err instanceof Error ? err.message : String(err)}`, 'zip-corrupt');
  }

  // Declared sizes gated the inflate; actual sizes are the truth. A header that lied small is
  // refused here rather than trusted.
  let actualTotal = 0;
  for (const [name, bytes] of Object.entries(unzipped)) {
    actualTotal += bytes.length;
    if (bytes.length > maxEntryBytes) {
      throw new ArtifactError(`zip entry "${name.slice(0, 120)}" inflated past the declared size cap`, 'zip-bounds');
    }
  }
  if (actualTotal > maxTotalBytes) {
    throw new ArtifactError('zip inflated past the total decompressed cap', 'zip-bounds');
  }

  const names = Object.keys(unzipped);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return {
    names,
    has: (name) => Object.hasOwn(unzipped, name),
    bytes: (name) => (Object.hasOwn(unzipped, name) ? unzipped[name]! : null),
    text: (name) => (Object.hasOwn(unzipped, name) ? decoder.decode(unzipped[name]!) : null),
  };
}

/**
 * The one fixed timestamp every generated archive carries. Arbitrary but stable; DOS-epoch-safe
 * (zip cannot represent years before 1980).
 */
export const ZIP_FIXED_MTIME = new Date(2001, 0, 1, 0, 0, 0);

/** Deterministic zip: sorted entry order, fixed mtime, fixed level. */
export function zipDeterministic(entries: Record<string, Uint8Array | string>): Uint8Array {
  const zippable: Record<string, [Uint8Array, { level: 6; mtime: Date }]> = {};
  for (const name of Object.keys(entries).sort()) {
    validateEntryName(name);
    const value = entries[name]!;
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    zippable[name] = [bytes, { level: 6, mtime: ZIP_FIXED_MTIME }];
  }
  return zipSync(zippable);
}
