import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './client.js';

/**
 * Manual recovery checkpoints (V0.5): a point-in-time capture of the workspace subtree as a
 * git commit object reachable ONLY from a hidden ref — the user's index, HEAD, working tree,
 * and branches are never touched. Built with plumbing against a TEMPORARY index file:
 *
 *   read-tree HEAD → add -A (workspace cwd) → write-tree → commit-tree → update-ref
 *     refs/agent-cli/checkpoints/<sessionId>/<n>
 *
 * Honesty (“low-pollution, not zero”): loose objects land in the repo's .git/objects and the
 * hidden refs keep them alive across gc; `checkpoint prune` deletes the refs so gc can collect.
 * A user-run `git gc --prune=now` racing between write-tree and update-ref is accepted and
 * documented. Checkpoints respect .gitignore natively (the add runs against the real repo
 * excludes), and an untracked-file sweep guard asks before capturing an unusually large set —
 * the Codex ghost-commit failure mode.
 */

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const REF_ROOT = 'refs/agent-cli/checkpoints';
const UNTRACKED_WARN_THRESHOLD = 200;

/** Identity used ONLY for checkpoint commit objects — user identity is never required or set. */
const CHECKPOINT_IDENT_ENV = {
  GIT_AUTHOR_NAME: 'Agent CLI',
  GIT_AUTHOR_EMAIL: 'agent-cli@localhost',
  GIT_COMMITTER_NAME: 'Agent CLI',
  GIT_COMMITTER_EMAIL: 'agent-cli@localhost',
};

export interface CheckpointContext {
  gitPath: string;
  repoRoot: string;
  workspaceRoot: string;
  /** Project state dir — holds the temporary index file (outside the workspace by contract). */
  stateDir: string;
}

export interface CheckpointInfo {
  ref: string;
  oid: string;
  sessionId: string;
  n: number;
  subject: string;
  createdAt: string;
}

export interface CreateCheckpointResult {
  ok: boolean;
  ref?: string;
  oid?: string;
  n?: number;
  /** Files that differ between HEAD (or the empty tree when unborn) and the checkpoint. */
  filesChanged?: number;
  error?: string;
  /** True when the untracked-sweep guard asked and the caller declined. */
  declined?: boolean;
}

export interface CreateCheckpointOptions {
  label?: string;
  /** Asked before capturing when more than `untrackedWarnThreshold` untracked files would be swept in. */
  confirmLargeUntracked?: (count: number) => Promise<boolean>;
  untrackedWarnThreshold?: number;
}

export async function createCheckpoint(
  cctx: CheckpointContext,
  sessionId: string,
  opts: CreateCheckpointOptions = {},
): Promise<CreateCheckpointResult> {
  const g = (argv: string[], env?: Record<string, string>, cwd?: string) =>
    runGit({ gitPath: cctx.gitPath, argv, cwd: cwd ?? cctx.repoRoot, ...(env ? { env } : {}) });

  const untracked = await g(['ls-files', '-z', '--others', '--exclude-standard'], undefined, cctx.workspaceRoot);
  if (untracked.ok) {
    const count = untracked.stdout.split('\0').filter((p) => p.length > 0).length;
    const threshold = opts.untrackedWarnThreshold ?? UNTRACKED_WARN_THRESHOLD;
    if (count > threshold) {
      const proceed = opts.confirmLargeUntracked !== undefined ? await opts.confirmLargeUntracked(count) : false;
      if (!proceed) {
        return { ok: false, declined: true, error: `declined: ${count} untracked files would be captured (is something big not gitignored?)` };
      }
    }
  }

  const indexFile = path.join(cctx.stateDir, `checkpoint-index-${process.pid}`);
  fs.rmSync(indexFile, { force: true });
  const env = { GIT_INDEX_FILE: indexFile }; // absolute — a relative value would resolve against the child cwd
  try {
    const head = await g(['rev-parse', '--verify', '-q', 'HEAD']);
    const hasHead = head.ok;
    if (hasHead) {
      const read = await g(['read-tree', 'HEAD'], env);
      if (!read.ok) return { ok: false, error: `read-tree failed: ${firstLine(read.stderr)}` };
    } // unborn: the fresh temp index starts empty — exactly the desired base

    const add = await g(['add', '-A', '--', '.'], env, cctx.workspaceRoot);
    if (!add.ok) return { ok: false, error: `add failed: ${firstLine(add.stderr)}` };

    const tree = await g(['write-tree'], env);
    if (!tree.ok) return { ok: false, error: `write-tree failed: ${firstLine(tree.stderr)}` };
    const treeOid = tree.stdout.trim();

    const n = (await maxCheckpointN(cctx, sessionId)) + 1;
    const subject = `agent checkpoint ${n}${opts.label ? `: ${opts.label}` : ''} (session ${sessionId})`;
    const commitArgv = ['commit-tree', treeOid, ...(hasHead ? ['-p', 'HEAD'] : []), '-m', subject];
    const commit = await g(commitArgv, { ...env, ...CHECKPOINT_IDENT_ENV });
    if (!commit.ok) return { ok: false, error: `commit-tree failed: ${firstLine(commit.stderr)}` };
    const oid = commit.stdout.trim();

    const ref = `${REF_ROOT}/${sessionId}/${n}`;
    const updateRef = await g(['update-ref', ref, oid]);
    if (!updateRef.ok) return { ok: false, error: `update-ref failed: ${firstLine(updateRef.stderr)}` };

    const diff = await g(['diff-tree', '-r', '--name-only', '-z', hasHead ? 'HEAD' : EMPTY_TREE, oid]);
    const filesChanged = diff.ok ? diff.stdout.split('\0').filter((p) => p.length > 0).length : 0;
    return { ok: true, ref, oid, n, filesChanged };
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

async function maxCheckpointN(cctx: CheckpointContext, sessionId: string): Promise<number> {
  const list = await listCheckpoints(cctx, sessionId);
  return list.reduce((max, c) => Math.max(max, c.n), 0);
}

export async function listCheckpoints(cctx: CheckpointContext, sessionId?: string): Promise<CheckpointInfo[]> {
  const prefix = sessionId !== undefined ? `${REF_ROOT}/${sessionId}` : REF_ROOT;
  const r = await runGit({
    gitPath: cctx.gitPath,
    argv: ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(subject)%00%(creatordate:iso8601)', prefix],
    cwd: cctx.repoRoot,
  });
  if (!r.ok) return [];
  const out: CheckpointInfo[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const [ref, oid, subject, createdAt] = line.split('\0');
    if (!ref || !oid) continue;
    const parts = ref.split('/');
    const n = Number(parts[parts.length - 1]);
    const sid = parts.slice(3, -1).join('/');
    out.push({ ref, oid, sessionId: sid, n: Number.isFinite(n) ? n : 0, subject: subject ?? '', createdAt: createdAt ?? '' });
  }
  return out.sort((a, b) => (a.sessionId === b.sessionId ? a.n - b.n : a.sessionId.localeCompare(b.sessionId)));
}

/** Delete checkpoint refs (all sessions when sessionId is undefined) so gc can reclaim them. */
export async function pruneCheckpoints(cctx: CheckpointContext, sessionId?: string): Promise<{ deleted: string[]; failed: string[] }> {
  const refs = await listCheckpoints(cctx, sessionId);
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const c of refs) {
    const r = await runGit({ gitPath: cctx.gitPath, argv: ['update-ref', '-d', c.ref], cwd: cctx.repoRoot });
    (r.ok ? deleted : failed).push(c.ref);
  }
  return { deleted, failed };
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '(no output)';
}
