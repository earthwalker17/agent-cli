import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runGit } from '../git/client.js';
import { parsePorcelainV2 } from '../git/porcelain.js';
import { caseFold } from '../shared/pathutil.js';
import type { SnapshotStore } from '../store/snapshots.js';
import type { TaskChangeFile } from '../types.js';

/**
 * Executor change capture (V0.7): enumerate what a task's worktree changed vs its checkpoint
 * base and persist the AFTER bytes (and base identity) as content-addressed blobs — the diff
 * must outlive the worktree, which is removed the moment capture completes.
 *
 * Mechanics: the worktree is DETACHED AT the base commit, so `git status --porcelain=v2 -z`
 * enumerates exactly changed-vs-base (untracked included). Base bytes are materialized
 * BINARY-SAFELY via the checkpoint-restore pattern — read-tree into a temp index +
 * `checkout-index --prefix` staging (worktree form, filters applied) — never via string-stdout
 * `git show`. Everything is bounded and every omission is counted, never silent.
 */

export const MAX_TASK_CHANGE_FILES = 200;
export const MAX_TASK_CHANGE_FILE_BYTES = 5 * 1024 * 1024;

export interface CaptureDeps {
  gitPath: string;
  /** The worktree checkout root (the repo root of the linked worktree). */
  worktreeDir: string;
  /** Workspace prefix inside the repo ('' when the workspace IS the repo root), POSIX-slashed. */
  wsRel: string;
  baseOid: string;
  snapshots: SnapshotStore;
  /** Harness scratch for the temp index/staging (outside the worktree; cleaned in finally). */
  scratchDir: string;
  /** S14.5: `-c` EOL-pin args (probeEolPin) — the capture must materialize base bytes under the
   *  SAME config the worktree was checked out with, or base shas diverge from worktree reality. */
  pinArgs?: readonly string[];
}

export interface CaptureResult {
  files: TaskChangeFile[];
  omittedCount: number;
  error?: string;
}

export async function captureTaskChanges(deps: CaptureDeps): Promise<CaptureResult> {
  const g = (argv: string[], env?: Record<string, string>) =>
    runGit({ gitPath: deps.gitPath, argv: [...(deps.pinArgs ?? []), ...argv], cwd: deps.worktreeDir, ...(env ? { env } : {}), timeoutMs: 60_000 });

  const status = await g(['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  if (!status.ok) return { files: [], omittedCount: 0, error: `status failed: ${firstLine(status.stderr)}` };

  // Candidate repo-relative paths, workspace-filtered (the checkpoint tree spans the whole
  // repo; a subdir workspace must never capture — or later apply — outside itself).
  const wsPrefix = deps.wsRel.length > 0 ? `${deps.wsRel}/` : '';
  const candidates: string[] = [];
  for (const e of parsePorcelainV2(status.stdout).entries) {
    if (e.kind === 'ignored') continue;
    if (wsPrefix.length > 0 && !caseFold(e.path + '/').startsWith(caseFold(wsPrefix))) continue;
    candidates.push(e.path);
    if (e.kind === 'renamed' && e.origPath !== undefined) {
      if (wsPrefix.length === 0 || caseFold(e.origPath + '/').startsWith(caseFold(wsPrefix))) candidates.push(e.origPath);
    }
  }
  const unique = [...new Set(candidates)].sort();
  const kept = unique.slice(0, MAX_TASK_CHANGE_FILES);
  const omittedCount = unique.length - kept.length;
  if (kept.length === 0) return { files: [], omittedCount };

  const tag = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const indexFile = path.join(deps.scratchDir, `capture-index-${tag}`);
  const staging = path.join(deps.scratchDir, `capture-stage-${tag}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    fs.rmSync(indexFile, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    const read = await g(['read-tree', deps.baseOid], env);
    if (!read.ok) return { files: [], omittedCount: 0, error: `read-tree failed: ${firstLine(read.stderr)}` };
    const lsBase = await g(['ls-files', '-z'], env);
    if (!lsBase.ok) return { files: [], omittedCount: 0, error: `ls-files failed: ${firstLine(lsBase.stderr)}` };
    const baseSet = new Set(lsBase.stdout.split('\0').filter((p) => p.length > 0));

    const inBase = kept.filter((p) => baseSet.has(p));
    for (let i = 0; i < inBase.length; i += 100) {
      const batch = inBase.slice(i, i + 100);
      const co = await g(['checkout-index', '-f', `--prefix=${staging}${path.sep}`, '--', ...batch], env);
      if (!co.ok) return { files: [], omittedCount: 0, error: `checkout-index failed: ${firstLine(co.stderr)}` };
    }

    const files: TaskChangeFile[] = [];
    for (const repoRel of kept) {
      const relPath = wsPrefix.length > 0 ? repoRel.slice(wsPrefix.length) : repoRel;
      const baseFile = path.join(staging, repoRel);
      const afterFile = path.join(deps.worktreeDir, repoRel);
      const baseBytes = fs.existsSync(baseFile) && baseSet.has(repoRel) ? fs.readFileSync(baseFile) : null;
      const afterExists = fs.existsSync(afterFile) && fs.statSync(afterFile).isFile();
      if (baseBytes === null && !afterExists) continue; // e.g. a directory-only entry; nothing to say
      const kind: TaskChangeFile['kind'] = baseBytes === null ? 'create' : !afterExists ? 'delete' : 'modify';
      const baseSha256 = baseBytes !== null ? deps.snapshots.putBlob(baseBytes) : null;
      if (kind === 'delete') {
        files.push({ relPath, kind, baseSha256, blobSha256: null, bytes: 0 });
        continue;
      }
      const stat = fs.statSync(afterFile);
      if (stat.size > MAX_TASK_CHANGE_FILE_BYTES) {
        files.push({ relPath, kind, baseSha256, blobSha256: null, bytes: stat.size, oversize: true });
        continue;
      }
      const afterBytes = fs.readFileSync(afterFile);
      const blobSha256 = deps.snapshots.putBlob(afterBytes);
      if (kind === 'modify' && blobSha256 === baseSha256) continue; // byte-identical: not a change
      files.push({ relPath, kind, baseSha256, blobSha256, bytes: afterBytes.length });
    }
    return { files, omittedCount };
  } catch (err) {
    return { files: [], omittedCount: 0, error: `capture failed: ${(err as Error).message}` };
  } finally {
    fs.rmSync(indexFile, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function firstLine(s: string): string {
  return s.split('\n')[0]?.trim() ?? '';
}
