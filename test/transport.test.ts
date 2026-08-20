import { describe, it, expect, vi } from 'vitest';
import { resolveProxy, redactProxyUrl, createTransport, type Transport } from '../src/net/transport.js';
import { AnthropicProvider } from '../src/provider/anthropic.js';
import { DEFAULT_MODEL } from '../src/provider/catalog.js';

const A = 'https://api.anthropic.com/v1/messages';

describe('resolveProxy: direct vs proxied', () => {
  it('is direct when no proxy is configured', () => {
    expect(resolveProxy(A, {})).toEqual({ proxyUrl: null, source: 'none', bypassed: false });
  });
  it('uses HTTPS_PROXY for an https target', () => {
    const r = resolveProxy(A, { HTTPS_PROXY: 'http://127.0.0.1:7897' });
    expect(r).toMatchObject({ proxyUrl: 'http://127.0.0.1:7897', source: 'https_proxy', bypassed: false });
  });
  it('uses HTTP_PROXY for an http target', () => {
    const r = resolveProxy('http://example.com/x', { HTTP_PROXY: 'http://p:8080' });
    expect(r).toMatchObject({ proxyUrl: 'http://p:8080', source: 'http_proxy' });
  });
  it('honors lowercase env vars', () => {
    expect(resolveProxy(A, { https_proxy: 'http://low:1' }).proxyUrl).toBe('http://low:1');
  });
  it('falls back to ALL_PROXY when no protocol-specific var is set', () => {
    const r = resolveProxy(A, { ALL_PROXY: 'socks5://a:1' });
    expect(r).toMatchObject({ proxyUrl: 'socks5://a:1', source: 'all_proxy' });
  });
});

describe('resolveProxy: precedence', () => {
  it('protocol-specific beats ALL_PROXY', () => {
    const r = resolveProxy(A, { HTTPS_PROXY: 'http://specific:1', ALL_PROXY: 'http://all:2' });
    expect(r.proxyUrl).toBe('http://specific:1');
  });
  it('explicit override beats the environment', () => {
    const r = resolveProxy(A, { HTTPS_PROXY: 'http://env:1' }, 'http://explicit:9');
    expect(r).toMatchObject({ proxyUrl: 'http://explicit:9', source: 'explicit' });
  });
  it('explicit false forces direct even with an env proxy', () => {
    expect(resolveProxy(A, { HTTPS_PROXY: 'http://env:1' }, false).proxyUrl).toBeNull();
  });
});

describe('resolveProxy: NO_PROXY bypass', () => {
  it('bypasses an exact host match', () => {
    const r = resolveProxy('https://localhost:8443/x', { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'localhost,127.0.0.1' });
    expect(r).toMatchObject({ proxyUrl: null, bypassed: true });
  });
  it('bypasses a domain-suffix match', () => {
    const r = resolveProxy('https://api.internal.example.com/x', { HTTPS_PROXY: 'http://p:1', NO_PROXY: '.example.com' });
    expect(r.bypassed).toBe(true);
  });
  it('bypasses everything with *', () => {
    expect(resolveProxy(A, { HTTPS_PROXY: 'http://p:1', NO_PROXY: '*' }).bypassed).toBe(true);
  });
  it('respects a host:port qualifier', () => {
    expect(resolveProxy('https://h:8443/x', { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'h:9000' }).bypassed).toBe(false);
    expect(resolveProxy('https://h:8443/x', { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'h:8443' }).bypassed).toBe(true);
  });
  it('an explicit override ignores NO_PROXY (developer asked for it)', () => {
    const r = resolveProxy('https://localhost/x', { NO_PROXY: 'localhost' }, 'http://explicit:1');
    expect(r.proxyUrl).toBe('http://explicit:1');
  });
  it('returns none for an unparseable target', () => {
    expect(resolveProxy('not a url', { HTTPS_PROXY: 'http://p:1' }).proxyUrl).toBeNull();
  });
});

describe('redactProxyUrl', () => {
  it('strips credentials', () => {
    expect(redactProxyUrl('http://user:secret@proxy:8080')).not.toContain('secret');
    expect(redactProxyUrl('http://user:secret@proxy:8080')).toContain('***');
  });
  it('leaves a credential-free url intact', () => {
    expect(redactProxyUrl('http://127.0.0.1:7897/')).toBe('http://127.0.0.1:7897/');
  });
  it('never throws on a malformed url', () => {
    expect(() => redactProxyUrl('%%%not a url%%%')).not.toThrow();
  });
});

describe('createTransport', () => {
  it('returns no custom fetch (direct) when nothing is configured', () => {
    const t = createTransport({ env: {} });
    expect(t.fetch).toBeUndefined();
    expect(t.describe()).toMatch(/direct/);
  });

  it('describes a configured proxy with credentials redacted', () => {
    const t = createTransport({ env: { HTTPS_PROXY: 'http://user:pw@127.0.0.1:7897' } });
    expect(t.fetch).toBeDefined();
    expect(t.describe()).toContain('***');
    expect(t.describe()).not.toContain('pw');
    expect(t.describe()).toContain('https_proxy');
  });

  it('attaches a dispatcher only for proxied requests, not NO_PROXY ones', async () => {
    const calls: { url: string; hasDispatcher: boolean }[] = [];
    const baseFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, hasDispatcher: Boolean((init as { dispatcher?: unknown } | undefined)?.dispatcher) });
      return new Response('ok');
    };
    const t = createTransport({ env: { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1' }, baseFetch });
    await t.fetch!('https://api.anthropic.com/v1/x');
    await t.fetch!('https://localhost:9/y');
    expect(calls[0]).toMatchObject({ hasDispatcher: true });
    expect(calls[1]).toMatchObject({ hasDispatcher: false });
  });

  it('forces direct when proxy:false even if the env has a proxy', () => {
    expect(createTransport({ proxy: false, env: { HTTPS_PROXY: 'http://p:1' } }).fetch).toBeUndefined();
  });
});

describe('AnthropicProvider transport integration', () => {
  it('routes requests through the transport fetch and exposes a redacted description', async () => {
    const spy = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'test' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const transport: Transport = {
      fetch: spy,
      describe: () => 'proxy http://***@127.0.0.1:7897 (via https_proxy)',
    };
    // Synthetic key fixture — never a live credential.
    const p = new AnthropicProvider({ apiKey: 'sk-test-not-real', transport });
    expect(p.transport).toContain('proxy');
    expect(p.transport).toContain('***');

    await expect(
      p.complete({ model: DEFAULT_MODEL, system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 16 }),
    ).rejects.toBeDefined();

    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]![0])).toContain('anthropic.com');
  });
});
