import { describe, expect, it } from 'vitest';
import { createRemoteState, localEvidenceLine, remoteSpendFromEvents } from '../src/tools/remote-state.js';
import { REMOTE_READS_PER_SESSION, REMOTE_WRITES_PER_SESSION, type RemoteContext, type RemoteEndpoint, type RemoteObservation } from '../src/remote/types.js';
import { REMOTE_OBSERVATION_MAX_AGE_MS, type SessionEvent } from '../src/types.js';

/**
 * The shared remote-state object (Session 20).
 *
 * The contract under test is an asymmetry, and it is deliberate: SPEND is durable (rebuilt from
 * events, so a resume cannot refill the allowance) while AUTHORITY is not (observations and the
 * gh identity live in memory only, so a resumed session must look at the remote again before it
 * may change it). Both halves are pinned here, because either one silently flipping would be a
 * security regression that nothing else would catch.
 */

function endpoint(name: string, host: string | null, slug: string | null, over: Partial<RemoteEndpoint> = {}): RemoteEndpoint {
  return { name, displayUrl: `https://${host ?? 'x'}/${slug ?? 'x'}.git`, host, slug, scheme: 'https', isGitHub: host === 'github.com', hadCredentials: false, ...over };
}

function context(over: Partial<RemoteContext> = {}): RemoteContext {
  return {
    gh: { ghPath: '/x/gh', version: '2.97.0', authStatusLeakRisk: false, tokenEnvPresentButNotForwarded: false, probeFailed: false, detail: 'gh 2.97.0' },
    endpoints: [endpoint('origin', 'github.com', 'o/r')],
    defaultRemote: 'origin',
    ambiguity: null,
    detail: 'gh 2.97.0; 1 remote(s)',
    ...over,
  };
}

function observation(over: Partial<RemoteObservation> = {}): RemoteObservation {
  return {
    id: 'obs1',
    remoteName: 'origin',
    host: 'github.com',
    slug: 'o/r',
    refName: 'refs/heads/main',
    remoteOid: null,
    localOid: 'a'.repeat(40),
    localRef: 'refs/heads/main',
    relation: 'new',
    ahead: 1,
    behind: 0,
    commits: [],
    commitsOmitted: 0,
    changedPaths: [],
    changedPathsOmitted: 0,
    basesIncomplete: false,
    touchesWorkflows: false,
    dirtyCount: 0,
    observedAtMs: 1_000,
    ...over,
  };
}

function ev(type: SessionEvent['type'], extra: Record<string, unknown> = {}, seq = 1): SessionEvent {
  return { v: 1, seq, ts: '2026-08-08T00:00:00.000Z', type, ...extra } as unknown as SessionEvent;
}

describe('spend is durable', () => {
  it('rebuilds read and write counts from the two distinct event types', () => {
    const events = [
      ev('remote.inspected', { callId: 'a', operation: 'auth', host: 'h', target: 't', ok: true, durationMs: 1 }, 1),
      ev('remote.inspected', { callId: 'b', operation: 'refs', host: 'h', target: 't', ok: true, durationMs: 1 }, 2),
      ev('remote.mutated', { callId: 'c', operation: 'push.branch', host: 'h', target: 't', exactTarget: 'r', overwrote: false, ok: true, verified: true, durationMs: 1 }, 3),
    ];
    expect(remoteSpendFromEvents(events)).toEqual({ reads: 2, writes: 1 });
  });

  it('a resumed session cannot refill its allowance', () => {
    const events = Array.from({ length: REMOTE_READS_PER_SESSION }, (_, i) =>
      ev('remote.inspected', { callId: `c${String(i)}`, operation: 'refs', host: 'h', target: 't', ok: true, durationMs: 1 }, i + 1),
    );
    const s = createRemoteState({ context: context(), initialSpend: remoteSpendFromEvents(events) });
    expect(s.exhausted('read')).toContain('spent');
    expect(s.exhausted('write')).toBeUndefined();
  });

  it('counts each kind against its own ceiling', () => {
    const s = createRemoteState({ context: context() });
    for (let i = 0; i < REMOTE_WRITES_PER_SESSION; i += 1) s.charge('write');
    expect(s.exhausted('write')).toContain(String(REMOTE_WRITES_PER_SESSION));
    expect(s.exhausted('read')).toBeUndefined();
    expect(s.remaining('write')).toContain('0 of');
  });
});

