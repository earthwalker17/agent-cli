import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './client.js';
import { parsePorcelainV2 } from './porcelain.js';
import { sessionMutationState } from '../report/diff.js';
import { sha256 } from '../shared/hash.js';
import { caseFold } from '../shared/pathutil.js';
import type { GitStatusEntry } from './types.js';
import type { SessionEvent } from '../types.js';

/**
 * The deliberate-commit flow (V0.5). This is a HARNESS capability driven by an explicit user
 * command (/commit, `agent commit`) — never reachable by the model. Contract:
 *
 * - Default scope is `session`: only paths the session's evidence log attributes to the agent
 *   (file.mutated, undo folded in) are staged — the user's own unrelated edits stay out unless
 *   `--all` is passed deliberately. Attribution is exact but structurally UNDER-claims:
 *   run_command side effects are not attributable, and the preview says so.
 * - Every path staged in session scope comes from the intersection of `git status` and the
 *   attribution set, so a stage pathspec can never miss (deleted-tracked files appear as status
 *   D entries; gitignored/vanished-untracked paths never appear at all).
 * - Preconditions are BLOCKERS, not warnings, when they would corrupt attribution: missing
 *   identity (never set it for the user), and — in session scope — a pre-staged index (the
 *   commit would sweep the user's staged work in under the agent's name).
 * - The commit itself is ordinary porcelain `git add` + `git commit -F <file>` against the real
 *   index: hooks run, a hook failure is reported honestly, and staged state remains exactly as
 *   a manual failed commit would leave it.
 */

export const AGENT_TRAILER = 'Co-authored-by: Agent CLI <agent-cli@localhost>';

export interface CommitContext {
  gitPath: string;
  repoRoot: string;
  workspaceRoot: string;
  /** Directory for the temporary commit-message file (the project state dir). */
  messageDir: string;
}

export interface CommitPreviewEntry {
  /** Repo-root-relative POSIX path (porcelain contract). */
  path: string;
  kind: GitStatusEntry['kind'];
  x: string;
  y: string;
  /** True when the session's evidence log attributes this path to the agent. */
  attributed: boolean;
  /** Attributed, but disk bytes differ from the last state the session recorded. */
  drifted: boolean;
}

export interface CommitPreview {
  scope: 'session' | 'all';
  entries: CommitPreviewEntry[];
  /** Repo-relative paths to stage (session scope); `null` means stage the workspace subtree. */
  stagePaths: string[] | null;
  proposedSubject: string;
  warnings: string[];
  /** Non-empty ⇒ the commit must not proceed. */
  blockers: string[];
}

const STAGE_BATCH = 100;

