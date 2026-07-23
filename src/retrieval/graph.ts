import type { LangId } from './extract.js';

/**
 * Import graph + centrality (Session 10). Pure: takes extracted specifiers, resolves the
 * RELATIVE ones against the inventory path set (bare/package specifiers are dropped — they
 * point outside the repo), and computes in-degree plus a bounded, damped PageRank. Imprecise
 * resolution is acceptable by design: centrality is a ranking signal, never a claim, and no
 * rendered surface derives line numbers or "truth" from it.
 */

export interface ImportGraph {
  /** file → resolved repo-relative targets it imports. */
  edges: Map<string, string[]>;
  /** file → files that import it. */
  importers: Map<string, string[]>;
  inDegree: Map<string, number>;
  /** Damped PageRank over all inventory files; higher = more structurally central. */
  pagerank: Map<string, number>;
}

const TS_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const TS_INDEXES = TS_SUFFIXES.map((s) => '/index' + s);

/** Normalize a POSIX path, resolving '.' and '..' segments; null when it escapes the root. */
function normalizePosix(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join('/');
}

function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

function resolveTs(fromRel: string, spec: string, files: ReadonlySet<string>): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null; // bare specifier: outside the repo
  const base = normalizePosix(posixDirname(fromRel) + '/' + spec);
  if (base === null || base.length === 0) return null;
  if (files.has(base)) return base;
  // NodeNext idiom: source imports name the emitted '.js'; try the TS siblings first.
  if (base.endsWith('.js') || base.endsWith('.mjs') || base.endsWith('.cjs')) {
    const stem = base.slice(0, base.lastIndexOf('.'));
    for (const s of TS_SUFFIXES) if (files.has(stem + s)) return stem + s;
  }
  for (const s of TS_SUFFIXES) if (files.has(base + s)) return base + s;
  for (const s of TS_INDEXES) if (files.has(base + s)) return base + s;
  return null;
}

function resolvePy(fromRel: string, spec: string, files: ReadonlySet<string>): string | null {
  let baseDir: string;
  let rest: string;
  if (spec.startsWith('.')) {
    let dots = 0;
    while (dots < spec.length && spec[dots] === '.') dots++;
    rest = spec.slice(dots);
    baseDir = posixDirname(fromRel);
    for (let i = 1; i < dots; i++) {
      if (baseDir === '') return null;
      baseDir = posixDirname(baseDir);
    }
  } else {
    baseDir = '';
    rest = spec;
  }
  const segs = rest.length > 0 ? rest.split('.') : [];
  const joined = [baseDir, ...segs].filter((s) => s.length > 0).join('/');
  if (joined.length === 0) return null;
  if (files.has(joined + '.py')) return joined + '.py';
  if (files.has(joined + '/__init__.py')) return joined + '/__init__.py';
  return null;
}

export interface GraphSource {
  relPath: string;
  lang: LangId | null;
  imports: readonly string[];
}

const PAGERANK_DAMPING = 0.85;
const PAGERANK_ITERATIONS = 20;

/**
 * Build the graph over `allFiles` (every inventory path — unindexed files are valid TARGETS
 * and rank via incoming edges) from the extracted sources.
 */
export function buildImportGraph(sources: readonly GraphSource[], allFiles: ReadonlySet<string>): ImportGraph {
  const edges = new Map<string, string[]>();
  const importers = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const src of sources) {
    if (src.lang === null) continue;
    const targets: string[] = [];
    const seen = new Set<string>();
    for (const spec of src.imports) {
      const resolved = src.lang === 'ts' ? resolveTs(src.relPath, spec, allFiles) : resolvePy(src.relPath, spec, allFiles);
      if (resolved !== null && resolved !== src.relPath && !seen.has(resolved)) {
        seen.add(resolved);
        targets.push(resolved);
      }
    }
    if (targets.length > 0) {
      edges.set(src.relPath, targets);
      for (const t of targets) {
        inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
        const back = importers.get(t);
        if (back === undefined) importers.set(t, [src.relPath]);
        else back.push(src.relPath);
      }
    }
  }

  // Damped PageRank, deterministic: fixed iteration count over the sorted node list; the
  // dangling mass (files with no outgoing edges) redistributes uniformly.
  const nodes = [...allFiles].sort();
  const n = nodes.length;
  const pagerank = new Map<string, number>();
  if (n > 0) {
    let rank = new Map<string, number>(nodes.map((f) => [f, 1 / n]));
    for (let iter = 0; iter < PAGERANK_ITERATIONS; iter++) {
      const next = new Map<string, number>(nodes.map((f) => [f, 0]));
      let danglingMass = 0;
      for (const f of nodes) {
        const r = rank.get(f)!;
        const out = edges.get(f);
        if (out === undefined || out.length === 0) {
          danglingMass += r;
        } else {
          const share = r / out.length;
          for (const t of out) next.set(t, next.get(t)! + share);
        }
      }
      const base = (1 - PAGERANK_DAMPING) / n + (PAGERANK_DAMPING * danglingMass) / n;
      for (const f of nodes) next.set(f, base + PAGERANK_DAMPING * next.get(f)!);
      rank = next;
    }
    for (const [f, r] of rank) pagerank.set(f, r);
  }

  return { edges, importers, inDegree, pagerank };
}
