import fs from 'node:fs';
import path from 'node:path';
import { normalizeRelPrefix } from '../shared/pathutil.js';
import { detectProject, probeStamps } from './detect.js';
import type { DetectedProject, DetectedWorkspace, ManifestStamp } from './types.js';

/**
 * Project UNITS (Session 16). Before this, "the project" was whatever sat at the workspace root,
 * and a repository holding `web/` and `api/` detected as nothing at all — every check kind
 * `unsupported`, no preview-capable script, every declared gate warned unrunnable. The workflow
 * did not fail loudly; it went inert.
 *
 * Discovery follows the `detect.ts` discipline exactly: bounded, stat-first, and NEVER throwing.
 * Two further rules are load-bearing:
 *
 * 1. **A unit exists only where a manifest exists.** Directory names are candidates, never units.
 * 2. **Everything not interpreted is RECORDED.** A workspace glob this module refuses to expand
 *    becomes a `note`, not a silent absence — an ignored `packages/**` that quietly produced zero
 *    units would look identical to a repository that genuinely has none.
 *
 * Ordering is deterministic (root first, then lexicographic by id) because a unit id qualifies
 * recipe ids, and recipe ids are what consent binds to.
 */

/** Hard bounds. A repository is not allowed to make discovery expensive. */
export const MAX_PROJECT_UNITS = 12;
/** Depth BELOW the workspace root: `api` is 1, `apps/web` is 2. Nothing deeper is discovered. */
export const MAX_UNIT_DEPTH = 2;
const MAX_DIR_ENTRIES = 200;
const MAX_WORKSPACE_PATTERNS = 50;
const MAX_YAML_BYTES = 64 * 1024;
const MAX_PKG_BYTES = 256 * 1024;

/** The workspace root's own unit id. Reserved: `normalizeRelPrefix` rejects '.' by design. */
export const ROOT_UNIT_ID = '.';

/**
 * Depth 1 is scanned GENERALLY — every non-noise child directory is tested for a manifest —
 * rather than against a fixed name list. A list of conventional names (`web`, `api`, …) was the
 * first design and it was wrong: a Python service in `svc/` is a real project, and a discovery
 * rule that cannot see it produces exactly the silent inertness this module exists to end. One
 * bounded `readdir` of the root costs nothing and has no vocabulary to be missing a word from.
 *
 * Depth 2 stays narrow — only these conventional CONTAINERS, plus whatever the workspace file
 * itself declares — because an unbounded second level is where a repository gets expensive.
 */
const CONTAINER_DIRS = ['apps', 'packages', 'services', 'libs', 'modules'] as const;

/** Manifests whose presence makes a directory a unit. Mirrors `detect.ts`'s ecosystems. */
const UNIT_MANIFESTS = ['package.json', 'pyproject.toml', 'setup.cfg'] as const;

const SKIP_DIRS = new Set(['node_modules', '.git', '.agent-cli', 'dist', 'build', 'coverage', '.next', '.venv', 'venv', '__pycache__']);

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasManifest(dir: string): boolean {
  return UNIT_MANIFESTS.some((m) => {
    try {
      return fs.statSync(path.join(dir, m)).isFile();
    } catch {
      return false;
    }
  });
}

function readBounded(file: string, cap: number): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > cap) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Bounded child-directory listing, excluding the usual noise. Never throws. */
function childDirs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.slice(0, MAX_DIR_ENTRIES)) {
    if (!e.isDirectory()) continue;
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    out.push(e.name);
  }
  return out.sort();
}

/**
 * The workspace patterns this module is willing to expand: a literal directory, or a single
 * trailing `/*`. Anything richer (`**`, `!negation`, a mid-path `*`, brace sets) is refused with
 * a reason. Half-interpreting a glob is worse than not interpreting it: it would silently produce
 * a DIFFERENT unit set than the package manager itself uses.
 */
