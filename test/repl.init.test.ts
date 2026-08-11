import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { dispatchSlash, type CommandContext } from '../src/repl/commands.js';
import { startSession, endSession, type Session } from '../src/runtime/session.js';
import { resolveLayout } from '../src/store/layout.js';
import { MockProvider } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import type { Renderer } from '../src/repl/render.js';

/**
 * Session 21 — /init: the optional onboarding flow. Creates the global AGENT.md from skippable
 * answers, offers a starter project AGENT.md, NEVER rewrites an existing file, and aborts with
 * nothing written on EOF at any question.
 */

let tmp: string;
let ws: string;
let state: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-init-')));
  ws = path.join(tmp, 'ws');
  state = path.join(tmp, 'state');
  fs.mkdirSync(ws);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeRenderer(chrome: string[]): Renderer {
  return {
    onText: () => {},
    onCommandOutput: () => {},
    onEvent: () => {},
    beginTurn: () => {},
    endTurn: () => {},
    turnError: () => {},
    banner: () => {},
    chromeLine: (t) => chrome.push(t),
    flush: () => {},
  };
}

function makeSession(): Session {
  const layout = resolveLayout(ws, { ensure: true, env: { AGENT_CLI_STATE_DIR: state } });
  return startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock',
    mode: 'interactive',
    provider: new MockProvider([]),
    approver: autoDenyApprover,
    tools: [],
    saltHex: '00'.repeat(16),
  });
}

/** answers are consumed in order; null = EOF at that question. */
function ctxFor(session: Session, chrome: string[], answers: (string | null)[]): CommandContext {
  let i = 0;
  return {
    session,
    layout: resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: state } }),
    renderer: fakeRenderer(chrome),
    modelOut: new PassThrough(),
    pendingNotes: [],
    question: async () => (i < answers.length ? answers[i++]! : ''),
  };
}

const globalFile = (): string => path.join(resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: state } }).stateRoot, 'AGENT.md');
const projectFile = (): string => path.join(ws, 'AGENT.md');

describe('/init', () => {
  it('full flow: global doc with the answered sections + provenance header; project template on y', async () => {
    const session = makeSession();
    try {
      const chrome: string[] = [];
      const ctx = ctxFor(session, chrome, ['Sam', 'terse answers; evidence over narration', 'run the tests', 'push to any remote', 'y', 'A tiny weather CLI.']);
      await dispatchSlash('/init', ctx);

      const g = fs.readFileSync(globalFile(), 'utf8');
      expect(g).toContain('created by /init on');
      expect(g).toContain('# Global instructions (all projects)');
      expect(g).toContain('- Call me Sam.');
      expect(g).toContain('## Working style');
      expect(g).toContain('- terse answers; evidence over narration');
      expect(g).toContain('## Always');
      expect(g).toContain('## Never (without asking first)');
      expect(g).toContain('- push to any remote');
      expect(g).toContain('Secrets and credentials NEVER belong here');

      const p = fs.readFileSync(projectFile(), 'utf8');
      expect(p).toContain('# Project notes for the agent');
      expect(p).toContain('A tiny weather CLI.');
      expect(p).toContain('## Conventions');

      // The model learns; the docs load NEXT session, and the note says so.
      expect(ctx.pendingNotes.join(' ')).toContain('/init');
      expect(ctx.pendingNotes.join(' ')).toContain('NOT loaded into the current session');
    } finally {
      await endSession(session, 'completed');
    }
  });

  it('all questions skipped → a commented starter skeleton is still written', async () => {
    const session = makeSession();
    try {
      const ctx = ctxFor(session, [], ['', '', '', '', 'n']);
      await dispatchSlash('/init', ctx);
      const g = fs.readFileSync(globalFile(), 'utf8');
      expect(g).toContain('starter skeleton');
      expect(fs.existsSync(projectFile())).toBe(false);
    } finally {
      await endSession(session, 'completed');
    }
  });

  it('EOF at any question aborts with NOTHING written', async () => {
    const session = makeSession();
    try {
      const chrome: string[] = [];
      const ctx = ctxFor(session, chrome, ['Sam', null]);
      await dispatchSlash('/init', ctx);
      expect(fs.existsSync(globalFile())).toBe(false);
      expect(fs.existsSync(projectFile())).toBe(false);
      expect(chrome.join('\n')).toContain('aborted — nothing was written');
      expect(ctx.pendingNotes).toHaveLength(0);
    } finally {
      await endSession(session, 'completed');
    }
  });

  it('an existing global AGENT.md is NEVER rewritten — /init reports the path and moves on', async () => {
    const session = makeSession();
    try {
      fs.mkdirSync(path.dirname(globalFile()), { recursive: true });
      fs.writeFileSync(globalFile(), 'MY OWN GLOBAL RULES\n');
      const chrome: string[] = [];
      const ctx = ctxFor(session, chrome, ['n']);
      await dispatchSlash('/init', ctx);
      expect(fs.readFileSync(globalFile(), 'utf8')).toBe('MY OWN GLOBAL RULES\n');
      expect(chrome.join('\n')).toContain('never rewrites it');
    } finally {
      await endSession(session, 'completed');
    }
  });

  it('an existing project AGENT.md is untouched; answers are sanitized before landing in the file', async () => {
    const session = makeSession();
    try {
      fs.writeFileSync(projectFile(), 'PROJECT RULES\n');
      const chrome: string[] = [];
      const ctx = ctxFor(session, chrome, ['Sam\u{1b}[31m', '', '', '']);
      await dispatchSlash('/init', ctx);
      expect(fs.readFileSync(projectFile(), 'utf8')).toBe('PROJECT RULES\n');
      expect(chrome.join('\n')).toContain('project AGENT.md already exists — untouched');
      const g = fs.readFileSync(globalFile(), 'utf8');
      expect(g).not.toContain('\u{1b}');
      expect(g).toContain('Call me Sam');
    } finally {
      await endSession(session, 'completed');
    }
  });
});
