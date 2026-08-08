import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, userConfigPath, workspaceConfigPath } from '../src/config/config.js';
import { decide, Grants } from '../src/policy/engine.js';
import { writeFileTool, readFileTool, searchTool } from '../src/tools/index.js';
import { runCommandTool } from '../src/tools/run-command.js';
import { ConfigError } from '../src/shared/errors.js';
import type { PolicyRules, ToolContext } from '../src/types.js';

let tmp: string;
let state: string;
let ws: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-config-')));
  state = path.join(tmp, 'state');
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  fs.mkdirSync(state, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeUser(cfg: unknown): void {
  fs.writeFileSync(userConfigPath(state), JSON.stringify(cfg));
}
function writeWorkspace(cfg: unknown): void {
  fs.mkdirSync(path.dirname(workspaceConfigPath(ws)), { recursive: true });
  fs.writeFileSync(workspaceConfigPath(ws), JSON.stringify(cfg));
}

describe('config loading and merging', () => {
  it('no files → empty rules, no prefs, no sources', () => {
    const c = loadConfig(state, ws);
    expect(c).toEqual({ rules: { protectedPaths: [], secretPatterns: [], envExcludePatterns: [], researchBlockedDomains: [], remoteBlockedHosts: [] }, sources: [] });
  });

  it('merges narrowing knobs as a union and records source hashes', () => {
    writeUser({ model: 'my-model', maxSteps: 7, protectedPaths: ['docs'], secretPatterns: ['Token'], envExcludePatterns: ['NPM_'] });
    writeWorkspace({ protectedPaths: ['generated'], secretPatterns: ['apikey'], envExcludePatterns: ['deploy'] });
    const c = loadConfig(state, ws);
    expect(c.model).toBe('my-model');
    expect(c.maxSteps).toBe(7);
    expect(c.rules.protectedPaths).toEqual(['docs', 'generated']);
    expect(c.rules.secretPatterns).toEqual(['token', 'apikey']); // lowercased
    expect(c.rules.envExcludePatterns).toEqual(['npm_', 'deploy']); // lowercased union
    expect(c.sources).toHaveLength(2);
    for (const s of c.sources) expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects unknown keys hard (no silent degradation)', () => {
    writeUser({ allowCommands: ['git status'] });
    expect(() => loadConfig(state, ws)).toThrow(ConfigError);
  });

  it('workspace config cannot carry preferences (no model/maxSteps keys)', () => {
    writeWorkspace({ model: 'attacker-chosen-model' });
    expect(() => loadConfig(state, ws)).toThrow(ConfigError);
  });

  it('user config accepts a provider preference; the workspace layer structurally cannot (Session 15)', () => {
    writeUser({ provider: 'deepseek' });
    expect(loadConfig(state, ws).provider).toBe('deepseek');
    writeUser({ provider: 'not-a-provider' });
    expect(() => loadConfig(state, ws)).toThrow(ConfigError); // enum, not free text
    writeUser({});
    writeWorkspace({ provider: 'deepseek' }); // a cloned repo must never choose the vendor
    expect(() => loadConfig(state, ws)).toThrow(ConfigError);
  });

  it('rejects invalid JSON and over-cap lists', () => {
    fs.writeFileSync(userConfigPath(state), '{oops');
    expect(() => loadConfig(state, ws)).toThrow(ConfigError);
    writeUser({ secretPatterns: Array.from({ length: 65 }, (_, i) => `p${i}`) });
    expect(() => loadConfig(state, ws)).toThrow(ConfigError);
  });
});

describe('narrowing effects on policy', () => {
  const rules = (r: Partial<PolicyRules>): PolicyRules => ({ protectedPaths: [], secretPatterns: [], envExcludePatterns: [], researchBlockedDomains: [], remoteBlockedHosts: [], ...r });

  it('an extra protectedPath denies writes beneath it', () => {
    const ctx: ToolContext = { workspaceRoot: ws, stateDir: state, rules: rules({ protectedPaths: ['generated'] }) };
    const d = decide(writeFileTool, { path: 'generated/out.txt', content: 'x' }, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'path.protected' });
    // The same write elsewhere still auto-allows.
    const ok = decide(writeFileTool, { path: 'src.txt', content: 'x' }, ctx, new Grants());
    expect(ok).toMatchObject({ decision: 'allow', rule: 'mutation.in-workspace' });
  });

  it('an extra secretPattern turns a read into a redacted ask', () => {
    const ctx: ToolContext = { workspaceRoot: ws, stateDir: state, rules: rules({ secretPatterns: ['internal'] }) };
    const d = decide(readFileTool, { path: 'notes-internal.txt' }, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'ask', rule: 'path.secret-name', redactOutput: true });
  });

  it('search skips files matching extra secret patterns', async () => {
    fs.writeFileSync(path.join(ws, 'apikey.txt'), 'MATCHME');
    fs.writeFileSync(path.join(ws, 'plain.txt'), 'MATCHME');
    const ctx: ToolContext = { workspaceRoot: ws, stateDir: state, rules: rules({ secretPatterns: ['apikey'] }) };
    const r = await searchTool.execute({ pattern: 'MATCHME' }, ctx);
    expect(r.output).toContain('plain.txt');
    expect(r.output).not.toContain('apikey.txt');
  });

  it('envExcludePatterns drops additional variables from command children (core floor stays)', async () => {
    process.env['FAKE_DEPLOY_HOOK'] = 'hookvalue';
    try {
      const ctx: ToolContext = { workspaceRoot: ws, stateDir: state, rules: rules({ envExcludePatterns: ['deploy'] }) };
      const cmd =
        process.platform === 'win32' ? 'echo "D=$env:FAKE_DEPLOY_HOOK;"' : 'echo "D=$FAKE_DEPLOY_HOOK;"';
      const r = await runCommandTool.execute({ command: cmd }, ctx);
      // The command running AT ALL proves the non-excludable floor survived (the shell needs it).
      expect(r.ok).toBe(true);
      expect(r.output).toContain('D=;');
      expect(r.output).not.toContain('hookvalue');
    } finally {
      delete process.env['FAKE_DEPLOY_HOOK'];
    }
  });

  it('the workspace config directory itself is write-protected from the agent', () => {
    const ctx: ToolContext = { workspaceRoot: ws, stateDir: state };
    const d = decide(writeFileTool, { path: '.agent-cli/config.json', content: '{}' }, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'path.protected' });
  });
});
