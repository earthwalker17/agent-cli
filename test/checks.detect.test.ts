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
    expect(p.hasDependencies).toBe(true);
    expect(p.evidence.join(' ')).toContain('dependencies are declared but node_modules is ABSENT');
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

describe('detectProject — rust, go, cmake (Session 18)', () => {
  it('detects a cargo crate with edition, lockfile, and workspace-root facts', () => {
    write('Cargo.toml', '[package]\nname = "meterkit"\nedition = "2021"\n\n[dependencies]\n');
    const p = detectProject(ws);
    expect(p.kinds).toEqual(['rust']);
    expect(p.rust).toMatchObject({ workspaceRoot: false, hasCargoLock: false, edition: '2021', crossTarget: null, toolchainFile: null });
    expect(p.rust!.consentSha).toMatch(/^[0-9a-f]{64}$/);
    expect(p.evidence.join(' ')).toContain('Cargo.toml');

    write('Cargo.lock', '# lock');
    write('rust-toolchain.toml', '[toolchain]\nchannel = "stable"\n');
    const q = detectProject(ws);
    expect(q.rust!.hasCargoLock).toBe(true);
    expect(q.rust!.toolchainFile).toBe('rust-toolchain.toml');
  });

  it('the rust consent digest changes with EVERY steering file — the S18-review body binding', () => {
    write('Cargo.toml', '[package]\nname = "a"\n');
    const base = detectProject(ws).rust!.consentSha;
    write('.cargo/config.toml', '[source.crates-io]\nreplace-with = "evil"\n');
    const afterConfig = detectProject(ws).rust!.consentSha;
    expect(afterConfig).not.toBe(base);
    write('Cargo.lock', '# pinned');
    const afterLock = detectProject(ws).rust!.consentSha;
    expect(afterLock).not.toBe(afterConfig);
    // Deterministic for unchanged bytes.
    expect(detectProject(ws).rust!.consentSha).toBe(afterLock);
  });

  it('the go consent digest changes when go.mod or go.sum change', () => {
    write('go.mod', 'module m\n');
    const base = detectProject(ws).go!.consentSha;
    write('go.sum', 'example.com/x v1.0.0 h1:abc\n');
    const withSum = detectProject(ws).go!.consentSha;
    expect(withSum).not.toBe(base);
    write('go.mod', 'module m\n\nrequire example.com/x v1.0.0\n');
    expect(detectProject(ws).go!.consentSha).not.toBe(withSum);
  });

  it('a [workspace] section marks the cargo workspace root — including a virtual one', () => {
    write('Cargo.toml', '[workspace]\nmembers = ["crates/a"]\n');
    const p = detectProject(ws);
    expect(p.kinds).toEqual(['rust']);
    expect(p.rust!.workspaceRoot).toBe(true);
  });

  it('reads [build].target from .cargo/config.toml, charset-filtered, section-bounded', () => {
    write('Cargo.toml', '[package]\nname = "fw"\n');
    write('.cargo/config.toml', '[build]\ntarget = "thumbv7em-none-eabihf"\n');
    expect(detectProject(ws).rust!.crossTarget).toBe('thumbv7em-none-eabihf');

    // A hostile triple is refused at ingestion; a target key OUTSIDE [build] is not a cross target.
    write('.cargo/config.toml', '[build]\ntarget = "bad triple; rm -rf"\n');
    expect(detectProject(ws).rust!.crossTarget).toBeNull();
    write('.cargo/config.toml', '[target.thumbv7em-none-eabihf]\nrunner = "qemu"\n');
    expect(detectProject(ws).rust!.crossTarget).toBeNull();
  });

  it('detects a go module with module path, go directive, and go.sum', () => {
    write('go.mod', 'module example.com/svc\n\ngo 1.22\n');
    const p = detectProject(ws);
    expect(p.kinds).toEqual(['go']);
    expect(p.go).toMatchObject({ module: 'example.com/svc', goDirective: '1.22', hasGoSum: false, hasVendorDir: false });
    expect(p.go!.consentSha).toMatch(/^[0-9a-f]{64}$/);

    write('go.sum', '');
    fs.mkdirSync(path.join(ws, 'vendor'));
    const q = detectProject(ws);
    expect(q.go!.hasGoSum).toBe(true);
    expect(q.go!.hasVendorDir).toBe(true);
  });

  it('a hostile module path is dropped, not escaped', () => {
    write('go.mod', 'module bad`path$(x)\n');
    const p = detectProject(ws);
    expect(p.kinds).toEqual(['go']);
    expect(p.go!.module).toBeNull();
  });

  it('names a CMake project without claiming any capability for it', () => {
    write('CMakeLists.txt', 'cmake_minimum_required(VERSION 3.20)\nproject(hello VERSION 1.0)\n');
    const p = detectProject(ws);
    expect(p.kinds).toEqual(['cmake']);
    expect(p.cmake).toEqual({ projectName: 'hello' });

    write('CMakeLists.txt', 'add_subdirectory(src)\n');
    expect(detectProject(ws).cmake).toEqual({ projectName: null });
  });

  it('a polyglot unit lists every ecosystem in detection order', () => {
    write('package.json', '{}');
    write('Cargo.toml', '[package]\nname = "x"\n');
    write('go.mod', 'module m\n');
    expect(detectProject(ws).kinds).toEqual(['node', 'rust', 'go']);
  });

  it('the fingerprint notices Cargo.toml and nested .cargo/config.toml edits (fixed candidate list)', () => {
    write('Cargo.toml', '[package]\nname = "a"\n');
    const a = probeStamps(ws);
    write('Cargo.toml', '[package]\nname = "a"\nedition = "2021"\n');
    const b = probeStamps(ws);
    expect(stampsEqual(a, b)).toBe(false);
    write('.cargo/config.toml', '[build]\ntarget = "thumbv7em-none-eabihf"\n');
    expect(stampsEqual(b, probeStamps(ws))).toBe(false);
  });
});
