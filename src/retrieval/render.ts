import { sanitizeLine } from '../shared/text.js';
import { rankStructural, type RetrievalHandle } from './rank.js';

/**
 * Ranked repository-map rendering (Session 10). Deterministic tiers under a hard character
 * budget, replacing the alphabetical flat list that silently lost everything after the
 * truncation point on large repos:
 *
 *   1. header — coverage honesty (files, symbol support, partial-index disclosure);
 *   2. uncommitted (active) files — the git-state signal, capped;
 *   3. the COMPLETE directory tree with per-dir file counts — the recall backstop: ranking
 *      may order detail, but it must never hide that a directory exists;
 *   4. key files ranked by structure/imports/git state, with top exported symbols and NO
 *      line numbers (line numbers only ever come from live reads — staleness honesty);
 *   5. footer — how to reach everything the map does not show.
 *
 * Paths and names are sanitized at interpolation (repo content is untrusted prompt input).
 */

export const RANKED_MAP_BUDGET = 16_000;
const DIRTY_MAX = 20;
const TREE_SHARE = 0.4;
const TOP_LEVEL_FILE_MAX = 25;

interface DirNode {
  children: Map<string, DirNode>;
  /** Files directly in this dir. */
  direct: number;
  /** Files in this subtree (computed). */
  total: number;
}

function buildTree(relPaths: readonly string[]): DirNode {
  const root: DirNode = { children: new Map(), direct: 0, total: 0 };
  for (const p of relPaths) {
    const segs = p.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]!;
      let child = node.children.get(seg);
      if (child === undefined) {
        child = { children: new Map(), direct: 0, total: 0 };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.direct++;
  }
  const sum = (node: DirNode): number => {
    node.total = node.direct;
    for (const child of node.children.values()) node.total += sum(child);
    return node.total;
  };
  sum(root);
  return root;
}

/** Render dirs to `maxDepth`; deeper subtrees collapse into their ancestor's count. */
function renderTree(root: DirNode, maxDepth: number): string[] {
  const lines: string[] = [];
  const walk = (node: DirNode, depth: number, prefix: string): void => {
    for (const name of [...node.children.keys()].sort()) {
      const child = node.children.get(name)!;
      const collapsed = depth >= maxDepth && child.children.size > 0;
      lines.push(`${'  '.repeat(depth)}${sanitizeLine(name)}/ (${child.total} file${child.total === 1 ? '' : 's'}${collapsed ? ', subdirs collapsed' : ''})`);
      if (!collapsed) walk(child, depth + 1, prefix);
    }
  };
  walk(root, 0, '');
  return lines;
}

export interface RenderedMap {
  text: string;
  truncated: boolean;
}

export function renderRepoMap(handle: RetrievalHandle, opts: { budget?: number } = {}): RenderedMap {
  const budget = opts.budget ?? RANKED_MAP_BUDGET;
  const inv = handle.inventory;
  let truncated = inv.capped;

  const header = [
    `Repository map — ranked overview. It is SELECTIVE: the complete listing is always reachable via list_files, search, and the retrieve tool; line numbers come only from live file reads.`,
    `${inv.files.length} files${inv.capped ? ' (inventory capped)' : ''}; symbols indexed for ${handle.indexedFiles} (ts/js/py only — other languages rank by path/git signals)${handle.state === 'partial' ? '; index PARTIAL (build budget) — unindexed files still listed and ranked by path/git signals' : ''}.`,
  ];

  const dirtyLines: string[] = [];
  if (inv.dirtyPaths.length > 0) {
    dirtyLines.push('', 'Uncommitted (active) files:');
    for (const p of inv.dirtyPaths.slice(0, DIRTY_MAX)) dirtyLines.push(`  ${sanitizeLine(p)}`);
    if (inv.dirtyPaths.length > DIRTY_MAX) dirtyLines.push(`  … (+${inv.dirtyPaths.length - DIRTY_MAX} more)`);
  }

  // Tier 3: directory tree within its budget share — find the deepest depth that fits.
  const tree = buildTree(inv.files.map((f) => f.relPath));
  const topLevelFiles = inv.files.map((f) => f.relPath).filter((p) => !p.includes('/')).sort();
  const treeBudget = Math.floor(budget * TREE_SHARE);
  let treeLines: string[] = [];
  for (let depth = 6; depth >= 1; depth--) {
    treeLines = renderTree(tree, depth);
    if (treeLines.join('\n').length <= treeBudget) {
      if (depth < 6) truncated = true;
      break;
    }
    if (depth === 1) {
      // Even depth 1 overflows: keep what fits, honestly marked.
      const kept: string[] = [];
      let used = 0;
      for (const line of treeLines) {
        if (used + line.length + 1 > treeBudget) break;
        kept.push(line);
        used += line.length + 1;
      }
      kept.push(`… (${treeLines.length - kept.length} more directories not shown)`);
      treeLines = kept;
      truncated = true;
    }
  }
  const shownTop = topLevelFiles.slice(0, TOP_LEVEL_FILE_MAX);
  const treeSection = [
    '',
    'Layout (every directory, with file counts):',
    ...shownTop.map((p) => `  ${sanitizeLine(p)}`),
    ...(topLevelFiles.length > shownTop.length ? [`  … (+${topLevelFiles.length - shownTop.length} more top-level files)`] : []),
    ...treeLines.map((l) => `  ${l}`),
  ];

  const footer = [
    '',
    `(Selection above is ranked, not exhaustive. Use retrieve for task-directed lookup with reasons, search/list_files for anything else.)`,
  ];

  // Tier 4: ranked key files fill whatever budget remains.
  const fixed = [...header, ...dirtyLines, ...treeSection].join('\n').length + footer.join('\n').length + 1;
  const rankedHeader = ['', 'Key files (ranked by imports, structure, and git state):'];
  let remaining = budget - fixed - rankedHeader.join('\n').length;
  const rankedLines: string[] = [];
  if (remaining > 0) {
    for (const r of rankStructural(handle, 200)) {
      const entry = handle.index.entries[r.relPath];
      const symbols =
        entry === undefined
          ? []
          : [...entry.symbols]
              .sort((x, y) => Number(y.exported) - Number(x.exported))
              .slice(0, 6)
              .map((s) => sanitizeLine(s.name));
      const extra = entry !== undefined && entry.symbols.length > symbols.length ? ` (+${entry.symbols.length - symbols.length} more)` : '';
      const line = `  ${sanitizeLine(r.relPath)}${symbols.length > 0 ? ` — ${symbols.join(', ')}${extra}` : ''}`;
      if (line.length + 1 > remaining) {
        truncated = true;
        break;
      }
      rankedLines.push(line);
      remaining -= line.length + 1;
    }
  }

  const text = [...header, ...dirtyLines, ...treeSection, ...(rankedLines.length > 0 ? [...rankedHeader, ...rankedLines] : []), ...footer].join('\n');
  return { text, truncated };
}
