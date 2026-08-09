import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stampsEqual, detectProject } from '../src/checks/detect.js';
import { probeToolchains, probeToolchainState, toolchainStamps, TOOLCHAIN_STAMP_PREFIX } from '../src/checks/toolchain.js';
import { detectWorkspace, probeWorkspaceStamps } from '../src/checks/workspace.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-toolchain-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mkdir(rel: string): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function write(rel: string, content = 'x'): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/**
 * Platform-shaped executable suffix: the probe stats `cargo.exe` (PATHEXT) on win32 and the bare
 * `cargo` on POSIX, so fixtures carry the suffix the platform under test actually resolves. The
 * rustup directory LAYOUT (`toolchains/<tc>/bin`, `lib/rustlib/<triple>/lib`) is identical on
 * every platform — only the binary names differ.
 */
const EXE = process.platform === 'win32' ? '.exe' : '';

/** A fake env whose rustup home is INSIDE the temp dir, so machine state never leaks in. */
function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  // PATHEXT is deliberately present even though POSIX ignores it: pathExts() must not honor a
  // leaked PATHEXT off-Windows (the S18 review finding), and these tests exercise that for free.
  return { PATH: path.join(tmp, 'bin'), PATHEXT: '.exe', RUSTUP_HOME: path.join(tmp, '.rustup'), ...over };
}

