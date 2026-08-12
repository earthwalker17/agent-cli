import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { dispatchSlash, type CommandContext } from '../src/repl/commands.js';
import { createConsentAsker, completionReady, openEscalation, planReadyForApproval, planReapprovalNeeded } from '../src/repl/consent.js';
import { parseChoice } from '../src/repl/prompt-choice.js';
import { startSession, endSession, type Session } from '../src/runtime/session.js';
import { resolveLayout } from '../src/store/layout.js';
import { writeCanonicalPlan, setCanonicalStatus } from '../src/plan/canonical.js';
import { PlanGraphSchema } from '../src/plan/schema.js';
import { MockProvider } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { runRepl } from '../src/repl/repl.js';
import { EventLog } from '../src/store/event-log.js';
import { createNoneSandbox } from '../src/sandbox/none.js';
import type { ScriptTurn } from '../src/provider/mock.js';
import type { Renderer } from '../src/repl/render.js';
import type { SessionEvent } from '../src/types.js';

/**
 * Session 21.5 — contextual consent.
 *
 * The load-bearing property is EVIDENCE IDENTITY: answering a prompt and typing the command must
 * record the same events and tell the model the same thing. That is guaranteed structurally (both
 * call one extracted body), and pinned here by running the same fixture twice and comparing.
 */

let tmp: string;
let ws: string;
let state: string;
let session: Session;
let chrome: string[];

const GRAPH = {
  objective: 'build the importer',
  tasks: [
    { id: 't1', title: 'write the parser', intent: 'parse the input', role: 'executor', verify: 'npm test', touches: ['src/p'] },
    { id: 't2', title: 'wire it up', intent: 'connect it', role: 'main', verify: 'run it', dependsOn: ['t1'] },
  ],
};

