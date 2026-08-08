import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/report/report.js';
import { dispatchSlash, type CommandContext } from '../src/repl/commands.js';
import { computeAcceptance, workSince } from '../src/runtime/acceptance.js';
import { childTools } from '../src/runtime/subagent.js';
import { ROLE_CONTRACTS } from '../src/runtime/roles.js';
import { buildSystemPrompt } from '../src/workspace/system-prompt.js';
import { TOOLS } from '../src/tools/index.js';
import { CHILD_ONLY_TOOL_NAMES, SESSION_TOOL_NAMES } from '../src/cli/assemble.js';
import { hasResidualSecret } from '../src/shared/secrets.js';
import type { PlanState } from '../src/plan/canonical.js';
import type { SessionEvent } from '../src/types.js';
import type { WorkspaceMap } from '../src/workspace/map.js';

/**
 * The surfaces remote delivery reaches (Session 20): the report, `/accept`, the system prompt, and
 * the registries that decide who can reach it at all.
 *
 * The rules under test are the ones a later change could break silently — a publish becoming a
 * blocker, a publish staling an acceptance, a remote tool leaking into a child registry, or an
 * unverified mutation being rounded up to "delivered".
 */

function ev(type: string, extra: Record<string, unknown> = {}, seq = 1): SessionEvent {
  return { v: 1, seq, ts: '2026-08-08T00:00:00.000Z', type, ...extra } as unknown as SessionEvent;
}

function mutation(over: Record<string, unknown> = {}, seq = 10): SessionEvent {
  return ev(
    'remote.mutated',
    {
      callId: 'c1',
      operation: 'push.branch',
      host: 'github.com',
      target: 'earthwalker17/agent-cli',
      exactTarget: 'refs/heads/session-20',
      account: 'earthwalker17',
      beforeOid: null,
      afterOid: 'a'.repeat(40),
      overwrote: false,
      ok: true,
      verified: true,
      durationMs: 900,
      ...over,
    },
    seq,
  );
}

const CONTEXT = ev(
  'remote.context',
  {
    ghVersion: '2.96.0',
    ghAuthStatusLeakRisk: true,
    remotes: [{ name: 'origin', url: 'https://github.com/earthwalker17/agent-cli.git', host: 'github.com', slug: 'earthwalker17/agent-cli', isGitHub: true, hadCredentials: false }],
    defaultRemote: 'origin',
    tokenEnvNotForwarded: true,
    detail: 'gh 2.96.0; 1 remote(s), default origin',
  },
  2,
);

const emptyPlan: PlanState = { status: 'none' } as unknown as PlanState;

describe('the report', () => {
  it('renders a "## Remote delivery" section separating reads from mutations', () => {
    const events = [
      CONTEXT,
      ev('remote.inspected', { callId: 'c0', operation: 'auth', host: 'github.com', target: 'earthwalker17/agent-cli', account: 'earthwalker17', ok: true, durationMs: 5 }, 3),
      mutation(),
    ];
    const { md, json } = buildReport({ events });
    expect(md).toContain('## Remote delivery');
    expect(md).toContain('READ auth github.com/earthwalker17/agent-cli as earthwalker17');
    expect(md).toContain('MUTATED push.branch refs/heads/session-20');
    expect(md).toContain('ok, VERIFIED against the remote');
    expect(md).toContain('local check passing is never authorization to publish');
    expect(json.remote?.map((r) => r.kind)).toEqual(['context', 'read', 'mutation']);
  });

  it('records the gh advisory and the un-forwarded token env in the context row', () => {
    const { md } = buildReport({ events: [CONTEXT] });
    expect(md).toContain('GHSA-cg6r-mpgc-h9mm');
    expect(md).toContain('deliberately NOT forwarded');
  });

  it('says NOT VERIFIED plainly rather than rounding a successful command up to delivered', () => {
    const { md } = buildReport({ events: [mutation({ verified: false })] });
    expect(md).toContain('ok but NOT VERIFIED');
    expect(md).toContain('read it as unfinished, not as done');
  });

  it('marks an overwriting push', () => {
    const { md } = buildReport({ events: [mutation({ overwrote: true })] });
    expect(md).toContain('[OVERWROTE remote state]');
  });

  it('omits the section entirely when nothing remote happened', () => {
    const { md, json } = buildReport({ events: [ev('session.started', { sessionId: 's', model: 'm', workspaceRoot: 'w', mode: 'repl', argv: [] })] });
    expect(md).not.toContain('## Remote delivery');
    expect(json.remote).toBeUndefined();
  });
});

