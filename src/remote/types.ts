import type { CommandTermination } from '../types.js';

/**
 * The remote-delivery pack's domain model and its hard bounds.
 *
 * Nothing here imports from the kernel beyond the shared `CommandTermination` vocabulary (the
 * `git/types.ts` precedent) — the dependency arrow points one way, exactly as it does for
 * `src/research` and `src/artifacts` (constitution: workflow packs stay outside the kernel).
 *
 * The numbers below are the single source of truth for every bound the policy facts declare, the
 * approval prompt shows, and the session budget enforces. They are pinned by `test/limits.test.ts`
 * so a quiet edit cannot widen the capability.
 */

// ── Per-session budget ─────────────────────────────────────────────────────────

/**
 * Remote round-trips one session may make. Reads are session-grantable, so this counter is what
 * `[s]` is actually bounded by — the research precedent, where the budget IS the consent.
 */
export const REMOTE_READS_PER_SESSION = 60;
/**
 * Remote MUTATIONS one session may make. Every one of them asks individually and none is ever
 * granted, so this is not a consent ceiling — it is a runaway bound. Ten publishes is already far
 * more than any honest delivery session performs, and a loop that reaches it has gone wrong in a
 * way another keystroke should not be able to continue.
 */
export const REMOTE_WRITES_PER_SESSION = 10;

// ── Per-call bounds ────────────────────────────────────────────────────────────

/**
 * How long an observation of remote state stays admissible as the basis for a mutation.
 *
 * Five minutes is not a security boundary — the remote can move one millisecond after we look.
 * It bounds how stale the number a human READ in the approval prompt is allowed to be, and the
 * actual guarantees live downstream: execute re-reads the ref before pushing, and a force push
 * carries the observed oid as a server-enforced lease.
 */
export const OBSERVATION_MAX_AGE_MS = 5 * 60_000;
/** Bound for a `gh` call or an `ls-remote`. A cold network degrades honestly, never hangs a turn. */
export const REMOTE_CALL_TIMEOUT_MS = 30_000;
/**
 * Bound for the push itself. Larger because it uploads objects, and because a Windows credential
 * helper that decides to show a GUI prompt is the one failure mode nothing here can structurally
 * prevent — the timeout is the backstop that turns a hang into an honest failure.
 */
export const REMOTE_PUSH_TIMEOUT_MS = 120_000;
/** Items one list read may return (pull requests, issues, workflow runs). */
export const MAX_REMOTE_ITEMS = 30;
export const DEFAULT_REMOTE_ITEMS = 10;
/** Commit subjects rendered into a push preview before the rest are counted rather than listed. */
export const MAX_PREVIEW_COMMITS = 20;
/** Changed paths carried on an observation. Enough to judge a push; never a full diff. */
export const MAX_PREVIEW_PATHS = 60;
/**
 * Remote-ref object ids used to exclude already-published history when a ref is NEW.
 *
 * Without them the preview reports the ENTIRE branch as new — which the live S20 run showed
 * producing "207 commit(s)" and a `.github/workflows/` warning for a push that added one file.
 * The cap keeps one argv bounded on a repository with thousands of refs; anything beyond it makes
 * the estimate incomplete, which the observation records rather than hides.
 */
export const MAX_EXCLUSION_BASES = 200;
/** Characters of third-party text (bodies, logs) admitted into a context from one read. */
export const MAX_REMOTE_CONTENT_CHARS = 40_000;
/** Release notes the model may author. Larger than a commit message, far below a document. */
export const MAX_RELEASE_NOTES_CHARS = 60_000;

/**
 * The first `gh` release in which `gh auth status` stopped printing part of the token in plaintext
 * (GHSA-cg6r-mpgc-h9mm; affected `github_pat_*`, `ghs_*`, `ghu_*`). Anything older is recorded as a
 * leak risk in `remote.context` — the output is scrubbed regardless, but a user running a
 * vulnerable gh should be told, because everything ELSE on their machine reads that output too.
 */
export const GH_AUTH_STATUS_FIXED_VERSION = '2.97.0';

// ── Operations ─────────────────────────────────────────────────────────────────

/** Read operations. `refs` is the one that produces an observation a mutation can bind to. */
export type RemoteReadOp = 'auth' | 'repository' | 'refs' | 'pulls' | 'issues' | 'runs' | 'run';
export const REMOTE_READ_OPS: readonly RemoteReadOp[] = ['auth', 'repository', 'refs', 'pulls', 'issues', 'runs', 'run'];