export async function prepareCommit(
  cctx: CommitContext,
  events: readonly SessionEvent[],
  scope: 'session' | 'all',
): Promise<CommitPreview> {
  const warnings: string[] = [];
  const blockers: string[] = [];

  const name = await runGit({ gitPath: cctx.gitPath, argv: ['config', '--get', 'user.name'], cwd: cctx.repoRoot });
  const email = await runGit({ gitPath: cctx.gitPath, argv: ['config', '--get', 'user.email'], cwd: cctx.repoRoot });
  if (!name.ok || !email.ok || name.stdout.trim().length === 0 || email.stdout.trim().length === 0) {
    blockers.push(
      'git identity is not configured; set it yourself first (git config --global user.name "…" and user.email "…") — the harness never sets identity for you',
    );
  }

  const preStaged = await runGit({ gitPath: cctx.gitPath, argv: ['diff', '--cached', '--quiet'], cwd: cctx.repoRoot });
  if (preStaged.termination === 'exited' && preStaged.exitCode !== 0) {
    if (scope === 'session') {
      blockers.push(
        'the git index already has staged changes; committing now would sweep them in under this session. Commit or unstage them first, or use --all to include everything deliberately',
      );
    } else {
      warnings.push('the git index already had staged changes; --all will include them in this commit');
    }
  }

  // --untracked-files=all: without it a brand-new directory collapses to one `dir/` entry and
  // files the session created inside it could never match the attribution set.
  const status = await runGit({ gitPath: cctx.gitPath, argv: ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', '.'], cwd: cctx.workspaceRoot });
  if (!status.ok) {
    blockers.push(`git status failed: ${status.stderr.split(/\r?\n/)[0] ?? status.termination}`);
    return { scope, entries: [], stagePaths: scope === 'session' ? [] : null, proposedSubject: proposeSubject(events), warnings, blockers };
  }

  // Attribution: recorded absolute paths → case-folded lookup; drift = disk differs from the
  // last recorded state.
  const { expectedNow } = sessionMutationState(events);
  const attributedByFold = new Map<string, string | null>();
  for (const [absPath, sha] of expectedNow) attributedByFold.set(caseFold(absPath), sha);

  const entries: CommitPreviewEntry[] = [];
  for (const s of parsePorcelainV2(status.stdout).entries) {
    if (s.kind === 'ignored') continue;
    const abs = path.join(cctx.repoRoot, s.path);
    const fold = caseFold(abs);
    const attributed = attributedByFold.has(fold);
    let drifted = false;
    if (attributed) {
      let diskSha: string | null = null;
      try {
        diskSha = sha256(fs.readFileSync(abs));
      } catch {
        diskSha = null;
      }
      drifted = diskSha !== (attributedByFold.get(fold) ?? null);
    }
    entries.push({ path: s.path, kind: s.kind, x: s.x, y: s.y, attributed, drifted });
  }

  const attributedEntries = entries.filter((e) => e.attributed);
  const unattributed = entries.length - attributedEntries.length;
  if (scope === 'session') {
    if (attributedEntries.length === 0) {
      blockers.push('no attributable session file changes to commit (file-tool changes only; run_command side effects are not attributable). Use --all to commit everything in the workspace');
    }
    if (unattributed > 0) {
      warnings.push(
        `${unattributed} other change(s) in the workspace are NOT included — they are not attributable to this session's file tools (they may include your own edits or run_command effects). Use --all to include everything`,
      );
    }
  }
  for (const e of attributedEntries.filter((e) => e.drifted)) {
    warnings.push(`${e.path}: session-changed, then externally modified — the commit will contain the CURRENT bytes`);
  }

  return {
    scope,
    entries,
    stagePaths: scope === 'session' ? attributedEntries.map((e) => e.path) : null,
    proposedSubject: proposeSubject(events),
    warnings,
    blockers,
  };
}

function proposeSubject(events: readonly SessionEvent[]): string {
  const task = events.find((e) => e.type === 'user.message');
  const first = task?.type === 'user.message' ? task.text.split('\n')[0]!.trim() : '';
  const cleaned = first.replace(/^\[\[harness note:.*?\]\]\s*/, '');
  return (cleaned.length > 0 ? cleaned : 'agent session changes').slice(0, 72);
}

export interface CommitResult {
  ok: boolean;
  oid?: string;
  /** Repo-relative files actually IN the commit (from diff-tree — git's truth, not our plan). */
  files: string[];
  error?: string;
}

export interface CommitFlowIO {
  /** One chrome line (REPL renderer / CLI stderr). */
  info(line: string): void;
  /** Interactive question; null fn = non-interactive; null ANSWER = EOF = decline. */
  question: ((q: string) => Promise<string | null>) | null;
  /** --yes: skip confirmation (still blocked by blockers). */
  assumeYes: boolean;
}

export interface CommitFlowOptions {
  scope: 'session' | 'all';
  /** -m subject; when absent the proposed subject is offered for interactive editing. */
  subject?: string;
  trailer: boolean;
  sessionId: string;
  io: CommitFlowIO;
}

/**
 * The shared /commit / `agent commit` driver: preview → confirm → perform. UI-agnostic via
 * callbacks; the CALLER appends the git.commit event (it owns the session log).
 */
export async function runCommitFlow(
  cctx: CommitContext,
  events: readonly SessionEvent[],
  opts: CommitFlowOptions,
): Promise<{ committed: boolean; result?: CommitResult; preview: CommitPreview; subject?: string }> {
  const { io } = opts;
  const preview = await prepareCommit(cctx, events, opts.scope);

  io.info(`commit preview (scope: ${opts.scope === 'session' ? 'session-attributed files' : 'ALL workspace changes'}):`);
  if (preview.entries.length === 0) io.info('  (no changes in the workspace)');
  for (const e of preview.entries) {
    const mark = e.attributed ? (e.drifted ? '[session, EXTERNALLY MODIFIED after]' : '[session]') : opts.scope === 'session' ? '[not attributed — excluded]' : '[not session-attributed]';
    io.info(`  ${e.x}${e.y}  ${e.path}  ${mark}`);
  }
  for (const w of preview.warnings) io.info(`  warning: ${w}`);
  if (preview.blockers.length > 0) {
    for (const b of preview.blockers) io.info(`  blocked: ${b}`);
    return { committed: false, preview };
  }

  let subject = opts.subject ?? preview.proposedSubject;
  if (!io.assumeYes) {
    if (io.question === null) {
      io.info('  refusing: non-interactive commit requires --yes');
      return { committed: false, preview };
    }
    if (opts.subject === undefined) {
      const typed = await io.question(`  commit message [${preview.proposedSubject}]: `);
      if (typed === null) {
        io.info('  commit cancelled');
        return { committed: false, preview };
      }
      if (typed.trim().length > 0) subject = typed.trim();
    }
    const n = preview.stagePaths === null ? preview.entries.length : preview.stagePaths.length;
    const answer = await io.question(`  commit ${n} file(s) as "${subject}"? [y/N] `);
    if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
      io.info('  commit cancelled');
      return { committed: false, preview };
    }
  }

  const result = await performCommit(cctx, preview, subject, { trailer: opts.trailer, sessionId: opts.sessionId });
  if (!result.ok) {
    io.info(`  commit failed: ${result.error}`);
    return { committed: false, result, preview, subject };
  }
  io.info(`  committed ${result.oid?.slice(0, 12)} — ${result.files.length} file(s): ${subject}`);
  return { committed: true, result, preview, subject };
}

export async function performCommit(
  cctx: CommitContext,
  preview: CommitPreview,
  subject: string,
  opts: { trailer: boolean; sessionId: string },
): Promise<CommitResult> {
  if (preview.blockers.length > 0) return { ok: false, files: [], error: `blocked: ${preview.blockers.join('; ')}` };

  if (preview.stagePaths !== null) {
    for (let i = 0; i < preview.stagePaths.length; i += STAGE_BATCH) {
      const batch = preview.stagePaths.slice(i, i + STAGE_BATCH);
      const add = await runGit({ gitPath: cctx.gitPath, argv: ['add', '-A', '--', ...batch], cwd: cctx.repoRoot });
      if (!add.ok) return { ok: false, files: [], error: `git add failed: ${add.stderr.split(/\r?\n/)[0] ?? add.termination}` };
    }
  } else {
    const add = await runGit({ gitPath: cctx.gitPath, argv: ['add', '-A', '--', '.'], cwd: cctx.workspaceRoot });
    if (!add.ok) return { ok: false, files: [], error: `git add failed: ${add.stderr.split(/\r?\n/)[0] ?? add.termination}` };
  }

  const anyStaged = await runGit({ gitPath: cctx.gitPath, argv: ['diff', '--cached', '--quiet'], cwd: cctx.repoRoot });
  if (anyStaged.termination === 'exited' && anyStaged.exitCode === 0) {
    return { ok: false, files: [], error: 'nothing to commit (no staged changes after add)' };
  }

  const message = [subject.trim(), '', `Session: ${opts.sessionId}`, ...(opts.trailer ? ['', AGENT_TRAILER] : [])].join('\n') + '\n';
  const msgFile = path.join(cctx.messageDir, `commit-msg-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(msgFile, message, 'utf8');
  try {
    const commit = await runGit({ gitPath: cctx.gitPath, argv: ['commit', '-q', '-F', msgFile], cwd: cctx.repoRoot, timeoutMs: 60_000 });
    if (!commit.ok) {
      const firstErr = (commit.stderr + '\n' + commit.stdout).split(/\r?\n/).find((l) => l.trim().length > 0) ?? commit.termination;
      return {
        ok: false,
        files: [],
        error: `git commit failed (${firstErr}). Staged changes REMAIN staged, exactly as after a failed manual commit — inspect with git status`,
      };
    }
  } finally {
    fs.rmSync(msgFile, { force: true });
  }

  const oid = await runGit({ gitPath: cctx.gitPath, argv: ['rev-parse', 'HEAD'], cwd: cctx.repoRoot });
  const files = await runGit({ gitPath: cctx.gitPath, argv: ['diff-tree', '--root', '--no-commit-id', '--name-only', '-z', '-r', 'HEAD'], cwd: cctx.repoRoot });
  return {
    ok: true,
    oid: oid.ok ? oid.stdout.trim() : 'unknown',
    files: files.ok ? files.stdout.split('\0').filter((f) => f.length > 0) : [],
  };
}
