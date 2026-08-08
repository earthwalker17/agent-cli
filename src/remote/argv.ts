import { DEFAULT_REMOTE_ITEMS, MAX_REMOTE_ITEMS } from './types.js';

/**
 * Argument composition for every remote operation.
 *
 * This module is the reason there is no `gh api` passthrough and no generic escape. Every argv is
 * assembled here from typed, validated inputs — the `ResolvedCheckFact.command` discipline one
 * layer out: the model authors VALUES (a branch name, a release title), never flags, never a
 * command, never a subcommand. Two consequences follow, and both are load-bearing:
 *
 *  - What the approval prompt displays is what executes, because the prompt renders this exact
 *    array rather than a reconstruction of it.
 *  - A value that begins with `-` cannot become a flag. Every option is emitted in `--flag=value`
 *    form, and the few positional slots (a repository slug, a tag, a run id) take inputs whose
 *    validators already refuse a leading `-`.
 *
 * Nothing here spawns anything; it is pure over its inputs, which is what lets a policy fact
 * declare the exact argv before a human is asked about it.
 */

/** The `gh repo view --json` fields this pack reads. Named once so parser and argv cannot drift. */
export const REPO_FIELDS = 'nameWithOwner,description,isPrivate,isArchived,isFork,defaultBranchRef,viewerPermission,url,pushedAt';
export const PULL_FIELDS = 'number,title,state,isDraft,author,headRefName,baseRefName,url,updatedAt';
export const ISSUE_FIELDS = 'number,title,state,author,labels,url,updatedAt';
export const RUN_FIELDS = 'databaseId,workflowName,displayTitle,status,conclusion,headBranch,headSha,event,url,createdAt';

function limitOf(n: number | undefined): number {
  const raw = n ?? DEFAULT_REMOTE_ITEMS;
  return Math.max(1, Math.min(MAX_REMOTE_ITEMS, Math.trunc(raw)));
}

// ── gh: reads ──────────────────────────────────────────────────────────────────

/**
 * `gh auth status --json hosts`.
 *
 * The `--json` form is used rather than the human one for a specific reason: gh below 2.97.0 could
 * print a portion of the token in the PLAIN output (GHSA-cg6r-mpgc-h9mm). The structured form
 * carries no token field at all, so the leak is avoided at the source rather than only scrubbed
 * afterwards. `--show-token` is never passed, under any circumstance.
 */
export function ghAuthStatusArgv(): string[] {
  return ['auth', 'status', '--json', 'hosts'];
}

export function ghRepoViewArgv(slug: string): string[] {
  return ['repo', 'view', slug, '--json', REPO_FIELDS];
}

export function ghPullListArgv(slug: string, opts: { limit?: number; state?: 'open' | 'closed' | 'merged' | 'all' }): string[] {
  return ['pr', 'list', `--repo=${slug}`, `--limit=${String(limitOf(opts.limit))}`, `--state=${opts.state ?? 'open'}`, '--json', PULL_FIELDS];
}

export function ghIssueListArgv(slug: string, opts: { limit?: number; state?: 'open' | 'closed' | 'all' }): string[] {
  return ['issue', 'list', `--repo=${slug}`, `--limit=${String(limitOf(opts.limit))}`, `--state=${opts.state ?? 'open'}`, '--json', ISSUE_FIELDS];
}

export function ghRunListArgv(slug: string, opts: { limit?: number; branch?: string; workflow?: string }): string[] {
  return [
    'run',
    'list',
    `--repo=${slug}`,
    `--limit=${String(limitOf(opts.limit))}`,
    ...(opts.branch !== undefined ? [`--branch=${opts.branch}`] : []),
    ...(opts.workflow !== undefined ? [`--workflow=${opts.workflow}`] : []),
    '--json',
    RUN_FIELDS,
  ];
}

export function ghRunViewArgv(slug: string, runId: number): string[] {
  return ['run', 'view', String(runId), `--repo=${slug}`, '--json', RUN_FIELDS];
}

