import { ProxyAgent, type Dispatcher } from 'undici';

/**
 * Reusable network transport. Detects standard system proxy settings (HTTPS_PROXY, HTTP_PROXY,
 * ALL_PROXY, NO_PROXY, in either case) and routes outbound requests through a proxy when one
 * applies, otherwise leaves direct connections untouched. Designed to be shared by any provider —
 * it is deliberately not coupled to the Anthropic client.
 *
 * Principles: no global side effects (per-request undici dispatcher, never `setGlobalDispatcher`);
 * explicit configuration overrides the environment; proxy credentials are redacted from any
 * description; and nothing here is ever persisted.
 */

export type ProxySource = 'explicit' | 'https_proxy' | 'http_proxy' | 'all_proxy' | 'none';

export interface ProxyResolution {
  /** The proxy URL to use, or null for a direct connection. */
  proxyUrl: string | null;
  source: ProxySource;
  /** A proxy was configured but a NO_PROXY rule matched this target, so we go direct. */
  bypassed: boolean;
}

function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name.toUpperCase()] ?? env[name.toLowerCase()];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/** Redact userinfo (`user:pass@`) from a proxy URL for safe logging. Never throws. */
export function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString();
  } catch {
    // Fall back to a regex redaction if the URL doesn't parse.
    return url.replace(/\/\/[^/@]+@/, '//***@');
  }
}

/**
 * Does `host` (optionally `host:port`) match a NO_PROXY entry? Supports `*` (all), exact host,
 * and domain-suffix (`example.com` or `.example.com` both match `api.example.com`), plus an
 * optional `:port` qualifier on the entry.
 */
function noProxyMatches(host: string, port: string, entry: string): boolean {
  const e = entry.trim().toLowerCase();
  if (e === '') return false;
  if (e === '*') return true;

  let pattern = e;
  if (pattern.includes(':')) {
    const [h, p] = pattern.split(':');
    if (p && p !== port) return false;
    pattern = h ?? '';
  }
  const bare = pattern.replace(/^\./, '');
  return host === bare || host.endsWith('.' + bare);
}

function isBypassed(targetHost: string, targetPort: string, env: NodeJS.ProcessEnv): boolean {
  const noProxy = envVar(env, 'NO_PROXY');
  if (!noProxy) return false;
  return noProxy.split(',').some((e) => noProxyMatches(targetHost, targetPort, e));
}

/**
 * Resolve which proxy (if any) to use for a target URL. Precedence: an explicit override wins;
 * otherwise the protocol-specific variable (HTTPS_PROXY for https, HTTP_PROXY for http) beats
 * ALL_PROXY; and NO_PROXY overrides an environment-derived proxy (but not an explicit override,
 * which the developer asked for directly).
 */
export function resolveProxy(
  targetUrl: string,
  env: NodeJS.ProcessEnv,
  explicit?: string | false,
): ProxyResolution {
  if (explicit === false) return { proxyUrl: null, source: 'explicit', bypassed: false };
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return { proxyUrl: explicit.trim(), source: 'explicit', bypassed: false };
  }

  let host: string;
  let port: string;
  let isHttps: boolean;
  try {
    const u = new URL(targetUrl);
    host = u.hostname.toLowerCase();
    isHttps = u.protocol === 'https:';
    port = u.port || (isHttps ? '443' : '80');
  } catch {
    return { proxyUrl: null, source: 'none', bypassed: false };
  }

  const specific = isHttps ? envVar(env, 'HTTPS_PROXY') : envVar(env, 'HTTP_PROXY');
  const all = envVar(env, 'ALL_PROXY');
  const source: ProxySource = specific ? (isHttps ? 'https_proxy' : 'http_proxy') : all ? 'all_proxy' : 'none';
  const candidate = specific ?? all;

  if (!candidate) return { proxyUrl: null, source: 'none', bypassed: false };
  if (isBypassed(host, port, env)) return { proxyUrl: null, source, bypassed: true };
  return { proxyUrl: candidate, source, bypassed: false };
}

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface Transport {
  /** A fetch implementation to hand to a client, or undefined when a plain direct fetch suffices. */
  fetch?: FetchImpl;
  /** Human-readable, credential-redacted description of the transport for logging. */
  describe(): string;
}

export interface TransportOptions {
  /** Force a proxy URL, or `false` to force direct. Omit to auto-detect from the environment. */
  proxy?: string | false;
  env?: NodeJS.ProcessEnv;
  /** Base fetch to wrap (defaults to the global fetch). Injected in tests. */
  baseFetch?: FetchImpl;
  /**
   * Representative https URL for `describe()` (Session 15): the label should name the provider
   * host it actually applies to, not a hardcoded one. Routing always resolves per request URL.
   */
  describeUrl?: string;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** True when any proxy configuration exists that could apply to some request. */
function anyProxyConfigured(opts: TransportOptions, env: NodeJS.ProcessEnv): boolean {
  if (opts.proxy === false) return false;
  if (typeof opts.proxy === 'string' && opts.proxy.trim() !== '') return true;
  return Boolean(envVar(env, 'HTTPS_PROXY') || envVar(env, 'HTTP_PROXY') || envVar(env, 'ALL_PROXY'));
}

/**
 * Build a transport. When no proxy could ever apply, `fetch` is undefined so the client uses its
 * own default (a normal direct connection). Otherwise `fetch` resolves the proxy PER request URL
 * — so NO_PROXY is honored correctly for any host — and attaches an undici ProxyAgent dispatcher
 * for that request only. ProxyAgent instances are cached per proxy URL.
 */
export function createTransport(opts: TransportOptions = {}): Transport {
  const env = opts.env ?? process.env;
  const baseFetch: FetchImpl = opts.baseFetch ?? ((input, init) => globalThis.fetch(input as never, init as never));

  const describeUrl = opts.describeUrl ?? 'https://api.anthropic.com';

  if (!anyProxyConfigured(opts, env)) {
    return { describe: () => 'direct (no proxy configured)' };
  }

  const agents = new Map<string, ProxyAgent>();
  const fetchImpl: FetchImpl = (input, init) => {
    const res = resolveProxy(urlOf(input), env, opts.proxy);
    if (!res.proxyUrl) return baseFetch(input, init);
    let agent = agents.get(res.proxyUrl);
    if (!agent) {
      agent = new ProxyAgent(res.proxyUrl);
      agents.set(res.proxyUrl, agent);
    }
    // `dispatcher` is an undici extension to RequestInit (the global fetch IS undici).
    return baseFetch(input, { ...init, dispatcher: agent } as RequestInit & { dispatcher: Dispatcher });
  };

  return {
    fetch: fetchImpl,
    describe: () => {
      // Describe against a representative https target so the source label is meaningful.
      const r = resolveProxy(describeUrl, env, opts.proxy);
      if (r.proxyUrl) return `proxy ${redactProxyUrl(r.proxyUrl)} (via ${r.source})`;
      return r.bypassed ? `direct (NO_PROXY bypass, ${r.source} otherwise)` : 'direct (no proxy configured)';
    },
  };
}