/**
 * Write operations. Deliberately three: publish a branch, publish a tag, cut a release against a
 * tag that already exists remotely. Pull-request/issue creation, merges, repository creation and
 * deletion, settings and workflow dispatch are OUT of scope for this session by explicit decision —
 * this is a delivery capability, not GitHub administration.
 */
export type RemoteWriteOp = 'push.branch' | 'push.tag' | 'release.create';
export const REMOTE_WRITE_OPS: readonly RemoteWriteOp[] = ['push.branch', 'push.tag', 'release.create'];

// ── Local, network-free inventory ──────────────────────────────────────────────

export type RemoteScheme = 'https' | 'ssh' | 'scp' | 'file' | 'other';

/** One configured git remote, parsed and credential-redacted. */
export interface RemoteEndpoint {
  name: string;
  /** The URL with any userinfo replaced. The raw string is never stored, printed, or logged. */
  displayUrl: string;
  host: string | null;
  /** `owner/repo` when the URL is a recognisable forge path; null otherwise. */
  slug: string | null;
  scheme: RemoteScheme;
  isGitHub: boolean;
  /** True when the configured URL embedded a credential. Surfaced so the user can remove it. */
  hadCredentials: boolean;
  /**
   * `remote.<name>.pushurl` differs from the fetch URL, so `ls-remote` and `push` would talk to
   * DIFFERENT repositories (Session 20 review). Every operation on such a remote is refused: an
   * observation of one URL cannot describe the other, and the prompt would name the wrong
   * destination for the act being approved.
   */
  pushUrlDiffers?: boolean;
}

/** What is known about the `gh` binary WITHOUT contacting anything. */
export interface GhFacts {
  ghPath: string | null;
  version: string | null;
  /** Installed gh predates the `gh auth status` token-leak fix. */
  authStatusLeakRisk: boolean;
  /** `GH_HOST` in the parent environment — recorded because it retargets which host gh talks to. */
  hostOverride?: string;
  /** `GH_CONFIG_DIR` in the parent environment — recorded because it retargets which account is used. */
  configDirOverride?: string;
  /**
   * A `GH_TOKEN`/`GITHUB_TOKEN` exists in the parent environment. It is NOT forwarded to children
   * (`buildChildEnv` drops every `*token*` name), so gh will use its stored credential instead.
   * Recorded because the difference is otherwise invisible and produces a baffling "not logged in".
   */
  tokenEnvPresentButNotForwarded: boolean;
  probeFailed: boolean;
  /** One honest line: "gh 2.96.0", "gh not found", "gh probe failed". */
  detail: string;
}

/**
 * The session's local remote inventory: which remotes exist, where they point, whether `gh` is
 * usable. Established at assembly from git config and `gh --version` — no network, no credential,
 * no approval. Knowing that a remote is CONFIGURED is not the same as contacting it.
 */
export interface RemoteContext {
  gh: GhFacts;
  endpoints: RemoteEndpoint[];
  /**
   * The remote a mutation may default to, or null when the session must be told which one. Null is
   * a stop, not a fallback: guessing between two remotes is guessing where the work is published.
   */
  defaultRemote: string | null;
  /** Why there is no default, when there is none. */
  ambiguity: string | null;
  detail: string;
}

/** Who `gh` is, established only by an authorized `auth` read. Never carries the credential. */
export interface RemoteIdentity {
  host: string;
  account: string;
  /** 'https' | 'ssh' — how gh configured git operations for this host. */
  protocol: string;
  /** OAuth scopes on the stored token. The absence of `workflow` is load-bearing (see observe.ts). */
  scopes: string[];
  /** Where gh keeps it ('keyring', 'config', …). The location, never the value. */
  source: string;
  /** True when more than one account/host is configured, so the active one had to be chosen. */
  multipleAccounts: boolean;
}

// ── Observation ────────────────────────────────────────────────────────────────

/** How the local ref relates to what the remote actually holds RIGHT NOW. */
export type RefRelation = 'new' | 'up-to-date' | 'fast-forward' | 'behind' | 'diverged' | 'unknown';

export interface PreviewCommit {
  oid: string;
  subject: string;
}

/**
 * One look at a real remote ref, and everything derived from it that a human needs in order to
 * answer "may this be published".
 *
 * A mutation MUST be bound to one of these (the `browser.no-preview` precedent: a flow that is not
 * bound to harness-observed state is denied, not asked). Observations are in-memory only and do not
 * survive a resume — a restarted session has to look again, which is the correct direction to fail.
 */
