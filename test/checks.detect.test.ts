import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectProject, probeStamps, stampsEqual } from '../src/checks/detect.js';

let ws: string;

beforeEach(() => {
  ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-detect-')));
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const p = path.join(ws, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

describe('detectProject', () => {
  it('detects nothing in an empty workspace and never throws', () => {
    const p = detectProject(ws);
    expect(p.kinds).toEqual([]);
    expect(p.packageManager).toBeNull();
    expect(p.scripts).toEqual({});
    expect(p.stamps).toEqual([]);
  });

  it('reads package.json scripts, tools, and lockfile-derived package manager', () => {
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'tsc -p .', test: 'vitest run', typecheck: 'tsc --noEmit' },
        devDependencies: { typescript: '^5', vitest: '^4', unrelated: '^1' },
      }),
    );
    write('package-lock.json', '{}');
    write('tsconfig.json', '{}');
    const p = detectProject(ws);
    expect(p.kinds).toEqual(['node']);
    expect(p.packageManager).toBe('npm');
    expect(Object.keys(p.scripts).sort()).toEqual(['build', 'test', 'typecheck']);
    expect(p.nodeTools).toEqual(['typescript', 'vitest']);
    expect(p.hasTsconfig).toBe(true);
    expect(p.hasNodeModules).toBe(false);
    expect(p.evidence.join(' ')).toContain('node_modules ABSENT');
  });

  it('prefers the declared packageManager field over lockfiles', () => {
    write('package.json', JSON.stringify({ packageManager: 'pnpm@9.0.0' }));
    write('package-lock.json', '{}');
    expect(detectProject(ws).packageManager).toBe('pnpm');
  });

  it('derives yarn and pnpm from lockfiles', () => {
    write('package.json', '{}');
    write('yarn.lock', '');
    expect(detectProject(ws).packageManager).toBe('yarn');
    fs.rmSync(path.join(ws, 'yarn.lock'));
    write('pnpm-lock.yaml', '');
    expect(detectProject(ws).packageManager).toBe('pnpm');
  });

  it('degrades honestly on an unparseable package.json instead of throwing', () => {
    write('package.json', '{ not json');
    const p = detectProject(ws);
    expect(p.kinds).toEqual(['node']);
    expect(p.scripts).toEqual({});
    expect(p.evidence.join(' ')).toContain('unparseable');
  });

  it('drops script names that fail the safe-name charset (they compose into commands)', () => {
    write(
      'package.json',
      JSON.stringify({ scripts: { test: 'vitest', 'evil; rm -rf /': 'x', 'a b': 'y', "q'uote": 'z' } }),
    );
    expect(Object.keys(detectProject(ws).scripts)).toEqual(['test']);
  });

  it('detects python manifests and referenced tools', () => {
    write('pyproject.toml', '[tool.pytest.ini_options]\n[tool.mypy]\n[tool.ruff]\n');
    const p = detectProject(ws);
    expect(p.kinds).toEqual(['python']);
    expect(p.pythonTools).toEqual(['pytest', 'mypy', 'ruff']);
  });

  it('detects both ecosystems in one workspace', () => {
    write('package.json', JSON.stringify({ scripts: { test: 'vitest' } }));
    write('setup.cfg', '[tool:pytest]\n');
    expect(detectProject(ws).kinds).toEqual(['node', 'python']);
  });

  it('detects eslint and prettier configuration', () => {
    write('package.json', JSON.stringify({ devDependencies: { eslint: '^9', prettier: '^3' } }));
    write('eslint.config.js', '');
    write('.prettierrc', '{}');
    const p = detectProject(ws);
    expect(p.hasEslintConfig).toBe(true);
    expect(p.hasPrettierConfig).toBe(true);
  });

  it('accepts a prettier key in package.json as prettier configuration', () => {
    write('package.json', JSON.stringify({ prettier: { semi: false } }));
    expect(detectProject(ws).hasPrettierConfig).toBe(true);
  });
});

describe('probeStamps / stampsEqual', () => {
  it('is stable across calls and changes when a manifest changes', () => {
    write('package.json', JSON.stringify({ scripts: { test: 'a' } }));
    const a = probeStamps(ws);
    expect(stampsEqual(a, probeStamps(ws))).toBe(true);
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'a', build: 'b' } }));
    fs.utimesSync(path.join(ws, 'package.json'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(stampsEqual(a, probeStamps(ws))).toBe(false);
  });

  it('notices a manifest that did not exist before (fixed candidate list)', () => {
    write('package.json', '{}');
    const a = probeStamps(ws);
    write('tsconfig.json', '{}');
    expect(stampsEqual(a, probeStamps(ws))).toBe(false);
  });

  it('notices node_modules appearing', () => {
    write('package.json', '{}');
    const a = probeStamps(ws);
    fs.mkdirSync(path.join(ws, 'node_modules'));
    expect(stampsEqual(a, probeStamps(ws))).toBe(false);
  });
});
