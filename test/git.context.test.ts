import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/workspace/system-prompt.js';
import { buildReport } from '../src/report/report.js';
import { TOOLS } from '../src/tools/index.js';
import type { SessionEvent } from '../src/types.js';
import type { GitFacts } from '../src/git/types.js';

/** Stage-2 tests: git context in the system prompt, the report, and the tool-registry guard. */

const MAP = { text: 'src/a.ts', fileCount: 1, truncated: false, sha256: 'x'.repeat(64) };

function facts(over: Partial<GitFacts> = {}): GitFacts {
  return {
    isRepo: true,
    gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
    gitVersion: '2.52.0.windows.1',
    repoRoot: 'C:\\ws',
    workspaceIsRepoRoot: true,
    branch: 'main',
    detached: false,
    unborn: false,
    head: 'ab12cd34ef56',
    upstream: null,
    ahead: null,
    behind: null,
    dirtyCount: 0,
    untrackedCount: 0,
    probeFailed: false,
    detail: 'branch main @ ab12cd34ef56, clean',
    ...over,
  };
}

describe('system prompt git context', () => {
  const OLD_RULE = 'Never initialize or modify version control';

  it('in a repo: states the context and keeps the mutation prohibition', () => {
    const p = buildSystemPrompt('C:\\ws', MAP, undefined, facts());
    expect(p).toContain('inside a git repository: branch main @ ab12cd34ef56, clean');
    expect(p).toContain('Never stage, commit, or otherwise modify version-control state');
    expect(p).not.toContain(OLD_RULE);
  });

  it('outside a repo: the original no-git rule stays verbatim', () => {
    for (const g of [undefined, facts({ isRepo: false, detail: 'not a git repository' })]) {
      const p = buildSystemPrompt('C:\\ws', MAP, undefined, g);
      expect(p).toContain(OLD_RULE);
      expect(p).not.toContain('inside a git repository');
    }
  });

  it('S21.6: with the git tools registered, the prompt names them instead of the shell', () => {
    const p = buildSystemPrompt('C:\\ws', MAP, undefined, facts(), undefined, undefined, undefined, undefined, true);
    expect(p).toContain('Read it with `git_status`');
    expect(p).toContain('git_checkpoint');
    // The sentence the tools replace must be GONE: a prompt telling the model to shell out while a
    // structured tool exists is two surfaces disagreeing about the same job.
    expect(p).not.toContain('Read-only git commands (status/log/diff/show) are the right way');
    // The boundary is stated plainly, because it is the one thing the model must not try.
    expect(p).toContain('You have NO way to commit on your own initiative');
    expect(p).toContain('the harness offers it to them at the acceptance boundary');
    expect(p).toContain('Never stage, commit, or otherwise modify version-control state');
  });

  it('S21.6: without the tools (no addressable repo), the shell sentence stays and nothing is promised', () => {
    const p = buildSystemPrompt('C:\\ws', MAP, undefined, facts());
    expect(p).toContain('Read-only git commands (status/log/diff/show) are the right way');
    expect(p).not.toContain('git_status');
    expect(p).not.toContain('git_checkpoint');
    // The no-commit boundary is NOT conditional on the tools — it was always true.
    expect(p).toContain('You have NO way to commit on your own initiative');
  });
});

describe('report git context', () => {
  const started: SessionEvent = {
    v: 1, seq: 1, ts: 't', type: 'session.started',
    sessionId: 's1', workspaceRoot: 'C:\\ws', model: 'm', mode: 'interactive', providerName: 'mock', argv: [],
  };

  it('renders the probed git line and carries it in json (state at session start)', () => {
    const gitEvent: SessionEvent = {
      v: 1, seq: 2, ts: 't', type: 'git.context',
      isRepo: true, gitVersion: '2.52.0', repoRoot: 'C:\\ws', workspaceIsRepoRoot: true,
      branch: 'main', detached: false, unborn: false, head: 'ab12cd34ef56', upstream: null,
      ahead: null, behind: null, dirtyCount: 2, untrackedCount: 1, probeFailed: false,
      detail: 'branch main @ ab12cd34ef56, 2 uncommitted (1 untracked)',
    };
    const { json, md } = buildReport({ events: [started, gitEvent] });
    expect(json.session.git).toMatchObject({ isRepo: true, branch: 'main', dirtyCount: 2 });
    expect(md).toContain('- git (at session start): branch main @ ab12cd34ef56, 2 uncommitted (1 untracked)');
  });

  it('old logs without git.context render without a git section', () => {
    const { json, md } = buildReport({ events: [started] });
    expect(json.session.git).toBeUndefined();
    expect(md).not.toContain('- git');
  });
});

describe('tool registry guard', () => {
  it('no git capability is registered as a model tool (policy would auto-allow a command-less tool)', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['read_file', 'list_files', 'search', 'write_file', 'edit_file', 'run_command']);
  });
});
