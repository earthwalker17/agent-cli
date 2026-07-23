import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../src/shared/hash.js';
import { buildImportGraph } from '../src/retrieval/graph.js';
import { loadOrBuildIndex } from '../src/retrieval/store.js';
import { buildRetrievalHandle, rankForQuery, rankStructural, queryTerms, type RetrievalHandle } from '../src/retrieval/rank.js';
import { renderRepoMap } from '../src/retrieval/render.js';
import type { Inventory, InventoryFile } from '../src/retrieval/inventory.js';

/** Session 10: graph resolution, structural + query ranking, and the tiered map render. */

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-rank-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write files, then fabricate the inventory (no git needed) and build a live handle. */
function makeHandle(files: Record<string, string>, dirtyPaths: string[] = []): RetrievalHandle {
  const inv: InventoryFile[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    const st = fs.statSync(abs);
    inv.push({ relPath: rel, size: st.size, mtimeMs: st.mtimeMs });
  }
  inv.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  const inventory: Inventory = {
    files: inv,
    dirtyPaths,
    inventorySha256: sha256(inv.map((f) => f.relPath).join('\n')),
    capped: false,
  };
  const build = loadOrBuildIndex({ indexFile: path.join(tmp, 'state', 'retrieval.json'), root: tmp, inventory, head: null });
  return buildRetrievalHandle(tmp, inventory, build);
}

describe('buildImportGraph', () => {
  it('resolves relative TS specifiers with .js→.ts NodeNext guessing and index files', () => {
    const files = new Set(['src/a.ts', 'src/b.ts', 'src/util/index.ts', 'src/c.tsx']);
    const g = buildImportGraph(
      [{ relPath: 'src/a.ts', lang: 'ts', imports: ['./b.js', './util', './c.js', 'node:fs', 'zod'] }],
      files,
    );
    expect(g.edges.get('src/a.ts')).toEqual(['src/b.ts', 'src/util/index.ts', 'src/c.tsx']);
    expect(g.inDegree.get('src/b.ts')).toBe(1);
  });

  it('resolves python relative and absolute module specifiers', () => {
    const files = new Set(['pkg/mod.py', 'pkg/sibling.py', 'pkg/sub/__init__.py', 'top.py']);
    const g = buildImportGraph([{ relPath: 'pkg/mod.py', lang: 'py', imports: ['.sibling', '.sub', 'top', 'os.path'] }], files);
    expect(g.edges.get('pkg/mod.py')).toEqual(['pkg/sibling.py', 'pkg/sub/__init__.py', 'top.py']);
  });

  it('a hub imported by many outranks a leaf in pagerank', () => {
    const files = new Set(['hub.ts', 'a.ts', 'b.ts', 'c.ts', 'leaf.ts']);
    const g = buildImportGraph(
      [
        { relPath: 'a.ts', lang: 'ts', imports: ['./hub.js'] },
        { relPath: 'b.ts', lang: 'ts', imports: ['./hub.js'] },
        { relPath: 'c.ts', lang: 'ts', imports: ['./hub.js', './leaf.js'] },
      ],
      files,
    );
    expect(g.pagerank.get('hub.ts')!).toBeGreaterThan(g.pagerank.get('leaf.ts')!);
    expect(g.pagerank.get('hub.ts')!).toBeGreaterThan(g.pagerank.get('a.ts')!);
  });
});

describe('rankStructural', () => {
  it('boosts dirty files and hubs; penalizes tests; deterministic tie-break', () => {
    const handle = makeHandle(
      {
        'src/core.ts': 'export function core() {}',
        'src/a.ts': `import { core } from './core.js';`,
        'src/b.ts': `import { core } from './core.js';`,
        'src/c.ts': `import { core } from './core.js';`,
        'test/core.test.ts': `import { core } from '../src/core.js';`,
        'src/touched.ts': 'export const t = 1;',
      },
      ['src/touched.ts'],
    );
    const ranked = rankStructural(handle, 10);
    const pos = (p: string): number => ranked.findIndex((r) => r.relPath === p);
    expect(pos('src/core.ts')).toBeLessThan(pos('src/a.ts'));
    expect(pos('src/touched.ts')).toBeLessThan(pos('src/a.ts'));
    expect(pos('test/core.test.ts')).toBeGreaterThan(pos('src/core.ts'));
    const touched = ranked[pos('src/touched.ts')]!;
    expect(touched.signals).toContain('uncommitted changes');
    const core = ranked[pos('src/core.ts')]!;
    expect(core.signals).toContain('imported by 4 files');
  });
});

