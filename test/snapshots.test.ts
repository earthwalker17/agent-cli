import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SnapshotStore } from '../src/store/snapshots.js';
import { SnapshotError } from '../src/shared/errors.js';
import { sha256 } from '../src/shared/hash.js';

let tmp: string;
let objects: string;
let store: SnapshotStore;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-snap-'));
  objects = path.join(tmp, 'objects');
  fs.mkdirSync(objects);
  store = new SnapshotStore(objects);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SnapshotStore.capture', () => {
  it('captures an existing file and stores its blob', () => {
    const f = path.join(tmp, 'a.txt');
    fs.writeFileSync(f, 'original');
    const [rec] = store.capture([f]);
    expect(rec!.beforeSha256).toBe(sha256('original'));
    expect(fs.existsSync(path.join(objects, rec!.beforeSha256!))).toBe(true);
  });
  it('captures an absent file as beforeSha256 null (undo ⇒ delete)', () => {
    const [rec] = store.capture([path.join(tmp, 'ghost.txt')]);
    expect(rec!.beforeSha256).toBeNull();
  });
  it('throws SnapshotError on an oversized file (escalation, not silent proceed)', () => {
    const f = path.join(tmp, 'big.bin');
    fs.writeFileSync(f, Buffer.alloc(21 * 1024 * 1024));
    expect(() => store.capture([f])).toThrow(SnapshotError);
  });
});

describe('SnapshotStore.restore', () => {
  it('restores modified content when the file still holds the post-image', () => {
    const f = path.join(tmp, 'a.txt');
    fs.writeFileSync(f, 'original');
    const [rec] = store.capture([f]);
    fs.writeFileSync(f, 'changed');
    const res = store.restore({ path: f, beforeSha256: rec!.beforeSha256, expectedCurrentSha256: sha256('changed') });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('original');
  });
  it('deletes a created file on undo (beforeSha256 null)', () => {
    const f = path.join(tmp, 'new.txt');
    store.capture([f]); // absent
    fs.writeFileSync(f, 'created content');
    const res = store.restore({ path: f, beforeSha256: null, expectedCurrentSha256: sha256('created content') });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(f)).toBe(false);
  });
  it('REFUSES to overwrite a drifted file (external edit since the action)', () => {
    const f = path.join(tmp, 'a.txt');
    fs.writeFileSync(f, 'original');
    const [rec] = store.capture([f]);
    fs.writeFileSync(f, 'the agent wrote this');
    // A human edited it after the agent — expectedCurrentSha256 no longer matches disk.
    fs.writeFileSync(f, 'human edited this later');
    const res = store.restore({ path: f, beforeSha256: rec!.beforeSha256, expectedCurrentSha256: sha256('the agent wrote this') });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/drift/);
    expect(fs.readFileSync(f, 'utf8')).toBe('human edited this later'); // untouched
  });
  it('errors clearly when the blob is missing', () => {
    const f = path.join(tmp, 'a.txt');
    fs.writeFileSync(f, 'x');
    const res = store.restore({ path: f, beforeSha256: 'deadbeef'.repeat(8), expectedCurrentSha256: sha256('x') });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/blob missing/);
  });
  it('preserves binary fidelity across capture/restore', () => {
    const f = path.join(tmp, 'img.bin');
    const bytes = Buffer.from([0, 255, 10, 13, 200, 0, 1]);
    fs.writeFileSync(f, bytes);
    const [rec] = store.capture([f]);
    fs.writeFileSync(f, Buffer.from([9, 9, 9]));
    store.restore({ path: f, beforeSha256: rec!.beforeSha256, expectedCurrentSha256: sha256(Buffer.from([9, 9, 9])) });
    expect(fs.readFileSync(f).equals(bytes)).toBe(true);
  });
});
