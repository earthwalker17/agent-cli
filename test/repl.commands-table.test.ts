import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { dispatchSlash, type CommandContext } from '../src/repl/commands.js';
import { COMMANDS, completeSlash } from '../src/repl/command-table.js';
import { startSession, endSession, type Session } from '../src/runtime/session.js';
import { resolveLayout } from '../src/store/layout.js';
import { MockProvider } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import type { Renderer } from '../src/repl/render.js';

/**
 * S22 — the command table is DATA describing the surface `dispatchSlash` implements, consumed by
 * the Tab completer and the `/` menu. This suite is the drift pin: a command added to the switch
 * without a table row (or vice versa) fails here, in both directions, instead of silently
 * missing from discovery.
 */

let tmp: string;
let ws: string;
let state: string;
let session: Session;
let chrome: string[];

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-table-')));
  ws = path.join(tmp, 'ws');
  state = path.join(tmp, 'state');
  fs.mkdirSync(ws);
  chrome = [];
  session = startSession({
    workspaceRoot: ws,
    layout: layout(),
    model: 'mock',
    mode: 'interactive',
    provider: new MockProvider([]),
    approver: autoDenyApprover,
    tools: [],
    saltHex: '00'.repeat(16),
  });
});
afterEach(() => {
  try {
    endSession(session, 'user-quit');
  } catch {
    /* already ended */
  }
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

function ctx(): CommandContext {
  const modelOut = new PassThrough();
  modelOut.resume();
  return {
    session,
    layout: layout(),
    renderer: fakeRenderer(chrome),
    modelOut,
    pendingNotes: [],
    // Every question answered blank: flows that ask decline safely and still prove dispatch.
    question: async () => '',
  };
}

describe('the command table ↔ dispatch drift pin', () => {
  it('every table name and alias reaches a real dispatch branch (never "unknown command")', async () => {
    for (const c of COMMANDS) {
      for (const name of [c.name, ...(c.aliases ?? [])]) {
        chrome.length = 0;
        const outcome = await dispatchSlash(`/${name}`, ctx());
        const text = chrome.join('\n');
        expect(text, `/${name} fell through to the unknown-command branch`).not.toContain('unknown command:');
        if (name === 'quit' || name === 'exit') expect(outcome).toBe('quit');
      }
    }
  });

  it('every case label in the dispatch switch has a table row (the reverse direction)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'repl', 'commands.ts'), 'utf8');
    // The dispatch switch's cases sit at 4-space indentation in dispatchSlash; nested command
    // bodies indent deeper, so this scan is anchored to the switch itself. The character class
    // admits digits and hyphens (S22 review: a `case 'md2pdf':` under `[a-z]+` would silently
    // escape the pin), and SET EQUALITY replaces the loose >20 guard — a case leaving the scan
    // is as loud as a case leaving the table.
    const labels = [...src.matchAll(/^ {4}case '([a-z0-9-]+)':/gm)].map((m) => m[1]!);
    const tabled = new Set(COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    expect(new Set(labels).size).toBe(tabled.size);
    for (const label of labels) {
      expect(tabled.has(label), `case '${label}' has no command-table row`).toBe(true);
    }
  });
});

describe('the Tab completer', () => {
  it('completes a unique prefix, lists an ambiguous one, ignores non-slash lines', () => {
    expect(completeSlash('/che')[0]).toEqual(['/checkpoint ', '/checks ']);
    expect(completeSlash('/q')[0]).toEqual(['/quit ']);
    expect(completeSlash('/')[0].length).toBeGreaterThanOrEqual(COMMANDS.length);
    expect(completeSlash('hello')[0]).toEqual([]);
    expect(completeSlash('/plan approve')[0]).toEqual([]); // args are not completed
  });

  it('aliases complete too, and share the prefix space with real names', () => {
    expect(completeSlash('/exi')[0]).toEqual(['/exit ']);
    expect(completeSlash('/ex')[0]).toEqual(['/expand ', '/exit ']); // ambiguous since /expand (S22)
  });
});
