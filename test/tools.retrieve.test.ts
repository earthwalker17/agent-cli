import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createRetrieveTool } from '../src/tools/retrieve.js';
import { childTools } from '../src/runtime/subagent.js';
import { ROLE_CONTRACTS } from '../src/runtime/roles.js';
import { decide, Grants } from '../src/policy/engine.js';
import { loadOrBuildIndex } from '../src/retrieval/store.js';
import { buildRetrievalHandle, type RetrievalHandle } from '../src/retrieval/rank.js';
import { sha256 } from '../src/shared/hash.js';
import type { Inventory, InventoryFile } from '../src/retrieval/inventory.js';
import type { Tool, ToolContext } from '../src/types.js';

/** Session 10: the retrieve tool — policy shape, live excerpts, honest drops, child admission. */

let tmp: string;
let ws: string;
let ctx: ToolContext;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-ret-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  ctx = { workspaceRoot: ws, stateDir: path.join(tmp, 'state') };
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function makeHandle(files: Record<string, string>, dirtyPaths: string[] = []): RetrievalHandle {
  const inv: InventoryFile[] = [];
  for (const [rel, content] of Object.entries(files)) {
    writeFile(rel, content);
    const st = fs.statSync(path.join(ws, rel));
    inv.push({ relPath: rel, size: st.size, mtimeMs: st.mtimeMs });
  }
  inv.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  const inventory: Inventory = {
    files: inv,
    dirtyPaths,
    inventorySha256: sha256(inv.map((f) => f.relPath).join('\n')),
    capped: false,
  };
  const build = loadOrBuildIndex({ indexFile: path.join(tmp, 'state', 'retrieval.json'), root: ws, inventory, head: 'headsha' });
  return buildRetrievalHandle(ws, inventory, build);
}

describe('retrieve — policy shape', () => {
  it('classifies observe/allow with no scope, and asks for an out-of-workspace scope path', () => {
    const tool = createRetrieveTool(makeHandle({ 'a.ts': 'export const a = 1;' }));
    const allow = decide(tool, { query: 'anything' }, ctx, new Grants());
    expect(allow).toMatchObject({ classification: 'observe', decision: 'allow' });
    const outside = decide(tool, { query: 'x', scope_paths: [path.join('..', '..', 'etc')] }, ctx, new Grants());
    expect(outside.decision).toBe('ask');
    expect(outside.classification).toBe('sensitive');
  });

  it('declares no command/delegates/planDoc and an empty mutation plan (read-only by construction)', () => {
    const tool = createRetrieveTool(makeHandle({ 'a.ts': 'export const a = 1;' }));
    expect(tool.command).toBeUndefined();
    expect(tool.delegates).toBeUndefined();
    expect(tool.planDoc).toBeUndefined();
    expect(tool.mutates({ query: 'x' }, ctx)).toEqual({ paths: [] });
  });

  it('.strict() schema rejects unknown keys', () => {
    const tool = createRetrieveTool(makeHandle({ 'a.ts': 'export const a = 1;' }));
    expect(tool.schema.safeParse({ query: 'x', sneaky: true }).success).toBe(false);
    expect(tool.schema.safeParse({ query: 'x' }).success).toBe(true);
  });
});

