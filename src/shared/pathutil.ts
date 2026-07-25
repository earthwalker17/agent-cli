import path from 'node:path';

/** Case-fold for path comparison. Windows and macOS default filesystems are case-insensitive. */
export function caseFold(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * True when `child` is equal to, or nested inside, `parent`. Both are resolved to absolute
 * and compared with a trailing separator so a sibling prefix does NOT match
 * (`C:\ws` must not contain `C:\ws-evil`). This is the core of the workspace boundary check.
 */
export function isInside(parent: string, child: string): boolean {
  const p = caseFold(path.resolve(parent));
  const c = caseFold(path.resolve(child));
  if (c === p) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

/**
 * Normalize a declared workspace-relative path prefix: forward slashes, no leading `./`, no
 * trailing `/`. Returns null for prefixes that must be rejected (absolute, drive-letter, or
 * `..`-escaping). Containment is decided STRUCTURALLY here — such a prefix is never resolved or
 * disk-probed, so a declared prefix can never become an existence oracle for paths outside the
 * workspace. Shared by plan `touches` (Session 11) and typed-check scopes (Session 12).
 */
export function normalizeRelPrefix(prefix: string): string | null {
  let p = prefix.replace(/\\/g, '/').trim();
  while (p.startsWith('./')) p = p.slice(2);
  while (p.endsWith('/')) p = p.slice(0, -1);
  if (p === '' || p === '.') return null;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  if (p.split('/').some((seg) => seg === '..')) return null;
  return p;
}

/** Two prefixes overlap when equal or one path-nests the other (the focus-brief rule). */
export function relPrefixesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
