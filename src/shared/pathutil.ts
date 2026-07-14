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
