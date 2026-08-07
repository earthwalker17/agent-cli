import { z } from 'zod';
import { createTransport } from '../net/transport.js';
import { sanitizeLine } from '../shared/text.js';
import { ResearchError, type ResearchErrorReason } from './errors.js';
import { domainMatches, refusal, sanitizeBlock, validateSourceUrl } from './sanitize.js';
import {
  MAX_EXTRACT_CHARS_PER_CALL,
  MAX_EXTRACT_CHARS_PER_PAGE,
  MAX_SEARCH_CONTENT_CHARS,
  type ExtractOutcome,
  type ExtractRequest,
  type RefusedUrl,
  type ResearchClient,
  type SearchDepth,
  type SearchOutcome,
  type SearchRequest,
  type SourceResult,
} from './types.js';

/**
 * The Tavily search/extract client — the ONLY code in this harness that opens a connection for
 * research, and it opens exactly one: `api.tavily.com`. Page retrieval happens on the provider's
 * infrastructure, not here, which is why this pack owns no redirect policy, no response size
 * limiter and no SSRF guard: it never fetches a model-named URL itself.
 *
 * That claim is scoped deliberately. It is "the research tools' egress is one host", NOT "the
 * harness's egress is one host" — `npm view`/`npm ping` sit on the auto-run command allowlist and
 * the sandbox does not confine network. Overstating it would be the exact overclaim the
 * constitution's fifth principle forbids.
 *
 * Every response string is sanitized and delimiter-neutralized HERE, at the one place bytes enter
 * the process, before any caller can render or store them.
 *
 * Credentials are env-only (`provider/registry.ts` discipline): the key is read by name, held in
 * this closure, sent only as an `Authorization` header, and never placed in an error message, an
 * event, a log line or a prompt.
 */

export const TAVILY_HOST = 'api.tavily.com';
export const TAVILY_BASE_URL = `https://${TAVILY_HOST}`;
/** Env var NAMES holding the credential (first present wins). Never values. */
export const TAVILY_KEY_ENVS = ['TAVILY_API_KEY'] as const;
export const TAVILY_KEY_URL = 'https://app.tavily.com';
/** One bounded retry for transient failures, always inside the call's own timeout. */
const MAX_ATTEMPTS = 2;
const MAX_RETRY_DELAY_MS = 4_000;

// ── Credential discovery (names and presence only — never a value) ─────────────

export interface KeyAvailability {
  present: boolean;
  /** The FIRST present env var name; undefined when none is set. */
  keyEnv?: string;
}

export function tavilyKeyAvailability(env: NodeJS.ProcessEnv = process.env): KeyAvailability {
  const keyEnv = TAVILY_KEY_ENVS.find((k) => (env[k] ?? '').trim() !== '');
  return keyEnv !== undefined ? { present: true, keyEnv } : { present: false };
}

/** The sentence shown whenever research is unavailable. Names the cure; never guesses. */
export function noKeyMessage(): string {
  return (
    `web research needs a credential: set ${TAVILY_KEY_ENVS.join(' or ')} in your environment ` +
    `(get a key: ${TAVILY_KEY_URL}). Research is unavailable until then — no other capability is affected.`
  );
}

// ── Cost estimation (pure; the budget and the approval prompt read these) ───────

/** Tavily: basic search = 1 credit, advanced = 2. */
export function estimateSearchCredits(depth: SearchDepth): number {
  return depth === 'advanced' ? 2 : 1;
}

/**
 * Tavily: extract is billed per 5 successful URLs, doubled at advanced depth. Rounding for a
 * partial batch is NOT documented, so this assumes the pessimistic ceiling — a budget that
 * under-charges itself is a budget that silently overspends.
 */
export function estimateExtractCredits(urlCount: number, depth: SearchDepth): number {
  return Math.ceil(Math.max(0, urlCount) / 5) * (depth === 'advanced' ? 2 : 1);
}

// ── Wire schemas ───────────────────────────────────────────────────────────────
// Conditional fields are OMITTED by Tavily rather than nulled, but both SDKs disagree with the
// HTTP reference on nullability in places, so every optional field accepts null too. Unknown keys
// are stripped by default: a new provider field must never fail an otherwise-good response.

