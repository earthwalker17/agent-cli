import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWorkspaceMap } from '../src/workspace/map.js';
import { buildSystemPrompt } from '../src/workspace/system-prompt.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-ws-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('buildWorkspaceMap', () => {
  it('lists workspace files, excluding node_modules/.git', () => {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), '');
    fs.writeFileSync(path.join(tmp, 'README.md'), '');
    fs.mkdirSync(path.join(tmp, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'node_modules', 'dep', 'x.js'), '');
    fs.mkdirSync(path.join(tmp, '.git'));
    fs.writeFileSync(path.join(tmp, '.git', 'config'), '');

    const map = buildWorkspaceMap(tmp);
    expect(map.text.split('\n').sort()).toEqual(['README.md', 'src/a.ts']);
    expect(map.fileCount).toBe(2);
    expect(map.sha256).toHaveLength(64);
  });

  it('honors the root .gitignore', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'secret.txt\nbuild/\n');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), '');
    fs.writeFileSync(path.join(tmp, 'keep.txt'), '');
    fs.mkdirSync(path.join(tmp, 'build'));
    fs.writeFileSync(path.join(tmp, 'build', 'out.js'), '');

    const map = buildWorkspaceMap(tmp);
    expect(map.text).toContain('keep.txt');
    expect(map.text).not.toContain('secret.txt');
    expect(map.text).not.toContain('out.js');
    // .gitignore itself is a normal file and is listed.
    expect(map.text).toContain('.gitignore');
  });

  it('is deterministic for identical trees', () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), '');
    fs.writeFileSync(path.join(tmp, 'b.txt'), '');
    expect(buildWorkspaceMap(tmp).sha256).toBe(buildWorkspaceMap(tmp).sha256);
  });

  it('truncates to the char budget and flags it', () => {
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(tmp, `file-${i}.txt`), '');
    const map = buildWorkspaceMap(tmp, { budget: 100 });
    expect(map.truncated).toBe(true);
    expect(map.text.length).toBeLessThanOrEqual(160);
  });
});

describe('buildSystemPrompt', () => {
  it('with no enforced sandbox, states honestly that NO command auto-runs and nothing is contained', () => {
    const map = buildWorkspaceMap(tmp);
    const sys = buildSystemPrompt(tmp, map);
    expect(sys).toMatch(/NO OS sandbox active/i);
    expect(sys).toMatch(/NO command auto-runs/i);
    expect(sys).toContain(tmp);
  });
  it('with an enforced windows-lowil sandbox, explains auto-run inside Low integrity and its honest limits', () => {
    const map = buildWorkspaceMap(tmp);
    const sys = buildSystemPrompt(tmp, map, {
      mode: 'windows-lowil',
      enforced: true,
      summary: 's',
      confines: ['writes'],
      doesNotConfine: ['reads', 'network'],
      detail: 'ok',
    });
    expect(sys).toMatch(/runs AUTOMATICALLY inside an OS sandbox at Low integrity/i);
    expect(sys).toMatch(/does NOT stop reads or network/i);
    expect(sys).toContain(tmp);
  });
});
