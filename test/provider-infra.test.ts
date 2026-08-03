import { describe, it, expect } from 'vitest';
import {
  CATALOG_VERIFIED,
  DEFAULT_MODEL,
  MODELS,
  PROVIDERS,
  PROVIDER_NAMES,
  capsFor,
  contextBudgetFor,
  providersOfModel,
} from '../src/provider/catalog.js';
import { COMPAT_PROFILES } from '../src/provider/profiles.js';
import { ProviderError, classifyHttpStatus, retryAfterMs, withRetry } from '../src/provider/errors.js';
import { sseEvents, SSE_DONE, type SseEvent } from '../src/provider/sse.js';
import { TOOLS } from '../src/tools/index.js';

// ── Catalog invariants ─────────────────────────────────────────────────────────────────────

describe('provider catalog invariants', () => {
  const allModels = PROVIDER_NAMES.flatMap((p) => MODELS[p].map((m) => ({ p, m })));

  it('has a verified date and a default model per provider that exists in its own catalog', () => {
    expect(CATALOG_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const p of PROVIDER_NAMES) {
      expect(MODELS[p].some((m) => m.id === PROVIDERS[p].defaultModel)).toBe(true);
    }
    expect(PROVIDERS.anthropic.defaultModel).toBe(DEFAULT_MODEL);
  });

  it('every model: sane budgets, defaults within caps, vision consistent with tool-result images', () => {
    for (const { p, m } of allModels) {
      expect(m.defaultMaxTokens, `${p}/${m.id} defaultMaxTokens`).toBeLessThanOrEqual(m.maxOutputTokens);
      // The working budget + one full output + headroom must fit the window.
      expect(m.budgetTokens + m.defaultMaxTokens + 16_000, `${p}/${m.id} budget fits window`).toBeLessThanOrEqual(
        m.contextTokens,
      );
      if (!m.visionInput) expect(m.toolResultImages, `${p}/${m.id}`).toBe('none');
      else expect(['native', 'rehomed']).toContain(m.toolResultImages);
      if (m.reasoning.mode === 'none') expect(m.reasoning.replay).toBe('none');
    }
  });

  it('never advertises retired/invite-only ids', () => {
    const banned = [
      'deepseek-chat',
      'deepseek-reasoner',
      'kimi-latest',
      'kimi-thinking-preview',
      'kimi-k2-0905-preview',
      'kimi-k2-turbo-preview',
      'kimi-k2-thinking',
      'glm-4.5-flash',
      'claude-mythos-5',
      'claude-mythos-preview',
    ];
    const ids = new Set(allModels.map(({ m }) => m.id));
    for (const b of banned) expect(ids.has(b), b).toBe(false);
  });

  it('capsFor: exact hit, permissive mock, conservative unknown', () => {
    expect(capsFor('anthropic', 'claude-opus-5').visionInput).toBe(true);
    expect(capsFor('mock', 'anything').toolResultImages).toBe('native'); // the offline test backbone
    const unknown = capsFor('deepseek', 'deepseek-v9-imaginary');
    expect(unknown.visionInput).toBe(false);
    expect(unknown.defaultMaxTokens).toBe(16_000);
    expect(unknown.notes?.[0]).toContain('not in the shipped catalog');
  });

  it('providersOfModel resolves cross-provider membership', () => {
    expect(providersOfModel('glm-5.2')).toEqual(['glm']);
    expect(providersOfModel('claude-opus-5')).toEqual(['anthropic']);
    expect(providersOfModel('no-such-model')).toEqual([]);
  });

  it('contextBudgetFor reproduces the pre-S15 defaults on 100k-budget models', () => {
    expect(contextBudgetFor('anthropic', 'claude-opus-5')).toEqual({ triggerChars: 400_000, targetChars: 200_000 });
    expect(contextBudgetFor('glm', 'glm-4.6v').triggerChars).toBeLessThan(400_000);
  });

  it('every session tool name satisfies the strictest provider naming rules (kimi regex, glm charset)', () => {
    // Registered file/shell tools plus every per-session tool the assembly attaches.
    const perSession = [
      'retrieve',
      'run_check',
      'preview',
      'browser_flow',
      'view_image',
      'recover',
      'review',
      'report_finding',
      'delegate_task',
      'update_plan',
      'apply_task_changes',
    ];
    const names = [...TOOLS.map((t) => t.name), ...perSession];
    for (const n of names) {
      expect(n, `kimi name rule: ${n}`).toMatch(/^[a-zA-Z_][a-zA-Z0-9-_]{2,63}$/);
      expect(n, `glm name rule: ${n}`).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });
});

// ── SSE parser ─────────────────────────────────────────────────────────────────────────────

async function* chunks(parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === 'string' ? new TextEncoder().encode(p) : p;
}

async function collect(parts: (string | Uint8Array)[]): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of sseEvents(chunks(parts))) out.push(ev);
  return out;
}

