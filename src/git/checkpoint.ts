import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runGit } from './client.js';
import { caseFold } from '../shared/pathutil.js';
import type { SnapshotStore } from '../store/snapshots.js';
import type { EventBody } from '../types.js';

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

/**
 * Temp-file disambiguator: pid alone is NOT enough once one process runs concurrent sessions
 * (parallel worktree children checkpoint from the SAME pid), so every temp index/staging name
 * carries fresh randomness per operation.
 */
function tempTag(): string {
  return `${process.pid}-${randomBytes(4).toString('hex')}`;
}
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
  /**
   * Turn cancellation (Session 21.6). Absent for the user-typed flows, which are not running
   * inside a turn; supplied by `git_checkpoint`, because `types.ts` requires a long-running tool
   * to observe the signal and a whole-tree `add -A` is otherwise unkillable by Ctrl+C.
   */
  signal?: AbortSignal;
  /**
   * Per-invocation timeout override. The client's 15 s default is generous for plumbing and thin
   * for `add -A` / `write-tree` over a large cold tree; a capture that dies on a timer is not a
   * safer capture, it is an absent one.
   */
  timeoutMs?: number;
}

/**
 * The label the /accept delivery path gives its checkpoint, and the ONLY way `agent checkpoint
 * prune` recognizes a delivery anchor.
 *
 * It is matched against the WHOLE subject, anchored (Session 21.6). A substring test was
 * forgeable: `createCheckpoint` interpolates the caller's label into the same subject, so once a
 * model could choose a label, `x: delivery (accepted)` produced a ref that prune preserved and
 * that `agent checkpoint list` presented as an accepted state no acceptance ever produced. A label
 * is display; it must never be identity.
 */
export const DELIVERY_LABEL = 'delivery (accepted)';
const DELIVERY_SUBJECT_RE = /^agent checkpoint \d+: delivery \(accepted\) \(session .+\)$/;

/** True only for a subject this harness itself composed for a delivery checkpoint. */
export function isDeliverySubject(subject: string): boolean {
  return DELIVERY_SUBJECT_RE.test(subject.trim());
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
  /** Honest degrade notes (e.g. the untracked guard could not run) — display, never a verdict. */
  notes?: string[];
}

export interface CreateCheckpointOptions {
  label?: string;
  /** Asked before capturing when more than `untrackedWarnThreshold` untracked files would be swept in. */
  confirmLargeUntracked?: (count: number) => Promise<boolean>;
  untrackedWarnThreshold?: number;
  /**
   * Event-before-ref seam (Session 14): invoked with the chosen ref name and commit oid
   * AFTER commit-tree and BEFORE update-ref. Harness call sites append their creation event
   * here (EventLog.append is synchronous), so a crash between the append and the ref write
   * leaves an owed ref that does not exist — `deleteCheckpointRefs` counts a missing ref as
   * deleted, so the prune fold converges and the creation-instant leak is structurally
   * closed. If update-ref then FAILS, the recorded creation is a phantom: readers must treat
   * the ref scan (`agent checkpoint list`) as live truth and fold latest-creation-per-ref.
   * A throw here aborts the checkpoint BEFORE the ref exists (surfaced as ok:false) — a ref
   * with no recorded creation would be exactly the leak this seam closes.
   */
  onRefReady?: (ref: string, oid: string) => void;
}

