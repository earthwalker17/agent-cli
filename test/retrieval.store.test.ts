import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInventory, listGitFiles } from '../src/retrieval/inventory.js';
import { loadOrBuildIndex, INDEX_VERSION, type RetrievalIndex } from '../src/retrieval/store.js';
import { findGitOnPath, runGit } from '../src/git/client.js';
import { detectGitFacts } from '../src/git/facts.js';
import type { Inventory, InventoryFile } from '../src/retrieval/inventory.js';
import { FIXTURE_GIT_TIMEOUT_MS, rmTemp } from './common.fixtures.js';

/** Session 10: the inventory (git-backed) and the persisted incremental index store. */

const REAL_GIT = findGitOnPath(process.env, process.platform);
const hasGit = REAL_GIT !== null;

let tmp: string;
let ws: string;
let indexFile: string;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-ridx-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  indexFile = path.join(tmp, 'state', 'index', 'retrieval.json');
});
afterEach(() => {
  rmTemp(tmp);
});

function writeFile(rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Fabricated inventory over the on-disk files (no git needed for store tests). */
function fabricateInventory(relPaths: string[], dirtyPaths: string[] = []): Inventory {
  const files: InventoryFile[] = [];
  for (const relPath of relPaths.sort()) {
    const st = fs.statSync(path.join(ws, relPath));
    files.push({ relPath, size: st.size, mtimeMs: st.mtimeMs });
  }
  return { files, dirtyPaths, inventorySha256: 'x'.repeat(64), capped: false };
}

describe.skipIf(!hasGit)('buildInventory (git-backed)', () => {
  async function initRepo(): Promise<void> {
    expect((await runGit({ gitPath: REAL_GIT!, argv: ['init', '-q', '-b', 'main'], cwd: ws, timeoutMs: FIXTURE_GIT_TIMEOUT_MS })).ok).toBe(true);
  }

  it('lists files with stats, digests the path SET, and reports dirty paths', async () => {
    await initRepo();
    writeFile('a.ts', 'export const a = 1;');
    writeFile('src/b.ts', 'export const b = 2;');
    const facts = await detectGitFacts(ws, { gitPath: REAL_GIT });
    const inv = await buildInventory(ws, facts);
    expect(inv).not.toBeNull();
    expect(inv!.files.map((f) => f.relPath)).toEqual(['a.ts', 'src/b.ts']);
    for (const f of inv!.files) expect(f.size).toBeGreaterThan(0);
    // Everything is untracked ⇒ dirty.
    expect(inv!.dirtyPaths).toEqual(['a.ts', 'src/b.ts']);
    expect(inv!.inventorySha256).toHaveLength(64);
  });

  it('the inventory digest is independent of content changes but changes on add/remove', async () => {
    await initRepo();
    writeFile('a.ts', 'v1');
    const facts = await detectGitFacts(ws, { gitPath: REAL_GIT });
    const d1 = (await buildInventory(ws, facts))!.inventorySha256;
    writeFile('a.ts', 'v2 — content changed, same path set');
    const d2 = (await buildInventory(ws, facts))!.inventorySha256;
    expect(d2).toBe(d1);
    writeFile('b.ts', 'new file');
    const d3 = (await buildInventory(ws, facts))!.inventorySha256;
    expect(d3).not.toBe(d1);
  });

  it('matches listGitFiles and returns null without a usable repo', async () => {
    const facts = await detectGitFacts(ws, { gitPath: REAL_GIT }); // not a repo
    expect(await listGitFiles(ws, facts)).toBeNull();
    expect(await buildInventory(ws, facts)).toBeNull();
  });
});

describe('loadOrBuildIndex', () => {
  it('cold build extracts eligible files, persists, and re-load is warm with zero extraction', () => {
    writeFile('a.ts', `import { b } from './b.js';\nexport function alpha() {}`);
    writeFile('b.ts', 'export const beta = 1;');
    writeFile('notes.md', '# not extractable');
    const inv = fabricateInventory(['a.ts', 'b.ts', 'notes.md']);

    const cold = loadOrBuildIndex({ indexFile, root: ws, inventory: inv, head: 'abc' });
    expect(cold.cache).toBe('cold');
    expect(cold.state).toBe('full');
    expect(cold.extracted).toBe(2);
    expect(cold.persisted).toBe(true);
    expect(cold.index.entries['a.ts']!.symbols.map((s) => s.name)).toContain('alpha');
    expect(cold.index.entries['notes.md']).toBeUndefined();
    expect(fs.existsSync(indexFile)).toBe(true);

    const warm = loadOrBuildIndex({ indexFile, root: ws, inventory: inv, head: 'abc' });
    expect(warm.cache).toBe('warm');
    expect(warm.extracted).toBe(0);
    expect(warm.index.generatedAt).toBe(cold.index.generatedAt); // untouched cache is not rewritten
  });

  it('re-extracts ONLY the changed file on a warm load', () => {
    writeFile('a.ts', 'export const a = 1;');
    writeFile('b.ts', 'export const b = 1;');
    loadOrBuildIndex({ indexFile, root: ws, inventory: fabricateInventory(['a.ts', 'b.ts']), head: null });

    // Touch b with different size (stat-diff key is size+mtime; size change is deterministic).
    writeFile('b.ts', 'export const b = 12345;');
    const warm = loadOrBuildIndex({ indexFile, root: ws, inventory: fabricateInventory(['a.ts', 'b.ts']), head: null });
    expect(warm.cache).toBe('warm');
    expect(warm.extracted).toBe(1);
  });

  it('corrupt or version-mismatched index files rebuild cold and never throw', () => {
    writeFile('a.ts', 'export const a = 1;');
    const inv = fabricateInventory(['a.ts']);
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });

    fs.writeFileSync(indexFile, '{ not json');
    expect(loadOrBuildIndex({ indexFile, root: ws, inventory: inv, head: null }).cache).toBe('cold');

    const future: RetrievalIndex = { version: INDEX_VERSION + 1, head: null, generatedAt: 'x', entries: {} };
    fs.writeFileSync(indexFile, JSON.stringify(future));
    const rebuilt = loadOrBuildIndex({ indexFile, root: ws, inventory: inv, head: null });
    expect(rebuilt.cache).toBe('cold');
    expect(rebuilt.extracted).toBe(1);
    // The rebuild rewrites the file at the CURRENT version.
    expect((JSON.parse(fs.readFileSync(indexFile, 'utf8')) as RetrievalIndex).version).toBe(INDEX_VERSION);
  });

  it('wall-budget exhaustion yields partial and CONVERGES on the next load', () => {
    for (let i = 0; i < 6; i++) writeFile(`f${i}.ts`, `export const v${i} = ${i};`);
    const inv = fabricateInventory(['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts']);

    // Injectable clock: every now() call advances far past the budget after the first file.
    let t = 0;
    const partial = loadOrBuildIndex({ indexFile, root: ws, inventory: inv, head: null, budgetMs: 5, now: () => (t += 4) });
    expect(partial.state).toBe('partial');
    expect(partial.skippedBudget).toBeGreaterThan(0);
    expect(partial.extracted).toBeLessThan(6);

    const converged = loadOrBuildIndex({ indexFile, root: ws, inventory: inv, head: null });
    expect(converged.state).toBe('full');
    expect(converged.extracted).toBe(6 - partial.extracted);
    expect(Object.keys(converged.index.entries).length).toBe(6);
  });

  it('budget-deferred CHANGED files carry their stale prior entry (partial, converges later)', () => {
    writeFile('a.ts', 'export const oldName = 1;');
    loadOrBuildIndex({ indexFile, root: ws, inventory: fabricateInventory(['a.ts']), head: null });
    // The file changes, but the warm load's budget expires before re-extraction.
    writeFile('a.ts', 'export const newName = 12345;');
    let t = 0;
    const partial = loadOrBuildIndex({ indexFile, root: ws, inventory: fabricateInventory(['a.ts']), head: null, budgetMs: 1, now: () => (t += 5) });
    expect(partial.state).toBe('partial');
    // Stale-but-present beats absent for ranking; the disclosure ('partial') covers it.
    expect(partial.index.entries['a.ts']!.symbols.map((s) => s.name)).toContain('oldName');
    const converged = loadOrBuildIndex({ indexFile, root: ws, inventory: fabricateInventory(['a.ts']), head: null });
    expect(converged.state).toBe('full');
    expect(converged.index.entries['a.ts']!.symbols.map((s) => s.name)).toContain('newName');
  });

  it('skips secret-named files entirely and marks binary files unextractable', () => {
    writeFile('config/secret.key.ts', 'export const k = 1;'); // basename contains "secret"
    writeFile('bin.ts', 'x'); // will be overwritten binary
    fs.writeFileSync(path.join(ws, 'bin.ts'), Buffer.from([0x65, 0x00, 0x66, 0x67]));
    writeFile('ok.ts', 'export const fine = 1;');
    const inv = fabricateInventory(['bin.ts', 'config/secret.key.ts', 'ok.ts']);
    const r = loadOrBuildIndex({ indexFile, root: ws, inventory: inv, head: null });
    expect(r.index.entries['config/secret.key.ts']).toBeUndefined();
    expect(r.index.entries['bin.ts']!.lang).toBeNull();
    expect(r.index.entries['bin.ts']!.symbols).toEqual([]);
    expect(r.index.entries['ok.ts']!.lang).toBe('ts');
    // Config secretPatterns narrow further.
    const r2 = loadOrBuildIndex({
      indexFile: indexFile + '.2',
      root: ws,
      inventory: inv,
      head: null,
      rules: { protectedPaths: [], secretPatterns: ['ok.'], envExcludePatterns: [], researchBlockedDomains: [], remoteBlockedHosts: [] },
    });
    expect(r2.index.entries['ok.ts']).toBeUndefined();
  });

  it('drops entries for files no longer in the inventory', () => {
    writeFile('a.ts', 'export const a = 1;');
    writeFile('b.ts', 'export const b = 1;');
    loadOrBuildIndex({ indexFile, root: ws, inventory: fabricateInventory(['a.ts', 'b.ts']), head: null });
    const shrunk = loadOrBuildIndex({ indexFile, root: ws, inventory: fabricateInventory(['a.ts']), head: null });
    expect(Object.keys(shrunk.index.entries)).toEqual(['a.ts']);
    const onDisk = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as RetrievalIndex;
    expect(Object.keys(onDisk.entries)).toEqual(['a.ts']);
  });

  it('a read-only index location degrades to persisted:false without blocking', () => {
    writeFile('a.ts', 'export const a = 1;');
    const inv = fabricateInventory(['a.ts']);
    // Point the index file AT a directory: mkdir succeeds, rename cannot replace a dir.
    const dirAsFile = path.join(tmp, 'state', 'index', 'retrieval.json');
    fs.mkdirSync(dirAsFile, { recursive: true });
    const r = loadOrBuildIndex({ indexFile: dirAsFile, root: ws, inventory: inv, head: null });
    expect(r.persisted).toBe(false);
    expect(r.index.entries['a.ts']).toBeDefined(); // in-memory index still serves the session
  });
});