describe('shared SSE parser', () => {
  it('parses events split at hostile chunk boundaries, including mid-UTF-8', async () => {
    const bytes = new TextEncoder().encode('data: {"t":"héllo"}\n\n');
    // Split INSIDE the two-byte é sequence.
    const cut = 12;
    const evs = await collect([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(evs).toEqual([{ data: '{"t":"héllo"}' }]);
  });

  it('tolerates CRLF, skips comment keep-alives, joins multi-line data, captures event names', async () => {
    const evs = await collect([
      ': keep-alive\r\n',
      'event: response.output_text.delta\r\n',
      'data: line1\r\n',
      'data: line2\r\n',
      '\r\n',
      'data: {"x":1}\n\n',
    ]);
    expect(evs).toEqual([{ event: 'response.output_text.delta', data: 'line1\nline2' }, { data: '{"x":1}' }]);
  });

  it('yields the [DONE] sentinel and flushes a trailing event without a final newline', async () => {
    const evs = await collect(['data: a\n\ndata: [DONE]']);
    expect(evs).toEqual([{ data: 'a' }, { data: SSE_DONE }]);
  });
});

// ── Errors + retry ─────────────────────────────────────────────────────────────────────────

describe('provider errors and retry', () => {
  it('classifies HTTP statuses with 402 as balance, not auth', () => {
    expect(classifyHttpStatus(401)).toBe('auth');
    expect(classifyHttpStatus(402)).toBe('balance');
    expect(classifyHttpStatus(429)).toBe('rate-limit');
    expect(classifyHttpStatus(422)).toBe('bad-request');
    expect(classifyHttpStatus(503)).toBe('server');
  });

  it('retryAfterMs parses seconds and caps at 60s; garbage is undefined', () => {
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs('9999')).toBe(60_000);
    expect(retryAfterMs('not-a-date-or-number')).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });

  it('withRetry retries retryable kinds at most twice and never retries non-retryable ones', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const flaky = async (): Promise<string> => {
      calls++;
      if (calls < 3) throw new ProviderError({ kind: 'server', provider: 'test', message: 'boom', status: 500 });
      return 'ok';
    };
    await expect(withRetry(flaky, { sleep: async (ms) => void sleeps.push(ms) })).resolves.toBe('ok');
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);

    let authCalls = 0;
    const dead = async (): Promise<never> => {
      authCalls++;
      throw new ProviderError({ kind: 'auth', provider: 'test', message: 'bad key', status: 401 });
    };
    await expect(withRetry(dead, { sleep: async () => {} })).rejects.toMatchObject({ kind: 'auth' });
    expect(authCalls).toBe(1);
  });

  it('withRetry gives rate-limit errors the deeper default budget, but an explicit retries wins', async () => {
    // A 429 is EXPECTED to clear (Retry-After says when); on kimi Tier 0 (3 req/min) two
    // retries regularly turned a short throttle into a dead executor child (S16.5b review).
    let calls = 0;
    const throttled = async (): Promise<string> => {
      calls++;
      if (calls < 5) throw new ProviderError({ kind: 'rate-limit', provider: 'test', message: '429', status: 429 });
      return 'ok';
    };
    await expect(withRetry(throttled, { sleep: async () => {} })).resolves.toBe('ok');
    expect(calls).toBe(5); // first attempt + RATE_LIMIT_RETRIES

    // Explicit retries: 0 disables retry even for 429 — tests and callers stay in control.
    let strictCalls = 0;
    const strict = async (): Promise<never> => {
      strictCalls++;
      throw new ProviderError({ kind: 'rate-limit', provider: 'test', message: '429', status: 429 });
    };
    await expect(withRetry(strict, { retries: 0, sleep: async () => {} })).rejects.toMatchObject({ kind: 'rate-limit' });
    expect(strictCalls).toBe(1);
  });

  it('withRetry rethrows aborts immediately', async () => {
    let calls = 0;
    const aborting = async (): Promise<never> => {
      calls++;
      const e = new Error('request aborted');
      e.name = 'AbortError';
      throw e;
    };
    await expect(withRetry(aborting, { sleep: async () => {} })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });
});

