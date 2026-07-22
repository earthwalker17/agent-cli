import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256 } from '../shared/hash.js';
import { SnapshotError } from '../shared/errors.js';

const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;

/** Recorded pre-image of one file. `beforeSha256 === null` ⇔ the file did not exist. */
export interface CapturedFile {
  path: string;
  beforeSha256: string | null;
  bytes: number;
}

export interface RestoreTarget {
  path: string;
  /** State to restore to (null ⇒ delete the file). */
  beforeSha256: string | null;
  /** Hash the file is expected to currently hold (the recorded post-mutation hash), or null if it should be absent. */
  expectedCurrentSha256: string | null;
}

export interface RestoreResult {
  path: string;
  ok: boolean;
  toSha256: string | null;
  reason?: string;
}

/**
 * Content-addressed pre-mutation snapshot store. Blobs are raw file bytes at
 * `<objectsDir>/<sha256>` — no git dependency (avoids git.exe assumptions and Windows
 * git-snapshot bugs). Metadata lives in the event log; this store owns only the bytes.
 */
export class SnapshotStore {
  constructor(private readonly objectsDir: string) {}

  private blobPath(hash: string): string {
    return path.join(this.objectsDir, hash);
  }

  /**
   * Capture pre-images of the given paths. Throws `SnapshotError` on any failure (locked file,
   * I/O error, or file over the size cap) so the caller escalates rather than proceeding with an
   * unrecoverable mutation. Absent files snapshot as `beforeSha256: null` (undo ⇒ delete).
   */
  capture(paths: string[]): CapturedFile[] {
    return paths.map((p) => this.captureOne(p));
  }

  private captureOne(p: string): CapturedFile {
    let bytes: Buffer;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) throw new SnapshotError('snapshot target is a directory', p);
      if (st.size > MAX_SNAPSHOT_BYTES) throw new SnapshotError(`file too large to snapshot (${st.size} bytes)`, p);
      bytes = fs.readFileSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { path: p, beforeSha256: null, bytes: 0 };
      if (e instanceof SnapshotError) throw e;
      throw new SnapshotError(`cannot read file for snapshot: ${(e as Error).message}`, p);
    }
    const hash = sha256(bytes);
    this.writeBlobAtomic(hash, bytes);
    return { path: p, beforeSha256: hash, bytes: bytes.length };
  }

  /**
   * Store arbitrary bytes as a content-addressed blob and return its hash. Used by the
   * worktree change-capture path (a task's after/base bytes must outlive the worktree).
   */
  putBlob(bytes: Buffer): string {
    const hash = sha256(bytes);
    this.writeBlobAtomic(hash, bytes);
    return hash;
  }

  /**
   * Atomic same-dir temp + rename (the memory-store pattern): concurrent sessions share this
   * store, and a plain write could be observed — or left by a crash — half-written. Writers of
   * the SAME hash write identical bytes, so losing the rename race to another writer is success.
   */
  private writeBlobAtomic(hash: string, bytes: Buffer): void {
    const bp = this.blobPath(hash);
    if (fs.existsSync(bp)) return;
    const tmp = `${bp}.tmp-${randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, bytes);
    try {
      fs.renameSync(tmp, bp);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort temp cleanup */
      }
      if (!fs.existsSync(bp)) throw err; // a concurrent identical write winning the rename is fine
    }
  }

  getBlob(hash: string): Buffer {
    try {
      return fs.readFileSync(this.blobPath(hash));
    } catch {
      throw new SnapshotError(`snapshot blob missing: ${hash}`, this.blobPath(hash));
    }
  }

  /**
   * Restore one file to its pre-image, but only if the file still holds the recorded
   * post-mutation content — a drifted file (external edit, or a later undo) is REFUSED rather
   * than clobbered. There is no force in V0.1 (force-clobbering unrecorded bytes is itself an
   * unsnapshotted destructive act).
   */
  restore(t: RestoreTarget): RestoreResult {
    let currentHash: string | null = null;
    try {
      currentHash = sha256(fs.readFileSync(t.path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { path: t.path, ok: false, toSha256: t.beforeSha256, reason: `cannot read current file: ${(e as Error).message}` };
      }
    }
    if (currentHash !== t.expectedCurrentSha256) {
      return {
        path: t.path,
        ok: false,
        toSha256: t.beforeSha256,
        reason: 'drift: file changed since the action (external edit or prior undo); refusing to overwrite',
      };
    }
    try {
      if (t.beforeSha256 === null) {
        fs.rmSync(t.path, { force: true });
      } else {
        fs.mkdirSync(path.dirname(t.path), { recursive: true });
        fs.writeFileSync(t.path, this.getBlob(t.beforeSha256));
      }
    } catch (e) {
      return { path: t.path, ok: false, toSha256: t.beforeSha256, reason: `restore failed: ${(e as Error).message}` };
    }
    return { path: t.path, ok: true, toSha256: t.beforeSha256 };
  }
}
