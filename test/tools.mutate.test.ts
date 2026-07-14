import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileTool, editFileTool } from '../src/tools/index.js';
import { runCommandTool } from '../src/tools/run-command.js';
import type { ToolContext } from '../src/types.js';

let tmp: string;
let ctx: ToolContext;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-mut-')));
  ctx = { workspaceRoot: tmp, stateDir: path.join(tmp, '..', 'state') };
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('write_file', () => {
  it('creates a file and reports bytes', async () => {
    const r = await writeFileTool.execute({ path: 'sub/a.txt', content: 'hello' }, ctx);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'sub', 'a.txt'), 'utf8')).toBe('hello');
    expect(r.output).toMatch(/created/);
  });
  it('declares its mutation plan as the resolved absolute path', () => {
    const plan = writeFileTool.mutates({ path: 'a.txt', content: 'x' }, ctx);
    expect(plan).toEqual({ paths: [path.join(tmp, 'a.txt')] });
  });
});

describe('edit_file', () => {
  it('replaces a unique occurrence', async () => {
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'alpha beta gamma');
    const r = await editFileTool.execute({ path: 'f.txt', old_string: 'beta', new_string: 'BETA' }, ctx);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'f.txt'), 'utf8')).toBe('alpha BETA gamma');
  });
  it('fails when old_string is absent', async () => {
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'alpha');
    const r = await editFileTool.execute({ path: 'f.txt', old_string: 'zzz', new_string: 'x' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });
  it('fails when old_string is not unique', async () => {
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'x x');
    const r = await editFileTool.execute({ path: 'f.txt', old_string: 'x', new_string: 'y' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not unique/);
  });
});

describe('run_command', () => {
  it('captures output and a zero exit code on success', async () => {
    const r = await runCommandTool.execute({ command: 'echo hello-world' }, ctx);
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/hello-world/);
  });

  it('propagates a nonzero exit code (no false success)', async () => {
    // A command that exits non-zero on every shell/platform.
    const cmd = process.platform === 'win32' ? 'exit 3' : 'exit 3';
    const r = await runCommandTool.execute({ command: cmd }, ctx);
    expect(r.exitCode).toBe(3);
    expect(r.ok).toBe(false);
  });

  it('propagates a failing native command inside PowerShell as nonzero ($LASTEXITCODE)', async () => {
    // `cmd /c exit 7` is a native process whose failure must not be masked as exit 0.
    const cmd = process.platform === 'win32' ? 'cmd /c exit 7' : 'sh -c "exit 7"';
    const r = await runCommandTool.execute({ command: cmd }, ctx);
    expect(r.exitCode).toBe(7);
    expect(r.ok).toBe(false);
  });

  it('times out and kills the process, returning ok:false', async () => {
    const cmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const r = await runCommandTool.execute({ command: cmd, timeoutMs: 400 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
  }, 15000);

  it('runs in the workspace root', async () => {
    fs.writeFileSync(path.join(tmp, 'marker.txt'), '');
    const cmd = process.platform === 'win32' ? 'Get-ChildItem -Name' : 'ls';
    const r = await runCommandTool.execute({ command: cmd }, ctx);
    expect(r.output).toMatch(/marker\.txt/);
  });
});