function expandPattern(root: string, pattern: string): { ids: string[]; note?: string } {
  const raw = pattern.trim();
  if (raw === '') return { ids: [] };
  if (raw.startsWith('!')) return { ids: [], note: `workspace pattern '${raw}' ignored (negations are not interpreted)` };
  const star = raw.indexOf('*');
  if (star === -1) {
    const id = normalizeRelPrefix(raw);
    if (id === null) return { ids: [], note: `workspace pattern '${raw}' ignored (escapes the workspace)` };
    return { ids: [id] };
  }
  if (!raw.endsWith('/*') || raw.slice(0, -2).includes('*')) {
    return { ids: [], note: `workspace pattern '${raw}' ignored (only a literal directory or a single trailing '/*' is expanded)` };
  }
  const base = normalizeRelPrefix(raw.slice(0, -2));
  if (base === null) return { ids: [], note: `workspace pattern '${raw}' ignored (escapes the workspace)` };
  const dir = path.join(root, base);
  if (!isDir(dir)) return { ids: [] };
  return { ids: childDirs(dir).map((c) => `${base}/${c}`) };
}

/** npm/yarn `workspaces`: `string[]` or `{ packages: string[] }`. Never throws. */
function declaredNpmWorkspaces(root: string): { patterns: string[]; note?: string } {
  const text = readBounded(path.join(root, 'package.json'), MAX_PKG_BYTES);
  if (text === null) return { patterns: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { patterns: [] }; // detect.ts already records the unparseable-manifest evidence
  }
  if (parsed === null || typeof parsed !== 'object') return { patterns: [] };
  const raw = (parsed as Record<string, unknown>)['workspaces'];
  const list = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>)['packages'])
      ? ((raw as Record<string, unknown>)['packages'] as unknown[])
      : null;
  if (list === null) return { patterns: [] };
  const patterns = list.filter((p): p is string => typeof p === 'string').slice(0, MAX_WORKSPACE_PATTERNS);
  return {
    patterns,
    ...(list.length > MAX_WORKSPACE_PATTERNS ? { note: `package.json declares ${String(list.length)} workspace patterns; only the first ${String(MAX_WORKSPACE_PATTERNS)} were read` } : {}),
  };
}

/**
 * `pnpm-workspace.yaml` `packages:` — extracted, not YAML-parsed. The harness has no YAML
 * dependency and does not want one for a five-line list; extraction is bounded to the `packages:`
 * block, accepts the block and inline-flow forms, and yields nothing (with a note) on anything
 * else. A pattern this misses is a missing unit, which the conventional scan usually recovers and
 * which the notes make visible either way.
 */
