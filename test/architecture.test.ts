import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The module-boundary pin (S20.5) — the limits.test.ts idea applied to STRUCTURE: the shape of
 * src/ was audited (171 files, 28 flat modules, four cycles) and the verdict was that the flat
 * tree is the right design but its boundaries were eroding invisibly. This file freezes the
 * INVARIANTS, not the full edge matrix — a matrix breaks on every legitimate new import and
 * degrades into a change log nobody reads.
 *
 * Rules, each with its reason:
 *  1. No `../../` imports. Depth is exactly src/<module>/<file>.ts, and a two-level ascent
 *     means a file is reaching around the module structure instead of through it.
 *  2. shared/ is a LEAF: it imports node builtins and itself, nothing else. Everything depends
 *     on shared/, so one outward edge from it can quietly become a cycle through anything.
 *  3. Module CYCLES are a frozen, removal-only set. Two are deliberate and documented:
 *     runtime↔tools (the registry seam: runTurn needs the tool table, delegate needs the child
 *     runner) and cli↔repl (the wiring hub: the REPL consumes assembleSession, the CLI mounts
 *     the REPL). FIXING one of these passes this test; ADDING any other fails it. The other two
 *     cycles the audit found (plan↔memory, retrieval↔workspace) were cut in this session — they
 *     must not come back.
 *  4. sandbox/ is imported from outside only via its index (the one module with a real entry
 *     point — its internals are an OS-security boundary whose surface should stay deliberate).
 */

const SRC = path.resolve(__dirname, '..', 'src');

interface Edge {
  fromFile: string;
  fromModule: string;
  toModule: string;
  spec: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function moduleOf(relFile: string): string {
  const parts = relFile.split(/[\\/]/);
  return parts.length === 1 ? 'types' : parts[0]!;
}

const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;

function collect(): { files: string[]; edges: Edge[]; specs: { fromFile: string; spec: string }[] } {
  const files = walk(SRC);
  const edges: Edge[] = [];
  const specs: { fromFile: string; spec: string }[] = [];
  for (const file of files) {
    const rel = path.relative(SRC, file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1]!;
      if (!spec.startsWith('.')) continue; // node builtins + deps are out of scope here
      specs.push({ fromFile: rel, spec });
      const resolved = path.relative(SRC, path.resolve(path.dirname(file), spec));
      const from = moduleOf(rel);
      const to = moduleOf(resolved);
      if (from !== to) edges.push({ fromFile: rel, fromModule: from, toModule: to, spec });
    }
  }
  return { files, edges, specs };
}

/** Tarjan SCCs over the module graph — catches 3+-module cycles a pairwise check would miss. */
function stronglyConnected(edges: Edge[]): string[][] {
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adj.has(e.fromModule)) adj.set(e.fromModule, new Set());
    adj.get(e.fromModule)!.add(e.toModule);
    if (!adj.has(e.toModule)) adj.set(e.toModule, new Set());
  }
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  const strongconnect = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      if (scc.length > 1) sccs.push(scc.sort());
    }
  };
  for (const v of adj.keys()) if (!idx.has(v)) strongconnect(v);
  return sccs;
}

/** REMOVAL-ONLY: fixing a frozen cycle passes; adding any cycle fails with a named reason. */
const FROZEN_CYCLES: string[][] = [
  ['cli', 'repl'], // the wiring hub: repl consumes assembleSession; the CLI mounts the REPL
  ['runtime', 'tools'], // the registry seam: runTurn needs TOOLS; delegate needs the child runner
];

describe('module boundaries (S20.5) — invariants, not an edge matrix', () => {
  const { edges, specs } = collect();

  it('no import ascends two levels — the tree is exactly src/<module>/<file>', () => {
    const deep = specs.filter((s) => s.spec.includes('../../'));
    expect(deep, deep.map((d) => `${d.fromFile} → ${d.spec}`).join('\n')).toEqual([]);
  });

  it('shared/ is a LEAF: it imports nothing outside itself', () => {
    const out = edges.filter((e) => e.fromModule === 'shared');
    expect(out, out.map((e) => `${e.fromFile} → ${e.spec}`).join('\n')).toEqual([]);
  });

  it('module cycles are a frozen, removal-only set', () => {
    const frozen = new Set(FROZEN_CYCLES.map((c) => [...c].sort().join('+')));
    const found = stronglyConnected(edges);
    for (const scc of found) {
      expect(
        frozen.has(scc.join('+')),
        `NEW module cycle: {${scc.join(' ↔ ')}} — either break it or make freezing it an explicit, argued decision here`,
      ).toBe(true);
    }
    // Removal-only bookkeeping: if a frozen cycle no longer exists, prune it from the list so
    // the freeze cannot silently re-authorize its return.
    const foundKeys = new Set(found.map((c) => c.join('+')));
    for (const f of frozen) {
      expect(foundKeys.has(f), `frozen cycle {${f}} no longer exists — remove it from FROZEN_CYCLES`).toBe(true);
    }
  });

  it('sandbox/ is imported from outside only through its entry point', () => {
    const inward = edges.filter((e) => e.toModule === 'sandbox' && e.fromModule !== 'sandbox');
    const offenders = inward.filter((e) => !/sandbox\/index(\.js)?$/.test(e.spec));
    expect(offenders, offenders.map((e) => `${e.fromFile} → ${e.spec}`).join('\n')).toEqual([]);
  });
});

