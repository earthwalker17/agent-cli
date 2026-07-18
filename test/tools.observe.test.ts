import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileTool, listFilesTool, searchTool, toToolSchema } from '../src/tools/index.js';
import type { ToolContext } from '../src/types.js';

let tmp: string;
let ctx: ToolContext;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-tools-')));
  ctx = { workspaceRoot: tmp, stateDir: path.join(tmp, '..', 'state') };
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('read_file', () => {
  it('reads an existing file', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello world');
    const r = await readFileTool.execute({ path: 'a.txt' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('hello world');
  });
  it('fails clearly on a missing file', async () => {
    const r = await readFileTool.execute({ path: 'nope.txt' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });
  it('pages a file with offset/limit and labels the window', async () => {
    fs.writeFileSync(path.join(tmp, 'lines.txt'), Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join('\n'));
    const r = await readFileTool.execute({ path: 'lines.txt', offset: 10, limit: 3 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('[lines 10–12 of 50]\nline-10\nline-11\nline-12');
    const tail = await readFileTool.execute({ path: 'lines.txt', offset: 49 }, ctx);
    expect(tail.output).toBe('[lines 49–50 of 50]\nline-49\nline-50');
  });
  it('fails when offset is beyond the end of the file', async () => {
    fs.writeFileSync(path.join(tmp, 'short.txt'), 'one\ntwo');
    const r = await readFileTool.execute({ path: 'short.txt', offset: 10 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('beyond the end');
  });
  it('refuses to read a directory', async () => {
    fs.mkdirSync(path.join(tmp, 'dir'));
    const r = await readFileTool.execute({ path: 'dir' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/directory/);
  });
});

describe('list_files', () => {
  it('lists entries with a trailing slash on directories, sorted', async () => {
    fs.writeFileSync(path.join(tmp, 'b.txt'), '');
    fs.writeFileSync(path.join(tmp, 'a.txt'), '');
    fs.mkdirSync(path.join(tmp, 'sub'));
    const r = await listFilesTool.execute({}, ctx);
    expect(r.output.split('\n')).toEqual(['a.txt', 'b.txt', 'sub/']);
  });
});

describe('search', () => {
  it('finds matching lines with relpath:line prefixes', async () => {
    fs.writeFileSync(path.join(tmp, 'x.ts'), 'const a = 1;\nconst target = 2;\n');
    const r = await searchTool.execute({ pattern: 'target' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/x\.ts:2: const target = 2;/);
  });
  it('reports an invalid regex as a tool error', async () => {
    const r = await searchTool.execute({ pattern: '(' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid regular expression/);
  });
  it('excludes node_modules', async () => {
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    fs.writeFileSync(path.join(tmp, 'node_modules', 'dep.js'), 'needle');
    fs.writeFileSync(path.join(tmp, 'src.js'), 'needle');
    const r = await searchTool.execute({ pattern: 'needle' }, ctx);
    expect(r.output).toMatch(/src\.js/);
    expect(r.output).not.toMatch(/node_modules/);
  });
});

describe('toToolSchema', () => {
  it('derives additionalProperties:false and required from the zod source', () => {
    const s = toToolSchema(readFileTool);
    expect(s.name).toBe('read_file');
    expect(s.input_schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['path'],
    });
  });
});
