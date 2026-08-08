import { workSince } from '../runtime/acceptance.js';
import { remoteNameProblem } from '../remote/refs.js';
import {
  REMOTE_READS_PER_SESSION,
  REMOTE_WRITES_PER_SESSION,
  type RemoteContext,
  type RemoteEndpoint,
  type RemoteIdentity,
  type RemoteObservation,
} from '../remote/types.js';
import { REMOTE_OBSERVATION_MAX_AGE_MS, type RemoteBlockKind, type SessionEvent } from '../types.js';

/**
 * The session's remote state: one shared object held by all three remote tools.
 *
 * Its shape encodes the session's central distinction, so read it as a contract rather than as a
 * cache:
 *
 *  - **Spend is DURABLE.** Read and write counts are rebuilt from the event log on resume, so a
 *    restarted session cannot refill its allowance by restarting (the `ResearchBudget` argument,
 *    unchanged).
 *  - **Authority is NOT durable.** Observations and the established gh identity live in memory
 *    only and are gone after a resume — deliberately, and in the safe direction. A resumed session
 *    must look at the remote again before it may change it, exactly as grants are never restored.
 *
 * The clock is injected. A freshness rule needs one, and a fact that consults it is the
 * research-budget precedent one step further: in-memory, never the filesystem, never a probe.
 */

export interface RemoteSpend {
  reads: number;
  writes: number;
}

export interface EndpointResolution {
  endpoint: RemoteEndpoint;
}
export interface EndpointRefusal {
  error: string;
  kind: RemoteBlockKind;
}

export interface RemoteState {
  /** Live totals. Read by `/remote`, the approval prompt, and the report. */
  readonly spend: RemoteSpend;
  /** The local, network-free inventory established at assembly. */
  readonly context: RemoteContext;
  /** Why a call of this kind cannot be admitted, or undefined when it can. */
  exhausted(kind: 'read' | 'write'): string | undefined;
  /** One line of remaining allowance, for the approval prompt and `/remote`. */
  remaining(kind: 'read' | 'write'): string;
  /** Record a COMPLETED call. Charged after the fact, like every other budget here. */
  charge(kind: 'read' | 'write'): void;
  now(): number;

  /** Record a live look at a remote ref. Only the read tool ever calls this. */
  observe(o: RemoteObservation): void;
  /** The freshest ADMISSIBLE observation for this exact target, or undefined. */
  observationFor(remoteName: string, refName: string): RemoteObservation | undefined;
  /** Every observation still held, newest first. For `/remote`. */
  observations(): RemoteObservation[];

  /** The gh identity for a host, once an authorized `auth` read has established one. */
  identityFor(host: string): RemoteIdentity | undefined;
  identities(): readonly RemoteIdentity[];
  setIdentities(list: readonly RemoteIdentity[]): void;

  /**
   * Resolve which configured remote an operation targets. A missing name uses the session default;
   * when there is no unambiguous default this REFUSES rather than picking one, because picking one
   * is picking where a human's work gets published.
   */
  resolveEndpoint(remoteName?: string): EndpointResolution | EndpointRefusal;
}

export interface RemoteStateOptions {
  context: RemoteContext;
  /** Injected in tests; production passes `Date.now`. */
  nowMs?: () => number;
  /** Prior spend, rebuilt from the event log. */
  initialSpend?: RemoteSpend;
}

