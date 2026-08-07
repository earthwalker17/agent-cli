import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../shared/hash.js';
import type {
  CmakeFacts,
  DetectedLockfile,
  DetectedProject,
  GoFacts,
  ManifestStamp,
  PackageManager,
  ProjectKind,
  RustFacts,
  ToolchainFacts,
} from './types.js';

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
/**
 * Lockfiles are legitimately large (a real `package-lock.json` runs to megabytes, well past the
 * manifest cap), and install consent binds their CONTENT — so they get their own generous bound.
 * Past it the sha is null: the install still runs after an approval, it just cannot earn replay
 * consent. Refusing to hash is honest; hashing a prefix and calling it the lockfile identity is
 * the display-cap mistake of S14.5 wearing a different hat.
 */
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024;

/** Script/dependency names accepted from workspace bytes. Anything else is dropped, not escaped. */
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_.\-]{0,63}$/;
/** `packageManager` declarations, e.g. `yarn@4.5.0+sha224.abc`. Charset-filtered at ingestion. */
// 256, not 100: corepack's canonical form is `yarn@4.5.0+sha512.<128 hex>` (~146 chars), and a
// cap below that silently nulled the field — after which the setup resolver told the user to
// declare a `packageManager` the project had declared all along.
const PM_SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9@.+_\-]{0,255}$/;

/** Node dependency names the recipe table knows how to use. */
const NODE_TOOLS = ['typescript', 'vitest', 'jest', 'eslint', 'prettier'] as const;
/** Python tool names looked for as literal substrings in pyproject.toml / setup.cfg. */
const PYTHON_TOOLS = ['pytest', 'mypy', 'ruff'] as const;

/** Target triples / editions / go versions end up in prompts and reasons — filtered at ingestion. */
const TRIPLE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const EDITION_RE = /^[0-9]{4}$/;
const GO_VERSION_RE = /^[0-9][0-9.]{0,15}$/;
/** Go module paths: host/path segments. Anything richer is dropped, not escaped. */
const GO_MODULE_RE = /^[A-Za-z0-9][A-Za-z0-9._~\/-]{0,255}$/;
const CMAKE_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

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

/** Lockfile names, preference-ordered; the FIRST present one names the install pinning. */
export const LOCKFILES: readonly { name: string; pm: PackageManager }[] = [
  { name: 'package-lock.json', pm: 'npm' },
  { name: 'pnpm-lock.yaml', pm: 'pnpm' },
  { name: 'yarn.lock', pm: 'yarn' },
];

/**
 * Files that decide what an install fetches or executes, beyond the lockfile and package.json.
 * Bound into the install's consent identity, in this fixed order.
 */
const INSTALL_CONFIG_FILES = ['.npmrc', '.yarnrc.yml', '.pnpmfile.cjs'] as const;

/** Files that DECLARE expected environment configuration, and files that PROVIDE it. Names only. */
const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template', '.env.defaults'] as const;
const ENV_PRESENT = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production'] as const;

/**
 * The FIXED candidate list. Fixed matters: `probeStamps` must be able to notice a manifest that
 * did not exist before (a newly added tsconfig.json changes what typecheck resolves to), which a
 * "re-stat what we read last time" list could not.
 *
 * Session 16 additions: `pnpm-workspace.yaml` (it decides which UNITS exist) and the env-file
 * names (they decide whether a unit reads as configured). Both only ever change what the harness
 * DESCRIBES; a re-detect refuses a call solely when the resolved COMMAND changed, so widening the
 * fingerprint costs a cheap re-detect and buys a surface that is never stale.
 *
 * Session 18 additions: the Rust/Go/CMake manifests and the files that change what cargo/go
 * would DO (`.cargo/config.toml` selects a cross target; `rust-toolchain*` selects a toolchain;
 * `go.work` reshapes the unit set). `target/` is deliberately NOT stamped — its mtime moves on
 * every build while nothing the harness resolves depends on it, so stamping it would flap the
 * fingerprint once per check for zero resolution change (unlike `node_modules`, which gates
 * precondition curability).
 */
