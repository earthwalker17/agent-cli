/**
 * Wire profiles for the Chat-Completions-compatible adapter (Session 15): DeepSeek, Kimi
 * (Moonshot), GLM (Z.AI/Zhipu). "OpenAI-compatible" is a family resemblance, not an identity —
 * every deviation that matters to the harness lives HERE as visible per-provider data (param
 * names, usage-field extraction, extra finish_reason values, error envelopes), so the adapter
 * has one code path and zero provider name-checks. Base URLs / env names / key URLs stay in
 * catalog.ts (PROVIDERS) — one source, no drift.
 *
 * Facts verified against first-party docs 2026-07-29 (see catalog.CATALOG_VERIFIED).
 */

import type { StopReason, Usage } from '../types.js';
import { classifyHttpStatus, type ProviderErrorKind } from './errors.js';

export interface ErrorClassification {
  kind: ProviderErrorKind;
  code?: string;
  message?: string;
  /** Actionable, provider-specific guidance rendered with the error (never marketing). */
  hint?: string;
}

export type FinishExtra =
  | { stop: StopReason }
  | { error: ProviderErrorKind; retryable?: boolean; message: string };

export interface CompatProfile {
  provider: 'deepseek' | 'kimi' | 'glm';
  /** Param name for the output cap: kimi documents max_completion_tokens as current. */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  /** stream_options:{include_usage:true} — GLM does not document stream_options; its usage
   *  arrives on the final chunk automatically, so the field is never sent there. */
  sendIncludeUsage: boolean;
  /** Kimi defaults tools to strict:true (schema-enforced) — zod-derived draft-7 schemas are not
   *  strict-compatible, so the adapter sends an explicit strict:false there; others omit it. */
  explicitToolStrictFalse: boolean;
  /** Echo assistant reasoning_content back on tool-looping assistant messages (deepseek/kimi
   *  REQUIRE it; GLM's clear_thinking default strips server-side — never sent). */
  echoReasoningContent: boolean;
  /** finish_reason values beyond stop/tool_calls/length/content_filter. An `error` entry throws
   *  a typed ProviderError instead of fabricating a model turn. */
  finishExtras: Record<string, FinishExtra>;
  /** Extract harness Usage from the provider's raw usage object (absent → zeros). */
  mapUsage(raw: Record<string, unknown> | undefined): Usage;
  /** Refine the HTTP base classification with the provider's error envelope. */
  classifyError(status: number, body: unknown): ErrorClassification;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The shared { error: {...} } envelope reader (shapes differ per provider; all nest under error). */
function errorBody(body: unknown): Record<string, unknown> | undefined {
  return rec(rec(body)?.['error']);
}

export const DEEPSEEK_PROFILE: CompatProfile = {
  provider: 'deepseek',
  maxTokensParam: 'max_tokens',
  sendIncludeUsage: true,
  explicitToolStrictFalse: false, // strict tools are a /beta-base feature; never sent here
  echoReasoningContent: true, // REQUIRED: tool-looping assistant messages must carry it back
  finishExtras: {
    insufficient_system_resource: {
      error: 'server',
      retryable: true,
      message: 'inference aborted for capacity (insufficient_system_resource)',
    },
  },
  mapUsage(raw) {
    const miss = num(raw?.['prompt_cache_miss_tokens']);
    const hit = num(raw?.['prompt_cache_hit_tokens']);
    const prompt = num(raw?.['prompt_tokens']);
    const reasoning = num(rec(raw?.['completion_tokens_details'])?.['reasoning_tokens']);
    return {
      // prompt_cache_miss_tokens IS the uncached input; fall back to prompt − hit.
      inputTokens: miss > 0 || hit > 0 ? miss : Math.max(0, prompt - hit),
      outputTokens: num(raw?.['completion_tokens']),
      cacheReadInputTokens: hit,
      ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    };
  },
  classifyError(status, body) {
    const e = errorBody(body);
    const kind = classifyHttpStatus(status);
    const base: ErrorClassification = { kind, ...(str(e?.['message']) !== undefined ? { message: str(e?.['message'])! } : {}) };
    if (status === 402) {
      return { ...base, kind: 'balance', hint: 'DeepSeek is prepaid — top up at platform.deepseek.com' };
    }
    return base;
  },
};

export const KIMI_PROFILE: CompatProfile = {
  provider: 'kimi',
  maxTokensParam: 'max_completion_tokens',
  sendIncludeUsage: true,
  explicitToolStrictFalse: true, // kimi tools default to strict:true — zod draft-7 schemas would trip it
  echoReasoningContent: true, // REQUIRED: pass the complete assistant message back as-is
  finishExtras: {},
  mapUsage(raw) {
    const cached = num(raw?.['cached_tokens'] ?? rec(raw?.['prompt_tokens_details'])?.['cached_tokens']);
    const prompt = num(raw?.['prompt_tokens']);
    return {
      inputTokens: Math.max(0, prompt - cached),
      outputTokens: num(raw?.['completion_tokens']),
      cacheReadInputTokens: cached,
    };
  },
  classifyError(status, body) {
    const e = errorBody(body);
    const type = str(e?.['type']);
    const message = str(e?.['message']);
    const byType: Record<string, ProviderErrorKind> = {
      invalid_authentication_error: 'auth',
      incorrect_api_key_error: 'auth',
      permission_denied_error: 'auth',
      exceeded_current_quota_error: 'balance',
      rate_limit_reached_error: 'rate-limit',
      engine_overloaded_error: 'rate-limit',
      resource_not_found_error: 'bad-request',
      content_filter: 'bad-request',
      invalid_request_error: 'bad-request',
      server_error: 'server',
    };
    const kind = (type !== undefined ? byType[type] : undefined) ?? classifyHttpStatus(status);
    return {
      kind,
      ...(type !== undefined ? { code: type } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(kind === 'rate-limit'
        ? { hint: 'Kimi limits are recharge-tier based — agent loops need Tier 1+ ($10 cumulative recharge); Tier 0 allows 3 requests/min' }
        : {}),
    };
  },
};

export const GLM_PROFILE: CompatProfile = {
  provider: 'glm',
  maxTokensParam: 'max_tokens',
  sendIncludeUsage: false, // stream_options is undocumented on GLM; usage rides the final chunk
  explicitToolStrictFalse: false,
  echoReasoningContent: false, // clear_thinking (default true) strips prior reasoning server-side
  finishExtras: {
    sensitive: { stop: 'refusal' },
    network_error: { error: 'server', retryable: true, message: 'inference failed mid-stream (finish_reason network_error)' },
    model_context_window_exceeded: {
      error: 'context-window',
      message: 'input exceeded the model context window (finish_reason model_context_window_exceeded)',
    },
  },
  mapUsage(raw) {
    const cached = num(rec(raw?.['prompt_tokens_details'])?.['cached_tokens']);
    const prompt = num(raw?.['prompt_tokens']);
    return {
      inputTokens: Math.max(0, prompt - cached),
      outputTokens: num(raw?.['completion_tokens']),
      cacheReadInputTokens: cached,
    };
  },
  classifyError(status, body) {
    const e = errorBody(body);
    const code = str(e?.['code']);
    const message = str(e?.['message']);
    const n = code !== undefined ? Number(code) : NaN;
    let kind: ProviderErrorKind | undefined;
    if (Number.isFinite(n)) {
      if (n >= 1000 && n <= 1005) kind = 'auth';
      else if (n === 1113) kind = 'balance';
      else if (n === 1301) kind = 'bad-request';
      else if (n === 1302 || n === 1305 || (n >= 1308 && n <= 1321)) kind = 'rate-limit';
      else if (n === 1210 || n === 1211 || n === 1212 || n === 1214) kind = 'bad-request';
      else if (n === 1200) kind = 'server';
    }
    return {
      kind: kind ?? classifyHttpStatus(status),
      ...(code !== undefined ? { code } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(code === '1211' ? { hint: 'the model id does not exist on this platform — the shipped catalog may be stale, or this id is China/international-platform specific' } : {}),
    };
  },
};

export const COMPAT_PROFILES = {
  deepseek: DEEPSEEK_PROFILE,
  kimi: KIMI_PROFILE,
  glm: GLM_PROFILE,
} as const;