describe('acceptance treats delivery as a caveat, never a gate', () => {
  it('a publish does NOT block completion', () => {
    const a = computeAcceptance(emptyPlan, null, [mutation()]);
    expect(a.unfinished).toEqual([]);
    expect(a.complete).toBe(true);
  });

  it('a publish IS recorded as a caveat, naming the exact target', () => {
    const a = computeAcceptance(emptyPlan, null, [mutation()]);
    expect(a.caveats.join('\n')).toContain('PUBLISHED to a remote');
    expect(a.caveats.join('\n')).toContain('refs/heads/session-20');
    expect(a.caveats.join('\n')).toContain('nothing here can undo it');
  });

  it('an UNVERIFIED publish gets its own caveat', () => {
    const a = computeAcceptance(emptyPlan, null, [mutation({ verified: false })]);
    expect(a.caveats.join('\n')).toContain('could NOT be verified');
    expect(a.caveats.join('\n')).toContain('unconfirmed, not as delivered');
  });

  it('an ATTEMPTED-and-failed publish is named too — silence there would hide the whole point', () => {
    const a = computeAcceptance(emptyPlan, null, [mutation({ ok: false, verified: false, detail: 'protected branch' })]);
    expect(a.caveats.join('\n')).toContain('were ATTEMPTED and failed');
    expect(a.caveats.join('\n')).toContain('protected branch');
    expect(a.unfinished).toEqual([]);
  });

  it('an OVERWRITING publish says so', () => {
    const a = computeAcceptance(emptyPlan, null, [mutation({ overwrote: true })]);
    expect(a.caveats.join('\n')).toContain('OVERWROTE remote state');
  });

  it('remote events do NOT stale an acceptance — accept, commit, push is the ordinary order', () => {
    const accepted = ev('session.accepted', { complete: true, summary: 'done' }, 5);
    const events = [accepted, ev('remote.inspected', { callId: 'x', operation: 'refs', host: 'h', target: 't', ok: true, durationMs: 1 }, 6), mutation({}, 7)];
    expect(workSince(events, 5)).toBe(false);
    const a = computeAcceptance(emptyPlan, null, events);
    expect(a.acceptedStale).toBe(false);
  });
});

describe('the system prompt is conditional and states the boundary', () => {
  const map: WorkspaceMap = { text: '', fileCount: 0, truncated: false } as unknown as WorkspaceMap;

  it('says NOTHING about remote delivery when there is no remote', () => {
    const p = buildSystemPrompt('/ws', map, undefined, { isRepo: true, detail: 'branch main' } as never, undefined, undefined, false, undefined);
    expect(p).not.toContain('remote_push');
    expect(p).not.toContain('Remote delivery is available');
  });

  it('states the split authority, and that local completion is never permission to publish', () => {
    const p = buildSystemPrompt('/ws', map, undefined, { isRepo: true, detail: 'branch main' } as never, undefined, undefined, false, {
      defaultRemote: 'origin',
      ghAvailable: true,
    });
    expect(p).toContain('Remote delivery is available');
    expect(p).toContain('asks the user EVERY SINGLE TIME');
    expect(p).toContain('local completion is NEVER permission to publish');
    expect(p).toContain("The default remote for this workspace is 'origin'");
    expect(p).toContain('REFUSE unless a fresh `remote_status view=refs` observation');
    expect(p).toContain('UNTRUSTED DATA');
  });

  it('warns when there is no unambiguous default remote', () => {
    const p = buildSystemPrompt('/ws', map, undefined, { isRepo: true, detail: 'd' } as never, undefined, undefined, false, {
      defaultRemote: null,
      ghAvailable: false,
    });
    expect(p).toContain('NO unambiguous default remote');
    expect(p).toContain('gh) is not installed');
  });

  it('redirects the model away from `git push` through run_command', () => {
    const p = buildSystemPrompt('/ws', map, undefined, { isRepo: true, detail: 'd' } as never, undefined, undefined, false, {
      defaultRemote: 'origin',
      ghAvailable: true,
    });
    expect(p).toContain('use the remote_* tools rather than `git push`');
  });
});