describe('rankForQuery', () => {
  function corpus(): RetrievalHandle {
    return makeHandle({
      'src/runtime/elision.ts': 'export function elideHistory() {}\nexport const DEFAULT_TRIGGER_CHARS = 1;',
      'src/runtime/session.ts': `import { elideHistory } from './elision.js';\nexport function runTurn() {}`,
      'src/tools/index.ts': 'export const TOOLS = [];',
      'docs/elision-notes.md': 'notes about elision',
      'src/unrelated.ts': 'export const nothing = 1;',
    });
  }

  it('planted file beats decoys, with symbol/path signals attributed on every hit', () => {
    const hits = rankForQuery(corpus(), 'how does history elision work?');
    expect(hits[0]!.relPath).toBe('src/runtime/elision.ts');
    expect(hits[0]!.signals.some((s) => s.includes('elision') || s.includes('elideHistory'))).toBe(true);
    for (const h of hits) expect(h.signals.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.relPath)).not.toContain('src/unrelated.ts');
  });

  it('graph neighbors of the top hit get a boost with an attribution', () => {
    const hits = rankForQuery(corpus(), 'elision');
    const session = hits.find((h) => h.relPath === 'src/runtime/session.ts');
    expect(session).toBeDefined();
    expect(session!.signals).toContain('imports src/runtime/elision.ts');
  });

  it('scope_paths filters and the limit caps', () => {
    const hits = rankForQuery(corpus(), 'elision', { scopePaths: ['docs'], limit: 1 });
    expect(hits.length).toBe(1);
    expect(hits[0]!.relPath).toBe('docs/elision-notes.md');
  });

  it('is deterministic', () => {
    const a = rankForQuery(corpus(), 'elision history');
    const b = rankForQuery(corpus(), 'elision history');
    expect(a).toEqual(b);
  });

  it('queryTerms drops stopwords and short terms', () => {
    expect(queryTerms('How does THE history elision work in a file?')).toEqual(expect.arrayContaining(['history', 'elision', 'work']));
    expect(queryTerms('the and for')).toEqual([]);
  });
});

describe('renderRepoMap', () => {
  function bigHandle(): RetrievalHandle {
    const files: Record<string, string> = {
      'package.json': '{}',
      'README.md': 'readme',
      'src/index.ts': `import { a } from './deep/a.js';`,
      'src/deep/a.ts': 'export function a() {}',
    };
    for (let i = 0; i < 40; i++) files[`src/deep/nested/level/mod${i}.ts`] = `export const m${i} = ${i};`;
    return makeHandle(files, ['src/index.ts']);
  }

  it('renders all tiers: coverage header, dirty tier, complete layout, ranked files, footer', () => {
    const r = renderRepoMap(bigHandle());
    expect(r.text).toContain('Repository map — ranked overview');
    expect(r.text).toContain('symbols indexed for');
    expect(r.text).toContain('Uncommitted (active) files:');
    expect(r.text).toContain('  src/index.ts');
    expect(r.text).toContain('Layout (every directory, with file counts):');
    expect(r.text).toMatch(/src\/ \(\d+ files\)/);
    expect(r.text).toContain('Key files (ranked by imports, structure, and git state):');
    expect(r.text).toContain('package.json');
    expect(r.text).toContain('retrieve');
  });

  it('respects the budget at several sizes and stays deterministic', () => {
    const handle = bigHandle();
    for (const budget of [1200, 4000, 16000]) {
      const r1 = renderRepoMap(handle, { budget });
      const r2 = renderRepoMap(handle, { budget });
      expect(r1.text).toBe(r2.text);
      expect(r1.text.length).toBeLessThanOrEqual(budget + 400); // tree tier + markers have small fixed overhead
    }
    // Smaller budgets must not lose the layout tier (the recall backstop).
    const tiny = renderRepoMap(handle, { budget: 1200 });
    expect(tiny.text).toContain('Layout (every directory, with file counts):');
    expect(tiny.truncated).toBe(true);
  });

  it('sanitizes control characters in paths', () => {
    const handle = makeHandle({ 'src/ok.ts': 'export const a = 1;' });
    // Fabricate a hostile path entry directly on the inventory (git can produce odd names).
    handle.inventory.files.push({ relPath: 'evil\u001b[31mred.ts', size: 1, mtimeMs: 0 });
    handle.structural.set('evil\u001b[31mred.ts', { score: 999, signals: [] });
    const r = renderRepoMap(handle);
    expect(r.text).not.toContain('\u001b');
    expect(r.text).toContain('red.ts'); // still listed, just neutralized
  });
});