function declaredPnpmWorkspaces(root: string): { patterns: string[]; note?: string } {
  const text = readBounded(path.join(root, 'pnpm-workspace.yaml'), MAX_YAML_BYTES);
  if (text === null) return { patterns: [] };
  const lines = text.split(/\r?\n/);
  const patterns: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (patterns.length >= MAX_WORKSPACE_PATTERNS) break;
    const inline = /^packages:\s*\[(.*)\]\s*$/.exec(line);
    if (inline !== null) {
      for (const part of inline[1]!.split(',')) {
        const v = part.trim().replace(/^['"]|['"]$/g, '');
        if (v !== '') patterns.push(v);
      }
      inBlock = false;
      continue;
    }
    if (/^packages:\s*(#.*)?$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const item = /^\s+-\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (item !== null) {
      const v = item[1]!.trim().replace(/^['"]|['"]$/g, '');
      if (v !== '') patterns.push(v);
      continue;
    }
    if (line.trim() !== '') inBlock = false; // a new top-level key ends the block
  }
  return {
    patterns,
    ...(patterns.length === 0 ? { note: 'pnpm-workspace.yaml is present but no `packages:` entries could be read from it' } : {}),
  };
}

/**
 * The candidate unit ids for a workspace, in deterministic order, WITHOUT reading manifests for
 * content. Shared by `detectWorkspace` and `probeWorkspaceStamps` so a re-probe sees exactly the
 * unit set a re-detect would — otherwise a newly added `api/package.json` would be invisible to
 * the TOCTOU guard, which is the one thing the fixed-candidate-list rule exists to prevent.
 */
export function discoverUnitIds(root: string): { ids: string[]; notes: string[] } {
  const notes: string[] = [];
  const seen = new Set<string>();
  const ids: string[] = [];
  const add = (id: string): void => {
    if (seen.has(id) || id === ROOT_UNIT_ID) return;
    if (id.split('/').length > MAX_UNIT_DEPTH) return;
    if (!hasManifest(path.join(root, id))) return;
    seen.add(id);
    ids.push(id);
  };

  for (const src of [declaredNpmWorkspaces(root), declaredPnpmWorkspaces(root)]) {
    if (src.note !== undefined) notes.push(src.note);
    for (const pattern of src.patterns) {
      const { ids: expanded, note } = expandPattern(root, pattern);
      if (note !== undefined) notes.push(note);
      for (const id of expanded) add(id);
    }
  }

  const depth1 = childDirs(root);
  for (const name of depth1) add(name);
  for (const container of CONTAINER_DIRS) {
    if (!depth1.includes(container)) continue;
    for (const child of childDirs(path.join(root, container))) add(`${container}/${child}`);
  }

  ids.sort();
  if (ids.length > MAX_PROJECT_UNITS) {
    notes.push(
      `${String(ids.length)} project units were discovered; only the first ${String(MAX_PROJECT_UNITS)} are used ` +
        `(dropped: ${ids.slice(MAX_PROJECT_UNITS).join(', ')})`,
    );
    ids.length = MAX_PROJECT_UNITS;
  }
  return { ids, notes };
}

/** Stamps for every unit, each `relPath` qualified by its unit so two units cannot collide. */
function stampsFor(root: string, id: string): ManifestStamp[] {
  const dir = id === ROOT_UNIT_ID ? root : path.join(root, id);
  const prefix = id === ROOT_UNIT_ID ? '' : `${id}/`;
  return probeStamps(dir).map((s) => ({ ...s, relPath: `${prefix}${s.relPath}` }));
}

/**
 * The cheap TOCTOU fingerprint of a whole workspace: re-discover the unit set, then stat each
 * unit's candidates. Cheap enough to run per call (stats plus at most two small bounded reads),
 * and it is what lets a check approved in `api` notice that `web` grew a manifest.
 */
export function probeWorkspaceStamps(root: string): ManifestStamp[] {
  const { ids } = discoverUnitIds(root);
  return [ROOT_UNIT_ID, ...ids].flatMap((id) => stampsFor(root, id));
}

/**
 * Detect every project unit in a workspace. The root unit is included only when it actually has a
 * manifest — a bare container repository holding `web/` and `api/` has no root project, and saying
 * it has one would put a `.`-rooted `npm test` in front of a human as if it meant something.
 */
export function detectWorkspace(root: string): DetectedWorkspace {
  const { ids, notes } = discoverUnitIds(root);
  const units: DetectedProject[] = [];

  const rootUnit = detectProject(root, ROOT_UNIT_ID);
  if (rootUnit.kinds.length > 0) units.push(rootUnit);

  for (const id of ids) {
    const unit = detectProject(path.join(root, id), id);
    if (unit.kinds.length > 0) units.push(unit);
  }

  // The stamp union covers the ROOT even when it is not a unit: a package.json appearing at the
  // root changes the answer, and a fingerprint that could not see it would never re-detect.
  const stamps = [ROOT_UNIT_ID, ...ids].flatMap((id) => stampsFor(root, id));

  return { root, rootUnit, units, stamps, notes };
}

/** The unit a call means, or an honest refusal. Ambiguity REFUSES; it never picks. */
export function selectUnit(
  ws: DetectedWorkspace,
  requested?: string,
): { unit: DetectedProject } | { unit: null; reason: string } {
  // A workspace with no project at all resolves to its ROOT, not to a refusal. That distinction
  // is load-bearing: "this project cannot run a build" is a project-capability fact that may
  // legitimately waive a declared gate, while "you did not say which of three projects" is a
  // caller mistake that must never waive anything. Only the second one refuses below.
  if (ws.units.length === 0 && requested === undefined) return { unit: ws.rootUnit };
  if (requested !== undefined) {
    const id = requested.trim() === ROOT_UNIT_ID ? ROOT_UNIT_ID : normalizeRelPrefix(requested);
    const found = id === null ? undefined : ws.units.find((u) => u.id === id);
    if (found === undefined) {
      return { unit: null, reason: `unknown project '${requested}'; detected projects: ${ws.units.map((u) => u.id).join(', ')}` };
    }
    return { unit: found };
  }
  const rootUnit = ws.units.find((u) => u.id === ROOT_UNIT_ID);
  if (rootUnit !== undefined) return { unit: rootUnit };
  if (ws.units.length === 1) return { unit: ws.units[0]! };
  return {
    unit: null,
    reason:
      `this workspace holds ${String(ws.units.length)} projects and no project was named: ` +
      `${ws.units.map((u) => u.id).join(', ')}. Name one with "project" — guessing which of several ` +
      'real projects a command belongs to is not something the harness will do for you.',
  };
}
