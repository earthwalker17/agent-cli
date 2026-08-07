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

/**
 * Rust (Session 18). Two edge families, both bounded:
 * - `mod::x` (from a `mod x;` declaration): the crate's file-tree edge — sibling `x.rs` or
 *   `x/mod.rs` of the DECLARING file's directory.
 * - `crate::a::b` paths: the crate root is the nearest ancestor directory holding `lib.rs` or
 *   `main.rs`; path segments then try `a/b.rs`, `a/b/mod.rs`, and progressively shorter
 *   prefixes (an item inside `a.rs` still lands on `a.rs`). `super::`/`self::` do dirname
 *   arithmetic. External crate names resolve to nothing, like bare TS specifiers.
 */
function resolveRust(fromRel: string, spec: string, files: ReadonlySet<string>): string | null {
  const tryModule = (dir: string, name: string): string | null => {
    const flat = normalizePosix(`${dir}/${name}.rs`);
    if (flat !== null && files.has(flat)) return flat;
    const nested = normalizePosix(`${dir}/${name}/mod.rs`);
    if (nested !== null && files.has(nested)) return nested;
    return null;
  };
  if (spec.startsWith('mod::')) {
    return tryModule(posixDirname(fromRel), spec.slice('mod::'.length));
  }
  const segs = spec.split('::').filter((s) => s.length > 0);
  if (segs.length === 0) return null;
  let baseDir: string;
  if (segs[0] === 'crate') {
    let root = posixDirname(fromRel);
    for (let hops = 0; hops < 8; hops++) {
      if (files.has(root === '' ? 'lib.rs' : `${root}/lib.rs`) || files.has(root === '' ? 'main.rs' : `${root}/main.rs`)) break;
      if (root === '') return null;
      root = posixDirname(root);
    }
    baseDir = root;
    segs.shift();
  } else if (segs[0] === 'self' || segs[0] === 'super') {
    baseDir = posixDirname(fromRel);
    while (segs[0] === 'super') {
      if (baseDir === '') return null;
      baseDir = posixDirname(baseDir);
      segs.shift();
    }
    if (segs[0] === 'self') segs.shift();
  } else {
    return null; // an external crate — outside the repo, like a bare TS specifier
  }
  // Longest-first: `crate::a::b` may be file `a/b.rs`, module dir `a/b/mod.rs`, or an item
  // inside `a.rs`. Two prefix drops bound the walk.
  for (let take = segs.length; take > 0 && take >= segs.length - 2; take--) {
    const head = segs.slice(0, take - 1).join('/');
    const dir = [baseDir, head].filter((s) => s.length > 0).join('/');
    const hit = tryModule(dir === '' ? '.' : dir, segs[take - 1]!);
    if (hit !== null) return hit;
  }
  return null;
}

/** Directories holding `.go` files → their sorted non-test files. Precomputed once per build. */
export function goPackageDirs(allFiles: ReadonlySet<string>): Map<string, string[]> {
  const dirs = new Map<string, string[]>();
  for (const f of allFiles) {
    if (!f.endsWith('.go')) continue;
    const dir = posixDirname(f);
    const list = dirs.get(dir);
    if (list === undefined) dirs.set(dir, [f]);
    else list.push(f);
  }
  for (const list of dirs.values()) list.sort();
  return dirs;
}

/**
 * Go (Session 18): SUFFIX-DIRECTORY matching. An import like `example.com/mod/pkg/sub` cannot be
 * resolved without the module path in go.mod, which a per-file resolver does not have — so the
 * trailing segments are matched against the repo's go-package directories instead, longest
 * suffix first, and the edge lands on ONE deterministic representative file (`<dir>/<last>.go`
 * when it exists, else the lexicographically first non-test file). Chosen over threading module
 * paths through the resolver: centrality is a signal, never a claim, and the suffix match is
 * bounded, pure, and wrong only toward MISSING edges plus the rare same-named-directory hit.
 * Single-segment specs (`fmt`, `os`) are dropped as stdlib.
 */
function resolveGo(spec: string, goDirs: ReadonlyMap<string, string[]>): string | null {
  const segs = spec.split('/').filter((s) => s.length > 0);
  if (segs.length < 2) return null;
  for (let k = Math.min(4, segs.length); k >= 1; k--) {
    const suffix = segs.slice(segs.length - k).join('/');
    const matches: string[] = [];
    for (const dir of goDirs.keys()) {
      if (dir === suffix || dir.endsWith(`/${suffix}`)) matches.push(dir);
    }
    if (matches.length === 0) continue;
    matches.sort();
    const dir = matches[0]!;
    const filesIn = goDirs.get(dir)!;
    const preferred = dir === '' ? `${segs[segs.length - 1]!}.go` : `${dir}/${segs[segs.length - 1]!}.go`;
    if (filesIn.includes(preferred)) return preferred;
    const nonTest = filesIn.find((f) => !f.endsWith('_test.go'));
    return nonTest ?? filesIn[0]!;
  }
  return null;
}

/**
 * C/C++ (Session 18): `#include` names resolve relative to the includer first (the quoted-form
 * rule), then against the conventional repo roots. The angle/quote distinction is deliberately
 * not preserved — for repo-internal headers both forms appear in the wild, and a wrong guess
 * costs a missing edge, never a wrong claim.
 */
function resolveC(fromRel: string, spec: string, files: ReadonlySet<string>): string | null {
  const relative = normalizePosix(posixDirname(fromRel) + '/' + spec);
  if (relative !== null && files.has(relative)) return relative;
  const plain = normalizePosix(spec);
  if (plain === null || plain.length === 0) return null;
  if (files.has(plain)) return plain;
  for (const root of ['include/', 'src/']) {
    if (files.has(root + plain)) return root + plain;
  }
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
  // Precomputed once: the go resolver matches directory suffixes, not per-file paths.
  const goDirs = goPackageDirs(allFiles);

  const resolveFor = (lang: NonNullable<GraphSource['lang']>, fromRel: string, spec: string): string | null => {
    switch (lang) {
      case 'ts':
        return resolveTs(fromRel, spec, allFiles);
      case 'py':
        return resolvePy(fromRel, spec, allFiles);
      case 'rust':
        return resolveRust(fromRel, spec, allFiles);
      case 'go':
        return resolveGo(spec, goDirs);
      case 'c-cpp':
        return resolveC(fromRel, spec, allFiles);
    }
  };

  for (const src of sources) {
    if (src.lang === null) continue;
    const targets: string[] = [];
    const seen = new Set<string>();
    for (const spec of src.imports) {
      const resolved = resolveFor(src.lang, src.relPath, spec);
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