const SearchResultWire = z.object({
  title: z.string().nullish(),
  url: z.string(),
  content: z.string().nullish(),
  score: z.number().nullish(),
  published_date: z.string().nullish(),
});

const SearchResponseWire = z.object({
  query: z.string().nullish(),
  answer: z.string().nullish(),
  results: z.array(SearchResultWire).nullish(),
  response_time: z.number().nullish(),
  request_id: z.string().nullish(),
  usage: z.object({ credits: z.number().nullish() }).nullish(),
});

const ExtractResponseWire = z.object({
  results: z
    .array(z.object({ url: z.string(), raw_content: z.string().nullish() }))
    .nullish(),
  failed_results: z.array(z.object({ url: z.string(), error: z.string().nullish() })).nullish(),
  response_time: z.number().nullish(),
  request_id: z.string().nullish(),
  usage: z.object({ credits: z.number().nullish() }).nullish(),
});

/** Tavily's uniform error envelope: `{"detail": {"error": "<message>"}}`. */
const ErrorWire = z.object({
  detail: z.union([z.string(), z.object({ error: z.string().nullish() })]).nullish(),
});

// ── Client ─────────────────────────────────────────────────────────────────────

type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TavilyClientOptions {
  /** The credential. Read by the CALLER from the environment; never read from config or argv. */
  apiKey: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch for hermetic tests (overrides the proxy transport). */
  fetchImpl?: FetchImpl;
  /**
   * The operator's configured domain denylist. Applied to the request (as `exclude_domains`) AND
   * re-checked on every returned result: provider-side exclusion is best-effort, and a narrowing
   * rule the operator set must not depend on a third party honoring it.
   */
  blockedDomains?: readonly string[];
  searchTimeoutMs?: number;
  extractTimeoutMs?: number;
}

