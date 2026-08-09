import fs from 'node:fs';
import path from 'node:path';
import { caseFold, isInside, normalizeRelPrefix, realpathBoundary } from '../shared/pathutil.js';
import { detectProject, probeStamps } from './detect.js';
import { probeToolchainState, toolchainStamps } from './toolchain.js';
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
export const MAX_PROJECT_UNITS = 16;
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

/**
 * Manifests whose presence makes a directory a unit. Mirrors `detect.ts`'s ecosystems.
 * Session 18: `Cargo.toml`, `go.mod` and `CMakeLists.txt` join — a unit does NOT require recipe
 * rows to exist (a cmake unit is named so refusals are honest). `go.work` is deliberately absent:
 * it marks a CONTAINER whose `use` directives name the units, exactly as pnpm-workspace.yaml does.
 */
const UNIT_MANIFESTS = ['package.json', 'pyproject.toml', 'setup.cfg', 'Cargo.toml', 'go.mod', 'CMakeLists.txt'] as const;

// Session 18 adds `target` (cargo build output) and `vendor` (vendored deps — real source, but
// never a project UNIT; retrieval still sees the files) to the discovery skip set.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.agent-cli',
  'dist',
  'build',
  'coverage',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
]);

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
  // Filter FIRST, then sort, then cap. Capping raw dirents let files and dotfiles consume the
  // budget and — because readdir returns OS order, not sorted order — made the surviving set a
  // function of inode hashing rather than of the tree. Unit ids qualify consent keys and feed the
  // TOCTOU fingerprint, so an unstable set produces spurious "the project changed" refusals.
  const dirs = entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')).map((e) => e.name);
  dirs.sort();
  return dirs.length > MAX_DIR_ENTRIES ? dirs.slice(0, MAX_DIR_ENTRIES) : dirs;
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
    // A blank line or a comment — at ANY indentation, including column 0 — does not end the
    // block. Treating a column-0 comment as a terminator silently truncated the list, and because
    // some patterns HAD been read the "nothing could be read" note did not fire either: a wrong
    // unit set with no note, which is the one outcome this module says is worse than an empty one.
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    inBlock = false; // a genuine new top-level key ends the block
  }
  return {
    patterns,
    ...(patterns.length === 0 ? { note: 'pnpm-workspace.yaml is present but no `packages:` entries could be read from it' } : {}),
  };
}

/**
 * Cargo `[workspace] members` — extracted, not TOML-parsed (the pnpm-YAML precedent, one format
 * over). Bounded to the `[workspace]` section; accepts the inline `members = ["a", "crates/*"]`
 * and the multiline-array forms; quoted strings only. Patterns feed the same `expandPattern`
 * vocabulary (a literal directory or one trailing `/*`), so anything richer refuses into a note
 * rather than half-interpreting into a unit set cargo itself would not use.
 */
function declaredCargoMembers(root: string): { patterns: string[]; note?: string } {
  const text = readBounded(path.join(root, 'Cargo.toml'), MAX_PKG_BYTES);
  if (text === null) return { patterns: [] };
  const patterns: string[] = [];
  let inWorkspace = false;
  let inMembersArray = false;
  let sawMembersKey = false;
  let dropped = 0;
  const takeQuoted = (fragment: string): void => {
    for (const m of fragment.matchAll(/"([^"]{1,256})"/g)) {
      if (patterns.length >= MAX_WORKSPACE_PATTERNS) return;
      // Control characters are refused AT INGESTION (S18 review): a rejected pattern is later
      // interpolated into a note rendered on harness-attributed surfaces. The refusal itself is
      // still recorDED — as a count, never as an echo of the bytes.
      if (/[\x00-\x1f\x7f]/.test(m[1]!)) {
        dropped++;
        continue;
      }
      patterns.push(m[1]!);
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]{1,128})\]\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      inWorkspace = header[1]!.trim() === 'workspace';
      inMembersArray = false;
      continue;
    }
    if (!inWorkspace) continue;
    if (inMembersArray) {
      takeQuoted(line);
      if (line.includes(']')) inMembersArray = false;
      continue;
    }
    const members = /^\s*members\s*=\s*\[(.*)$/.exec(line);
    if (members !== null) {
      sawMembersKey = true;
      takeQuoted(members[1]!);
      if (!members[1]!.includes(']')) inMembersArray = true;
    }
  }
  return {
    patterns,
    ...(sawMembersKey && patterns.length === 0
      ? { note: 'Cargo.toml declares [workspace] members but no entries could be read from it' }
      : dropped > 0
        ? { note: `${String(dropped)} Cargo.toml workspace member entr${dropped === 1 ? 'y' : 'ies'} ignored (control characters)` }
        : {}),
  };
}

