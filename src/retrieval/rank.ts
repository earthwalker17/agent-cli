import { buildImportGraph, type ImportGraph } from './graph.js';
import type { Inventory } from './inventory.js';
import type { IndexBuildResult, RetrievalIndex } from './store.js';

/**
 * Ranking (Session 10). Pure and deterministic: same inventory + index ⇒ same order (ties break
 * on relPath). Every hit carries human-readable signal attributions — "traceable file
 * selection" is a completion criterion, so a score is never an unexplained number.
 */

export interface RetrievalHandle {
  root: string;
  inventory: Inventory;
  index: RetrievalIndex;
  graph: ImportGraph;
  /** Task-agnostic prior, computed once per session. */
  structural: Map<string, { score: number; signals: string[] }>;
  state: 'full' | 'partial';
  cache: 'cold' | 'warm';
  /** Files with a supported-language extraction (the honest "symbols for N of M" count). */
  indexedFiles: number;
}

export interface RankedFile {
  relPath: string;
  score: number;
  signals: string[];
}

export interface RetrievalHit extends RankedFile {
  /** Top extracted symbol names (exported first); [] for unindexed files. */
  symbols: string[];
}

// Session 18: `lib`/`mod` boost lib.rs and mod.rs (matched on the STEM, so lib.ts profits too —
// deliberate: a `lib` stem is entry-shaped in any ecosystem).
const ENTRY_BASENAMES = new Set(['index', 'main', 'cli', 'app', 'server', '__init__', 'lib', 'mod']);
const MANIFEST_BASENAMES = new Set(['package.json', 'pyproject.toml', 'setup.py', 'tsconfig.json', 'readme.md', 'cargo.toml', 'go.mod', 'cmakelists.txt']);
const PENALTY_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'fixtures', 'fixture', 'vendor', 'third_party', 'testdata']);

function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}

function stemOf(base: string): string {
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

function isTestPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  if (lower.split('/').some((seg) => PENALTY_SEGMENTS.has(seg))) return true;
  const base = baseName(lower);
  // `_test.go` is Go's test convention (Session 18) — a sibling of production code, so no
  // directory segment ever catches it.
  return base.includes('.test.') || base.includes('.spec.') || base.startsWith('test_') || base.endsWith('_test.go');
}

function structuralFor(relPath: string, handle: { inventory: Inventory; index: RetrievalIndex; graph: ImportGraph }, maxPr: number, dirty: ReadonlySet<string>): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;

  const pr = handle.graph.pagerank.get(relPath) ?? 0;
  if (maxPr > 0 && pr > 0) score += (pr / maxPr) * 30;
  const inDeg = handle.graph.inDegree.get(relPath) ?? 0;
  if (inDeg >= 3) signals.push(`imported by ${inDeg} files`);

  const base = baseName(relPath).toLowerCase();
  if (ENTRY_BASENAMES.has(stemOf(base))) {
    score += 8;
    signals.push('entry-point name');
  }
  if (MANIFEST_BASENAMES.has(base)) {
    score += 6;
    signals.push('project manifest');
  }
  if (dirty.has(relPath)) {
    score += 15;
    signals.push('uncommitted changes');
  }
  const entry = handle.index.entries[relPath];
  if (entry !== undefined) {
    const exported = entry.symbols.filter((s) => s.exported).length;
    score += Math.min(exported, 10) * 0.8;
  }
  score -= (relPath.split('/').length - 1) * 1.5;
  if (isTestPath(relPath)) {
    score -= 10;
    signals.push('test/vendor path');
  }
  return { score, signals };
}

/** Assemble the per-session handle: graph + structural prior over the whole inventory. */
export function buildRetrievalHandle(root: string, inventory: Inventory, build: IndexBuildResult): RetrievalHandle {
  const allFiles = new Set(inventory.files.map((f) => f.relPath));
  const sources = Object.entries(build.index.entries).map(([relPath, e]) => ({ relPath, lang: e.lang, imports: e.imports }));
  const graph = buildImportGraph(sources, allFiles);
  const dirty = new Set(inventory.dirtyPaths);
  let maxPr = 0;
  for (const v of graph.pagerank.values()) if (v > maxPr) maxPr = v;

  const partial = { inventory, index: build.index, graph };
  const structural = new Map<string, { score: number; signals: string[] }>();
  for (const f of inventory.files) structural.set(f.relPath, structuralFor(f.relPath, partial, maxPr, dirty));

  return {
    root,
    inventory,
    index: build.index,
    graph,
    structural,
    state: build.state,
    cache: build.cache,
    indexedFiles: Object.values(build.index.entries).filter((e) => e.lang !== null).length,
  };
}

