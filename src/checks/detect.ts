import fs from 'node:fs';
import path from 'node:path';
import type { DetectedProject, ManifestStamp, PackageManager, ProjectKind } from './types.js';

/**
 * Project detection for typed checks (Session 12): bounded, never-throwing, stat-first.
 *
 * Two properties are load-bearing:
 * - It NEVER throws. A malformed package.json degrades to "no scripts detected", never to a
 *   failed session — the same rule the memory loader and the retrieval index follow.
 * - Everything it takes from workspace bytes (script names, dependency names) is charset-filtered
 *   HERE, at the boundary. Those values are later composed into a command string; treating them
 *   as untrusted input at the point of ingestion is what keeps the composition provably safe.
 */

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SCRIPTS = 40;
const MAX_SCRIPT_NAME = 64;
const MAX_SCRIPT_VALUE = 200;

/** Script/dependency names accepted from workspace bytes. Anything else is dropped, not escaped. */
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_.\-]{0,63}$/;

/** Node dependency names the recipe table knows how to use. */
const NODE_TOOLS = ['typescript', 'vitest', 'jest', 'eslint', 'prettier'] as const;
/** Python tool names looked for as literal substrings in pyproject.toml / setup.cfg. */
const PYTHON_TOOLS = ['pytest', 'mypy', 'ruff'] as const;

const ESLINT_CONFIGS = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
] as const;

const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
] as const;

/**
 * The FIXED candidate list. Fixed matters: `probeStamps` must be able to notice a manifest that
 * did not exist before (a newly added tsconfig.json changes what typecheck resolves to), which a
 * "re-stat what we read last time" list could not.
 */
const CANDIDATES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'pyproject.toml',
  'setup.cfg',
  'node_modules',
  ...ESLINT_CONFIGS,
  ...PRETTIER_CONFIGS,
];

/** Stat-only fingerprint of every candidate that exists. Cheap enough to run per check call. */
export function probeStamps(root: string): ManifestStamp[] {
  const stamps: ManifestStamp[] = [];
  for (const rel of CANDIDATES) {
    try {
      const st = fs.statSync(path.join(root, rel));
      // A directory's size is meaningless across platforms; mtime still moves on install.
      stamps.push({ relPath: rel, size: st.isDirectory() ? 0 : st.size, mtimeMs: Math.floor(st.mtimeMs) });
    } catch {
      /* absent candidates are simply not stamped — absence is itself part of the fingerprint */
    }
  }
  return stamps;
}

export function stampsEqual(a: readonly ManifestStamp[], b: readonly ManifestStamp[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.relPath !== y.relPath || x.size !== y.size || x.mtimeMs !== y.mtimeMs) return false;
  }
  return true;
}

function readBounded(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function exists(root: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(root, rel));
  } catch {
    return false;
  }
}

function detectPackageManager(root: string, pkg: Record<string, unknown> | null): PackageManager | null {
  const declared = typeof pkg?.['packageManager'] === 'string' ? (pkg['packageManager'] as string) : '';
  if (declared.startsWith('pnpm')) return 'pnpm';
  if (declared.startsWith('yarn')) return 'yarn';
  if (declared.startsWith('npm')) return 'npm';
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(root, 'yarn.lock')) return 'yarn';
  if (exists(root, 'package-lock.json')) return 'npm';
  return pkg !== null ? 'npm' : null;
}

/**
 * Detect what this workspace can be checked with. Pure with respect to the harness: it reads
 * workspace files and returns a snapshot — it writes nothing, spawns nothing, and never throws.
 */
export function detectProject(root: string): DetectedProject {
  const stamps = probeStamps(root);
  const kinds: ProjectKind[] = [];
  const evidence: string[] = [];
  const scripts: Record<string, string> = {};
  const nodeTools: string[] = [];
  const pythonTools: string[] = [];

  let hasDependencies = false;
  let pkg: Record<string, unknown> | null = null;
  const pkgText = readBounded(path.join(root, 'package.json'));
  if (pkgText !== null) {
    try {
      const parsed: unknown = JSON.parse(pkgText);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        pkg = parsed as Record<string, unknown>;
      }
    } catch {
      evidence.push('package.json present but unparseable — scripts unavailable');
    }
  }

  if (pkg !== null) {
    kinds.push('node');
    const rawScripts = pkg['scripts'];
    if (rawScripts !== null && typeof rawScripts === 'object' && !Array.isArray(rawScripts)) {
      let n = 0;
      for (const [name, value] of Object.entries(rawScripts as Record<string, unknown>)) {
        if (n >= MAX_SCRIPTS) break;
        if (typeof value !== 'string') continue;
        if (name.length > MAX_SCRIPT_NAME || !SAFE_NAME_RE.test(name)) continue;
        scripts[name] = value.slice(0, MAX_SCRIPT_VALUE);
        n++;
      }
    }
    const deps = new Set<string>();
    for (const field of ['dependencies', 'devDependencies']) {
      const d = pkg[field];
      if (d !== null && typeof d === 'object' && !Array.isArray(d)) {
        for (const name of Object.keys(d as Record<string, unknown>)) {
          if (SAFE_NAME_RE.test(name)) deps.add(name);
        }
      }
    }
    hasDependencies = deps.size > 0;
    for (const t of NODE_TOOLS) if (deps.has(t)) nodeTools.push(t);
    const names = Object.keys(scripts);
    evidence.push(
      `package.json (${names.length > 0 ? `scripts: ${names.slice(0, 8).join(', ')}` : 'no scripts'}` +
        `${nodeTools.length > 0 ? `; tools: ${nodeTools.join(', ')}` : ''})`,
    );
  } else if (pkgText !== null) {
    // Unparseable package.json: still a Node project by evidence, just without scripts.
    kinds.push('node');
  }

  const pyTexts = [readBounded(path.join(root, 'pyproject.toml')), readBounded(path.join(root, 'setup.cfg'))]
    .filter((t): t is string => t !== null)
    .join('\n');
  if (pyTexts !== '') {
    kinds.push('python');
    for (const t of PYTHON_TOOLS) if (pyTexts.includes(t)) pythonTools.push(t);
    evidence.push(
      `python manifest (${exists(root, 'pyproject.toml') ? 'pyproject.toml' : 'setup.cfg'}` +
        `${pythonTools.length > 0 ? `; tools: ${pythonTools.join(', ')}` : '; no known tools referenced'})`,
    );
  }

  const hasNodeModules = exists(root, 'node_modules');
  const hasTsconfig = exists(root, 'tsconfig.json');
  const hasEslintConfig = ESLINT_CONFIGS.some((c) => exists(root, c));
  const hasPrettierConfig = PRETTIER_CONFIGS.some((c) => exists(root, c)) || pkg?.['prettier'] !== undefined;

  if (hasTsconfig) evidence.push('tsconfig.json');
  if (hasDependencies && !hasNodeModules) evidence.push('dependencies are declared but node_modules is ABSENT');

  return {
    root,
    kinds,
    packageManager: detectPackageManager(root, pkg),
    scripts,
    nodeTools,
    pythonTools,
    hasNodeModules,
    hasDependencies,
    hasTsconfig,
    hasEslintConfig,
    hasPrettierConfig,
    evidence,
    stamps,
  };
}