let prevStateEnv: string | undefined;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-consent-')));
  ws = path.join(tmp, 'ws');
  state = path.join(tmp, 'state');
  fs.mkdirSync(ws);
  // runRepl resolves its state root from the environment, not from an injected layout.
  prevStateEnv = process.env['AGENT_CLI_STATE_DIR'];
  process.env['AGENT_CLI_STATE_DIR'] = state;
  chrome = [];
  session = makeSession();
});
afterEach(() => {
  try {
    endSession(session, 'user-quit');
  } catch {
    /* already ended */
  }
  if (prevStateEnv === undefined) delete process.env['AGENT_CLI_STATE_DIR'];
  else process.env['AGENT_CLI_STATE_DIR'] = prevStateEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function layout() {
  return resolveLayout(ws, { ensure: true, env: { AGENT_CLI_STATE_DIR: state } });
}

function fakeRenderer(sink: string[]): Renderer {
  return {
    onText: () => {},
    onCommandOutput: () => {},
    onEvent: () => {},
    beginTurn: () => {},
    endTurn: () => {},
    turnError: () => {},
    banner: () => {},
    chromeLine: (t) => sink.push(t),
    flush: () => {},
  };
}

function makeSession(): Session {
  return startSession({
    workspaceRoot: ws,
    layout: layout(),
    model: 'mock',
    mode: 'interactive',
    provider: new MockProvider([]),
    approver: autoDenyApprover,
    tools: [],
    saltHex: '00'.repeat(16),
  });
}

/** Records every question asked, and answers from the scripted list (null = EOF). */
function ctxWith(answers: (string | null)[]): { ctx: CommandContext; asked: string[]; notes: string[] } {
  let i = 0;
  const asked: string[] = [];
  const notes: string[] = [];
  return {
    asked,
    notes,
    ctx: {
      session,
      layout: layout(),
      renderer: fakeRenderer(chrome),
      modelOut: new PassThrough(),
      pendingNotes: notes,
      question: async (q: string) => {
        asked.push(q);
        return i < answers.length ? answers[i++]! : null;
      },
    },
  };
}

async function seedPlan(status: 'draft' | 'approved' = 'draft'): Promise<string> {
  const graph = PlanGraphSchema.parse(GRAPH);
  const w = await writeCanonicalPlan(layout(), session.id, graph, session.snapshots, session.clock);
  if ('error' in w) throw new Error(w.error);
  if (status === 'approved') {
    await setCanonicalStatus(layout(), session.id, 'approved', session.snapshots, session.clock);
    // The consent EVENT is what `approvedSha` derives from — the file's status alone is not an
    // approval, which is precisely the distinction the two plan predicates turn on.
    session.log.append({ type: 'plan.approved', planId: session.id, sha256: w.contentSha });
  }
  return w.contentSha;
}

const ON = { enabled: true, turnOk: true, aborted: false };
const events = (): readonly SessionEvent[] => session.log.events;
const kinds = (): string[] => events().map((e) => e.type);

// ── the shared answer grammar ────────────────────────────────────────────────────────────────

describe('parseChoice — one grammar, no affirmative default (S21.5)', () => {
  const CHOICES = [
    { key: 'y', label: 'yes' },
    { key: 'n', label: 'no' },
  ] as const;

  it('matches on the first character, like the approval parser', () => {
    expect(parseChoice('y', CHOICES).key).toBe('y');
    expect(parseChoice('  Y  ', CHOICES).key).toBe('y');
    expect(parseChoice('yes please', CHOICES).key).toBe('y');
    expect(parseChoice('n', CHOICES).key).toBe('n');
  });

  it('empty, unrecognized and EOF all mean DO NOTHING', () => {
    expect(parseChoice('', CHOICES)).toMatchObject({ key: null, reason: 'declined' });
    expect(parseChoice('   ', CHOICES)).toMatchObject({ key: null, reason: 'declined' });
    expect(parseChoice('maybe', CHOICES)).toMatchObject({ key: null, reason: 'unrecognized' });
    expect(parseChoice(null, CHOICES)).toMatchObject({ key: null, reason: 'eof' });
  });

  it('does not honour a key the prompt never offered', () => {
    // `a` mints durable authority in the APPROVAL grammar. It must mean nothing here.
    expect(parseChoice('a', CHOICES)).toMatchObject({ key: null, reason: 'unrecognized' });
    expect(parseChoice('s', CHOICES)).toMatchObject({ key: null, reason: 'unrecognized' });
  });
});

// ── predicates ───────────────────────────────────────────────────────────────────────────────

describe('consent predicates (S21.5)', () => {
  it('a never-approved plan with executor tasks is ready for approval', async () => {
    const sha = await seedPlan();
    const { ctx } = ctxWith([]);
    expect(planReadyForApproval(ctx)).toMatchObject({ executors: 1, tasks: 2, contentSha: sha });
    // …and is NOT the re-approval case. The two differ in exactly one clause and must be disjoint.
    expect(planReapprovalNeeded(ctx)).toBeNull();
  });

  it('an approved-then-amended plan is the re-approval case and NOT the ready case', async () => {
    await seedPlan('approved');
    const amended = PlanGraphSchema.parse({
      ...GRAPH,
      tasks: [{ ...GRAPH.tasks[0]!, title: 'write the parser differently' }, GRAPH.tasks[1]!],
    });
    await writeCanonicalPlan(layout(), session.id, amended, session.snapshots, session.clock);
    const { ctx } = ctxWith([]);
    expect(planReadyForApproval(ctx)).toBeNull();
    expect(planReapprovalNeeded(ctx)).toMatchObject({ waiting: ['t1'] });
  });

  it('a plan-less conversation is never volunteered for acceptance', () => {
    const { ctx } = ctxWith([]);
    // computeAcceptance says complete:true here; the materiality gate is what stops the nag.
    expect(completionReady(ctx)).toBeNull();
  });

  it('a session that changed files IS offered acceptance', () => {
    session.log.append({
      type: 'file.mutated',
      callId: 'c1',
      path: path.join(ws, 'a.ts'),
      kind: 'create',
      beforeSha256: null,
      afterSha256: 'a'.repeat(64),
      createdDirs: [],
    });
    const { ctx } = ctxWith([]);
    expect(completionReady(ctx)).not.toBeNull();
  });

  it('openEscalation targets the NEWEST open escalation and skips evidence-resolved ones', () => {
    for (const target of ['first', 'second']) {
      session.log.append({
        type: 'repair.escalated',
        callId: 'recover-1',
        target,
        failureClass: 'test-assertion',
        signature: `sig-${target}`,
        reason: `${target} failed`,
      });
    }
    const { ctx } = ctxWith([]);
    expect(openEscalation(ctx)?.esc.target).toBe('second');
  });
});

// ── the gate ─────────────────────────────────────────────────────────────────────────────────

describe('the consent gate (S21.5)', () => {
  it('asks nothing when disabled — the piped/headless contract', async () => {
    await seedPlan();
    const { ctx, asked } = ctxWith(['y']);
    await createConsentAsker().maybeAsk(ctx, { ...ON, enabled: false });
    expect(asked).toEqual([]);
    expect(kinds()).not.toContain('plan.approved');
  });

  it('asks nothing when the turn was aborted', async () => {
    await seedPlan();
    const { ctx, asked } = ctxWith(['y']);
    await createConsentAsker().maybeAsk(ctx, { ...ON, aborted: true });
    expect(asked).toEqual([]);
  });

  it('asks nothing when there is no question seam', async () => {
    await seedPlan();
    const { ctx } = ctxWith([]);
    delete (ctx as { question?: unknown }).question;
    await createConsentAsker().maybeAsk(ctx, ON);
    expect(kinds()).not.toContain('plan.approved');
  });
});

// ── behaviour ────────────────────────────────────────────────────────────────────────────────

describe('the approval prompt (S21.5)', () => {
  it('y approves and records the same consent event the command records', async () => {
    await seedPlan();
    const { ctx, asked, notes } = ctxWith(['y']);
    await createConsentAsker().maybeAsk(ctx, ON);
    expect(asked[0]).toContain('plan ready: build the importer');
    expect(asked[0]).toContain('1 isolated executor task(s)');
    expect(asked[0]).toContain('[y] approve');
    expect(kinds()).toContain('plan.approved');
    expect(notes.join(' ')).toContain('the user APPROVED the plan');
  });

  it('n, empty, an unknown key and EOF all leave the plan unapproved', async () => {
    for (const answer of ['n', '', 'maybe', null]) {
      const fresh = makeSession();
      const prev = session;
      session = fresh;
      try {
        await seedPlan();
        const { ctx } = ctxWith([answer]);
        await createConsentAsker().maybeAsk(ctx, ON);
        expect(kinds(), `answer ${JSON.stringify(answer)}`).not.toContain('plan.approved');
      } finally {
        endSession(fresh, 'user-quit');
        session = prev;
      }
    }
  });

  it('v shows the plan and re-asks exactly once', async () => {
    await seedPlan();
    const { ctx, asked } = ctxWith(['v', 'y']);
    await createConsentAsker().maybeAsk(ctx, ON);
    expect(asked).toHaveLength(2);
    expect(kinds()).toContain('plan.approved');
  });

  it('v twice stops rather than badgering', async () => {
    await seedPlan();
    const { ctx, asked } = ctxWith(['v', 'v', 'y']);
    await createConsentAsker().maybeAsk(ctx, ON);
    expect(asked).toHaveLength(2);
    expect(kinds()).not.toContain('plan.approved');
  });
});

describe('anti-nag (S21.5)', () => {
  it('asks once per plan content sha, and re-arms when the plan changes', async () => {
    await seedPlan();
    const asker = createConsentAsker();

    const a = ctxWith(['n']);
    await asker.maybeAsk(a.ctx, ON);
    expect(a.asked).toHaveLength(1);

    // Same state → silent.
    const b = ctxWith(['y']);
    await asker.maybeAsk(b.ctx, ON);
    expect(b.asked).toEqual([]);

    // A new plan content sha re-arms it.
    const amended = PlanGraphSchema.parse({ ...GRAPH, objective: 'build the importer, revised' });
    await writeCanonicalPlan(layout(), session.id, amended, session.snapshots, session.clock);
    const c = ctxWith(['y']);
    await asker.maybeAsk(c.ctx, ON);
    expect(c.asked).toHaveLength(1);
    expect(kinds()).toContain('plan.approved');
  });

  it('a declined completion re-arms only after new work', async () => {
    session.log.append({
      type: 'file.mutated',
      callId: 'c1',
      path: path.join(ws, 'a.ts'),
      kind: 'create',
      beforeSha256: null,
      afterSha256: 'a'.repeat(64),
      createdDirs: [],
    });
    const asker = createConsentAsker();

    const a = ctxWith(['n']);
    await asker.maybeAsk(a.ctx, ON);
    expect(a.asked).toHaveLength(1);

    const b = ctxWith(['y']);
    await asker.maybeAsk(b.ctx, ON);
    expect(b.asked).toEqual([]);

    session.log.append({
      type: 'file.mutated',
      callId: 'c2',
      path: path.join(ws, 'b.ts'),
      kind: 'create',
      beforeSha256: null,
      afterSha256: 'b'.repeat(64),
      createdDirs: [],
    });
    const c = ctxWith(['y']);
    await asker.maybeAsk(c.ctx, ON);
    expect(c.asked).toHaveLength(1);
    expect(kinds()).toContain('session.accepted');
  });
});

describe('precedence — one prompt per boundary (S21.5)', () => {
  it('the plan gate outranks an open escalation, and the escalation is asked next time', async () => {
    await seedPlan();
    session.log.append({
      type: 'repair.escalated',
      callId: 'recover-1',
      target: 'session',
      failureClass: 'test-assertion',
      signature: 'sig-1',
      reason: 'the suite keeps failing',
    });
    const asker = createConsentAsker();

    const a = ctxWith(['n']);
    await asker.maybeAsk(a.ctx, ON);
    expect(a.asked).toHaveLength(1);
    expect(a.asked[0]).toContain('plan ready');

    // The escalation was never asked, so it stays armed for the next boundary.
    const b = ctxWith(['n']);
    await asker.maybeAsk(b.ctx, ON);
    expect(b.asked).toHaveLength(1);
    expect(b.asked[0]).toContain('escalated');
  });

  it('C is suppressed when the turn ended in error, but A still fires', async () => {
    await seedPlan();
    const { ctx, asked } = ctxWith(['n']);
    await createConsentAsker().maybeAsk(ctx, { ...ON, turnOk: false });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('plan ready');
  });
});

describe('the escalation prompt (S21.5)', () => {
  function escalate(): void {
    session.log.append({
      type: 'repair.escalated',
      callId: 'recover-1',
      target: 'session',
      failureClass: 'test-assertion',
      signature: 'sig-1',
      reason: 'the suite keeps failing',
    });
  }

  it('d then a reason records the dismissal with source user', async () => {
    escalate();
    const { ctx, notes } = ctxWith(['d', 'verified by hand; the fixture is intentional']);
    await createConsentAsker().maybeAsk(ctx, ON);
    const dismissed = events().find((e) => e.type === 'repair.dismissed');
    expect(dismissed).toBeDefined();
    expect(dismissed).toMatchObject({ source: 'user', target: 'session' });
    expect(notes.join(' ')).toContain('the user DISMISSED');
  });

  it('an empty reason records NOTHING, matching the typed command', async () => {
    escalate();
    const { ctx } = ctxWith(['d', '   ']);
    await createConsentAsker().maybeAsk(ctx, ON);
    expect(kinds()).not.toContain('repair.dismissed');
    expect(chrome.join('\n')).toContain('a reason is required');
  });

  it('EOF at the reason records nothing', async () => {
    escalate();
    const { ctx } = ctxWith(['d', null]);
    await createConsentAsker().maybeAsk(ctx, ON);
    expect(kinds()).not.toContain('repair.dismissed');
  });

  it('the affirmative key is d, not y — y is not a dismissal', async () => {
    escalate();
    const { ctx } = ctxWith(['y']);
    await createConsentAsker().maybeAsk(ctx, ON);
    expect(kinds()).not.toContain('repair.dismissed');
  });
});

// ── level 4: a REACTIVE full-REPL TTY harness ────────────────────────────────────────────────

/**
 * The existing `drive()` harness pre-writes every input line and runs with `isTTY:false`, so it
 * structurally cannot reach a contextual prompt. On a TTY `io.question` refuses a line typed
 * before the question existed (`fresh`), so a pre-written buffer would DEADLOCK: the answer sits
 * in the type-ahead queue while the prompt waits for a new one. This driver therefore writes each
 * answer only after seeing the prompt it answers — the same shape as the live E2E drivers.
 */
async function driveTTY(
  script: ScriptTurn[],
  steps: { awaitChrome: RegExp; send: string }[],
): Promise<{ code: number; chrome: string; events: SessionEvent[] }> {
  const scriptFile = path.join(tmp, 'script.json');
  fs.writeFileSync(scriptFile, JSON.stringify(script));

  const input = new PassThrough();
  const chromeChunks: Buffer[] = [];
  const chromeOut = new PassThrough();
  const modelOut = new PassThrough();
  modelOut.resume();

  let buf = '';
  let next = 0;
  chromeOut.on('data', (c: Buffer) => {
    chromeChunks.push(c);
    buf += c.toString('utf8');
    while (next < steps.length && steps[next]!.awaitChrome.test(buf)) {
      const line = steps[next]!.send;
      // A short delay is REQUIRED, not politeness. `io.ts` writes the prompt bytes and only then
      // installs its single `pending` resolver, so a line written the instant the prompt appears
      // can arrive first and be buffered as type-ahead — where a `fresh` question will never
      // consume it, and the REPL waits forever. A human's reaction time hides this window; a
      // driver has to respect it. The live E2E drivers do the same thing.
      setTimeout(() => input.write(`${line}\n`), 60);
      next++;
    }
  });

  const timer = setTimeout(() => input.end(), 100_000).unref();
  const code = await runRepl(
    { C: ws, provider: 'mock', script: scriptFile, interactive: true, 'trust-this-workspace': true },
    { streams: { input, modelOut, chromeOut, isTTY: true }, sandbox: createNoneSandbox('test') },
  );
  clearTimeout(timer);

  const l = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: state } });
  let evts: SessionEvent[] = [];
  try {
    // The suite's own `beforeEach` session lives in the same directory; read the REPL's, not it.
    const ids = fs
      .readdirSync(l.sessionsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -6))
      .filter((id) => id !== session.id)
      .sort();
    const id = ids.at(-1);
    if (id !== undefined) evts = EventLog.readLenient(l.sessionFile(id)).events;
  } catch {
    /* no sessions */
  }
  return { code, chrome: Buffer.concat(chromeChunks).toString('utf8'), events: evts };
}