/** Task-agnostic ranking for the repository map's key-files tier. */
export function rankStructural(handle: RetrievalHandle, limit: number): RankedFile[] {
  const out: RankedFile[] = [];
  for (const [relPath, s] of handle.structural) out.push({ relPath, score: s.score, signals: s.signals });
  out.sort((a, b) => b.score - a.score || (a.relPath < b.relPath ? -1 : 1));
  return out.slice(0, Math.max(0, limit));
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'where', 'when', 'what', 'which',
  'how', 'does', 'file', 'files', 'code', 'find', 'search', 'show', 'all', 'are', 'not', 'its',
  'implement', 'implementation', 'function', 'module', 'class', 'about', 'used', 'uses', 'use',
]);

/** Lowercased query terms worth matching (≥3 chars, stopwords dropped, capped). */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const t of query.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) seen.add(t);
    if (seen.size >= 12) break;
  }
  return [...seen];
}

export interface QueryOptions {
  scopePaths?: readonly string[];
  limit?: number;
}

/**
 * Task-directed ranking: lexical term matches on paths and symbol names, a graph-neighbor
 * boost around the strongest lexical hits, and a small structural prior. Hits carry the
 * matching signals verbatim so the selection is traceable.
 */
export function rankForQuery(handle: RetrievalHandle, query: string, opts: QueryOptions = {}): RetrievalHit[] {
  const terms = queryTerms(query);
  const limit = opts.limit ?? 15;
  const scopes = (opts.scopePaths ?? []).map((s) => s.replace(/\\/g, '/').replace(/\/+$/, ''));
  const inScope = (relPath: string): boolean =>
    scopes.length === 0 || scopes.some((s) => relPath === s || relPath.startsWith(s + '/'));

  interface Acc {
    score: number;
    signals: string[];
  }
  const acc = new Map<string, Acc>();
  const bump = (relPath: string, points: number, signal?: string): void => {
    let a = acc.get(relPath);
    if (a === undefined) {
      a = { score: 0, signals: [] };
      acc.set(relPath, a);
    }
    a.score += points;
    if (signal !== undefined && a.signals.length < 6 && !a.signals.includes(signal)) a.signals.push(signal);
  };

  for (const f of handle.inventory.files) {
    const relPath = f.relPath;
    if (!inScope(relPath)) continue;
    const pathLower = relPath.toLowerCase();
    const base = baseName(pathLower);
    const stem = stemOf(base);
    for (const term of terms) {
      if (stem === term) bump(relPath, 30, `filename matches '${term}'`);
      else if (base.includes(term)) bump(relPath, 18, `filename contains '${term}'`);
      else if (pathLower.includes(term)) bump(relPath, 10, `path contains '${term}'`);
    }
    const entry = handle.index.entries[relPath];
    if (entry !== undefined && terms.length > 0) {
      let symbolPoints = 0;
      for (const s of entry.symbols) {
        const nameLower = s.name.toLowerCase();
        for (const term of terms) {
          if (nameLower === term) {
            symbolPoints += 18;
            bump(relPath, 0, `defines '${s.name}'`);
          } else if (nameLower.includes(term)) {
            symbolPoints += 8;
            bump(relPath, 0, `defines '${s.name}'`);
          }
        }
        if (symbolPoints >= 40) break;
      }
      if (symbolPoints > 0) bump(relPath, Math.min(symbolPoints, 40));
    }
  }

  // Graph-neighbor boost around the strongest lexical hits (deterministic: sorted top slice).
  const lexicalTop = [...acc.entries()]
    .sort((a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1))
    .slice(0, 15)
    .map(([relPath]) => relPath);
  for (const top of lexicalTop) {
    for (const n of handle.graph.edges.get(top) ?? []) {
      if (inScope(n)) bump(n, 4, `imported by ${top}`);
    }
    for (const n of handle.graph.importers.get(top) ?? []) {
      if (inScope(n)) bump(n, 4, `imports ${top}`);
    }
  }

  const hits: RetrievalHit[] = [];
  for (const [relPath, a] of acc) {
    if (a.score <= 0) continue;
    const structural = handle.structural.get(relPath);
    const score = a.score + (structural !== undefined ? structural.score * 0.2 : 0);
    const entry = handle.index.entries[relPath];
    const symbols =
      entry === undefined
        ? []
        : [...entry.symbols]
            .sort((x, y) => Number(y.exported) - Number(x.exported))
            .slice(0, 8)
            .map((s) => s.name);
    hits.push({ relPath, score, signals: a.signals, symbols });
  }
  hits.sort((a, b) => b.score - a.score || (a.relPath < b.relPath ? -1 : 1));
  return hits.slice(0, Math.max(0, limit));
}
