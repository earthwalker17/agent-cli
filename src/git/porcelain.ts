import type { GitStatusEntry, GitStatusSummary } from './types.js';

/**
 * Parser for `git status --porcelain=v2 -b -z` output. Pure — fixture-tested, no I/O.
 *
 * `-z` is load-bearing: records are NUL-terminated (never newline), paths arrive verbatim
 * (no quoting, no core.quotepath mangling of unicode), and a rename record carries TWO
 * NUL-separated paths (current, then original). Only `-z` output may be fed to this parser.
 */

/** Split off the first `n` space-separated fields; the remainder is the (space-safe) tail. */
function splitFields(record: string, n: number): { fields: string[]; rest: string } | null {
  const fields: string[] = [];
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const next = record.indexOf(' ', idx);
    if (next === -1) return null;
    fields.push(record.slice(idx, next));
    idx = next + 1;
  }
  return { fields, rest: record.slice(idx) };
}

export function parsePorcelainV2(raw: string): GitStatusSummary {
  const summary: GitStatusSummary = {
    branchOid: null,
    branchHead: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    entries: [],
  };

  const records = raw.split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.length === 0) continue;

    if (rec.startsWith('# ')) {
      const body = rec.slice(2);
      if (body.startsWith('branch.oid ')) {
        const oid = body.slice('branch.oid '.length);
        summary.branchOid = oid === '(initial)' ? null : oid;
      } else if (body.startsWith('branch.head ')) {
        const head = body.slice('branch.head '.length);
        summary.detached = head === '(detached)';
        summary.branchHead = summary.detached ? null : head;
      } else if (body.startsWith('branch.upstream ')) {
        summary.upstream = body.slice('branch.upstream '.length);
      } else if (body.startsWith('branch.ab ')) {
        const m = /^\+(\d+) -(\d+)$/.exec(body.slice('branch.ab '.length));
        if (m) {
          summary.ahead = Number(m[1]);
          summary.behind = Number(m[2]);
        }
      }
      continue;
    }

    const tag = rec[0];
    if (tag === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parsed = splitFields(rec, 8);
      if (!parsed) continue;
      const xy = parsed.fields[1]!;
      summary.entries.push(entry('changed', parsed.rest, xy));
    } else if (tag === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path> NUL <origPath>
      const parsed = splitFields(rec, 9);
      if (!parsed) continue;
      const xy = parsed.fields[1]!;
      const orig = records[++i]; // consume the second NUL-separated path
      const e = entry('renamed', parsed.rest, xy);
      if (orig !== undefined && orig.length > 0) e.origPath = orig;
      summary.entries.push(e);
    } else if (tag === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parsed = splitFields(rec, 10);
      if (!parsed) continue;
      const xy = parsed.fields[1]!;
      summary.entries.push(entry('unmerged', parsed.rest, xy));
    } else if (tag === '?') {
      summary.entries.push(entry('untracked', rec.slice(2), '??'));
    } else if (tag === '!') {
      summary.entries.push(entry('ignored', rec.slice(2), '!!'));
    }
  }
  return summary;
}

function entry(kind: GitStatusEntry['kind'], path: string, xy: string): GitStatusEntry {
  return { kind, path, x: xy[0] ?? '.', y: xy[1] ?? '.' };
}
