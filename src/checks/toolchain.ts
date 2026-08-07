import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ManifestStamp, ToolchainFacts, ToolProbe } from './types.js';

/**
 * Toolchain availability as a FIRST-CLASS fact (Session 18) — stat-only, bounded, never-throwing,
 * exactly the `detect.ts` discipline. Detection deliberately never spawns a process, so "is cargo
 * installed" is answered the only way a pure detector can answer it: the binary is findable on
 * PATH. That is a presence probe, not a health check — a present-but-broken toolchain still fails
 * at run time and classifies through its signals, which is the honest division of labour.
 *
 * Why this exists at all: a recipe for an ecosystem whose toolchain is absent is a
 * RUNNABLE-LOOKING lie. Session 18's contract is that a missing compiler produces an explicit
 * `toolchain-unavailable` answer naming the cure, decided BEFORE anything is put in front of a
 * human for consent — not a command that spawns, dies with "'cargo' is not recognized", and asks
 * recovery to diagnose what detection already knew.
 *
 * Freshness (the S16.5 lesson — absence is never cached across a session): presence is folded
 * into the workspace TOCTOU fingerprint as PSEUDO-STAMPS under the reserved `~toolchain/` prefix
 * (`normalizeRelPrefix` can never produce a `~`-prefixed unit path, so collision with real
 * manifest stamps is structurally impossible). Installing Go mid-session changes the next
 * `probeWorkspaceStamps` result, the shared holder re-detects, and the next resolve sees the new
 * toolchain — the same seam that notices a new package.json, with no second cache to go stale.
 *
 * Approximation, stated: clippy/rustfmt/targets are probed across INSTALLED rustup toolchains
 * (union), not against the resolved active toolchain — reading rustup's settings.toml to decide
 * which toolchain `cargo` would select is rustup's job, not a stat probe's. The practical gap is
 * a component present only in a non-default toolchain reading as available; the failure is then
 * a real run error with a real signal, never a silent pass. The probe deliberately looks in
 * `<rustup>/toolchains/<tc>/bin`, NOT `~/.cargo/bin`: rustup installs PROXY SHIMS for every
 * component name in `.cargo/bin` whether or not the component exists, so a PATH probe for
 * `cargo-clippy` would false-positive on every rustup installation.
 */

/** Hard bounds. A hostile PATH or rustup home must not make probing expensive. */
const MAX_PATH_ENTRIES = 64;
const MAX_PATHEXT_ENTRIES = 12;
const MAX_RUSTUP_TOOLCHAINS = 8;
const MAX_RUSTUP_TARGETS = 32;
const MAX_RUSTLIB_ENTRIES = 256;

/** Target triples end up in prompts and refusal reasons — charset-filtered at ingestion. */
const TRIPLE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const EXT_RE = /^\.[A-Za-z0-9]{1,8}$/;

/** The stamp namespace. Reserved: unit-qualified manifest stamps can never start with `~`. */
export const TOOLCHAIN_STAMP_PREFIX = '~toolchain/';

function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readdirSafe(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

/**
 * Executable suffixes to try. An explicit PATHEXT wins (parsed, filtered, capped); otherwise the
 * Windows fallback covers the shapes toolchain installers actually ship. POSIX tries the bare
 * name only.
 */
function pathExts(env: NodeJS.ProcessEnv): string[] {
  // PATHEXT is a Windows concept. Honoring one that leaked into a POSIX env (WSLENV, CI images)
  // would stat `cargo.EXE` and never the bare `cargo` — losing every real binary (S18 review).
  if (process.platform !== 'win32') return [''];
  const raw = env['PATHEXT'];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const exts = raw
      .split(';')
      .map((e) => e.trim())
      .filter((e) => EXT_RE.test(e))
      .slice(0, MAX_PATHEXT_ENTRIES);
    if (exts.length > 0) return exts;
  }
  return ['.EXE', '.CMD', '.BAT'];
}

/** PATH entries, quoted-entry tolerant, bounded. A plain object env (tests) is read literally. */
function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const raw = env['PATH'] ?? env['Path'] ?? env['path'] ?? '';
  if (typeof raw !== 'string' || raw === '') return [];
  return raw
    .split(path.delimiter)
    .map((e) => e.trim().replace(/^"|"$/g, ''))
    .filter((e) => e !== '')
    .slice(0, MAX_PATH_ENTRIES);
}

/** First PATH hit for `name`, or null. Pure stats; never throws. */
function findOnPath(name: string, env: NodeJS.ProcessEnv): ToolProbe | null {
  const exts = pathExts(env);
  for (const dir of pathEntries(env)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      const st = statSafe(candidate);
      if (st !== null && st.isFile()) return { name, path: candidate };
    }
  }
  return null;
}

function rustupHome(env: NodeJS.ProcessEnv): string | null {
  const declared = env['RUSTUP_HOME'];
  if (typeof declared === 'string' && declared.trim() !== '') return declared;
  try {
    return path.join(os.homedir(), '.rustup');
  } catch {
    return null;
  }
}

/** The PATH-probed tool names. `go` ships gofmt/vet in the distribution; nothing else is needed. */
const PATH_TOOLS = ['cargo', 'rustc', 'go'] as const;

