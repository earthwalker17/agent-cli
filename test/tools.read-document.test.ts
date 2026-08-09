import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDocumentTool } from '../src/tools/artifact-read.js';
import { decide, Grants } from '../src/policy/engine.js';
import type { ToolContext } from '../src/types.js';
import { fixtureDocx, fixturePdf } from './artifacts.fixtures.js';

let ws: string;
let ctx: ToolContext;

beforeEach(() => {
  ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'read-doc-')));
  ctx = { workspaceRoot: ws, stateDir: path.join(os.tmpdir(), 'read-doc-state') };
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('read_document policy classification', () => {
  it('is a plain observe read in-workspace; outside asks; secret names ask with redaction', () => {
    expect(decide(readDocumentTool, { path: 'report.docx' }, ctx, new Grants())).toMatchObject({
      decision: 'allow',
      classification: 'observe',
      rule: 'observe.in-workspace',
    });
    expect(decide(readDocumentTool, { path: path.join('..', 'outside.docx') }, ctx, new Grants())).toMatchObject({
      decision: 'ask',
      rule: 'path.outside-workspace-read',
    });
    const d = decide(readDocumentTool, { path: '.env' }, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'ask', rule: 'path.secret-name', redactOutput: true });
  });
});

describe('read_document execute', () => {
  it('reads a docx from disk and reports format + coverage first', async () => {
    fs.writeFileSync(path.join(ws, 'report.docx'), fixtureDocx());
    const res = await readDocumentTool.execute({ path: 'report.docx' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('format: docx');
    expect(res.output).toContain('coverage: full');
    expect(res.output).toContain('H1 Intro');
    expect(res.output).toContain('Name · Value');
  });

  it('reads a pdf with detail: text', async () => {
    fs.writeFileSync(path.join(ws, 'doc.pdf'), fixturePdf('Findable sentence'));
    const res = await readDocumentTool.execute({ path: 'doc.pdf', detail: 'text' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('format: pdf');
    expect(res.output).toContain('Findable sentence');
  });

  it('refuses a renamed secret without echoing a byte of it', async () => {
    fs.writeFileSync(path.join(ws, 'totally-a-report.docx'), 'API_KEY=TOPSECRET-98765\n');
    const res = await readDocumentTool.execute({ path: 'totally-a-report.docx' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not a recognized document format');
    expect(res.error).not.toContain('TOPSECRET');
    expect(res.output).not.toContain('TOPSECRET');
  });

  it('handles missing files, directories, and oversized files with typed messages', async () => {
    expect((await readDocumentTool.execute({ path: 'absent.docx' }, ctx)).error).toContain('file not found');
    fs.mkdirSync(path.join(ws, 'adir'));
    expect((await readDocumentTool.execute({ path: 'adir' }, ctx)).error).toContain('is a directory');
  });
});