describe('retrieve — output', () => {
  it('returns ranked hits with signals, symbols, live excerpts, and a coverage header/footer', async () => {
    const tool = createRetrieveTool(
      makeHandle({
        'src/elision.ts': 'export function elideHistory() {}\nconst related = 1;\n',
        'src/session.ts': `import { elideHistory } from './elision.js';\n`,
        'src/other.ts': 'export const unrelated = 1;\n',
      }),
    );
    const r = await tool.execute({ query: 'elision history budget' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('retrieval over 3 files');
    expect(r.output).toContain('1. src/elision.ts');
    expect(r.output).toMatch(/filename contains 'elision'|defines 'elideHistory'/);
    expect(r.output).toContain('symbols: elideHistory');
    expect(r.output).toMatch(/1: export function elideHistory/); // live excerpt with line number
    expect(r.output).toContain('excerpts read live from disk');
    expect(r.output).toContain('(head headsha)');
  });

  it('excerpts reflect the CURRENT disk bytes, not the index (edit-after-index)', async () => {
    const handle = makeHandle({ 'src/thing.ts': 'export const thing = 1;\n' });
    // The file changes AFTER the index/handle was built.
    writeFile('src/thing.ts', 'const pad = 0;\nexport const thing = 999; // fresh bytes\n');
    const tool = createRetrieveTool(handle);
    const r = await tool.execute({ query: 'thing' }, ctx);
    expect(r.output).toContain('2: export const thing = 999; // fresh bytes');
    expect(r.output).not.toContain('1: export const thing = 1;');
  });

  it('drops hits whose files vanished, honestly counted in the footer', async () => {
    const handle = makeHandle({ 'src/gone.ts': 'export const target = 1;\n', 'src/stays.ts': 'export const target2 = 2;\n' });
    fs.rmSync(path.join(ws, 'src', 'gone.ts'));
    const tool = createRetrieveTool(handle);
    const r = await tool.execute({ query: 'target' }, ctx);
    expect(r.output).not.toContain('src/gone.ts');
    expect(r.output).toContain('src/stays.ts');
    expect(r.output).toContain('dropped (files no longer on disk');
  });

  it('omits secret-named hits (config secretPatterns respected) and never excerpts them', async () => {
    const handle = makeHandle({ 'notes/private-stuff.ts': 'export const apiThing = 1;\n', 'src/api.ts': 'export const apiMain = 2;\n' });
    const tool = createRetrieveTool(handle);
    const rules = { protectedPaths: [], secretPatterns: ['private-'], envExcludePatterns: [], researchBlockedDomains: [], remoteBlockedHosts: [] };
    const r = await tool.execute({ query: 'api' }, { ...ctx, rules });
    expect(r.output).not.toContain('private-stuff');
    expect(r.output).toContain('secret-named file(s) omitted');
    expect(r.output).toContain('src/api.ts');
  });

  it('max_results caps hits and zero matches degrade with honest guidance', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`src/widget${i}.ts`] = `export const widget${i} = ${i};\n`;
    const tool = createRetrieveTool(makeHandle(files));
    const capped = await tool.execute({ query: 'widget', max_results: 3 }, ctx);
    expect(capped.output).toContain('3 hit(s)');
    expect(capped.output).toContain('3. ');
    expect(capped.output).not.toContain('4. ');
    const none = await tool.execute({ query: 'zzznothing' }, ctx);
    expect(none.output).toContain('0 hit(s)');
    expect(none.output).toContain('no matches');
  });
});

describe('retrieve — child admission (childTools)', () => {
  const fakeRetrieve = (extra: Partial<Tool<{ query: string }>> = {}): Tool<{ query: string }> => ({
    name: 'retrieve',
    description: '',
    schema: z.object({ query: z.string() }),
    mutates: () => ({ paths: [] }),
    execute: async () => ({ ok: true, output: '', truncated: false, durationMs: 0 }),
    ...extra,
  });

  it('read-only roles name retrieve; the executor does not', () => {
    expect(ROLE_CONTRACTS.explorer.toolNames).toContain('retrieve');
    expect(ROLE_CONTRACTS.planner.toolNames).toContain('retrieve');
    expect(ROLE_CONTRACTS.reviewer.toolNames).toContain('retrieve');
    expect(ROLE_CONTRACTS.executor.toolNames).not.toContain('retrieve');
  });

  it('admits the instance for roles that name it; executor registry never receives it', () => {
    const t = fakeRetrieve();
    expect(childTools(ROLE_CONTRACTS.explorer.toolNames, { retrieve: t }).map((x) => x.name)).toContain('retrieve');
    expect(childTools(ROLE_CONTRACTS.executor.toolNames, { retrieve: t }).map((x) => x.name)).not.toContain('retrieve');
    expect(childTools(ROLE_CONTRACTS.explorer.toolNames, {}).map((x) => x.name)).not.toContain('retrieve');
  });

  it('FAIL-CLOSED: a command/delegates/planDoc-bearing instance is dropped, never admitted', () => {
    for (const bad of [
      fakeRetrieve({ command: () => 'evil' }),
      fakeRetrieve({ delegates: () => ({ roles: ['explorer'] }) }),
      fakeRetrieve({ planDoc: () => true as never }),
    ]) {
      expect(childTools(ROLE_CONTRACTS.explorer.toolNames, { retrieve: bad }).map((x) => x.name)).not.toContain('retrieve');
    }
  });

  it('the real tool instance passes admission', () => {
    const tool = createRetrieveTool(makeHandle({ 'a.ts': 'export const a = 1;' }));
    expect(childTools(ROLE_CONTRACTS.explorer.toolNames, { retrieve: tool }).map((x) => x.name)).toContain('retrieve');
  });
});
