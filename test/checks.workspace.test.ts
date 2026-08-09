import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../src/shared/hash.js';
import {
  detectWorkspace,
  discoverUnitIds,
  probeWorkspaceStamps,
  selectUnit,
  MAX_PROJECT_UNITS,
  ROOT_UNIT_ID,
} from '../src/checks/workspace.js';
import { detectProject } from '../src/checks/detect.js';

/**
 * Project-unit discovery (Session 16). The properties under test are the ones the rest of the
 * session rests on: a unit exists only where a manifest exists, ordering is deterministic (recipe
 * ids — and therefore consent — are qualified by unit id), anything not interpreted is RECORDED,
 * and ambiguity refuses instead of guessing.
 */

let tmp: string;
let ws: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-units-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const file = path.join(ws, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function pkg(rel: string, body: Record<string, unknown> = {}): void {
  write(rel, JSON.stringify({ name: rel.replace(/\//g, '-'), ...body }));
}

const ids = (root = ws): string[] => detectWorkspace(root).units.map((u) => u.id);

describe('unit discovery', () => {
  it('finds two independent packages with no root manifest, and the root is NOT a unit', () => {
    pkg('web/package.json', { scripts: { dev: 'vite' } });
    pkg('api/package.json', { scripts: { dev: 'tsx src/index.ts' } });

    const w = detectWorkspace(ws);
    expect(w.units.map((u) => u.id)).toEqual(['api', 'web']); // lexicographic, deterministic
    expect(w.units.some((u) => u.id === ROOT_UNIT_ID)).toBe(false);
    expect(w.units.find((u) => u.id === 'web')!.root).toBe(path.join(ws, 'web'));
  });

  it('puts the root unit FIRST when the root itself has a manifest', () => {
    pkg('package.json', { scripts: { test: 'vitest run' } });
    pkg('api/package.json');
    expect(ids()).toEqual([ROOT_UNIT_ID, 'api']);
  });

  it('a directory without a manifest is a candidate, never a unit', () => {
    fs.mkdirSync(path.join(ws, 'web'), { recursive: true });
    write('web/index.html', '<!doctype html>');
    expect(ids()).toEqual([]);
  });

  it('finds a sub-project under ANY depth-1 name, not just conventional ones', () => {
    pkg('totally-bespoke-name/package.json');
    expect(ids()).toEqual(['totally-bespoke-name']);
  });

  it('skips build output, dependency, and dot directories', () => {
    for (const noise of ['node_modules', 'dist', 'coverage', '.next']) pkg(`${noise}/package.json`);
    pkg('api/package.json');
    expect(ids()).toEqual(['api']);
  });

  it('expands npm workspaces in both the array and the { packages } form', () => {
    pkg('package.json', { workspaces: ['apps/*'] });
    pkg('apps/web/package.json');
    pkg('apps/api/package.json');
    expect(ids()).toEqual([ROOT_UNIT_ID, 'apps/api', 'apps/web']);

    pkg('package.json', { workspaces: { packages: ['apps/web'] } });
    expect(ids()).toContain('apps/web');
  });

  it('expands pnpm-workspace.yaml in the block and inline forms', () => {
    pkg('svc-a/package.json');
    pkg('svc-b/package.json');
    write('pnpm-workspace.yaml', "packages:\n  - 'svc-a'\n  - \"svc-b\"\n");
    expect(ids()).toEqual(['svc-a', 'svc-b']);

    write('pnpm-workspace.yaml', "packages: ['svc-a', 'svc-b']\n");
    expect(ids()).toEqual(['svc-a', 'svc-b']);
  });

  it('a pnpm packages block ends at the next top-level key', () => {
    pkg('svc-a/package.json');
    write('pnpm-workspace.yaml', "packages:\n  - 'svc-a'\nonlyBuiltDependencies:\n  - esbuild\n");
    expect(ids()).toEqual(['svc-a']);
  });

  it('REFUSES to half-interpret a rich glob, and records why', () => {
    pkg('package.json', { workspaces: ['packages/**', 'a/*/b', '!apps/legacy'] });
    pkg('packages/one/package.json');

    const w = detectWorkspace(ws);
    // The conventional container scan still finds it — but never because the glob was expanded.
    expect(w.notes.join('\n')).toContain("'packages/**' ignored");
    expect(w.notes.join('\n')).toContain("'a/*/b' ignored");
    expect(w.notes.join('\n')).toContain("'!apps/legacy' ignored (negations are not interpreted)");
  });

  it('refuses a workspace pattern that escapes the workspace', () => {
    pkg('package.json', { workspaces: ['../outside'] });
    const w = detectWorkspace(ws);
    expect(w.notes.join('\n')).toContain('escapes the workspace');
    expect(w.units.map((u) => u.id)).toEqual([ROOT_UNIT_ID]);
  });

  it('never descends past MAX_UNIT_DEPTH', () => {
    pkg('apps/web/deep/package.json');
    pkg('apps/web/package.json');
    expect(ids()).toEqual(['apps/web']);
  });

  it('caps the unit count and NAMES what it dropped', () => {
    const n = MAX_PROJECT_UNITS + 3;
    for (let i = 0; i < n; i++) pkg(`apps/p${String(i).padStart(2, '0')}/package.json`);

    const w = detectWorkspace(ws);
    expect(w.units).toHaveLength(MAX_PROJECT_UNITS);
    expect(w.notes.join('\n')).toContain(`only the first ${String(MAX_PROJECT_UNITS)} are used`);
    // The dropped ids are listed, not just counted (derived from the cap, so a retune moves it).
    expect(w.notes.join('\n')).toContain(`apps/p${String(MAX_PROJECT_UNITS)}`);
  });

  it('degrades on an unparseable sub-manifest instead of throwing', () => {
    write('api/package.json', '{ this is not json');
    expect(() => detectWorkspace(ws)).not.toThrow();
    const api = detectWorkspace(ws).units.find((u) => u.id === 'api');
    expect(api?.kinds).toEqual(['node']); // still a Node project by evidence, just without scripts
    expect(api?.evidence.join(' ')).toContain('unparseable');
  });

  it('discovers python units too', () => {
    write('svc/pyproject.toml', '[tool.pytest.ini_options]\n');
    pkg('web/package.json');
    expect(ids()).toEqual(['svc', 'web']);
  });
});

describe('the stamp union', () => {
  it('notices a manifest appearing in a SUBDIRECTORY, which a root-only fingerprint could not', () => {
    pkg('web/package.json');
    const before = probeWorkspaceStamps(ws);

    pkg('api/package.json');
    const after = probeWorkspaceStamps(ws);

    expect(after.length).toBeGreaterThan(before.length);
    expect(after.some((s) => s.relPath === 'api/package.json')).toBe(true);
  });

  it('qualifies every relPath by unit, so two units cannot collide', () => {
    pkg('web/package.json');
    pkg('api/package.json');
    const stamps = detectWorkspace(ws).stamps.map((s) => s.relPath);
    expect(stamps).toContain('web/package.json');
    expect(stamps).toContain('api/package.json');
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it('covers the ROOT even when the root is not a unit', () => {
    pkg('web/package.json');
    expect(detectWorkspace(ws).units.some((u) => u.id === ROOT_UNIT_ID)).toBe(false);

    fs.writeFileSync(path.join(ws, 'package.json'), '{}');
    expect(probeWorkspaceStamps(ws).some((s) => s.relPath === 'package.json')).toBe(true);
  });
});

describe('lockfile and env facts', () => {
  it('binds the lockfile CONTENT, not its name', () => {
    pkg('api/package.json');
    write('api/package-lock.json', '{"lockfileVersion":3}');

    const api = detectWorkspace(ws).units.find((u) => u.id === 'api')!;
    expect(api.lockfile?.name).toBe('package-lock.json');
    expect(api.lockfile?.sha256).toBe(sha256(Buffer.from('{"lockfileVersion":3}')));
    expect(api.evidence.join(' ')).toContain('lockfile package-lock.json');

    write('api/package-lock.json', '{"lockfileVersion":3,"packages":{}}');
    expect(detectWorkspace(ws).units.find((u) => u.id === 'api')!.lockfile?.sha256).not.toBe(api.lockfile?.sha256);
  });

  it('follows the DETECTED package manager when several lockfiles are present', () => {
    // The realistic case: a repo migrated to pnpm and the stale package-lock.json was never
    // deleted (neither tool deletes it). A first-match walk composed `npm ci` for a project whose
    // every other recipe already said `pnpm run …` — installing the wrong tree from the wrong
    // file, while the prompt claimed to install exactly what package-lock.json pins.
    pkg('package.json');
    write('package-lock.json', '{}');
    write('pnpm-lock.yaml', 'lockfileVersion: 9\n');

    const p = detectProject(ws);
    expect(p.packageManager).toBe('pnpm');
    expect(p.lockfile?.name).toBe('pnpm-lock.yaml');
    // And the fact that explains it is visible, not buried.
    expect(p.evidence.join(' ')).toContain('also present, NOT used: package-lock.json');
  });

  it('an explicit packageManager declaration outranks lockfile presence', () => {
    pkg('package.json', { packageManager: 'yarn@4.5.0' });
    write('package-lock.json', '{}');
    write('yarn.lock', '__metadata:\n  version: 8\n');
    expect(detectProject(ws).lockfile?.name).toBe('yarn.lock');
  });

  it('accepts a corepack packageManager spec long enough to carry a sha512 hash', () => {
    // 100 chars silently nulled the field, after which the setup resolver told the user to
    // declare a `packageManager` the project had declared all along.
    pkg('package.json', { packageManager: `yarn@4.5.0+sha512.${'a'.repeat(128)}` });
    expect(detectProject(ws).packageManagerSpec).not.toBeNull();
  });

  it('reports env files by NAME and flags an unconfigured project', () => {
    pkg('api/package.json');
    write('api/.env.example', 'PORT=3001\nJWT_SECRET=\n');

    const api = detectWorkspace(ws).units.find((u) => u.id === 'api')!;
    expect(api.envFiles).toEqual({ examples: ['.env.example'], present: [] });
    expect(api.evidence.join(' ')).toContain('expects environment configuration');

    write('api/.env', 'PORT=3001\nJWT_SECRET=dev\n');
    const configured = detectWorkspace(ws).units.find((u) => u.id === 'api')!;
    expect(configured.envFiles.present).toEqual(['.env']);
    expect(configured.evidence.join(' ')).not.toContain('expects environment configuration');
  });
});

describe('selectUnit', () => {
  const two = (): void => {
    pkg('web/package.json');
    pkg('api/package.json');
  };

  it('REFUSES a root-plus-subproject workspace — the standard monorepo shape', () => {
    // Every npm/pnpm/yarn workspaces monorepo has a root package.json, so a "prefer the root"
    // shortcut made this refusal dead code in exactly the shape it exists for — and worse than
    // dead: the container root declares no test script, so an unnamed run_check resolved against
    // it and came back `unsupported: no-recipe`, a reason that WAIVES a declared gate. A session
    // could be accepted as complete with zero tests run, its evidence claiming the project
    // cannot be tested.
    pkg('package.json', { workspaces: ['packages/*'] });
    pkg('packages/api/package.json', { scripts: { test: 'vitest run' } });
    pkg('packages/web/package.json', { scripts: { test: 'vitest run' } });

    const r = selectUnit(detectWorkspace(ws));
    expect(r.unit).toBeNull();
    expect((r as { reason: string }).reason).toContain('packages/api, packages/web');
  });

  it('the root is still selectable EXPLICITLY', () => {
    pkg('package.json');
    pkg('api/package.json');
    expect(selectUnit(detectWorkspace(ws), '.').unit?.id).toBe(ROOT_UNIT_ID);
  });

  it('defaults to the only unit when there is exactly one', () => {
    pkg('api/package.json');
    expect(selectUnit(detectWorkspace(ws)).unit?.id).toBe('api');
  });

  it('REFUSES rather than guessing when several projects exist and none was named', () => {
    two();
    const r = selectUnit(detectWorkspace(ws));
    expect(r.unit).toBeNull();
    expect((r as { reason: string }).reason).toContain('api, web');
    expect((r as { reason: string }).reason).toContain('Name one with "project"');
  });

  it('names the real ids when an unknown project is requested', () => {
    two();
    const r = selectUnit(detectWorkspace(ws), 'backend');
    expect(r.unit).toBeNull();
    expect((r as { reason: string }).reason).toContain("unknown project 'backend'");
    expect((r as { reason: string }).reason).toContain('api, web');
  });

  it('refuses an escaping or absolute project id structurally', () => {
    two();
    for (const bad of ['../outside', '/etc', 'C:/windows', 'api/../../x']) {
      expect(selectUnit(detectWorkspace(ws), bad).unit).toBeNull();
    }
  });

  it('accepts the root id explicitly', () => {
    pkg('package.json');
    expect(selectUnit(detectWorkspace(ws), '.').unit?.id).toBe(ROOT_UNIT_ID);
  });

  it('falls back to the ROOT when the workspace holds no project — a capability fact, not a refusal', () => {
    // Load-bearing: resolving a kind against an empty root yields the `no-recipe` unsupported
    // that legitimately waives a declared gate. Refusing the call instead would leave a session
    // in a manifest-less workspace unable to ever satisfy or waive its own gates.
    const r = selectUnit(detectWorkspace(ws));
    expect(r.unit?.id).toBe(ROOT_UNIT_ID);
    expect(r.unit?.kinds).toEqual([]);
  });

  it('still refuses a NAMED project that does not exist, even in an empty workspace', () => {
    const r = selectUnit(detectWorkspace(ws), 'api');
    expect(r.unit).toBeNull();
    expect((r as { reason: string }).reason).toContain("unknown project 'api'");
  });
});

describe('determinism', () => {
  it('yields the same ids and order on repeated runs — consent binds to them', () => {
    pkg('package.json', { workspaces: ['apps/*'] });
    for (const n of ['zeta', 'alpha', 'mid']) pkg(`apps/${n}/package.json`);

    const a = discoverUnitIds(ws).ids;
    const b = discoverUnitIds(ws).ids;
    expect(a).toEqual(b);
    expect(a).toEqual(['apps/alpha', 'apps/mid', 'apps/zeta']);
  });

  it('does not double-count a unit reachable both by declaration and by convention', () => {
    pkg('package.json', { workspaces: ['api'] });
    pkg('api/package.json');
    expect(ids()).toEqual([ROOT_UNIT_ID, 'api']);
  });
});

describe('unit discovery — rust, go, cmake (Session 18)', () => {
  it('discovers cargo, go, and cmake units too', () => {
    write('svc/go.mod', 'module example.com/svc\n');
    write('fw/Cargo.toml', '[package]\nname = "fw"\n');
    write('native/CMakeLists.txt', 'project(native)\n');
    const w = detectWorkspace(ws);
    expect(w.units.map((u) => u.id)).toEqual(['fw', 'native', 'svc']);
    expect(w.units.find((u) => u.id === 'svc')!.kinds).toEqual(['go']);
    expect(w.units.find((u) => u.id === 'fw')!.kinds).toEqual(['rust']);
    expect(w.units.find((u) => u.id === 'native')!.kinds).toEqual(['cmake']);
  });

  it('expands cargo [workspace] members — the declaration reaches OUTSIDE the container conventions', () => {
    // `crates` is not a conventional container dir, so only the declaration can find depth-2 units.
    write('Cargo.toml', '[workspace]\nmembers = [\n  "crates/alpha",\n  "crates/beta",\n]\n');
    write('crates/alpha/Cargo.toml', '[package]\nname = "alpha"\n');
    write('crates/beta/Cargo.toml', '[package]\nname = "beta"\n');
    expect(ids()).toEqual([ROOT_UNIT_ID, 'crates/alpha', 'crates/beta']);
  });

  it('expands the inline members form and the single trailing /* pattern', () => {
    write('Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n');
    write('crates/alpha/Cargo.toml', '[package]\nname = "alpha"\n');
    write('crates/beta/Cargo.toml', '[package]\nname = "beta"\n');
    expect(ids()).toEqual([ROOT_UNIT_ID, 'crates/alpha', 'crates/beta']);
  });

  it('refuses a rich cargo member glob into a note, never half-interprets it', () => {
    write('Cargo.toml', '[workspace]\nmembers = ["crates/**"]\n');
    write('crates/deep/nested/Cargo.toml', '[package]\nname = "x"\n');
    const w = detectWorkspace(ws);
    expect(w.units.map((u) => u.id)).toEqual([ROOT_UNIT_ID]);
    expect(w.notes.join(' ')).toContain("'crates/**' ignored");
  });

  it('notes a members key nothing could be read from', () => {
    write('Cargo.toml', '[workspace]\nmembers = [ bare_unquoted ]\n');
    const w = detectWorkspace(ws);
    expect(w.notes.join(' ')).toContain('no entries could be read');
  });

  it('discovers go.work `use` units in both directive forms', () => {
    write('go.work', 'go 1.22\n\nuse ./api\nuse (\n\t./workers/queue\n)\n');
    write('api/go.mod', 'module example.com/api\n');
    write('workers/queue/go.mod', 'module example.com/queue\n');
    expect(ids()).toEqual(['api', 'workers/queue']);
  });

  it('control characters and oversize go.work lines are refused at ingestion, counted not echoed (S18 review)', () => {
    write('go.work', `go 1.22\n\nuse (\n\t./api\n\t./bad[31mdir\n\t./${'x'.repeat(300)}\n)\n`);
    write('api/go.mod', 'module example.com/api\n');
    const w = detectWorkspace(ws);
    expect(w.units.map((u) => u.id)).toEqual(['api']);
    expect(w.notes.join(' ')).toContain('2 go.work use entries ignored');
    for (const n of w.notes) expect(/[\x00-\x1f\x7f]/.test(n)).toBe(false);
  });

  it('skips target/ and vendor/ during the conventional scan', () => {
    write('Cargo.toml', '[package]\nname = "root"\n');
    write('target/debug-junk/Cargo.toml', '[package]\nname = "junk"\n');
    write('vendor/dep/go.mod', 'module vendored\n');
    expect(ids()).toEqual([ROOT_UNIT_ID]);
  });
});