// ── gh: writes ─────────────────────────────────────────────────────────────────

export interface ReleaseCreateArgs {
  slug: string;
  /** Tag name as it exists on the remote — never fully qualified, gh takes the short form. */
  tag: string;
  title: string;
  /** Absolute path to a harness-written notes file. Notes never travel through argv. */
  notesFile: string;
  draft: boolean;
  prerelease: boolean;
}

/**
 * `gh release create`.
 *
 * `--verify-tag` is NOT optional here. Without it, gh silently CREATES the tag from the latest
 * state of the default branch when the named tag does not exist — a publish nobody asked for, at a
 * commit nobody named. Creating a tag is a separate deliberate act (`push.tag`), so this operation
 * refuses rather than inventing one.
 *
 * Notes go through `--notes-file` rather than `--notes`: release notes are model-authored prose
 * that can be thousands of characters long and contain anything, and an argv is neither the right
 * size nor the right place for it (the `git commit -F` precedent).
 */
export function ghReleaseCreateArgv(a: ReleaseCreateArgs): string[] {
  return [
    'release',
    'create',
    a.tag,
    `--repo=${a.slug}`,
    '--verify-tag',
    `--title=${a.title}`,
    `--notes-file=${a.notesFile}`,
    ...(a.draft ? ['--draft'] : []),
    ...(a.prerelease ? ['--prerelease'] : []),
  ];
}

export function ghReleaseViewArgv(slug: string, tag: string): string[] {
  return ['release', 'view', tag, `--repo=${slug}`, '--json', 'url,tagName,isDraft,isPrerelease'];
}

// ── git: the push ──────────────────────────────────────────────────────────────

export interface PushArgs {
  remoteName: string;
  /** Fully qualified destination ref on the remote. */
  refName: string;
  /**
   * The exact commit-ish being published — the OID from the observation, not a branch name.
   *
   * This is the strongest binding available: git accepts an arbitrary SHA expression as a refspec
   * source, so the object that reaches the remote is the object the human read in the prompt, even
   * if the local branch moved while they were reading it.
   */
  sourceOid: string;
  /** When set, the push is a force bound to the oid the remote held at observation time. */
  lease?: { expect: string | null };
  dryRun: boolean;
}

/**
 * Compose `git push`.
 *
 * `--force-with-lease=<ref>:<oid>` uses the EXPLICIT-oid form deliberately. The bare
 * `--force-with-lease` compares against the local remote-tracking ref, which this pack never
 * creates (it uses `ls-remote`, which writes nothing) — so the bare form would compare against
 * something stale or absent. With the oid spelled out, the SERVER enforces exactly what was shown
 * to the human: if the remote is no longer at that commit, the push is refused by GitHub, not by
 * our optimism. An empty `<expect>` means "the ref must not exist", which is the correct lease for
 * a force push whose observation found nothing there.
 *
 * `--force-if-includes` is deliberately NOT used. It is a no-op without a lease, and its actual
 * check reads the remote-tracking ref's REFLOG — which, again, this pack never writes. Passing it
 * would look like extra safety while contributing none.
 */
export function gitPushArgv(a: PushArgs): string[] {
  return [
    'push',
    '--porcelain',
    ...(a.dryRun ? ['--dry-run'] : []),
    ...(a.lease !== undefined ? [`--force-with-lease=${a.refName}:${a.lease.expect ?? ''}`] : []),
    a.remoteName,
    `${a.sourceOid}:${a.refName}`,
  ];
}

// ── Display ────────────────────────────────────────────────────────────────────

/**
 * Render a composed argv as the single line the approval prompt shows.
 *
 * Quoting is for READABILITY only — nothing here is ever parsed by a shell (every invocation is an
 * argv array through `spawn`). An argument containing whitespace or a quote is shown quoted so a
 * human can see its boundaries; that is the whole contract.
 */
export function renderArgv(binary: string, argv: readonly string[]): string {
  const parts = argv.map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  return [binary, ...parts].join(' ');
}