export async function createCheckpoint(
  cctx: CheckpointContext,
  sessionId: string,
  opts: CreateCheckpointOptions = {},
): Promise<CreateCheckpointResult> {
  const g = (argv: string[], env?: Record<string, string>, cwd?: string) =>
    runGit({
      gitPath: cctx.gitPath,
      argv,
      cwd: cwd ?? cctx.repoRoot,
      ...(env ? { env } : {}),
      ...(cctx.signal !== undefined ? { signal: cctx.signal } : {}),
      ...(cctx.timeoutMs !== undefined ? { timeoutMs: cctx.timeoutMs } : {}),
    });

  const notes: string[] = [];
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
  } else {
    // The guard could not run (ls-files failed) — proceeding is the right call (this is a
    // convenience guard against sweeping huge un-ignored trees, not a boundary), but doing so
    // SILENTLY was not: the caller and the user must see that the sweep size went unchecked.
    notes.push(`untracked-sweep guard skipped (ls-files failed: ${firstLine(untracked.stderr) || 'unknown error'}) — the checkpoint may capture a large untracked set`);
  }

  const indexFile = path.join(cctx.stateDir, `checkpoint-index-${tempTag()}`);
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
    try {
      opts.onRefReady?.(ref, oid);
    } catch (e) {
      return { ok: false, error: `checkpoint creation record failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const updateRef = await g(['update-ref', ref, oid]);
    if (!updateRef.ok) return { ok: false, error: `update-ref failed: ${firstLine(updateRef.stderr)}` };

    const diff = await g(['diff-tree', '-r', '--name-only', '-z', hasHead ? 'HEAD' : EMPTY_TREE, oid]);
    const filesChanged = diff.ok ? diff.stdout.split('\0').filter((p) => p.length > 0).length : 0;
    return { ok: true, ref, oid, n, filesChanged, ...(notes.length > 0 ? { notes } : {}) };
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

/**
 * Delete SPECIFIC checkpoint refs by name (V0.7.1: session-end task-base pruning). Best-effort
 * per ref; the caller owns announcing and recording the outcome. An already-missing ref counts
 * as DELETED, not failed (Session 11.5): the goal state is "ref gone", and the event-seeded
 * resume prune retries anything in `failed` at every later quit — a ref the user already
 * pruned by hand must converge, never re-fail forever.
 */
export async function deleteCheckpointRefs(
  gitPath: string,
  repoRoot: string,
  refs: readonly string[],
): Promise<{ deleted: string[]; failed: string[] }> {
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const ref of refs) {
    const r = await runGit({ gitPath, argv: ['update-ref', '-d', ref], cwd: repoRoot });
    if (r.ok) {
      deleted.push(ref);
      continue;
    }
    // update-ref -d failed: distinguish "already gone" (success) from a real failure.
    // show-ref --verify --quiet exits 1 exactly when the ref does not exist; any other
    // outcome (0 = still there, 128/killed = git trouble) stays a retryable failure.
    const probe = await runGit({ gitPath, argv: ['show-ref', '--verify', '--quiet', ref], cwd: repoRoot });
    (probe.exitCode === 1 ? deleted : failed).push(ref);
  }
  return { deleted, failed };
}

/**
 * Delete checkpoint refs (all sessions when sessionId is undefined) so gc can reclaim them.
 * S14.5: shares deleteCheckpointRefs' missing-ref rule (already-gone counts as deleted) — the
 * two prune paths previously disagreed, and under the event-before-ref phantom window a ref
 * that vanished between the list and the delete must converge, not report a failure.
 */
export async function pruneCheckpoints(cctx: CheckpointContext, sessionId?: string): Promise<{ deleted: string[]; failed: string[] }> {
  const refs = await listCheckpoints(cctx, sessionId);
  return deleteCheckpointRefs(cctx.gitPath, cctx.repoRoot, refs.map((c) => c.ref));
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '(no output)';
}

// ── Restore ────────────────────────────────────────────────────────────────────────────────
//
// "Restore to checkpoint N" = make the WORKSPACE SUBTREE byte-identical to the checkpoint,
// including DELETING files the checkpoint predates — a half-restore that leaves later
// creations behind is not the checkpointed state (the failure mode that burned Codex).
// Never `git restore`/`git checkout` against the user's worktree: the affected set is computed
// tree-to-tree (current temp tree vs checkpoint tree, workspace-scoped), content is
// materialized through a SECOND temp index with `checkout-index --prefix` into a state-dir
// staging area (smudge filters/CRLF apply; binary-safe — file bytes never pass through a
// captured pipe). Restored content is therefore the git-native WORKTREE FORM under the repo's
// current filter config — exactly what `git checkout` would produce; a file whose original
// bytes were in a non-canonical form (e.g. LF on disk under autocrlf=true) comes back
// canonicalized, the same lossy round-trip git itself has. Every write goes through the
// harness's own snapshot-first flow:
// pre-images captured under ONE synthetic callId (+ snapshot.created + file.mutated events),
// so the whole restore is one atomically-undoable batch under the existing applyUndo contract.

export interface RestorePlanEntry {
  /** Repo-root-relative POSIX path. */
  relPath: string;
  absPath: string;
  /** write = create/overwrite with checkpoint content; delete = the checkpoint predates it. */
  action: 'write' | 'delete';
}

export interface RestorePlan {
  checkpoint: CheckpointInfo;
  entries: RestorePlanEntry[];
  error?: string;
}

export async function planRestore(cctx: CheckpointContext, checkpoint: CheckpointInfo): Promise<RestorePlan> {
  const g = (argv: string[], env?: Record<string, string>, cwd?: string) =>
    runGit({ gitPath: cctx.gitPath, argv, cwd: cwd ?? cctx.repoRoot, ...(env ? { env } : {}) });

  // Current-state tree via the same temp-index construction the checkpoint used.
  const indexFile = path.join(cctx.stateDir, `restore-index-${tempTag()}`);
  fs.rmSync(indexFile, { force: true });
  const env = { GIT_INDEX_FILE: indexFile };
  let currentTree: string;
  try {
    const head = await g(['rev-parse', '--verify', '-q', 'HEAD']);
    if (head.ok) {
      const read = await g(['read-tree', 'HEAD'], env);
      if (!read.ok) return { checkpoint, entries: [], error: `read-tree failed: ${firstLine(read.stderr)}` };
    }
    const add = await g(['add', '-A', '--', '.'], env, cctx.workspaceRoot);
    if (!add.ok) return { checkpoint, entries: [], error: `add failed: ${firstLine(add.stderr)}` };
    const tree = await g(['write-tree'], env);
    if (!tree.ok) return { checkpoint, entries: [], error: `write-tree failed: ${firstLine(tree.stderr)}` };
    currentTree = tree.stdout.trim();
  } finally {
    fs.rmSync(indexFile, { force: true });
  }

  // Affected set, current → checkpoint. D = delete on disk; A/M/T = write checkpoint content.
  const diff = await g(['diff-tree', '-r', '-z', '--name-status', currentTree, checkpoint.oid]);
  if (!diff.ok) return { checkpoint, entries: [], error: `diff-tree failed: ${firstLine(diff.stderr)}` };

  // Workspace-subtree guard: HEAD may have moved since the checkpoint, which makes files
  // OUTSIDE the workspace differ between the two trees — restore must never touch those.
  const wsRel = path.relative(cctx.repoRoot, cctx.workspaceRoot).split(path.sep).join('/');
  const wsPrefix = wsRel.length > 0 ? `${wsRel}/` : '';

  const entries: RestorePlanEntry[] = [];
  const tokens = diff.stdout.split('\0').filter((t) => t.length > 0);
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i]![0]!;
    const relPath = tokens[i + 1]!;
    if (wsPrefix.length > 0 && !caseFold(relPath + '/').startsWith(caseFold(wsPrefix))) continue;
    if (status === 'D') entries.push({ relPath, absPath: path.join(cctx.repoRoot, relPath), action: 'delete' });
    else entries.push({ relPath, absPath: path.join(cctx.repoRoot, relPath), action: 'write' });
  }
  return { checkpoint, entries };
}

export interface RestoreDeps {
  snapshots: SnapshotStore;
  appendEvent: (e: EventBody) => void;
  /** One synthetic callId binding the whole batch (snapshot + mutations = one undo unit). */
  callId: string;
  info: (line: string) => void;
  /** Confirmation; null = non-interactive (restore then requires assumeYes). */
  question: ((q: string) => Promise<string | null>) | null;
  assumeYes: boolean;
}

export interface RestoreResult {
  performed: boolean;
  restored: string[];
  refused: { path: string; reason: string }[];
}

export async function runRestoreFlow(cctx: CheckpointContext, checkpoint: CheckpointInfo, deps: RestoreDeps): Promise<RestoreResult> {
  const plan = await planRestore(cctx, checkpoint);
  if (plan.error) {
    deps.info(`  restore failed: ${plan.error}`);
    return { performed: false, restored: [], refused: [] };
  }
  if (plan.entries.length === 0) {
    deps.info('  workspace already matches the checkpoint — nothing to restore');
    return { performed: false, restored: [], refused: [] };
  }

  deps.info(`  restoring to ${checkpoint.oid.slice(0, 12)} (${checkpoint.subject}) affects ${plan.entries.length} file(s):`);
  for (const e of plan.entries) deps.info(`    ${e.action === 'delete' ? 'delete' : 'write '}  ${e.relPath}`);
  deps.info('  current bytes are snapshotted first: the restore is one undoable batch (/undo reverts it)');
  if (!deps.assumeYes) {
    if (deps.question === null) {
      deps.info('  refusing: non-interactive restore requires --yes');
      return { performed: false, restored: [], refused: [] };
    }
    const a = await deps.question(`  restore ${plan.entries.length} file(s)? [y/N] `);
    if (a === null || !/^y(es)?$/i.test(a.trim())) {
      deps.info('  restore cancelled');
      return { performed: false, restored: [], refused: [] };
    }
  }

  // Snapshot-first, ALL paths — a failure here refuses the WHOLE restore (a partially
  // undoable restore would be worse than none).
  let captured;
  try {
    captured = deps.snapshots.capture(plan.entries.map((e) => e.absPath));
    deps.appendEvent({
      type: 'snapshot.created',
      callId: deps.callId,
      files: captured.map((f) => ({ path: f.path, beforeSha256: f.beforeSha256, bytes: f.bytes })),
    });
  } catch (e) {
    deps.info(`  restore refused: cannot snapshot current state (${(e as Error).message}) — nothing was changed`);
    return { performed: false, restored: [], refused: [] };
  }
  const beforeByFold = new Map(captured.map((f) => [caseFold(f.path), f.beforeSha256]));

  // Materialize checkpoint content into a staging dir via checkout-index (binary-safe, smudge
  // filters applied — bytes never pass through a captured pipe).
  const writes = plan.entries.filter((e) => e.action === 'write');
  const staging = path.join(cctx.stateDir, `restore-stage-${tempTag()}`);
  const indexFile = path.join(cctx.stateDir, `restore-index2-${tempTag()}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(indexFile, { force: true });
  fs.mkdirSync(staging, { recursive: true }); // checkout-index will not create the prefix dir itself
  const env = { GIT_INDEX_FILE: indexFile };
  const restored: string[] = [];
  const refused: { path: string; reason: string }[] = [];
  try {
    if (writes.length > 0) {
      const read = await runGit({ gitPath: cctx.gitPath, argv: ['read-tree', checkpoint.oid], cwd: cctx.repoRoot, env });
      if (!read.ok) {
        deps.info(`  restore failed before any change: read-tree ${firstLine(read.stderr)}`);
        return { performed: false, restored: [], refused: [] };
      }
      for (let i = 0; i < writes.length; i += 100) {
        const batch = writes.slice(i, i + 100);
        const co = await runGit({
          gitPath: cctx.gitPath,
          argv: ['checkout-index', '-f', `--prefix=${staging}${path.sep}`, '--', ...batch.map((e) => e.relPath)],
          cwd: cctx.repoRoot,
          env,
        });
        if (!co.ok) {
          deps.info(`  restore failed before any change: checkout-index ${firstLine(co.stderr)}`);
          return { performed: false, restored: [], refused: [] };
        }
      }
    }

    const { sha256 } = await import('../shared/hash.js');
    for (const e of plan.entries) {
      const before = beforeByFold.get(caseFold(e.absPath)) ?? null;
      try {
        if (e.action === 'delete') {
          fs.rmSync(e.absPath, { force: true });
          deps.appendEvent({ type: 'file.mutated', callId: deps.callId, path: e.absPath, kind: 'delete', beforeSha256: before, afterSha256: null, createdDirs: [] });
        } else {
          const bytes = fs.readFileSync(path.join(staging, e.relPath));
          fs.mkdirSync(path.dirname(e.absPath), { recursive: true });
          fs.writeFileSync(e.absPath, bytes);
          deps.appendEvent({
            type: 'file.mutated',
            callId: deps.callId,
            path: e.absPath,
            kind: before === null ? 'create' : 'modify',
            beforeSha256: before,
            afterSha256: sha256(bytes),
            createdDirs: [],
          });
        }
        restored.push(e.relPath);
      } catch (err) {
        refused.push({ path: e.relPath, reason: (err as Error).message });
      }
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(indexFile, { force: true });
  }

  deps.appendEvent({ type: 'git.restore', ref: checkpoint.ref, oid: checkpoint.oid, restored, refused });
  return { performed: true, restored, refused };
}
