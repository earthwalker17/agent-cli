/**
 * The research pack's domain model and its hard bounds.
 *
 * Everything here is provider-agnostic: `ResearchClient` is the seam the tools depend on, and
 * `tavily.ts` is one implementation of it. Nothing in this module imports from the kernel
 * (`tools`/`runtime`/`policy`/`repl`) — the dependency arrow points one way, exactly as it does
 * for `src/artifacts` (constitution: workflow packs stay outside the kernel).
 *
 * The numbers below are the single source of truth for every bound the policy fact declares, the
 * approval prompt shows, and the session budget enforces. They are pinned by `test/limits.test.ts`
 * so a quiet edit cannot widen the capability.
 */

// ── Per-call bounds ────────────────────────────────────────────────────────────

/** Results one search may return. Tavily accepts up to 20; we ask for less and pay for less. */
export const MAX_RESULTS_PER_SEARCH = 10;
export const DEFAULT_RESULTS_PER_SEARCH = 5;
/** URLs one extract may name. Tavily accepts 20; a smaller batch keeps a failure cheap and legible. */
export const MAX_URLS_PER_EXTRACT = 5;
/** Total snippet characters admitted from one search, across all results. */
export const MAX_SEARCH_CONTENT_CHARS = 12_000;
/** Characters admitted from ONE extracted page. Pages are the context-heavy path. */
export const MAX_EXTRACT_CHARS_PER_PAGE = 24_000;
/** Total characters admitted from one extract call, across all pages. */
export const MAX_EXTRACT_CHARS_PER_CALL = 60_000;
export const SEARCH_TIMEOUT_MS = 20_000;
/**
 * Tavily's own effective server-side ceiling is 10s basic / 30s advanced, so 30s is the honest
 * bound rather than padding. It was 45s until the live S19 run showed why the difference matters:
 * a researcher's wall clock is finite, and a per-call timeout larger than the provider's own is
 * time the child can only ever lose.
 */
export const EXTRACT_TIMEOUT_MS = 30_000;
/**
 * Full-page reads ONE research task may make (Session 19, from the live run).
 *
 * The session cap alone was not enough: in the live proof a single researcher spent 10 of the 12
 * session extracts, hit its wall clock, and TIMED OUT having recorded nothing — so the whole task
 * was lost and the next one started with the allowance nearly gone. A per-task cap bounds both
 * failures at once, and it is the bound that matches the actual advice ("extract sparingly"):
 * four pages is a lot of reading for one bounded question.
 */
export const EXTRACTS_PER_RESEARCH_TASK = 4;

// ── Per-session budget ─────────────────────────────────────────────────────────

/**
 * Session-wide ceilings, shared by the parent's tool instance and every researcher child's (the
 * `checkCaps` precedent — ONE live object, not a per-instance copy). Rebuilt from events on
 * resume so a restarted session cannot silently refill its budget.
 */
export const SEARCHES_PER_SESSION = 24;
export const EXTRACTS_PER_SESSION = 12;
/** Provider credits: search basic = 1, advanced = 2; extract = ceil(urls/5) × depth multiplier. */
export const CREDITS_PER_SESSION = 80;
/** Total external content characters admitted into ANY context this session (parent + children). */
export const CONTENT_CHARS_PER_SESSION = 800_000;

// ── Domain model ───────────────────────────────────────────────────────────────

export type SearchDepth = 'basic' | 'advanced';

export interface SearchRequest {
  query: string;
  maxResults: number;
  depth: SearchDepth;
  /** Narrow to these registrable domains. Model-supplied; validated before it reaches the wire. */
  includeDomains?: readonly string[];
  /** The union of the model's own exclusions and the operator's config denylist. */
  excludeDomains?: readonly string[];
  /** Recency filter, when the question is time-sensitive. */
  timeRange?: 'day' | 'week' | 'month' | 'year';
  topic?: 'general' | 'news';
}

/** One retrieved source. Every string is already sanitized and delimiter-neutralized. */
export interface SourceResult {
  title: string;
  url: string;
  /** The URL's hostname, carried separately so a reader can see the origin without parsing. */
  host: string;
  /** Provider relevance, 0..1. Provider narration about its own ranking — not a truth signal. */
  score: number;
  snippet: string;
  /** Present only for news-topic results; the provider does not supply it otherwise. */
  publishedDate?: string;
}

export interface SearchOutcome {
  query: string;
  results: SourceResult[];
  /**
   * The provider's own synthesized answer, when requested. It is the provider's NARRATION over
   * the same sources — never treated as a source, and never rendered without its fence.
   */
  answer?: string;
  credits: number;
  responseTimeMs: number;
  requestId?: string;
  /**
   * Results the pack refused to admit (unparseable URL, unsupported scheme, private host). Named
   * rather than silently dropped: a reader must be able to tell "nothing matched" from
   * "something matched and we would not show it".
   */
  refused: RefusedUrl[];
  /** Snippet characters dropped to stay inside MAX_SEARCH_CONTENT_CHARS. */
  droppedChars: number;
}

export interface ExtractRequest {
  urls: readonly string[];
  depth: SearchDepth;
}

export interface ExtractedPage {
  url: string;
  host: string;
  /** Sanitized, delimiter-neutralized page text, bounded per page. */
  content: string;
  chars: number;
  truncated: boolean;
}

export interface ExtractOutcome {
  pages: ExtractedPage[];
  /** URLs the PROVIDER could not retrieve (paywall, robots, 404, timeout) — its error verbatim. */
  failed: { url: string; error: string }[];
  /** URLs the PACK refused before the wire. */
  refused: RefusedUrl[];
  credits: number;
  responseTimeMs: number;
  requestId?: string;
  droppedChars: number;
}

export interface RefusedUrl {
  /** The raw input, sanitized for display. A refused URL is never echoed unescaped. */
  url: string;
  reason: string;
}

/**
 * The seam the tools depend on. One implementation today (`tavily.ts`); the tools never import it
 * directly, so a second provider or a test double drops in without touching the kernel.
 */
export interface ResearchClient {
  /** The single host this client contacts. Shown in every approval prompt and every event. */
  readonly host: string;
  /** Human-readable, credential-redacted transport description (proxy or direct). */
  describeTransport(): string;
  search(req: SearchRequest, opts?: { signal?: AbortSignal }): Promise<SearchOutcome>;
  extract(req: ExtractRequest, opts?: { signal?: AbortSignal }): Promise<ExtractOutcome>;
}