export interface RemoteObservation {
  /** Stable id derived from the target and the oids; quoted in the prompt and the event. */
  id: string;
  remoteName: string;
  host: string;
  slug: string | null;
  /** Fully qualified — `refs/heads/x` or `refs/tags/v1`. Never a short name. */
  refName: string;
  /** What the remote holds, or null when the ref does not exist there. */
  remoteOid: string | null;
  /**
   * For an ANNOTATED tag, the commit the remote's tag object peels to (`refs/tags/x^{}` in
   * `ls-remote` output). Null for a branch, or for a lightweight tag where the ref IS the commit.
   *
   * Carried because a release is cut "at" a commit, and showing a human the tag-object hash while
   * saying "at" is a small lie they cannot check against their own `git log`.
   */
  remotePeeledOid?: string | null;
  /** The local commit this observation resolved. */
  localOid: string;
  /** The local ref/rev that produced `localOid` (`refs/heads/x`, `HEAD`, an oid). */
  localRef: string;
  relation: RefRelation;
  /** Commits the local side has that the remote does not, and vice versa. */
  ahead: number;
  behind: number;
  commits: PreviewCommit[];
  commitsOmitted: number;
  changedPaths: string[];
  changedPathsOmitted: number;
  /**
   * The remote holds refs whose objects this repository does not have, so they could not be used
   * to exclude already-published history. The counts and paths above are then an OVER-estimate,
   * and the preview says so rather than presenting an inflated number as fact.
   */
  basesIncomplete: boolean;
  /**
   * The change set touches `.github/workflows/**`. GitHub rejects such a push when the credential
   * lacks the `workflow` scope, with an error most users have never seen — so it is detected here
   * and named before the attempt rather than decoded afterwards.
   */
  touchesWorkflows: boolean;
  /**
   * Uncommitted workspace entries when the observation was taken. NOT part of what a push sends;
   * carried so the prompt can say so, because "I pushed my work" and "I pushed my commits" are the
   * same sentence to a human and different facts.
   */
  dirtyCount: number | null;
  observedAtMs: number;
}

// ── `git push --porcelain` ─────────────────────────────────────────────────────

/** The first column of a `--porcelain` push line. */
export type PushFlag = 'fast-forward' | 'forced' | 'deleted' | 'new' | 'rejected' | 'up-to-date';

export interface PushPorcelainLine {
  flag: PushFlag;
  /** Local source ref as git resolved it. */
  from: string;
  /** Remote destination ref. */
  to: string;
  summary: string;
  reason?: string;
}

export interface PushPorcelain {
  lines: PushPorcelainLine[];
  /** git printed its terminating `Done`. Its absence means the output was cut short. */
  done: boolean;
}

// ── `gh` invocation seam ───────────────────────────────────────────────────────

export interface GhInvocation {
  /** Arguments AFTER the hardening flags. Composed by the harness; never a shell string. */
  argv: readonly string[];
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Outcome of one managed `gh` invocation. Mirrors `GitResult` deliberately. */
export interface GhResult {
  ok: boolean;
  exitCode: number | null;
  termination: CommandTermination;
  /** Already passed through `scrubSecrets`. */
  stdout: string;
  /** Already passed through `scrubSecrets`. */
  stderr: string;
  durationMs: number;
}

/**
 * The seam the tools depend on. `gh.ts` is the one real implementation; tests inject a scripted
 * runner and never touch a socket (the `fetchImpl` precedent from the research pack).
 */
export type GhRunner = (inv: GhInvocation) => Promise<GhResult>;

// ── Shapes parsed out of `gh --json` ───────────────────────────────────────────

export interface RepositorySummary {
  nameWithOwner: string;
  description: string;
  isPrivate: boolean;
  isArchived: boolean;
  isFork: boolean;
  defaultBranch: string | null;
  /** ADMIN | MAINTAIN | WRITE | TRIAGE | READ | null. Decides whether a push can succeed at all. */
  viewerPermission: string | null;
  url: string;
  pushedAt: string | null;
}

export interface PullSummary {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  updatedAt: string;
}

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  url: string;
  updatedAt: string;
}

export interface RunSummary {
  databaseId: number;
  workflowName: string;
  displayTitle: string;
  status: string;
  conclusion: string;
  headBranch: string;
  headSha: string;
  event: string;
  url: string;
  createdAt: string;
}

export interface ReleaseResult {
  url: string;
  tagName: string;
  isDraft: boolean;
  isPrerelease: boolean;
}