describe('no subagent can reach the remote', () => {
  it('no role contract names a remote tool', () => {
    for (const [role, contract] of Object.entries(ROLE_CONTRACTS)) {
      for (const name of contract.toolNames) {
        expect(name.startsWith('remote_'), `${role} names ${name}`).toBe(false);
      }
    }
  });

  it('childTools admits no remote tool even when one is offered by name', () => {
    // `childTools` filters the STATIC registry by name and admits named instances only when their
    // facts are child-admissible. A remote tool is neither in TOOLS nor an admissible named slot.
    const names = childTools(['read_file', 'search', 'remote_status', 'remote_push', 'remote_release']).map((t) => t.name);
    expect(names).not.toContain('remote_status');
    expect(names).not.toContain('remote_push');
    expect(names).not.toContain('remote_release');
  });

  it('the remote tools are session names, never static kernel tools', () => {
    expect(TOOLS.map((t) => t.name)).not.toContain('remote_status');
    expect(SESSION_TOOL_NAMES).toContain('remote_status');
    expect(SESSION_TOOL_NAMES).toContain('remote_push');
    expect(SESSION_TOOL_NAMES).toContain('remote_release');
    expect(CHILD_ONLY_TOOL_NAMES).not.toContain('remote_status');
  });
});

describe('/remote is an accountability surface', () => {
  /** `/remote` reads only events + the state object, so a minimal context exercises it honestly. */
  async function run(events: SessionEvent[], extra: Partial<CommandContext> = {}): Promise<string> {
    let out = '';
    const ctx = {
      session: { log: { events } },
      renderer: { flush: () => undefined, chromeLine: () => undefined },
      modelOut: { write: (s: string) => { out += s; return true; } },
      pendingNotes: [],
      ...extra,
    } as unknown as CommandContext;
    expect(await dispatchSlash('/remote', ctx)).toBe('continue');
    return out;
  }

  it('lists the configured remotes, the gh advisory, and the un-forwarded token env', async () => {
    const out = await run([CONTEXT]);
    expect(out).toContain('origin → https://github.com/earthwalker17/agent-cli.git');
    expect(out).toContain('GHSA-cg6r-mpgc-h9mm');
    expect(out).toContain('deliberately NOT forwarded');
  });

  it('says plainly when nothing was changed on any remote', async () => {
    const out = await run([CONTEXT]);
    expect(out).toContain('nothing on any remote was changed by this session');
  });

  it('lists every mutation with its verification verdict, including FAILED ones', async () => {
    const out = await run([CONTEXT, mutation(), mutation({ ok: false, verified: false, exactTarget: 'refs/heads/other', detail: 'protected branch' }, 11)]);
    expect(out).toContain('ok, VERIFIED against the remote');
    expect(out).toContain('FAILED');
    expect(out).toContain('protected branch');
    expect(out).toContain('a green local check is never one');
    expect(out).toContain('dangerous-mode');
  });

  it('reports an unavailable capability as a line, never as a wall over the record', async () => {
    const out = await run([CONTEXT, mutation()], { remoteUnavailable: 'no git remote is configured' });
    expect(out).toContain('unavailable: no git remote is configured');
    // The audit record is still shown — a resumed session without a remote is exactly when a user
    // is most likely to be asking what was published.
    expect(out).toContain('refs/heads/session-20');
  });

  it('warns loudly about a remote URL that embeds a credential', async () => {
    const leaky = ev(
      'remote.context',
      {
        ghVersion: '2.97.0',
        ghAuthStatusLeakRisk: false,
        remotes: [{ name: 'origin', url: 'https://[REDACTED credentials]@github.com/o/r.git', host: 'github.com', slug: 'o/r', isGitHub: true, hadCredentials: true }],
        defaultRemote: 'origin',
        tokenEnvNotForwarded: false,
        detail: 'gh 2.97.0',
      },
      2,
    );
    const out = await run([leaky]);
    expect(out).toContain('URL embeds a credential');
    expect(hasResidualSecret(out)).toBe(false);
  });
});

describe('no credential ever reaches the event log', () => {
  it('a report built from remote events contains nothing credential-shaped', () => {
    // The belt-and-braces assertion that mirrors the live proof's grep over the session JSONL.
    const events = [
      CONTEXT,
      ev('remote.inspected', { callId: 'c', operation: 'auth', host: 'github.com', target: 'o/r', account: 'earthwalker17', ok: true, durationMs: 1 }, 3),
      mutation({}, 4),
    ];
    const { md, json } = buildReport({ events });
    expect(hasResidualSecret(md)).toBe(false);
    expect(hasResidualSecret(JSON.stringify(json))).toBe(false);
  });
});
