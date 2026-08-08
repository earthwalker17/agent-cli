import { runGit } from '../git/client.js';
import { scrubSecrets } from '../shared/secrets.js';
import { probeGhFacts } from './gh.js';
import { parseRemoteVerbose } from './url.js';
import type { GhRunner, RemoteContext, RemoteEndpoint } from './types.js';

/**
 * The session's LOCAL remote inventory — which remotes are configured, where they point, and
 * whether `gh` is usable.
 *
 * Deliberately network-free and approval-free. Reading `git config` and `gh --version` tells the
 * session that a destination EXISTS; it does not contact it, does not authenticate, and does not
 * establish who the user is. That distinction is the whole shape of this session: knowing a remote
 * is configured is local knowledge, and every question whose answer lives on the remote needs
 * authority first.
 *
 * A probe failure degrades to "no default remote" rather than to a guess — the direction that
 * makes a later mutation stop and ask instead of proceeding on an assumption.
 */

const PROBE_TIMEOUT_MS = 10_000;

export interface RemoteContextDeps {
  gitPath: string | null;
  repoRoot: string | null;
  /** Injected in tests; production uses the real gh runner built inside `probeGhFacts`. */
  ghRunner?: GhRunner;
  /** Injected in tests so a synthetic PATH/env can be exercised. */
  env?: NodeJS.ProcessEnv;
  /** Explicit override so a test can assert both the found and not-found paths. */
  ghPath?: string | null;
}

/** The remote a session may default to, and why there is none when there is none. */
function chooseDefault(
  endpoints: readonly RemoteEndpoint[],
  upstreamRemote: string | null,
  pushUrlDiffers: readonly string[],
): { defaultRemote: string | null; ambiguity: string | null } {
  if (endpoints.length === 0) return { defaultRemote: null, ambiguity: 'no git remote is configured' };
  const named = (n: string): RemoteEndpoint | undefined => endpoints.find((e) => e.name === n);

  const divergent = (n: string): boolean => pushUrlDiffers.includes(n);
  if (endpoints.length === 1) {
    const only = endpoints[0]!;
    if (divergent(only.name)) {
      return {
        defaultRemote: null,
        ambiguity: `remote '${only.name}' has a push URL different from its fetch URL, so an observation of one would not describe the other`,
      };
    }
    return { defaultRemote: only.name, ambiguity: null };
  }
  if (upstreamRemote !== null && named(upstreamRemote) !== undefined && !divergent(upstreamRemote)) {
    return { defaultRemote: upstreamRemote, ambiguity: null };
  }
  return {
    defaultRemote: null,
    ambiguity: `${String(endpoints.length)} remotes are configured (${endpoints.map((e) => e.name).join(', ')}) and the current branch has no upstream — the destination must be named explicitly`,
  };
}

export async function detectRemoteContext(deps: RemoteContextDeps): Promise<RemoteContext> {
  const env = deps.env ?? process.env;
  const cwd = deps.repoRoot ?? process.cwd();
  const gh = await probeGhFacts({
    cwd,
    env,
    ...(deps.ghRunner !== undefined ? { runner: deps.ghRunner } : {}),
    ...(deps.ghPath !== undefined ? { ghPath: deps.ghPath } : {}),
  });

  if (deps.gitPath === null || deps.repoRoot === null) {
    return {
      gh,
      endpoints: [],
      defaultRemote: null,
      ambiguity: 'the workspace is not inside a git repository',
      detail: `${gh.detail}; not a git repository`,
    };
  }

  const listed = await runGit({ gitPath: deps.gitPath, argv: ['remote', '-v'], cwd: deps.repoRoot, timeoutMs: PROBE_TIMEOUT_MS });
  if (!listed.ok) {
    return {
      gh,
      endpoints: [],
      defaultRemote: null,
      ambiguity: 'the remote list could not be read',
      detail: `${gh.detail}; remote probe failed`,
    };
  }
  const { endpoints, pushUrlDiffers } = parseRemoteVerbose(scrubSecrets(listed.stdout));

  // The upstream's remote NAME, read from config rather than split out of `origin/main` — a remote
  // name may itself contain a slash, and guessing where to cut is guessing the destination.
  let upstreamRemote: string | null = null;
  const branch = await runGit({ gitPath: deps.gitPath, argv: ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd: deps.repoRoot, timeoutMs: PROBE_TIMEOUT_MS });
  if (branch.ok) {
    const name = branch.stdout.trim();
    if (name !== '') {
      const cfg = await runGit({
        gitPath: deps.gitPath,
        argv: ['config', '--get', `branch.${name}.remote`],
        cwd: deps.repoRoot,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (cfg.ok && cfg.stdout.trim() !== '') upstreamRemote = cfg.stdout.trim();
    }
  }

  const { defaultRemote, ambiguity } = chooseDefault(endpoints, upstreamRemote, pushUrlDiffers);
  const credentialWarning = endpoints.some((e) => e.hadCredentials) ? '; a remote URL embeds a credential' : '';
  const detail =
    endpoints.length === 0
      ? `${gh.detail}; no remotes`
      : `${gh.detail}; ${String(endpoints.length)} remote(s)${defaultRemote !== null ? `, default '${defaultRemote}'` : ', no default'}${credentialWarning}`;

  return { gh, endpoints, defaultRemote, ambiguity, detail };
}