/** `go.work` `use` directives: the single-line form and the `use ( … )` block form. */
function declaredGoWorkUses(root: string): { patterns: string[]; note?: string } {
  const text = readBounded(path.join(root, 'go.work'), MAX_YAML_BYTES);
  if (text === null) return { patterns: [] };
  const patterns: string[] = [];
  let droppedUses = 0;
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (patterns.length >= MAX_WORKSPACE_PATTERNS) break;
    const stripped = line.replace(/\/\/.*$/, '').trim();
    if (inBlock) {
      if (stripped === ')') {
        inBlock = false;
        continue;
      }
      // Capped and control-filtered at ingestion (S18 review): the single-line form's \S{1,256}
      // bounded this; the block form pushed the raw line unbounded. Refusals are recorded as a
      // count — never as an echo of the bytes.
      if (stripped !== '' && stripped !== '(') {
        if (stripped.length <= 256 && !/[\x00-\x1f\x7f]/.test(stripped)) patterns.push(stripped);
        else droppedUses++;
      }
      continue;
    }
    if (/^use\s*\(\s*$/.test(stripped)) {
      inBlock = true;
      continue;
    }
    const single = /^use\s+(\S{1,256})$/.exec(stripped);
    if (single !== null) patterns.push(single[1]!);
  }
  return {
    patterns,
    ...(patterns.length === 0
      ? { note: 'go.work is present but no `use` directives could be read from it' }
      : droppedUses > 0
        ? { note: `${String(droppedUses)} go.work use entr${droppedUses === 1 ? 'y' : 'ies'} ignored (control characters or oversize)` }
        : {}),
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
  // Case-folded on Windows/macOS: `statSync` is case-insensitive there, so a declared `"Api"`
  // beside an on-disk `api` produced TWO units for one directory — two project ids, two recipe
  // ids, two consent identities, and a single-project repo that started refusing calls as
  // ambiguous. `caseFold` is the same helper every other containment comparison uses.
  const seen = new Set<string>();
  const ids: string[] = [];
  const add = (id: string): void => {
    const key = caseFold(id);
    if (seen.has(key) || id === ROOT_UNIT_ID) return;
    if (id.split('/').length > MAX_UNIT_DEPTH) return;
    if (!hasManifest(path.join(root, id))) return;
    // A unit's directory must be inside the workspace. A declared workspace entry can be a
    // SYMLINK (statSync follows it), which would put the approval prompt's "in: <ws>/vendor" in
    // front of a human while the install writes somewhere else entirely.
    if (!isInside(root, realpathBoundary(path.join(root, id)))) return;
    seen.add(key);
    ids.push(id);
  };

  for (const src of [declaredNpmWorkspaces(root), declaredPnpmWorkspaces(root), declaredCargoMembers(root), declaredGoWorkUses(root)]) {
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
 *
 * Session 18 appends the machine's TOOLCHAIN pseudo-stamps (`~toolchain/…`) — the same seam, so
 * installing a compiler mid-session flips staleness and the shared holder re-detects. The order
 * (unit stamps first, toolchain stamps last) must match `detectWorkspace`'s union exactly:
 * `stampsEqual` compares positionally.
 */
export function probeWorkspaceStamps(root: string): ManifestStamp[] {
  const { ids } = discoverUnitIds(root);
  return [...[ROOT_UNIT_ID, ...ids].flatMap((id) => stampsFor(root, id)), ...toolchainStamps()];
}

/**
 * Detect every project unit in a workspace. The root unit is included only when it actually has a
 * manifest — a bare container repository holding `web/` and `api/` has no root project, and saying
 * it has one would put a `.`-rooted `npm test` in front of a human as if it meant something.
 */
export function detectWorkspace(root: string): DetectedWorkspace {
  const { ids, notes } = discoverUnitIds(root);
  const units: DetectedProject[] = [];

  // ONE machine-toolchain probe per detection (Session 18), shared by reference across units,
  // and folded into the stamp union so a toolchain appearing or vanishing mid-session is drift
  // the TOCTOU guard can see — never a cached absence (the S16.5 probe-caching lesson).
  const toolchainState = probeToolchainState();

  const rootUnit = detectProject(root, ROOT_UNIT_ID, toolchainState.facts);
  if (rootUnit.kinds.length > 0) units.push(rootUnit);

  for (const id of ids) {
    const unit = detectProject(path.join(root, id), id, toolchainState.facts);
    if (unit.kinds.length > 0) units.push(unit);
  }

  // The stamp union covers the ROOT even when it is not a unit: a package.json appearing at the
  // root changes the answer, and a fingerprint that could not see it would never re-detect.
  // Toolchain pseudo-stamps LAST — the same order `probeWorkspaceStamps` produces.
  const stamps = [...[ROOT_UNIT_ID, ...ids].flatMap((id) => stampsFor(root, id)), ...toolchainState.stamps];

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
    // Case-folded on a case-insensitive filesystem, exactly as discovery folds when deduplicating.
    // Matching case-SENSITIVELY against a filesystem that does not was a hard refusal for
    // `project: 'API'` naming the on-disk `api` — and, worse, an unclearable gate: a plan scoped
    // to 'API' could never record a run in that scope, so it could never pass and never be waived.
    const found = id === null ? undefined : (ws.units.find((u) => u.id === id) ?? ws.units.find((u) => caseFold(u.id) === caseFold(id)));
    if (found === undefined) {
      return { unit: null, reason: `unknown project '${requested}'; detected projects: ${ws.units.map((u) => u.id).join(', ')}` };
    }
    return { unit: found };
  }
  // Exactly one project, or none. Deliberately NOT "prefer the root when a root unit exists":
  // every npm/pnpm/yarn workspaces monorepo HAS a root package.json, so a root-wins shortcut made
  // the ambiguity refusal dead code in precisely the standard multi-project shape — and worse
  // than dead. The root of a container repo declares no test script, so an unnamed `run_check`
  // resolved against it, came back `unsupported: no-recipe`, and that reason WAIVES a declared
  // gate: a session accepted as complete with zero tests run, its evidence claiming the project
  // cannot be tested. Ambiguity refuses; `project: '.'` still selects the root explicitly.
  if (ws.units.length === 1) return { unit: ws.units[0]! };
  return {
    unit: null,
    reason:
      `this workspace holds ${String(ws.units.length)} projects and no project was named: ` +
      `${ws.units.map((u) => u.id).join(', ')}. Name one with "project" — guessing which of several ` +
      'real projects a command belongs to is not something the harness will do for you.',
  };
}