export function createTavilyClient(opts: TavilyClientOptions): ResearchClient {
  const baseUrl = (opts.baseUrl ?? TAVILY_BASE_URL).replace(/\/+$/, '');
  const transport = createTransport({ ...(opts.env !== undefined ? { env: opts.env } : {}), describeUrl: baseUrl });
  const doFetch: FetchImpl =
    opts.fetchImpl ?? ((input, init) => (transport.fetch ?? (globalThis.fetch as FetchImpl))(input as never, init as never));
  const blocked = (opts.blockedDomains ?? []).filter((d) => d.trim() !== '');
  const host = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return TAVILY_HOST;
    }
  })();

  const post = async (path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> => {
    let lastError: ResearchError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // A caller abort and a self-imposed timeout both surface as AbortError, so the timeout
      // controller is tracked separately — otherwise a research timeout would be reported as a
      // user cancellation and the user would be told they stopped something they did not.
      const timer = new AbortController();
      const to = setTimeout(() => timer.abort(), timeoutMs);
      let timedOut = false;
      timer.signal.addEventListener('abort', () => {
        timedOut = true;
      });
      try {
        const res = await doFetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: signal !== undefined ? AbortSignal.any([signal, timer.signal]) : timer.signal,
        });
        if (res.ok) return await parseJson(res);
        lastError = await errorFromResponse(res);
      } catch (e) {
        if (timedOut) throw new ResearchError(`research request exceeded its ${timeoutMs} ms bound`, 'timeout');
        if (signal?.aborted === true) throw new ResearchError('research request was cancelled', 'aborted');
        // An already-typed failure keeps its reason. Without this, a malformed-response thrown by
        // parseJson would be relabeled 'network' — and 'network' is retryable, so a gateway
        // serving an HTML error page would be retried as if it were a transient blip.
        if (e instanceof ResearchError) throw e;
        lastError = new ResearchError(`could not reach ${host}: ${(e as Error).message}`, 'network');
      } finally {
        clearTimeout(to);
      }
      if (!lastError.retryable || attempt === MAX_ATTEMPTS) throw lastError;
      const delay = Math.min(lastError.detail?.retryAfterMs ?? 500 * attempt, MAX_RETRY_DELAY_MS);
      await sleep(delay, signal);
    }
    /* istanbul ignore next — the loop always returns or throws */
    throw lastError ?? new ResearchError('research request failed', 'network');
  };

  return {
    host,
    describeTransport: () => transport.describe(),

    async search(req: SearchRequest, o = {}): Promise<SearchOutcome> {
      const started = Date.now();
      const exclude = [...new Set([...(req.excludeDomains ?? []), ...blocked])];
      const raw = await post(
        '/search',
        {
          query: req.query,
          search_depth: req.depth,
          topic: req.topic ?? 'general',
          max_results: req.maxResults,
          include_answer: 'basic',
          include_raw_content: false,
          include_images: false,
          include_usage: true,
          ...(req.includeDomains !== undefined && req.includeDomains.length > 0 ? { include_domains: req.includeDomains } : {}),
          ...(exclude.length > 0 ? { exclude_domains: exclude } : {}),
          ...(req.timeRange !== undefined ? { time_range: req.timeRange } : {}),
        },
        opts.searchTimeoutMs ?? 20_000,
        o.signal,
      );

      const parsed = SearchResponseWire.safeParse(raw);
      if (!parsed.success) {
        throw new ResearchError(`${host} returned an unexpected search response shape`, 'malformed-response');
      }
      const body = parsed.data;

      const results: SourceResult[] = [];
      const refused: RefusedUrl[] = [];
      let used = 0;
      let droppedChars = 0;
      for (const r of body.results ?? []) {
        const v = validateSourceUrl(r.url);
        if (!v.ok) {
          refused.push(refusal(r.url, v.reason));
          continue;
        }
        const hit = blocked.find((d) => domainMatches(v.host, d));
        if (hit !== undefined) {
          refused.push(refusal(r.url, `host is on the configured research denylist ('${sanitizeLine(hit)}')`));
          continue;
        }
        const snippetFull = sanitizeBlock(r.content ?? '');
        const room = Math.max(0, MAX_SEARCH_CONTENT_CHARS - used);
        const snippet = snippetFull.length <= room ? snippetFull : snippetFull.slice(0, room);
        droppedChars += snippetFull.length - snippet.length;
        used += snippet.length;
        const published = typeof r.published_date === 'string' ? sanitizeLine(r.published_date).slice(0, 40) : undefined;
        results.push({
          title: sanitizeLine(r.title ?? '(untitled)').slice(0, 300),
          url: v.url,
          host: v.idn ? `${v.host} [IDN/punycode — verify this is the domain you expect]` : v.host,
          score: clampScore(r.score),
          snippet,
          ...(published !== undefined && published !== '' ? { publishedDate: published } : {}),
        });
      }

      const answer = typeof body.answer === 'string' && body.answer.trim() !== '' ? sanitizeBlock(body.answer).slice(0, 2_000) : undefined;
      return {
        query: req.query,
        results,
        ...(answer !== undefined ? { answer } : {}),
        credits: reportedCredits(body.usage?.credits) ?? estimateSearchCredits(req.depth),
        responseTimeMs: Date.now() - started,
        ...(typeof body.request_id === 'string' ? { requestId: sanitizeLine(body.request_id).slice(0, 80) } : {}),
        refused,
        droppedChars,
      };
    },

    async extract(req: ExtractRequest, o = {}): Promise<ExtractOutcome> {
      const started = Date.now();
      // Validate BEFORE the wire: a refused URL costs nothing and its reason is precise.
      const admitted: { url: string; host: string; idn: boolean }[] = [];
      const refused: RefusedUrl[] = [];
      for (const u of req.urls) {
        const v = validateSourceUrl(u);
        if (!v.ok) {
          refused.push(refusal(u, v.reason));
          continue;
        }
        const hit = blocked.find((d) => domainMatches(v.host, d));
        if (hit !== undefined) {
          refused.push(refusal(u, `host is on the configured research denylist ('${sanitizeLine(hit)}')`));
          continue;
        }
        if (!admitted.some((a) => a.url === v.url)) admitted.push({ url: v.url, host: v.host, idn: v.idn });
      }
      if (admitted.length === 0) {
        return { pages: [], failed: [], refused, credits: 0, responseTimeMs: Date.now() - started, droppedChars: 0 };
      }

      const raw = await post(
        '/extract',
        { urls: admitted.map((a) => a.url), extract_depth: req.depth, format: 'markdown', include_images: false, include_usage: true },
        opts.extractTimeoutMs ?? 45_000,
        o.signal,
      );
      const parsed = ExtractResponseWire.safeParse(raw);
      if (!parsed.success) {
        throw new ResearchError(`${host} returned an unexpected extract response shape`, 'malformed-response');
      }
      const body = parsed.data;

      const pages: ExtractOutcome['pages'] = [];
      let used = 0;
      let droppedChars = 0;
      for (const r of body.results ?? []) {
        const match = admitted.find((a) => a.url === r.url) ?? { url: r.url, host: '', idn: false };
        const full = sanitizeBlock(r.raw_content ?? '');
        const room = Math.min(MAX_EXTRACT_CHARS_PER_PAGE, Math.max(0, MAX_EXTRACT_CHARS_PER_CALL - used));
        const content = full.length <= room ? full : full.slice(0, room);
        droppedChars += full.length - content.length;
        used += content.length;
        pages.push({
          url: match.url,
          host: match.host !== '' ? match.host : sanitizeLine(r.url),
          content,
          chars: content.length,
          truncated: content.length < full.length,
        });
      }
      const failed = (body.failed_results ?? []).map((f) => ({
        url: sanitizeLine(f.url).slice(0, 300),
        error: sanitizeLine(f.error ?? 'extraction failed').slice(0, 300),
      }));

      return {
        pages,
        failed,
        refused,
        credits: reportedCredits(body.usage?.credits) ?? estimateExtractCredits(admitted.length, req.depth),
        responseTimeMs: Date.now() - started,
        ...(typeof body.request_id === 'string' ? { requestId: sanitizeLine(body.request_id).slice(0, 80) } : {}),
        droppedChars,
      };
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function clampScore(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Trust a provider-reported credit count only when it is a sane non-negative number. */
function reportedCredits(n: number | null | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ResearchError('research provider returned a body that is not JSON', 'malformed-response');
  }
}

/**
 * Backoff that WAKES on cancellation rather than sleeping through it: a /cancel during a retry
 * delay must end the call now, not after the delay expires.
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const cancelled = (): boolean => signal !== undefined && signal.aborted;
  const stop = (): never => {
    throw new ResearchError('research request was cancelled', 'aborted');
  };
  if (cancelled()) stop();
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
  if (cancelled()) stop();
}

/**
 * Map an HTTP status to a typed reason. 432 and 433 are Tavily-specific and TERMINAL — a generic
 * "retry 4xx that isn't 429" heuristic would hammer a plan ceiling that cannot move.
 */
export function classifyResearchStatus(status: number): ResearchErrorReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 432 || status === 433) return 'plan-limit';
  if (status >= 500) return 'server';
  return 'bad-request';
}