describe('authority is NOT durable', () => {
  it('an observation expires at the freshness bound', () => {
    let now = 1_000;
    const s = createRemoteState({ context: context(), nowMs: () => now });
    s.observe(observation({ observedAtMs: now }));
    expect(s.observationFor('origin', 'refs/heads/main')).toBeDefined();
    now += REMOTE_OBSERVATION_MAX_AGE_MS;
    expect(s.observationFor('origin', 'refs/heads/main')).toBeDefined();
    now += 1;
    expect(s.observationFor('origin', 'refs/heads/main')).toBeUndefined();
  });

  it('an observation covers ONE exact (remote, ref) pair and nothing else', () => {
    const s = createRemoteState({ context: context(), nowMs: () => 1_000 });
    s.observe(observation({ observedAtMs: 1_000 }));
    expect(s.observationFor('origin', 'refs/heads/other')).toBeUndefined();
    expect(s.observationFor('upstream', 'refs/heads/main')).toBeUndefined();
    expect(s.observationFor('origin', 'refs/tags/main')).toBeUndefined();
  });

  it('a newer look at the same target replaces the older one', () => {
    const s = createRemoteState({ context: context(), nowMs: () => 2_000 });
    s.observe(observation({ id: 'old', observedAtMs: 1_000 }));
    s.observe(observation({ id: 'new', observedAtMs: 2_000, relation: 'fast-forward' }));
    expect(s.observationFor('origin', 'refs/heads/main')?.id).toBe('new');
    expect(s.observations()).toHaveLength(1);
  });

  it('identity starts empty and is established only by an explicit set', () => {
    const s = createRemoteState({ context: context() });
    expect(s.identityFor('github.com')).toBeUndefined();
    s.setIdentities([{ host: 'GitHub.com', account: 'me', protocol: 'https', scopes: ['repo'], source: 'keyring', multipleAccounts: false }]);
    expect(s.identityFor('github.com')?.account).toBe('me');
    expect(s.identityFor('other.test')).toBeUndefined();
  });
});

describe('endpoint resolution stops rather than guessing', () => {
  it('uses the single configured remote', () => {
    const r = createRemoteState({ context: context() }).resolveEndpoint();
    expect(r).toHaveProperty('endpoint');
  });

  it('REFUSES when several remotes exist and there is no default', () => {
    const s = createRemoteState({
      context: context({
        endpoints: [endpoint('origin', 'github.com', 'o/r'), endpoint('upstream', 'github.com', 'up/r')],
        defaultRemote: null,
        ambiguity: '2 remotes are configured and the current branch has no upstream',
      }),
    });
    const r = s.resolveEndpoint();
    expect(r).toMatchObject({ kind: 'ambiguous' });
    // …but an explicitly named one resolves.
    expect(s.resolveEndpoint('upstream')).toHaveProperty('endpoint');
  });

  it('refuses a remote name that does not exist, naming the ones that do', () => {
    const r = createRemoteState({ context: context() }).resolveEndpoint('nope');
    expect(r).toMatchObject({ kind: 'ambiguous' });
    expect('error' in r ? r.error : '').toContain('origin');
  });

  it('refuses a remote name shaped like a flag', () => {
    expect(createRemoteState({ context: context() }).resolveEndpoint('--upload-pack=x')).toMatchObject({ kind: 'ambiguous' });
  });

  it('refuses when there is no remote at all', () => {
    const r = createRemoteState({ context: context({ endpoints: [], defaultRemote: null, ambiguity: 'no git remote is configured' }) }).resolveEndpoint();
    expect(r).toMatchObject({ kind: 'unavailable' });
  });
});

describe('localEvidenceLine', () => {
  it('reports "no check has passed" for a bare session', () => {
    expect(localEvidenceLine([])).toContain('no typed check has passed');
  });

  it('reports checks recorded since the last change, and the commit count', () => {
    const events = [
      ev('file.mutated', { callId: 'a', path: 'x', kind: 'modify' }, 1),
      ev('check.completed', { callId: 'b', check: 'test', recipeId: 'r', status: 'pass', exitCode: 0, durationMs: 1, summary: '' }, 2),
      ev('check.completed', { callId: 'c', check: 'lint', recipeId: 'r', status: 'fail', exitCode: 1, durationMs: 1, summary: '' }, 3),
      ev('git.commit', { callId: 'd', oid: 'x', files: [], subject: 's', scope: 'session' }, 4),
    ];
    const line = localEvidenceLine(events);
    expect(line).toContain('test pass');
    expect(line).toContain('lint fail');
    expect(line).toContain('1 commit(s)');
  });

  it('drops a check that predates the last change — a stale pass is not evidence', () => {
    const events = [
      ev('check.completed', { callId: 'a', check: 'test', recipeId: 'r', status: 'pass', exitCode: 0, durationMs: 1, summary: '' }, 1),
      ev('file.mutated', { callId: 'b', path: 'x', kind: 'modify' }, 2),
    ];
    expect(localEvidenceLine(events)).toContain('no typed check has passed since the last change');
  });

  it('reports an acceptance, and says plainly when work happened after it', () => {
    const accepted = ev('session.accepted', { complete: true, summary: 'done' }, 5);
    expect(localEvidenceLine([accepted])).toContain('COMPLETE, nothing since');
    const after = [accepted, ev('file.mutated', { callId: 'z', path: 'x', kind: 'modify' }, 6)];
    expect(localEvidenceLine(after)).toContain('work has happened since');
  });
});
