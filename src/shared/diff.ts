import { diffLines, structuredPatch } from 'diff';

/**
 * Line-diff utilities over jsdiff (runtime dependency #5). Pure text in, pure text out —
 * used by the runtime (per-mutation diffstat evidence) and the review surfaces (/diff,
 * `agent diff`). Binary and size guards live HERE so every consumer refuses the same way.
 */

/** Size above which diffs are not computed (diffing is O(n·d); evidence must never hang a turn). */
export const DIFF_MAX_BYTES = 1024 * 1024;

/** NUL in the first 8 KiB ⇒ treat as binary (the classic git heuristic). */
export function isProbablyBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, 8192);
  return window.includes(0);
}

export interface LineDiffStat {
  added: number;
  removed: number;
}

/** Count added/removed lines between two texts. */
export function lineDiffStat(before: string, after: string): LineDiffStat {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

/**
 * Render a unified diff for one file, capped at `maxLines` body lines. Returns '' when the
 * texts are identical. The header uses a/<path> b/<path> (familiar review shape, no git needed).
 */
export function unifiedDiff(relPath: string, before: string, after: string, maxLines = 400): string {
  const patch = structuredPatch(relPath, relPath, before, after, undefined, undefined, { context: 3 });
  if (patch.hunks.length === 0) return '';
  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`];
  let body = 0;
  for (const h of patch.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const line of h.lines) {
      if (body >= maxLines) {
        out.push(`… (diff truncated at ${maxLines} lines)`);
        return out.join('\n');
      }
      out.push(line);
      body++;
    }
  }
  return out.join('\n');
}