async function errorFromResponse(res: Response): Promise<ResearchError> {
  const reason = classifyResearchStatus(res.status);
  let detail = '';
  try {
    const parsed = ErrorWire.safeParse(await res.json());
    if (parsed.success) {
      const d = parsed.data.detail;
      detail = typeof d === 'string' ? d : (d?.error ?? '');
    }
  } catch {
    /* a non-JSON error body is normal for gateways; the status still classifies it */
  }
  const suffix = detail.trim() !== '' ? `: ${sanitizeLine(detail).slice(0, 300)}` : '';
  const message =
    reason === 'auth'
      ? `research provider rejected the credential (HTTP ${res.status})${suffix} — check ${TAVILY_KEY_ENVS.join(' / ')}`
      : reason === 'plan-limit'
        ? `research provider account limit reached (HTTP ${res.status})${suffix} — this will not succeed on retry`
        : `research provider returned HTTP ${res.status}${suffix}`;
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  return new ResearchError(message, reason, retryAfterMs !== undefined ? { status: res.status, retryAfterMs } : { status: res.status });
}

/** `retry-after` in seconds, capped so a hostile or absurd value cannot stall the call. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const secs = Number(header.trim());
  if (!Number.isFinite(secs) || secs < 0) return undefined;
  return Math.min(secs * 1000, MAX_RETRY_DELAY_MS);
}