describe('release surface (S22.5)', () => {
  it('the Node floor guard is the FIRST import, and imports nothing itself (S22.6)', () => {
    // The guard's whole promise is that it runs before anything else. ESM evaluates imports in
    // source order and BEFORE the importing module's body, so that promise holds only while
    // `./node-floor.js` is literally the first import of the entry point and node-floor itself
    // pulls in nothing. Either fact silently reverting turns the friendly "upgrade Node" line
    // back into whatever cryptic error the module graph produces first on an old runtime.
    const entry = fs.readFileSync(path.join(SRC, 'cli', 'index.ts'), 'utf8');
    const firstImport = entry.match(/^import\s.*$/m)?.[0] ?? '';
    expect(firstImport).toContain('./node-floor.js');

    const floor = fs.readFileSync(path.join(SRC, 'cli', 'node-floor.ts'), 'utf8');
    expect(floor.match(/^import\s/m), 'node-floor.ts must import nothing — an import runs before it').toBeNull();
    expect(floor).toContain('process.exit(1)');
  });

  it('package-lock.json records the same version as package.json', () => {
    // The lockfile version is stamped only when `npm install` runs after a bump; it sat at
    // 1.4.0 through six releases. Drift is invisible until someone reads the lockfile and
    // concludes the tree is older than it is — regenerate it as part of every version bump.
    const root = path.resolve(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
  });

  it('every GitHub Action is pinned to a commit SHA (S22.8)', () => {
    // A `@v7` tag is mutable: whoever controls the action can repoint it, and the next CI run
    // executes different code against this repository with no diff here to show it. The HOL
    // plugin scanner flagged exactly this (Operational Security, 0/5) and it was a fair hit —
    // these workflows run on `pull_request`, so an unpinned action is reachable from a fork PR.
    // The `# vX.Y.Z` comment after each pin is the human-readable half; the SHA is the contract.
    const dir = path.resolve(__dirname, '..', '.github', 'workflows');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    expect(files.length, 'no workflows found — has the path moved?').toBeGreaterThan(0);

    const unpinned: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const uses = line.match(/^\s*-?\s*uses:\s*(\S+)/)?.[1];
        if (uses === undefined || uses.startsWith('./')) continue; // local composite actions
        if (!/@[0-9a-f]{40}$/.test(uses)) unpinned.push(`${file}: ${uses}`);
      }
    }
    expect(unpinned, `unpinned actions: ${unpinned.join(', ')}`).toEqual([]);
  });

  it('the HOL scanner workflow keeps the shape the catalog gate reads (S22.8)', () => {
    // The awesome-ai-plugins validator does not run our workflow — it fetches this file and
    // asserts two things about the YAML: that some step `uses:` the scanner action, and that
    // the workflow triggers on push or pull_request. Both are easy to break while "tidying"
    // (renaming the file is fine; dropping the trigger or the action reference is not).
    // `contents: read` is pinned here for the reason SCANNER_GUIDE.md gives: this job needs no
    // secrets and no write scope, and a widened token is the thing worth noticing in review.
    const wf = path.resolve(__dirname, '..', '.github', 'workflows', 'hol-plugin-scanner.yml');
    const text = fs.readFileSync(wf, 'utf8').replace(/\r\n/g, '\n');
    expect(text).toMatch(/uses:\s*hashgraph-online\/ai-plugin-scanner-action@[0-9a-f]{40}/);
    expect(text).toMatch(/^\s{2}pull_request:/m);
    expect(text).toMatch(/^permissions:\n\s{2}contents: read\n/m);
    expect(text, 'no other top-level permission may be granted').not.toMatch(
      /^permissions:\n(?:\s{2}\w[\w-]*:.*\n){2,}/m,
    );
  });
});
