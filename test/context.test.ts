import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MODEL, buildRunContext, makeProvider, parseCountFlag, resolveModel, resolveProvider } from '../src/cli/context.js';
import { createProviderRegistry, resolveProviderName } from '../src/provider/registry.js';
import { ConfigError } from '../src/shared/errors.js';
import type { CliValues } from '../src/cli/context.js';

/**
 * Session 15: the provider construction seam had ZERO tests before the registry rewrite.
 * These pin: name resolution precedence + aliases, env-only key discovery (names, never
 * values), model precedence with cross-provider rules, and the catalog-driven budgets that
 * replaced the `name === 'anthropic' ? 64_000 : 16_000` branch.
 */

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-ctx-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveProvider / resolveProviderName', () => {
  it('precedence: flag > config > anthropic; aliases resolve; unknown refuses with the valid list', () => {
    expect(resolveProvider({ provider: 'deepseek' }, { provider: 'glm' })).toBe('deepseek');
    expect(resolveProvider({}, { provider: 'glm' })).toBe('glm');
    expect(resolveProvider({}, {})).toBe('anthropic');
    expect(resolveProviderName('moonshot')).toBe('kimi');
    expect(resolveProviderName('zhipu')).toBe('glm');
    expect(resolveProviderName('ZAI')).toBe('glm');
    expect(() => resolveProvider({ provider: 'grok' }, {})).toThrow(/valid: anthropic, openai, deepseek, kimi, glm, mock/);
  });

  it('mock is flag-only — a config file cannot select it', () => {
    expect(() => resolveProvider({}, { provider: 'mock' })).toThrow(ConfigError);
    expect(resolveProvider({ provider: 'mock' }, {})).toBe('mock');
  });
});

describe('registry key discovery (env-only)', () => {
  it('a missing key refuses with the env var NAME and key URL — never a value', () => {
    const registry = createProviderRegistry({ env: {} });
    try {
      registry.create('deepseek');
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('DEEPSEEK_API_KEY');
      expect(msg).toContain('platform.deepseek.com');
    }
  });

  it('the first present key env wins; aliases are honored; availability reports names only', () => {
    const registry = createProviderRegistry({ env: { KIMI_API_KEY: 'sk-secret-value' } });
    const a = registry.availability('kimi');
    expect(a).toMatchObject({ present: true, keyEnv: 'KIMI_API_KEY' });
    expect(JSON.stringify(a)).not.toContain('sk-secret-value');
    expect(registry.create('kimi').name).toBe('kimi');
  });

  it('base-URL env overrides are honored and flagged', () => {
    const registry = createProviderRegistry({
      env: { ZAI_API_KEY: 'k', ZAI_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4/' },
    });
    const a = registry.availability('glm');
    expect(a.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(a.baseUrlOverridden).toBe(true);
  });

  it('validateKey: 200 list verifies, 401 rejects definitively, network failure proceeds unverified, glm is presence-only', async () => {
    const okFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] }), { status: 200 });
    const okReg = createProviderRegistry({ env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl: okFetch });
    const ok = await okReg.validateKey('deepseek');
    expect(ok).toMatchObject({ verification: 'models-list', ok: true });
    expect(ok.modelIds).toContain('deepseek-v4-pro');

    const badReg = createProviderRegistry({
      env: { OPENAI_API_KEY: 'k' },
      fetchImpl: async () => new Response('{}', { status: 401 }),
    });
    expect(await badReg.validateKey('openai')).toMatchObject({ verification: 'models-list', ok: false });

    const downReg = createProviderRegistry({
      env: { MOONSHOT_API_KEY: 'k' },
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await downReg.validateKey('kimi')).toMatchObject({ verification: 'unverified-network', ok: true });

    const glmReg = createProviderRegistry({ env: { ZAI_API_KEY: 'k' }, fetchImpl: okFetch });
    expect(await glmReg.validateKey('glm')).toMatchObject({ verification: 'presence-only', ok: true });
  });
});

describe('resolveModel', () => {
  it('an explicit --model naming another provider REFUSES; config model is skipped with a note', () => {
    expect(() => resolveModel('deepseek', { model: 'claude-opus-5' })).toThrow(/--provider anthropic/);
    const viaConfig = resolveModel('deepseek', {}, { model: 'claude-opus-5' });
    expect(viaConfig.model).toBe('deepseek-v4-pro');
    expect(viaConfig.notes[0]).toContain("belongs to provider 'anthropic'");
  });

  it('unknown-to-all ids proceed with a conservative-defaults note; defaults come from the catalog', () => {
    const unknown = resolveModel('glm', { model: 'glm-9-imaginary' });
    expect(unknown.model).toBe('glm-9-imaginary');
    expect(unknown.notes[0]).toContain('conservative defaults');
    expect(resolveModel('anthropic', {}).model).toBe(DEFAULT_MODEL);
    expect(resolveModel('kimi', {}).model).toBe('kimi-k3');
    expect(resolveModel('openai', {}).model).toBe('gpt-5.6-sol');
  });
});

describe('buildRunContext (catalog-driven budgets)', () => {
  function mockValues(extra: Partial<CliValues> = {}): CliValues {
    const script = path.join(tmp, 'script.json');
    fs.writeFileSync(script, '[]');
    return { C: tmp, provider: 'mock', script, ...extra };
  }

  it('mock: 16k output cap and the standard 400k/200k elision budget; default model is the anthropic default id', () => {
    const ctx = buildRunContext(mockValues());
    expect(ctx.maxTokens).toBe(16_000);
    expect(ctx.contextBudget).toEqual({ triggerChars: 400_000, targetChars: 200_000 });
    expect(ctx.model).toBe(DEFAULT_MODEL);
    expect(ctx.notes).toEqual([]);
  });

  it('maxSteps precedence: flag > config > 20; non-numeric refuses loudly', () => {
    expect(buildRunContext(mockValues({ 'max-steps': '7' })).maxSteps).toBe(7);
    expect(buildRunContext(mockValues(), { config: { maxSteps: 11 } }).maxSteps).toBe(11);
    expect(buildRunContext(mockValues()).maxSteps).toBe(20);
    expect(() => buildRunContext(mockValues({ 'max-steps': 'lots' }))).toThrow(/positive integer/);
    expect(() => parseCountFlag('max-steps', '-3')).toThrow(/positive integer/);
  });

  it('makeProvider: mock still requires --script', () => {
    expect(() => makeProvider({ provider: 'mock' })).toThrow(/--script/);
  });

  it('a real provider resolves budgets from its catalog entry (kimi-k2.6: 32k out, 240k trigger)', () => {
    const registry = createProviderRegistry({ env: { MOONSHOT_API_KEY: 'k' } });
    const ctx = buildRunContext({ C: tmp, provider: 'kimi', model: 'kimi-k2.6' }, { registry });
    expect(ctx.provider.name).toBe('kimi');
    expect(ctx.maxTokens).toBe(32_768);
    expect(ctx.contextBudget).toEqual({ triggerChars: 240_000, targetChars: 120_000 });
  });
});