// ── Compat profiles ────────────────────────────────────────────────────────────────────────

describe('compat profiles', () => {
  it('deepseek usage: cache miss IS the uncached input; reasoning tokens carried', () => {
    const u = COMPAT_PROFILES.deepseek.mapUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 20 },
    });
    expect(u).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 900, reasoningTokens: 20 });
  });

  it('kimi usage: cached_tokens subtracted from prompt_tokens', () => {
    const u = COMPAT_PROFILES.kimi.mapUsage({ prompt_tokens: 500, completion_tokens: 10, cached_tokens: 400 });
    expect(u).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 400 });
  });

  it('glm usage: prompt_tokens_details.cached_tokens subtracted; absent usage maps to zeros', () => {
    const u = COMPAT_PROFILES.glm.mapUsage({ prompt_tokens: 300, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 200 } });
    expect(u).toEqual({ inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 200 });
    expect(COMPAT_PROFILES.glm.mapUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 });
  });

  it('kimi errors classify by type string with the tier hint on rate limits', () => {
    const c = COMPAT_PROFILES.kimi.classifyError(429, { error: { type: 'exceeded_current_quota_error', message: 'quota' } });
    expect(c.kind).toBe('balance');
    const r = COMPAT_PROFILES.kimi.classifyError(429, { error: { type: 'rate_limit_reached_error', message: 'slow down' } });
    expect(r.kind).toBe('rate-limit');
    expect(r.hint).toContain('Tier');
  });

  it('glm errors classify by numeric-string code (1113 balance, 1211 stale-catalog hint, 1302 rate limit)', () => {
    expect(COMPAT_PROFILES.glm.classifyError(429, { error: { code: '1113', message: 'overdue' } }).kind).toBe('balance');
    const unknownModel = COMPAT_PROFILES.glm.classifyError(400, { error: { code: '1211', message: 'no model' } });
    expect(unknownModel.kind).toBe('bad-request');
    expect(unknownModel.hint).toContain('catalog may be stale');
    expect(COMPAT_PROFILES.glm.classifyError(429, { error: { code: '1302', message: 'concurrent' } }).kind).toBe('rate-limit');
  });

  it('deepseek 402 is balance with the prepaid hint; finishExtras route errors as typed throws', () => {
    const c = COMPAT_PROFILES.deepseek.classifyError(402, { error: { message: 'Insufficient Balance' } });
    expect(c.kind).toBe('balance');
    expect(c.hint).toContain('prepaid');
    expect(COMPAT_PROFILES.deepseek.finishExtras['insufficient_system_resource']).toMatchObject({ error: 'server', retryable: true });
    expect(COMPAT_PROFILES.glm.finishExtras['sensitive']).toEqual({ stop: 'refusal' });
    expect(COMPAT_PROFILES.glm.finishExtras['model_context_window_exceeded']).toMatchObject({ error: 'context-window' });
  });
});
