import { sanitizeLine } from '../shared/text.js';
import { rankStructural, type RetrievalHandle } from './rank.js';

/**
 * Ranked repository-map rendering (Session 10). Deterministic tiers under a hard character
 * budget, replacing the alphabetical flat list that silently lost everything after the
 * truncation point on large repos:
 *
 *   1. header — coverage honesty (files, symbol support, partial-index disclosure);
 *   2. uncommitted (active) files — the git-state signal, capped;
 *   3. the directory tree with per-dir file counts — the recall backstop: ranking may order
 *      detail, but it must never hide that a directory exists (collapse is depth-wise and
 *      always announced);
 *   4. key files ranked by structure/imports/git state, with top exported symbols and NO
 *      line numbers (line numbers only ever come from live reads — staleness honesty);
 *   5. footer — how to reach everything the map does not show.
 *
 * EVERY tier is charged against the budget as it is appended (the footer is reserved up
 * front), so the returned text never exceeds `budget`; any tier cut sets `truncated`.
 * Paths and names are sanitized at interpolation (repo content is untrusted prompt input).
 */

export const RANKED_MAP_BUDGET = 16_000;
const DIRTY_MAX = 20;
const TREE_SHARE = 0.4;
const TOP_LEVEL_FILE_MAX = 25;
const LINE_CLIP = 220;

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

/** One rendered path line, clipped so hostile long names cannot blow the tier budgets. */
function clip(s: string): string {
  return s.length > LINE_CLIP ? s.slice(0, LINE_CLIP) + '…' : s;
}

/** Render dirs to `maxDepth` (already indented for the final layout tier). */
function renderTree(root: DirNode, maxDepth: number): string[] {
  const lines: string[] = [];
  const walk = (node: DirNode, depth: number): void => {
    for (const name of [...node.children.keys()].sort()) {
      const child = node.children.get(name)!;
      const collapsed = depth >= maxDepth && child.children.size > 0;
      lines.push(
        clip(`  ${'  '.repeat(depth)}${sanitizeLine(name)}/ (${child.total} file${child.total === 1 ? '' : 's'}${collapsed ? ', subdirs collapsed' : ''})`),
      );
      if (!collapsed) walk(child, depth + 1);
    }
  };
  walk(root, 0);
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

  const footer = `\n(Selection above is ranked, not exhaustive. Use retrieve for task-directed lookup with reasons, search/list_files for anything else.)`;
  // Everything below is charged against bodyBudget as it is appended; the footer is reserved.
  const bodyBudget = Math.max(400, budget - footer.length - 1);
  const lines: string[] = [];
  let used = 0;
  const tryPush = (line: string): boolean => {
    if (used + line.length + 1 > bodyBudget) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  // Tier 1 — header (unconditional; bounded, and the budget floor of 400 covers it).
  for (const h of [
    `Repository map — ranked overview. It is SELECTIVE: the complete listing is always reachable via list_files, search, and the retrieve tool; line numbers come only from live file reads.`,
    `${inv.files.length} files${inv.capped ? ' (inventory capped)' : ''}; symbols indexed for ${handle.indexedFiles} (ts/js/py only — other languages rank by path/git signals)${handle.state === 'partial' ? '; index PARTIAL (build budget) — some files are unindexed or carry stale symbols until a later session catches up (excerpts/line numbers are always live)' : ''}.`,
  ]) {
    lines.push(h);
    used += h.length + 1;
  }

  // Tier 2 — dirty files (count-capped AND budget-charged).
  if (inv.dirtyPaths.length > 0 && tryPush('') && tryPush('Uncommitted (active) files:')) {
    let shown = 0;
    for (const p of inv.dirtyPaths.slice(0, DIRTY_MAX)) {
      if (!tryPush(clip(`  ${sanitizeLine(p)}`))) {
        truncated = true;
        break;
      }
      shown++;
    }
    if (inv.dirtyPaths.length > shown) tryPush(`  … (+${inv.dirtyPaths.length - shown} more)`);
  }

  // Tier 3 — layout: top-level files + the directory tree, fitted to its budget share.
  if (tryPush('') && tryPush('Layout (every directory, with file counts):')) {
    const topLevelFiles = inv.files.map((f) => f.relPath).filter((p) => !p.includes('/')).sort();
    const shownTop = topLevelFiles.slice(0, TOP_LEVEL_FILE_MAX);
    for (const p of shownTop) {
      if (!tryPush(clip(`  ${sanitizeLine(p)}`))) {
        truncated = true;
        break;
      }
    }
    if (topLevelFiles.length > shownTop.length) tryPush(`  … (+${topLevelFiles.length - shownTop.length} more top-level files)`);

    const tree = buildTree(inv.files.map((f) => f.relPath));
    const treeBudget = Math.min(Math.floor(budget * TREE_SHARE), bodyBudget - used);
    let treeLines: string[] = [];
    for (let depth = 6; depth >= 1; depth--) {
      treeLines = renderTree(tree, depth);
      if (treeLines.join('\n').length <= treeBudget) {
        if (depth < 6) truncated = true;
        break;
      }
      if (depth === 1) {
        const kept: string[] = [];
        let treeUsed = 0;
        for (const line of treeLines) {
          if (treeUsed + line.length + 1 > treeBudget) break;
          kept.push(line);
          treeUsed += line.length + 1;
        }
        kept.push(`  … (${treeLines.length - kept.length} more directories not shown)`);
        treeLines = kept;
        truncated = true;
      }
    }
    for (const l of treeLines) {
      if (!tryPush(l)) {
        truncated = true;
        break;
      }
    }
  }

  // Tier 4 — ranked key files fill whatever body budget remains.
  let rankedShown = 0;
  if (tryPush('') && tryPush('Key files (ranked by imports, structure, and git state):')) {
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
      const line = clip(`  ${sanitizeLine(r.relPath)}${symbols.length > 0 ? ` — ${symbols.join(', ')}${extra}` : ''}`);
      if (!tryPush(line)) {
        truncated = true;
        break;
      }
      rankedShown++;
    }
  }
  // An absent/empty ranked tier on a non-empty repo is a budget cut, not completeness.
  if (rankedShown === 0 && inv.files.length > 0) truncated = true;

  return { text: lines.join('\n') + footer, truncated };
}
