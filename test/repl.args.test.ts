import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { dispatchSlash, parseCommitArgs, type CommandContext } from '../src/repl/commands.js';
import { startSession, endSession, type Session } from '../src/runtime/session.js';
import { resolveLayout } from '../src/store/layout.js';
import { MockProvider } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { addGrant, readGrants } from '../src/store/grants.js';
import type { Renderer } from '../src/repl/render.js';

/**
 * Session 21.5 — argument grammars and the surfaces that had ZERO dispatch coverage.
 *
 * Every case here is a defect the S21.5 interaction audit found by reading the dispatch code: a
 * destructive verb that silently accepted a malformed argument, a flag parser that swallowed the
 * flags after it, a documented subcommand that was a no-op, and a label branch that turned a
 * mistyped subcommand into a checkpoint. They share one property — the old behavior REPORTED
 * SUCCESS, so nothing on screen told the user their instruction had been reinterpreted.
 */

let tmp: string;
let ws: string;
let state: string;
let session: Session;
let chrome: string[];
let modelOut: PassThrough;
let modelText: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-args-')));
  ws = path.join(tmp, 'ws');
  state = path.join(tmp, 'state');
  fs.mkdirSync(ws);
  chrome = [];
  modelText = '';
  session = makeSession();
});
afterEach(() => {
  try {
    endSession(session, 'user-quit');
  } catch {
    /* already ended */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

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

function layout() {
  return resolveLayout(ws, { ensure: true, env: { AGENT_CLI_STATE_DIR: state } });
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

function ctx(answers: (string | null)[] = []): CommandContext {
  let i = 0;
  modelOut = new PassThrough();
  modelOut.on('data', (c: Buffer) => {
    modelText += c.toString();
  });
  return {
    session,
    layout: layout(),
    renderer: fakeRenderer(chrome),
    modelOut,
    pendingNotes: [],
    question: async () => (i < answers.length ? answers[i++]! : ''),
  };
}

const chromeText = (): string => chrome.join('\n');

// ── /undo: a destructive verb must not coerce its argument ───────────────────────────────────

describe('/undo argument validation (S21.5)', () => {
  it('refuses --all instead of silently undoing only the LAST change', async () => {
    await dispatchSlash('/undo --all', ctx());
    expect(chromeText()).toContain("'--all' is not a valid argument");
    // The CLI spelling gets a specific hint, because that is where the user learned it.
    expect(chromeText()).toContain('`/undo all`');
    // Nothing was attempted: no undo.applied event exists.
    expect(session.log.events.some((e) => e.type === 'undo.applied')).toBe(false);
  });

  it.each(['-a', 'everything', '5', 'al'])('refuses %s without touching the workspace', async (bad) => {
    await dispatchSlash(`/undo ${bad}`, ctx());
    expect(chromeText()).toContain('is not a valid argument');
    expect(session.log.events.some((e) => e.type === 'undo.applied')).toBe(false);
  });

  it('still accepts the two documented forms', async () => {
    await dispatchSlash('/undo', ctx());
    await dispatchSlash('/undo ALL', ctx());
    const applied = session.log.events.filter((e) => e.type === 'undo.applied');
    expect(applied).toHaveLength(2);
    expect(applied.map((e) => (e.type === 'undo.applied' ? e.target : ''))).toEqual(['last', 'all']);
  });
});

// ── parseCommitArgs: -m must not swallow the flags after it ──────────────────────────────────

describe('parseCommitArgs (S21.5)', () => {
  it('the exact syntax the help line prints now works', () => {
    // Before: subject `fix" --all`, and --all silently dropped.
    expect(parseCommitArgs('-m "fix the parser" --all')).toEqual({ all: true, noTrailer: false, message: 'fix the parser' });
  });

  it('honours every flag after -m, in any order', () => {
    expect(parseCommitArgs('-m "subject" --all --no-trailer')).toEqual({ all: true, noTrailer: true, message: 'subject' });
    expect(parseCommitArgs('--all -m "subject"')).toEqual({ all: true, noTrailer: false, message: 'subject' });
    expect(parseCommitArgs('--no-trailer --all -m "s"')).toEqual({ all: true, noTrailer: true, message: 's' });
  });

  it('keeps unquoted multi-word subjects working', () => {
    expect(parseCommitArgs('-m fix the parser')).toEqual({ all: false, noTrailer: false, message: 'fix the parser' });
    expect(parseCommitArgs('-m fix the parser --all')).toEqual({ all: true, noTrailer: false, message: 'fix the parser' });
  });

  it('a flag spelled INSIDE the quoted subject stays in the subject', () => {
    expect(parseCommitArgs('-m "make --all the default"')).toEqual({
      all: false,
      noTrailer: false,
      message: 'make --all the default',
    });
  });

  it('refuses an empty message, a repeated -m, and unknown arguments', () => {
    expect(parseCommitArgs('-m')?.error).toContain('-m needs a message');
    expect(parseCommitArgs('-m "" --all')?.error).toContain('-m needs a message');
    expect(parseCommitArgs('-m "a" -m "b"')?.error).toContain('-m given twice');
    expect(parseCommitArgs('--force')?.error).toContain('unknown /commit argument: --force');
  });

  it('the bare form is unchanged', () => {
    expect(parseCommitArgs('')).toEqual({ all: false, noTrailer: false });
    expect(parseCommitArgs('--all')).toEqual({ all: true, noTrailer: false });
  });
});

// ── /checkpoint: a mistyped subcommand is not a label ────────────────────────────────────────

describe('/checkpoint argument validation (S21.5)', () => {
  it('refuses a reserved verb instead of creating a checkpoint LABELLED with it', async () => {
    await dispatchSlash('/checkpoint prune', ctx());
    expect(chromeText()).toContain("no 'prune' subcommand");
    expect(chromeText()).toContain('agent checkpoint prune');
    expect(session.log.events.some((e) => e.type === 'git.checkpoint')).toBe(false);
  });

  it.each(['delete', 'remove', 'rm', 'drop', 'clear', 'clean', 'gc'])('refuses the reserved word %s', async (word) => {
    await dispatchSlash(`/checkpoint ${word}`, ctx());
    expect(chromeText()).toContain('subcommand');
    expect(session.log.events.some((e) => e.type === 'git.checkpoint')).toBe(false);
  });

  it('refuses a flag-shaped argument rather than making it the label', async () => {
    await dispatchSlash('/checkpoint --all', ctx());
    expect(chromeText()).toContain('takes a label, not flags');
    expect(session.log.events.some((e) => e.type === 'git.checkpoint')).toBe(false);
  });
});

// ── /grants revoke: the documented action was a silent no-op ─────────────────────────────────

describe('/grants revoke (S21.5)', () => {
  it('revokes a stored grant from inside the session', async () => {
    const g = await addGrant(
      layout().stateRoot,
      { kind: 'class', workspaceKey: null, tool: 'web_search', cls: 'external', label: 'bounded web searches' },
      '2026-08-12T00:00:00.000Z',
    );
    expect(readGrants(layout().stateRoot)).toHaveLength(1);

    await dispatchSlash(`/grants revoke ${g.id}`, ctx());

    expect(readGrants(layout().stateRoot)).toHaveLength(0);
    expect(chromeText()).toContain(`revoked ${g.id}`);
    // The honest scope: the store changed, this session's in-memory authority did not.
    expect(chromeText()).toContain('NEXT session assembly');
  });

  it('names an unknown id instead of silently listing', async () => {
    await dispatchSlash('/grants revoke nope-1234', ctx());
    expect(chromeText()).toContain('no durable grant with id nope-1234');
  });

  it('refuses a malformed subcommand with usage', async () => {
    await dispatchSlash('/grants revoke', ctx());
    expect(chromeText()).toContain('usage: /grants [revoke <id>]');
    chrome.length = 0;
    await dispatchSlash('/grants list', ctx());
    expect(chromeText()).toContain('usage: /grants [revoke <id>]');
  });

  it('the bare listing still reports the assembly view', async () => {
    await dispatchSlash('/grants', ctx());
    expect(chromeText()).toContain('no durable machine grants were active');
    expect(chromeText()).toContain('/grants revoke <id>');
  });
});

// ── surfaces that had ZERO dispatch coverage before S21.5 ────────────────────────────────────

describe('previously untested dispatch paths (S21.5)', () => {
  it('/exit is a real alias for /quit', async () => {
    expect(await dispatchSlash('/exit', ctx())).toBe('quit');
    expect(await dispatchSlash('/quit', ctx())).toBe('quit');
  });

  it('an unknown command hints instead of throwing', async () => {
    expect(await dispatchSlash('/nope', ctx())).toBe('continue');
    expect(chromeText()).toContain('unknown command: /nope');
  });

  it('a natural sentence beginning with / is still reported as an unknown command', async () => {
    await dispatchSlash('/tmp is where I keep scratch files', ctx());
    expect(chromeText()).toContain('unknown command: /tmp');
  });

  it('/diff renders to the model stream without touching the log', async () => {
    const before = session.log.events.length;
    await dispatchSlash('/diff', ctx());
    expect(session.log.events).toHaveLength(before);
  });

  it('/map prints the workspace map', async () => {
    fs.writeFileSync(path.join(ws, 'hello.ts'), 'export const x = 1;\n');
    await dispatchSlash('/map', ctx());
    expect(modelText).toContain('hello.ts');
  });

  it('/checks reports honestly when the typed-check tool is absent', async () => {
    await dispatchSlash('/checks', ctx());
    expect(modelText).toContain('typed checks are unavailable in this session');
  });

  it('/preview reports honestly when the preview tool is absent', async () => {
    await dispatchSlash('/preview', ctx());
    expect(chromeText()).toContain('managed previews are unavailable in this session');
  });

  it('/commit refuses outside a git repository', async () => {
    await dispatchSlash('/commit', ctx());
    expect(chromeText()).toContain('needs a git repository');
  });

  it('/checkpoint refuses outside a git repository', async () => {
    await dispatchSlash('/checkpoint', ctx());
    expect(chromeText()).toContain('needs a git repository');
  });

  it('/cancel at the idle prompt explains that it is mid-turn only', async () => {
    await dispatchSlash('/cancel abcd', ctx());
    expect(chromeText()).toContain('MID-TURN');
  });
});

// ── /research: an absent credential must not read as "nothing was searched" ──────────────────

describe('/research unavailability (S21.5)', () => {
  it('says research was unavailable instead of rendering an empty record', async () => {
    const c = ctx();
    c.researchUnavailable = 'no TAVILY_API_KEY in the environment';
    await dispatchSlash('/research', c);
    expect(modelText).toContain('unavailable: no TAVILY_API_KEY in the environment');
  });

  it('an available session renders the ordinary empty record', async () => {
    await dispatchSlash('/research', ctx());
    expect(modelText).toContain('# Web research (this session)');
    expect(modelText).not.toContain('unavailable:');
  });
});

// ── /report [section] — one projection, sliced (S21.5) ───────────────────────────────────────

describe('/report sections (S21.5)', () => {
  it('the bare form still prints the whole record', async () => {
    await dispatchSlash('/report', ctx());
    expect(modelText).toContain('# Agent CLI session report');
    expect(modelText).toContain('## Actions');
  });

  it('a named section prints only that section', async () => {
    await dispatchSlash('/report files', ctx());
    expect(modelText).toContain('## Files changed');
    expect(modelText).not.toContain('# Agent CLI session report');
    expect(modelText).not.toContain('## Actions');
  });

  it('an absent section says so rather than printing nothing', async () => {
    await dispatchSlash('/report research', ctx());
    expect(modelText).toContain('nothing of this kind is recorded');
  });

  it('an unknown section prints the list of real ones', async () => {
    await dispatchSlash('/report nonsense', ctx());
    expect(chromeText()).toContain('usage: /report [');
    expect(chromeText()).toContain('checks');
    expect(chromeText()).toContain('inspections');
  });
});