const CANDIDATES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'tsconfig.json',
  'pyproject.toml',
  'setup.cfg',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'rust-toolchain',
  '.cargo/config.toml',
  '.cargo/config',
  'go.mod',
  'go.sum',
  'go.work',
  'CMakeLists.txt',
  'node_modules',
  ...ESLINT_CONFIGS,
  ...PRETTIER_CONFIGS,
  ...ENV_EXAMPLES,
  ...ENV_PRESENT,
  // Part of an install's consent identity (see DetectedProject.npmrcSha256), so a write to one
  // must invalidate the fingerprint and force a re-detect.
  '.npmrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
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
 * The lockfile this unit is pinned by, hashed for install consent. Never throws.
 *
 * The DETECTED package manager wins over the file order. A repo that migrated to pnpm or yarn
 * commonly still carries a stale `package-lock.json` — neither tool deletes it — and a plain
 * first-match walk would compose `npm ci` for a project whose every other recipe already says
 * `pnpm run …`. That installs the wrong tree from the wrong file while the prompt claims to
 * install "exactly what package-lock.json pins", and binds consent to a lockfile the project
 * does not use.
 */
function detectLockfile(root: string, pm: PackageManager | null): DetectedLockfile | null {
  const ordered = pm !== null ? [...LOCKFILES].sort((a, b) => (a.pm === pm ? -1 : b.pm === pm ? 1 : 0)) : LOCKFILES;
  for (const { name } of ordered) {
    let size: number;
    try {
      const st = fs.statSync(path.join(root, name));
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (size > MAX_LOCKFILE_BYTES) return { name, sha256: null, size };
    try {
      return { name, sha256: sha256(fs.readFileSync(path.join(root, name))), size };
    } catch {
      // Unreadable (locked by a concurrent install, permissions): the lockfile EXISTS, so the
      // install command it implies is still correct — only its consent identity is unavailable.
      return { name, sha256: null, size };
    }
  }
  return null;
}

/**
 * Bounded TOML-shaped extraction (Session 18) — the pnpm-workspace precedent: no TOML dependency
 * for three key reads. `hasTomlSection` answers presence; `tomlSectionLines` yields the lines
 * between one `[section]` header and the next `[` header; `tomlString` reads a simple
 * `key = "value"` line from them. A value these miss degrades to null, never to a wrong value.
 * `section`/`key` are harness literals, never workspace bytes.
 */
function hasTomlSection(text: string, section: string): boolean {
  return new RegExp(`^\\s*\\[${section}\\]\\s*(?:#.*)?$`, 'm').test(text);
}

function tomlSectionLines(text: string, section: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]{1,128})\]\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      inSection = header[1]!.trim() === section;
      continue;
    }
    if (inSection) out.push(line);
  }
  return out;
}

function tomlString(lines: readonly string[], key: string): string | null {
  for (const line of lines) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]{1,256})"`).exec(line);
    if (m !== null) return m[1]!;
  }
  return null;
}

/**
 * Detect what one project unit can be checked with. Pure with respect to the harness: it reads
 * files under `root` and returns a snapshot — it writes nothing, spawns nothing, and never throws.
 *
 * `id` is this unit's workspace-relative identity (`'.'` for the workspace root). It defaults to
 * `'.'` so every pre-Session-16 caller keeps its exact meaning: one project, at the root.
 *
 * `toolchains` (Session 18) is the ONE machine-toolchain probe `detectWorkspace` performed,
 * shared by reference across every unit of a detection — a per-unit re-probe would answer the
 * same question at multiplied cost. Optional so direct callers and tests keep their meaning;
 * recipes treat absence as "not gated by a probe".
 */