describe('probeToolchains — PATH probe', () => {
  it('resolves a binary through a fake PATH dir, suffix-aware, stat-only', () => {
    // win32: PATHEXT '.com;.exe' resolves cargo.exe. POSIX: the same PATHEXT is IGNORED and the
    // bare name resolves — honoring a leaked PATHEXT there would lose every real binary.
    write(`bin/cargo${EXE}`);
    const facts = probeToolchains(env({ PATHEXT: '.com;.exe' }));
    expect(facts.cargo).not.toBeNull();
    expect(facts.cargo!.path.toLowerCase().endsWith(`cargo${EXE}`)).toBe(true);
    expect(facts.rustc).toBeNull();
    expect(facts.go).toBeNull();
  });

  it('tolerates quoted entries, empty segments, and nonexistent dirs without throwing', () => {
    write(`real/go${EXE}`);
    const hostile = ['', `"${path.join(tmp, 'real')}"`, path.join(tmp, 'no-such-dir'), '   '].join(path.delimiter);
    const facts = probeToolchains(env({ PATH: hostile }));
    expect(facts.go).not.toBeNull();
    expect(facts.cargo).toBeNull();
  });

  it('caps a hostile PATH and an undefined PATH probes nothing, never throws', () => {
    const many = Array.from({ length: 300 }, (_, i) => path.join(tmp, `d${String(i)}`)).join(path.delimiter);
    expect(probeToolchains(env({ PATH: many })).cargo).toBeNull();
    expect(probeToolchains({ RUSTUP_HOME: path.join(tmp, '.rustup') }).go).toBeNull();
  });

  it('a directory named like the binary is not a hit', () => {
    mkdir(`bin/cargo${EXE}`); // a DIRECTORY
    expect(probeToolchains(env()).cargo).toBeNull();
  });

  it('worst-case probing stays cheap (64 real dirs, bounded stats)', () => {
    const dirs = Array.from({ length: 64 }, (_, i) => mkdir(`p${String(i)}`)).join(path.delimiter);
    const t0 = Date.now();
    probeToolchainState(env({ PATH: dirs, PATHEXT: '.com;.exe;.cmd;.bat' }));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('probeToolchains — rustup components and targets', () => {
  it('ignores the cargo-bin proxy shims: components are probed under toolchain dirs only', () => {
    // rustup installs a cargo-clippy shim in .cargo/bin whether or not the component exists.
    write(`bin/cargo${EXE}`);
    write(`bin/cargo-clippy${EXE}`); // the shim, ON PATH
    mkdir('.rustup/toolchains/stable-x86_64-pc-windows-gnu/bin'); // no real component
    const facts = probeToolchains(env());
    expect(facts.cargo).not.toBeNull();
    expect(facts.clippy).toBe(false);
    expect(facts.rustfmt).toBe(false);
  });

  it('finds real components and installed targets, charset-filtered and lib-dir-verified', () => {
    const tc = '.rustup/toolchains/stable-x86_64-pc-windows-gnu';
    write(`${tc}/bin/cargo-clippy${EXE}`);
    write(`${tc}/bin/rustfmt${EXE}`);
    mkdir(`${tc}/lib/rustlib/thumbv7em-none-eabihf/lib`);
    mkdir(`${tc}/lib/rustlib/x86_64-pc-windows-gnu/lib`);
    write(`${tc}/lib/rustlib/manifest-rust-std`); // a FILE — not a target
    mkdir(`${tc}/lib/rustlib/weird$name/lib`); // bad charset — refused at ingestion
    mkdir(`${tc}/lib/rustlib/components-empty`); // no lib/ inside — not a target
    const facts = probeToolchains(env());
    expect(facts.clippy).toBe(true);
    expect(facts.rustfmt).toBe(true);
    expect(facts.rustupTargets).toEqual(['thumbv7em-none-eabihf', 'x86_64-pc-windows-gnu']);
  });

  it('a hostile RUSTUP_HOME (missing, or a file) never throws', () => {
    expect(probeToolchains(env({ RUSTUP_HOME: path.join(tmp, 'nope') })).clippy).toBe(false);
    write('rustup-as-file');
    expect(probeToolchains(env({ RUSTUP_HOME: path.join(tmp, 'rustup-as-file') })).rustupTargets).toEqual([]);
  });

  it('a NON-rustup install trusts PATH components — the shim hazard exists only under rustup (S18 review)', () => {
    // No toolchains dir at all: a PATH hit for cargo-clippy/rustfmt is real evidence (apt,
    // scoop, standalone MSI installs have no proxy shims), and refusing to look there falsely
    // waived lint/format gates on such machines.
    write(`bin/cargo${EXE}`);
    write(`bin/cargo-clippy${EXE}`);
    write(`bin/rustfmt${EXE}`);
    const facts = probeToolchains(env());
    expect(facts.clippy).toBe(true);
    expect(facts.rustfmt).toBe(true);
    // The moment rustup MANAGES the install (a toolchains dir exists), PATH is distrusted again.
    mkdir('.rustup/toolchains/stable-x86_64-pc-windows-gnu/bin');
    const managed = probeToolchains(env());
    expect(managed.clippy).toBe(false);
    expect(managed.rustfmt).toBe(false);
  });

  it('eight nightlies cannot evict the stable toolchain from the bounded scan (S18 review)', () => {
    for (let i = 0; i < 9; i++) mkdir(`.rustup/toolchains/nightly-2024-01-0${String(i)}/bin`);
    const tc = '.rustup/toolchains/stable-x86_64-pc-windows-gnu';
    write(`${tc}/bin/cargo-clippy${EXE}`);
    write(`${tc}/bin/rustfmt${EXE}`);
    const facts = probeToolchains(env());
    expect(facts.clippy).toBe(true);
    expect(facts.rustfmt).toBe(true);
  });
});

describe('toolchain pseudo-stamps', () => {
  it('stamps present tools under the reserved prefix; absence is not stamped', () => {
    expect(toolchainStamps(env())).toEqual([]);
    write(`bin/go${EXE}`);
    const stamps = toolchainStamps(env());
    expect(stamps.length).toBe(1);
    expect(stamps[0]!.relPath).toBe(`${TOOLCHAIN_STAMP_PREFIX}go`);
    expect(stamps.every((s) => s.relPath.startsWith(TOOLCHAIN_STAMP_PREFIX))).toBe(true);
  });

  it('a tool APPEARING flips stampsEqual — the mid-session install drift signal', () => {
    const before = toolchainStamps(env());
    write(`bin/cargo${EXE}`);
    const after = toolchainStamps(env());
    expect(stampsEqual(before, after)).toBe(false);
  });

  it('a rustup target APPEARING flips stampsEqual — the `rustup target add` mid-session arc', () => {
    write(`bin/cargo${EXE}`);
    const tc = '.rustup/toolchains/stable-x86_64-pc-windows-gnu';
    mkdir(`${tc}/lib/rustlib`);
    const before = toolchainStamps(env());
    mkdir(`${tc}/lib/rustlib/thumbv7em-none-eabihf/lib`);
    const after = toolchainStamps(env());
    expect(stampsEqual(before, after)).toBe(false);
    expect(after.some((s) => s.relPath === `${TOOLCHAIN_STAMP_PREFIX}target/thumbv7em-none-eabihf`)).toBe(true);
  });
});

describe('workspace integration', () => {
  it('detectWorkspace stamps and probeWorkspaceStamps agree — including the toolchain suffix', () => {
    const ws = mkdir('ws');
    fs.writeFileSync(path.join(ws, 'package.json'), '{}');
    // Both sides use the REAL process env for toolchains, so this holds on any machine, with or
    // without compilers installed — the contract is agreement, not a particular machine state.
    expect(stampsEqual(detectWorkspace(ws).stamps, probeWorkspaceStamps(ws))).toBe(true);
  });

  it('every unit of one detection shares the same toolchain facts reference', () => {
    const ws = mkdir('ws2');
    fs.writeFileSync(path.join(ws, 'package.json'), '{}');
    fs.mkdirSync(path.join(ws, 'api'));
    fs.writeFileSync(path.join(ws, 'api', 'package.json'), '{}');
    const detected = detectWorkspace(ws);
    expect(detected.rootUnit.toolchains).toBeDefined();
    for (const u of detected.units) expect(u.toolchains).toBe(detected.rootUnit.toolchains);
  });

  it('detectProject without a probe leaves toolchains undefined (tests and direct callers)', () => {
    const ws = mkdir('ws3');
    expect(detectProject(ws).toolchains).toBeUndefined();
  });
});
