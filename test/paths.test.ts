import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePath } from '../src/policy/paths.js';
import { PathError } from '../src/shared/errors.js';

const isWin = process.platform === 'win32';
const itWin = isWin ? it : it.skip;

let tmp: string;
let ws: string;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-paths-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('validatePath boundary', () => {
  it('accepts an in-workspace relative path', () => {
    const v = validatePath(ws, 'src/index.ts');
    expect(v.inWorkspace).toBe(true);
    expect(v.resolved).toBe(path.join(ws, 'src', 'index.ts'));
  });

  it('flags a ".." traversal as outside the workspace', () => {
    expect(validatePath(ws, '..\\..\\etc').inWorkspace).toBe(false);
  });

  it('does NOT treat a sibling with a shared prefix as inside (the classic escape)', () => {
    const evil = path.join(tmp, 'ws-evil');
    fs.mkdirSync(evil);
    const v = validatePath(ws, path.join(evil, 'secret.txt'));
    expect(v.inWorkspace).toBe(false);
  });

  it('marks .git as protected', () => {
    expect(validatePath(ws, '.git/config').protectedPath).toBe(true);
  });

  it('marks the state dir as protected when provided', () => {
    const state = path.join(tmp, 'state');
    const target = path.join(state, 'sessions', 'x.jsonl');
    expect(validatePath(ws, target, { stateDir: state }).protectedPath).toBe(true);
  });
});

describe('validatePath hard rejects', () => {
  it('rejects NUL bytes', () => {
    expect(() => validatePath(ws, 'a\0b')).toThrow(PathError);
  });
  it('rejects device-namespace prefixes', () => {
    expect(() => validatePath(ws, '\\\\?\\C:\\x')).toThrowError(/device/);
  });
  it('rejects UNC paths', () => {
    expect(() => validatePath(ws, '\\\\server\\share\\x')).toThrowError(/UNC/);
  });
  it('rejects reserved device names (incl. with extension)', () => {
    expect(() => validatePath(ws, 'CON')).toThrowError(/reserved/);
    expect(() => validatePath(ws, 'nul.txt')).toThrowError(/reserved/);
  });
  itWin('rejects NTFS alternate data streams', () => {
    expect(() => validatePath(ws, 'file.txt:hidden')).toThrowError(/alternate data stream/);
  });
  itWin('rejects trailing dots/spaces (Windows silently strips them)', () => {
    expect(() => validatePath(ws, 'foo. ')).toThrowError(/trailing/);
    expect(() => validatePath(ws, 'bar.')).toThrowError(/trailing/);
  });
  it('still allows "." and ".." navigation segments', () => {
    expect(() => validatePath(ws, './src/../src/x.ts')).not.toThrow();
  });
});

describe('validatePath symlink/junction escape', () => {
  itWin('follows a junction out of the workspace and reports outside', () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(ws, 'link');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      return; // junction creation may require privileges; skip if unavailable
    }
    const v = validatePath(ws, 'link/secret.txt');
    expect(v.inWorkspace).toBe(false);
  });
});