/**
 * These two run a whole REPL with `isTTY: true` and react to its output, so they are the slowest
 * and most timing-sensitive tests in the suite. Under a fully parallel run the process start,
 * assembly probes and mock turns all compete for the machine, so the budgets here are generous on
 * purpose: a timeout would be a flake, and a flaky test about consent is worse than none.
 */
describe('the contextual prompt on a real TTY (S21.5)', () => {
  const PLAN = {
    objective: 'build the widget',
    tasks: [
      { id: 't1', title: 'write it', intent: 'write the widget', role: 'executor', verify: 'npm test', touches: ['src/w'] },
    ],
  };

  it('asks after the planning turn, and y records the approval', async () => {
    const r = await driveTTY(
      [
        { say: 'planning', calls: [{ name: 'update_plan', input: { plan: PLAN } }] },
        { say: 'plan written' },
        { say: 'bye' },
      ],
      [
        { awaitChrome: /\/help for commands/, send: 'build the widget' },
        { awaitChrome: /\[y\] approve/, send: 'y' },
        { awaitChrome: /plan approved \(content sha/, send: '/quit' },
      ],
    );
    expect(r.code).toBe(0);
    expect(r.chrome).toContain('[y] approve');
    expect(r.events.some((e) => e.type === 'plan.approved')).toBe(true);
  }, 120_000);

  it('fails closed: a bare Enter approves nothing and the session still quits cleanly', async () => {
    const r = await driveTTY(
      [
        { say: 'planning', calls: [{ name: 'update_plan', input: { plan: PLAN } }] },
        { say: 'plan written' },
        { say: 'bye' },
      ],
      [
        { awaitChrome: /\/help for commands/, send: 'build the widget' },
        // Empty is a DECLINE, never a default-yes.
        { awaitChrome: /\[y\] approve/, send: '' },
        { awaitChrome: /\(Enter = not now\)[\s\S]*\n/, send: '/quit' },
      ],
    );
    expect(r.code).toBe(0);
    expect(r.events.some((e) => e.type === 'plan.approved')).toBe(false);
    expect(r.events.find((e) => e.type === 'session.ended')).toMatchObject({ reason: 'user-quit' });
  }, 120_000);
});

// ── the property the whole design rests on ───────────────────────────────────────────────────

describe('evidence identity: typed vs answered (S21.5)', () => {
  /** Consent events with the per-run fields removed (seq, ts, and planId — the session id). */
  function shape(evts: readonly SessionEvent[]): unknown[] {
    return evts
      .filter((e) => e.type === 'plan.approved' || e.type === 'session.accepted' || e.type === 'repair.dismissed')
      .map((e) => {
        const { seq: _seq, ts: _ts, planId: _planId, ...rest } = e as unknown as Record<string, unknown>;
        return rest;
      });
  }

  it('/plan approve and the prompt record the same event and the same note', async () => {
    // Run 1: the typed command.
    await seedPlan();
    const typed = ctxWith([]);
    await dispatchSlash('/plan approve', typed.ctx);
    const typedShape = shape(events());
    const typedNotes = [...typed.notes];
    endSession(session, 'user-quit');

    // Run 2: the prompt, on a fresh identical session.
    session = makeSession();
    await seedPlan();
    const answered = ctxWith(['y']);
    await createConsentAsker().maybeAsk(answered.ctx, ON);

    expect(shape(events())).toEqual(typedShape);
    expect(answered.notes).toEqual(typedNotes);
  });

  it('/repair dismiss and the prompt record the same event and the same note', async () => {
    const escalation = {
      type: 'repair.escalated' as const,
      callId: 'recover-1',
      target: 'session',
      failureClass: 'test-assertion' as const,
      signature: 'sig-1',
      reason: 'the suite keeps failing',
    };
    const REASON = 'verified by hand; the fixture is intentional';

    session.log.append(escalation);
    const typed = ctxWith([]);
    await dispatchSlash(`/repair dismiss 1 ${REASON}`, typed.ctx);
    const typedShape = shape(events());
    const typedNotes = [...typed.notes];
    endSession(session, 'user-quit');

    session = makeSession();
    session.log.append(escalation);
    const answered = ctxWith(['d', REASON]);
    await createConsentAsker().maybeAsk(answered.ctx, ON);

    expect(shape(events())).toEqual(typedShape);
    expect(answered.notes).toEqual(typedNotes);
  });

  it('/accept and the prompt record the same acceptance and the same note', async () => {
    const mutate = {
      type: 'file.mutated' as const,
      callId: 'c1',
      path: path.join(ws, 'a.ts'),
      kind: 'create' as const,
      beforeSha256: null,
      afterSha256: 'a'.repeat(64),
      createdDirs: [],
    };

    session.log.append(mutate);
    const typed = ctxWith([]);
    await dispatchSlash('/accept', typed.ctx);
    const typedShape = shape(events());
    const typedNotes = [...typed.notes];
    endSession(session, 'user-quit');

    session = makeSession();
    session.log.append(mutate);
    const answered = ctxWith(['y']);
    await createConsentAsker().maybeAsk(answered.ctx, ON);

    expect(shape(events())).toEqual(typedShape);
    expect(answered.notes).toEqual(typedNotes);
  });
});