interface ProbedToolchains {
  facts: ToolchainFacts;
  stamps: ManifestStamp[];
}

/**
 * One walk answering both questions: what is available (facts) and what state that answer was
 * derived from (pseudo-stamps for the TOCTOU fingerprint). Deterministic order — tools in fixed
 * order, toolchains and targets sorted — because `stampsEqual` compares positionally.
 */
export function probeToolchainState(env: NodeJS.ProcessEnv = process.env): ProbedToolchains {
  const stamps: ManifestStamp[] = [];
  const stamped = new Set<string>();
  const stamp = (rel: string, st: fs.Stats): void => {
    if (stamped.has(rel)) return;
    stamped.add(rel);
    stamps.push({
      relPath: `${TOOLCHAIN_STAMP_PREFIX}${rel}`,
      size: st.isDirectory() ? 0 : st.size,
      mtimeMs: Math.floor(st.mtimeMs),
    });
  };

  const found: Record<(typeof PATH_TOOLS)[number], ToolProbe | null> = { cargo: null, rustc: null, go: null };
  for (const name of PATH_TOOLS) {
    const hit = findOnPath(name, env);
    found[name] = hit;
    if (hit !== null) {
      const st = statSafe(hit.path);
      if (st !== null) stamp(name, st);
    }
  }

  let clippy = false;
  let rustfmt = false;
  const targets = new Set<string>();
  const home = rustupHome(env);
  let sawRustupToolchains = false;
  if (home !== null) {
    const toolchainsDir = path.join(home, 'toolchains');
    // stable-* first (S18 review): a bisect workflow accumulates dated nightlies that sort
    // BEFORE `stable-…`, and eight minimal-profile nightlies would otherwise evict the default
    // toolchain — the one actually holding clippy/rustfmt — from the bounded scan. Both
    // partitions stay sorted, so the order (and the stamps) remain deterministic.
    const all = readdirSafe(toolchainsDir).sort();
    const toolchains = [...all.filter((t) => t.startsWith('stable-')), ...all.filter((t) => !t.startsWith('stable-'))].slice(
      0,
      MAX_RUSTUP_TOOLCHAINS,
    );
    sawRustupToolchains = toolchains.length > 0;
    const exts = pathExts(env);
    for (const tc of toolchains) {
      for (const [bin, set] of [
        ['cargo-clippy', (): void => void (clippy = true)],
        ['rustfmt', (): void => void (rustfmt = true)],
      ] as const) {
        for (const ext of exts) {
          const st = statSafe(path.join(toolchainsDir, tc, 'bin', bin + ext));
          if (st !== null && st.isFile()) {
            set();
            stamp(`component/${bin}`, st);
            break;
          }
        }
      }
      const rustlib = path.join(toolchainsDir, tc, 'lib', 'rustlib');
      // The entry cap bounds the WALK, not just the yield: without it every junk entry in a
      // hostile rustlib still cost two stats (S18 review — the module promises hard bounds).
      for (const entry of readdirSafe(rustlib).sort().slice(0, MAX_RUSTLIB_ENTRIES)) {
        if (targets.size >= MAX_RUSTUP_TARGETS) break;
        if (!TRIPLE_RE.test(entry)) continue;
        // A real installed target ships a lib/ directory; manifest files and version markers in
        // rustlib/ do not. This is what keeps `manifest-rust-std` out of the target list.
        const lib = statSafe(path.join(rustlib, entry, 'lib'));
        if (lib === null || !lib.isDirectory()) continue;
        targets.add(entry);
        const dir = statSafe(path.join(rustlib, entry));
        if (dir !== null) stamp(`target/${entry}`, dir);
      }
    }
  }

  // A NON-rustup install (apt, scoop, standalone MSI) has no toolchains dir — and therefore no
  // proxy shims either: the shim false-positive exists only where rustup manages the install.
  // So when rustup shows nothing, a PATH hit for the component binaries is REAL evidence, and
  // refusing to look there falsely waived lint/format gates on such machines (S18 review).
  if (!sawRustupToolchains) {
    for (const [bin, set] of [
      ['cargo-clippy', (): void => void (clippy = true)],
      ['rustfmt', (): void => void (rustfmt = true)],
    ] as const) {
      const hit = findOnPath(bin, env);
      if (hit !== null) {
        const st = statSafe(hit.path);
        if (st !== null) {
          set();
          stamp(`component/${bin}`, st);
        }
      }
    }
  }

  return {
    facts: {
      cargo: found.cargo,
      rustc: found.rustc,
      go: found.go,
      clippy,
      rustfmt,
      rustupTargets: [...targets].sort(),
    },
    stamps,
  };
}

/** What is installed on this machine, as data. */
export function probeToolchains(env: NodeJS.ProcessEnv = process.env): ToolchainFacts {
  return probeToolchainState(env).facts;
}

/**
 * The pseudo-stamps for the workspace TOCTOU fingerprint. Absence is not stamped — absence is
 * itself part of the fingerprint, exactly as `probeStamps` treats absent manifests.
 */
export function toolchainStamps(env: NodeJS.ProcessEnv = process.env): ManifestStamp[] {
  return probeToolchainState(env).stamps;
}