export function createRemoteState(opts: RemoteStateOptions): RemoteState {
  const spend: RemoteSpend = { reads: opts.initialSpend?.reads ?? 0, writes: opts.initialSpend?.writes ?? 0 };
  const now = opts.nowMs ?? (() => Date.now());
  const observations: RemoteObservation[] = [];
  let identities: RemoteIdentity[] = [];

  const state: RemoteState = {
    spend,
    context: opts.context,
    now,
    exhausted(kind) {
      if (kind === 'read' && spend.reads >= REMOTE_READS_PER_SESSION) {
        return `the session remote-read allowance is spent (${String(REMOTE_READS_PER_SESSION)} reads)`;
      }
      if (kind === 'write' && spend.writes >= REMOTE_WRITES_PER_SESSION) {
        return `the session remote-write allowance is spent (${String(REMOTE_WRITES_PER_SESSION)} mutations)`;
      }
      return undefined;
    },
    remaining(kind) {
      return kind === 'read'
        ? `${String(Math.max(0, REMOTE_READS_PER_SESSION - spend.reads))} of ${String(REMOTE_READS_PER_SESSION)} read(s)`
        : `${String(Math.max(0, REMOTE_WRITES_PER_SESSION - spend.writes))} of ${String(REMOTE_WRITES_PER_SESSION)} mutation(s)`;
    },
    charge(kind) {
      if (kind === 'read') spend.reads += 1;
      else spend.writes += 1;
    },
    observe(o) {
      // Newest wins for a given target: an older look at the same ref can only mislead.
      const i = observations.findIndex((x) => x.remoteName === o.remoteName && x.refName === o.refName);
      if (i >= 0) observations.splice(i, 1);
      observations.unshift(o);
      // Bounded so a long session cannot accumulate unboundedly; the cap is far above the number
      // of distinct refs any delivery touches.
      if (observations.length > 50) observations.length = 50;
    },
    observationFor(remoteName, refName) {
      const o = observations.find((x) => x.remoteName === remoteName && x.refName === refName);
      if (o === undefined) return undefined;
      // Staleness is filtered HERE as well as denied in the engine. The engine's check is the
      // guarantee; this one keeps a stale observation from being quoted into a prompt at all.
      return now() - o.observedAtMs > REMOTE_OBSERVATION_MAX_AGE_MS ? undefined : o;
    },
    observations() {
      return [...observations];
    },
    identityFor(host) {
      const h = host.trim().toLowerCase();
      return identities.find((i) => i.host.trim().toLowerCase() === h);
    },
    identities() {
      return identities;
    },
    setIdentities(list) {
      identities = [...list];
    },
    resolveEndpoint(remoteName) {
      const { endpoints, defaultRemote, ambiguity } = opts.context;
      if (endpoints.length === 0) {
        return { error: 'no git remote is configured for this repository; there is nowhere to publish', kind: 'unavailable' };
      }
      if (remoteName !== undefined && remoteName.trim() !== '') {
        const problem = remoteNameProblem(remoteName.trim());
        if (problem !== undefined) return { error: problem, kind: 'ambiguous' };
        const hit = endpoints.find((e) => e.name === remoteName.trim());
        if (hit === undefined) {
          return {
            error: `no remote named '${remoteName.trim()}' is configured (have: ${endpoints.map((e) => e.name).join(', ')})`,
            kind: 'ambiguous',
          };
        }
        return { endpoint: hit };
      }
      if (defaultRemote === null) {
        return { error: ambiguity ?? 'the destination remote is ambiguous and must be named explicitly', kind: 'ambiguous' };
      }
      const hit = endpoints.find((e) => e.name === defaultRemote);
      if (hit === undefined) return { error: `the default remote '${defaultRemote}' is no longer configured`, kind: 'ambiguous' };
      return { endpoint: hit };
    },
  };
  return state;
}

/**
 * Rebuild the spend from a session's events, so a resumed session cannot refill its allowance by
 * restarting.
 *
 * Reads and writes are counted from the two DISTINCT event types rather than from one arm with an
 * operation field — which is the practical payoff of having recorded them separately.
 */
export function remoteSpendFromEvents(events: readonly SessionEvent[]): RemoteSpend {
  const spend: RemoteSpend = { reads: 0, writes: 0 };
  for (const e of events) {
    if (e.type === 'remote.inspected') spend.reads += 1;
    else if (e.type === 'remote.mutated') spend.writes += 1;
  }
  return spend;
}

/**
 * One line of LOCAL verification state for a publish prompt.
 *
 * Stated so a human can weigh it, and deliberately not enforced. Making a green gate a precondition
 * for publishing would make a green gate an authorization — the exact inversion this capability
 * exists to prevent — so this fold produces a sentence, never a veto.
 *
 * It reads the same events `/accept` reads, but it is a separate, smaller fold on purpose: it must
 * work in a session that never made a plan at all, where `computeAcceptance` has nothing to say.
 */
export function localEvidenceLine(events: readonly SessionEvent[]): string {
  const accepted = [...events].reverse().find((e): e is Extract<SessionEvent, { type: 'session.accepted' }> => e.type === 'session.accepted');
  const acceptedLine =
    accepted === undefined
      ? null
      : workSince(events, accepted.seq)
        ? `/accept recorded ${accepted.complete ? 'COMPLETE' : 'partial'} at seq ${String(accepted.seq)}, but work has happened since`
        : `/accept recorded ${accepted.complete ? 'COMPLETE' : 'partial'}, nothing since`;

  // The last event that could invalidate a check result. Same class the completion gate anchors on.
  const CHANGE = new Set(['file.mutated', 'task.applied', 'undo.applied', 'git.restore', 'command.started', 'setup.started']);
  let lastChange = 0;
  for (const e of events) if (CHANGE.has(e.type)) lastChange = Math.max(lastChange, e.seq);

  const byKind = new Map<string, string>();
  for (const e of events) {
    if (e.type !== 'check.completed' || e.seq < lastChange) continue;
    byKind.set(e.check, e.status);
  }
  const checkLine =
    byKind.size === 0
      ? 'no typed check has passed since the last change'
      : `checks since the last change: ${[...byKind.entries()].map(([k, s]) => `${k} ${s}`).join(', ')}`;

  const commits = events.filter((e) => e.type === 'git.commit').length;
  const commitLine = commits === 0 ? 'no commit was made this session' : `${String(commits)} commit(s) this session`;

  return [acceptedLine, checkLine, commitLine].filter((l): l is string => l !== null).join(' · ');
}
