import fs from 'node:fs';
import path from 'node:path';
import { PathError } from '../shared/errors.js';
import { isInside } from '../shared/pathutil.js';

export interface PathVerdict {
  /** Resolved absolute path: realpath of the deepest existing ancestor + the non-existing tail. */
  resolved: string;
  /** Equal to, or nested inside, the workspace root. */
  inWorkspace: boolean;
  /** Under a protected subtree (.git, the state dir, or any `.agent-cli`). */
  protectedPath: boolean;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const isWin = process.platform === 'win32';

function segments(input: string): string[] {
  return input.split(/[\\/]+/).filter((s) => s.length > 0);
}

/**
 * Realpath the deepest existing ancestor, then re-append the non-existing tail. This catches
 * symlink/junction escapes even when the final target does not yet exist. `realpathSync.native`
 * also expands Windows 8.3 short names on the existing portion.
 */
function realpathBoundary(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // hit the filesystem root; nothing existed
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Validate a model-supplied path against the workspace boundary. Throws `PathError` for
 * structurally dangerous inputs (device namespaces, UNC, reserved names, NTFS ADS, trailing
 * dot/space). For legitimate paths it returns a verdict; the POLICY engine — not this function
 * and not the tool — decides allow/ask/deny from `inWorkspace`/`protectedPath` + intent. This is
 * the single canonicalization used by both the policy gate and the tools, so they never diverge.
 *
 * KNOWN LIMITATION: the realpath check is TOCTOU-racy (a junction created between validation and
 * use is not caught) — logical policy only, not OS enforcement. Documented in the README.
 */
export function validatePath(
  workspaceRoot: string,
  input: string,
  opts: { stateDir?: string } = {},
): PathVerdict {
  if (input.length === 0) throw new PathError('empty path', 'path.empty');
  if (input.includes('\0')) throw new PathError('path contains a NUL byte', 'path.nul');

  const norm = input.replace(/\//g, '\\');
  if (/^\\\\[?.]\\/.test(norm)) throw new PathError('device namespace path rejected', 'path.device');
  if (/^\\\\/.test(norm)) throw new PathError('UNC path rejected', 'path.unc');

  const segs = segments(input);
  for (const seg of segs) {
    if (seg === '.' || seg === '..') continue;
    const base = seg.split('.')[0] ?? seg;
    if (RESERVED.test(base)) throw new PathError(`reserved device name: ${seg}`, 'path.reserved');
    if (isWin) {
      // Strip a leading drive letter (`C:`) so its colon isn't mistaken for an ADS.
      const afterDrive = seg.replace(/^[A-Za-z]:/, '');
      if (afterDrive.includes(':')) throw new PathError('NTFS alternate data stream rejected', 'path.ads');
      if (/[ .]$/.test(seg)) throw new PathError('trailing dot/space rejected', 'path.trailing');
    }
  }

  const abs = path.resolve(workspaceRoot, input);
  const resolved = realpathBoundary(abs);
  const realWorkspace = realpathBoundary(path.resolve(workspaceRoot));

  const inWorkspace = isInside(realWorkspace, resolved);

  const protectedRoots = [path.join(realWorkspace, '.git')];
  if (opts.stateDir) protectedRoots.push(path.resolve(opts.stateDir));
  const protectedPath =
    protectedRoots.some((r) => isInside(r, resolved)) ||
    segments(resolved).includes('.agent-cli');

  return { resolved, inWorkspace, protectedPath };
}
