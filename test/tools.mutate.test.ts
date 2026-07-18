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
  it('replace_all replaces every occurrence and reports the count', async () => {
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'x foo y foo z foo');
    const r = await editFileTool.execute({ path: 'f.txt', old_string: 'foo', new_string: 'bar', replace_all: true }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('3 replacements');
    expect(fs.readFileSync(path.join(tmp, 'f.txt'), 'utf8')).toBe('x bar y bar z bar');
  });
  it('the non-unique failure reports the occurrence count and suggests replace_all', async () => {
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'dup dup');
    const r = await editFileTool.execute({ path: 'f.txt', old_string: 'dup', new_string: 'D' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('occurs 2 times');
    expect(r.error).toContain('replace_all');
    expect(fs.readFileSync(path.join(tmp, 'f.txt'), 'utf8')).toBe('dup dup'); // untouched on failure
  });
  it('rejects an empty old_string', async () => {
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'abc');
    const r = await editFileTool.execute({ path: 'f.txt', old_string: '', new_string: 'x' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('must not be empty');
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
    expect(r.error).toMatch(/occurs 2 times/);
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

  it('times out and kills the process: no exit code, honest termination', async () => {
    const cmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const r = await runCommandTool.execute({ command: cmd, timeoutMs: 400 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
    expect(r.termination).toBe('timeout');
    expect(r.exitCode).toBeUndefined();
    expect(r.killDetail).toMatch(/probe: dead/);
  }, 15000);

  it('is killed mid-run by the context AbortSignal (triggered by its own started evidence)', async () => {
    const controller = new AbortController();
    const events: import('../src/types.js').CommandEvidence[] = [];
    const cmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const r = await runCommandTool.execute(
      { command: cmd },
      {
        ...ctx,
        signal: controller.signal,
        reportCommand: (e) => {
          events.push(e);
          if (e.kind === 'started') controller.abort();
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.termination).toBe('aborted');
    expect(r.error).toMatch(/aborted by user/);
    expect(r.exitCode).toBeUndefined();
    const started = events.find((e) => e.kind === 'started');
    const ended = events.find((e) => e.kind === 'ended');
    expect(started && started.kind === 'started' && started.pid).toBeGreaterThan(0);
    expect(ended && ended.kind === 'ended' && ended.termination).toBe('aborted');
    expect(ended && ended.kind === 'ended' && ended.exitCode).toBeNull();
  }, 30000);

  it('spawns children with a filtered environment (secrets dropped, marker injected)', async () => {
    process.env['FAKE_API_KEY'] = 'super-secret-value';
    try {
      const cmd =
        process.platform === 'win32'
          ? 'echo "K=$env:FAKE_API_KEY;A=$env:AGENT_CLI"'
          : 'echo "K=$FAKE_API_KEY;A=$AGENT_CLI"';
      const r = await runCommandTool.execute({ command: cmd }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toMatch(/K=;A=1/);
      expect(r.output).not.toMatch(/super-secret-value/);
    } finally {
      delete process.env['FAKE_API_KEY'];
    }
  });

  it('does not connect stdin: a stdin-reading command completes instead of hanging', async () => {
    const cmd =
      process.platform === 'win32'
        ? '$x = [Console]::In.ReadToEnd(); echo "len=$($x.Length)"'
        : 'x=$(cat); echo "len=${#x}"';
    const r = await runCommandTool.execute({ command: cmd, timeoutMs: 8000 }, ctx);
    expect(r.termination).toBe('exited'); // a hang would surface as 'timeout'
  }, 20000);

  it('runs in the workspace root', async () => {
    fs.writeFileSync(path.join(tmp, 'marker.txt'), '');
    const cmd = process.platform === 'win32' ? 'Get-ChildItem -Name' : 'ls';
    const r = await runCommandTool.execute({ command: cmd }, ctx);
    expect(r.output).toMatch(/marker\.txt/);
  });
});