export function detectProject(root: string, id = '.', toolchains?: ToolchainFacts): DetectedProject {
  const stamps = probeStamps(root);
  const kinds: ProjectKind[] = [];
  const evidence: string[] = [];
  const scripts: Record<string, string> = {};
  const scriptShas: Record<string, string> = {};
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
        scriptShas[name] = sha256(value); // the FULL value — what consent binds
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

  // Rust/Cargo (Session 18). Everything read is bounded and charset-filtered; a value the
  // extraction misses is null, never a guess.
  let rust: RustFacts | null = null;
  const cargoText = readBounded(path.join(root, 'Cargo.toml'));
  if (cargoText !== null) {
    kinds.push('rust');
    const editionRaw = tomlString(tomlSectionLines(cargoText, 'package'), 'edition');
    const edition = editionRaw !== null && EDITION_RE.test(editionRaw) ? editionRaw : null;
    const workspaceRoot = hasTomlSection(cargoText, 'workspace');
    const hasCargoLock = exists(root, 'Cargo.lock');
    const toolchainFile = exists(root, 'rust-toolchain.toml')
      ? 'rust-toolchain.toml'
      : exists(root, 'rust-toolchain')
        ? 'rust-toolchain'
        : null;
    // `.cargo/config.toml` (modern name) wins over legacy `.cargo/config` — cargo's own order.
    // Only a plain string `target = "<triple>"` is read; an array form degrades to null.
    let crossTarget: string | null = null;
    const cargoConfig = readBounded(path.join(root, '.cargo', 'config.toml')) ?? readBounded(path.join(root, '.cargo', 'config'));
    if (cargoConfig !== null) {
      const raw = tomlString(tomlSectionLines(cargoConfig, 'build'), 'target');
      if (raw !== null && TRIPLE_RE.test(raw)) crossTarget = raw;
    }
    rust = { workspaceRoot, hasCargoLock, edition, crossTarget, toolchainFile };
    evidence.push(
      `Cargo.toml (${[
        edition !== null ? `edition ${edition}` : null,
        workspaceRoot ? 'workspace root' : null,
        hasCargoLock ? 'Cargo.lock present' : 'no Cargo.lock',
      ]
        .filter((s): s is string => s !== null)
        .join('; ')})`,
    );
    if (crossTarget !== null) {
      evidence.push(`.cargo config sets [build].target = ${crossTarget} — every compile targets that triple`);
    }
    if (toolchainFile !== null) evidence.push(`${toolchainFile} pins the rust toolchain (the harness never overrides it)`);
  }

  // Go modules (Session 18).
  let goFacts: GoFacts | null = null;
  const goModText = readBounded(path.join(root, 'go.mod'));
  if (goModText !== null) {
    kinds.push('go');
    const moduleRaw = /^module\s+(\S{1,256})\s*$/m.exec(goModText)?.[1] ?? null;
    const goRaw = /^go\s+([0-9][0-9.]{0,15})\s*$/m.exec(goModText)?.[1] ?? null;
    goFacts = {
      module: moduleRaw !== null && GO_MODULE_RE.test(moduleRaw) ? moduleRaw : null,
      goDirective: goRaw !== null && GO_VERSION_RE.test(goRaw) ? goRaw : null,
      hasGoSum: exists(root, 'go.sum'),
      hasVendorDir: exists(root, 'vendor'),
    };
    evidence.push(
      `go.mod (${goFacts.module ?? 'module name unreadable'}` +
        `${goFacts.goDirective !== null ? `; go ${goFacts.goDirective}` : ''}` +
        `${goFacts.hasGoSum ? '; go.sum present' : '; no go.sum'})`,
    );
    if (goFacts.hasVendorDir) evidence.push('vendor/ directory present');
  }

  // CMake (Session 18): NAMED, not supported — detection exists so the refusal can say what this
  // is instead of claiming no manifest was found. Checks stay unsupported; retrieval indexes it.
  let cmake: CmakeFacts | null = null;
  const cmakeText = readBounded(path.join(root, 'CMakeLists.txt'));
  if (cmakeText !== null) {
    kinds.push('cmake');
    const nameRaw = /^\s*project\s*\(\s*([A-Za-z0-9_.-]{1,64})/im.exec(cmakeText)?.[1] ?? null;
    cmake = { projectName: nameRaw !== null && CMAKE_NAME_RE.test(nameRaw) ? nameRaw : null };
    evidence.push(`CMakeLists.txt (${cmake.projectName !== null ? `project ${cmake.projectName}` : 'no project() name read'})`);
  }

  const hasNodeModules = exists(root, 'node_modules');
  const hasTsconfig = exists(root, 'tsconfig.json');
  const hasEslintConfig = ESLINT_CONFIGS.some((c) => exists(root, c));
  const hasPrettierConfig = PRETTIER_CONFIGS.some((c) => exists(root, c)) || pkg?.['prettier'] !== undefined;

  // An install's consent identity spans THREE files, not one: the lockfile decides which
  // versions, package.json's lifecycle scripts decide what runs during the install, and .npmrc
  // decides which registry the code comes from and what shell runs those scripts. Binding only
  // the lockfile let an ordinary auto-allowed package.json write turn one `[s]` into standing
  // arbitrary-shell consent — the S14.5 body-binding hole, reopened one file over.
  const lockfile = detectLockfile(root, detectPackageManager(root, pkg));
  const manifestSha256 = pkgText !== null ? sha256(pkgText) : null;
  const npmrcText = readBounded(path.join(root, '.npmrc'));
  const npmrcSha256 = npmrcText !== null ? sha256(npmrcText) : null;
  // Every OTHER file that changes what an install fetches or executes, folded into one sha.
  // `.npmrc` was bound from the start; `.yarnrc.yml` can point `yarnPath` at an arbitrary script
  // and `.pnpmfile.cjs` runs a `readPackage` hook in-process during resolution. Both are ordinary
  // workspace files an auto-allowed write can create, so binding only the lockfile, package.json
  // and .npmrc left a granted `[s]` covering an install whose behaviour had been rewritten
  // underneath it — the S14.5 body-binding lesson, two files over. Names are included in the
  // digest so adding a file is a different identity from editing one.
  const installConfigSha256 = ((): string | null => {
    const parts: string[] = [];
    for (const name of INSTALL_CONFIG_FILES) {
      const text = readBounded(path.join(root, name));
      if (text !== null) parts.push(`${name}:${sha256(text)}`);
    }
    return parts.length > 0 ? sha256(parts.join('\n')) : null;
  })();
  const envFiles = {
    examples: ENV_EXAMPLES.filter((c) => exists(root, c)),
    present: ENV_PRESENT.filter((c) => exists(root, c)),
  };

  if (hasTsconfig) evidence.push('tsconfig.json');
  if (lockfile !== null) {
    // Name every lockfile present, not just the chosen one: "this repo has two lockfiles" is the
    // fact that explains an otherwise baffling install command, and it must not be invisible.
    const others = LOCKFILES.filter((l) => l.name !== lockfile.name && exists(root, l.name)).map((l) => l.name);
    evidence.push(`lockfile ${lockfile.name}` + (others.length > 0 ? ` (also present, NOT used: ${others.join(', ')})` : ''));
  }
  if (hasDependencies && !hasNodeModules) evidence.push('dependencies are declared but node_modules is ABSENT');
  if (envFiles.examples.length > 0 && envFiles.present.length === 0) {
    evidence.push(`expects environment configuration (${envFiles.examples.join(', ')}) but none is present`);
  }

  const declaredPm = typeof pkg?.['packageManager'] === 'string' ? (pkg['packageManager'] as string) : '';
  const packageManagerSpec = PM_SPEC_RE.test(declaredPm) ? declaredPm : null;

  return {
    root,
    id,
    kinds,
    packageManagerSpec,
    packageManager: detectPackageManager(root, pkg),
    scripts,
    scriptShas,
    nodeTools,
    pythonTools,
    hasNodeModules,
    hasDependencies,
    hasTsconfig,
    hasEslintConfig,
    hasPrettierConfig,
    lockfile,
    manifestSha256,
    npmrcSha256,
    installConfigSha256,
    envFiles,
    ...(rust !== null ? { rust } : {}),
    ...(goFacts !== null ? { go: goFacts } : {}),
    ...(cmake !== null ? { cmake } : {}),
    evidence,
    stamps,
    ...(toolchains !== undefined ? { toolchains } : {}),
  };
}
