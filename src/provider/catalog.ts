/**
 * The provider/model capability catalog (Session 15) — pure DATA plus tiny lookups.
 *
 * Everything a harness decision can hinge on lives here as data, not as code branches:
 * context windows, output caps, vision support, how images inside tool_results can reach the
 * model, reasoning behavior and its replay requirement, and the harness's own working-context
 * budget. Only Anthropic and Kimi expose live capability metadata; OpenAI and DeepSeek list ids
 * only and GLM has no model-list endpoint at all — so this shipped table is the source the
 * harness can be HONEST about, and `CATALOG_VERIFIED` (rendered by every listing) says when it
 * was last checked against first-party documentation. The catalog is advisory: the wire answer
 * always outranks it, and an uncataloged model runs with conservative defaults plus a recorded
 * warning rather than a refusal — catalogs go stale before harnesses do.
 *
 * Deliberately ABSENT: deprecated/retired ids (deepseek-chat, deepseek-reasoner, kimi-k2-*
 * previews, kimi-latest, glm-4.5-flash…) — a harness must not advertise models that no longer
 * resolve; and claude-mythos-5, which is invite-only.
 */

export const CATALOG_VERIFIED = '2026-08-09';

/** Selectable real providers ('mock' is flag-only and never a config preference). */
export const PROVIDER_NAMES = ['anthropic', 'openai', 'deepseek', 'kimi', 'glm'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number] | 'mock';

export type ModelLifecycle = 'ga' | 'preview' | 'legacy' | 'deprecated';

export interface ModelCaps {
  id: string;
  display: string;
  lifecycle: ModelLifecycle;
  contextTokens: number;
  maxOutputTokens: number;
  /** What the harness requests as max_tokens by default (≤ maxOutputTokens; reasoning shares it). */
  defaultMaxTokens: number;
  visionInput: boolean;
  /**
   * How image parts inside tool_results reach the model: 'native' (Anthropic — images are legal
   * inside tool_result blocks), 'rehomed' (the adapter re-emits pixels as a follow-up user
   * message — OpenAI/Kimi/GLM-vision have string-only tool outputs), 'none' (no image input at
   * all — the pixels stay in the evidence store and the model gets an honest text pointer).
   */
  toolResultImages: 'native' | 'rehomed' | 'none';
  reasoning: {
    /** 'none' | 'off-by-default' | 'on-by-default' | 'forced' (cannot be disabled). */
    mode: 'none' | 'off-by-default' | 'on-by-default' | 'forced';
    /** Replay requirement for reasoning blocks: none / current tool loop only / entire history. */
    replay: 'none' | 'current-loop' | 'all';
  };
  /** Prompt-caching style, for listings: Anthropic uses explicit breakpoints; others automatic. */
  caching: 'explicit-breakpoints' | 'automatic' | 'none';
  /**
   * The harness's working-context cap in TOKENS — OUR cost/latency opinion, NOT the provider's
   * window. Drives elision (triggerChars = ×4 chars).
   *
   * Derivation rule (S20.5 — pinned by test/limits.test.ts, per model, not per class):
   *   budget × 1.25  +  40_000  +  defaultMaxTokens  ≤  contextTokens
   * The 1.25 covers the chars≈4×tokens heuristic's undercount on code (~3.3 chars/token is
   * common), the 40k covers what elision cannot see (system prompt + map + tool schemas +
   * memory/plan injections), and the output reservation is the provider-side share of the
   * window. On top of the fit rule, two clamps: a provider BILLING threshold when one exists
   * (gpt-5.6 bills the whole request at 2×in/1.5×out above 272K input — verified 2026-08-09),
   * and a latency/cost opinion on the 1M-window models (re-sending half a window per step is a
   * cost bug even at flat pricing). The old flat 100k — which merely reproduced the pre-S15
   * 400k/200k chars — sat at ~10% of the real window on flagships and, worse, OVERFLOWED the
   * 200k/128k-window models once the un-counted overhead was priced in.
   */
  budgetTokens: number;
  notes?: string[];
}

export interface ProviderInfo {
  name: ProviderName;
  display: string;
  protocol: 'anthropic-messages' | 'openai-responses' | 'openai-chat' | 'mock';
  /** Env var NAMES holding the credential (first present wins). Never values. */
  keyEnvs: string[];
  baseUrlEnv?: string;
  defaultBaseUrl?: string;
  /** Where a human obtains a key (rendered by listings/README; never fetched). */
  keyUrl?: string;
  defaultModel: string;
  /** Relative path of a bounded key-validation model list; absent = presence-only (glm, mock). */
  modelsPath?: string;
}

export const DEFAULT_MODEL = 'claude-opus-5';

const K = 1024;

export const PROVIDERS: Record<Exclude<ProviderName, 'mock'>, ProviderInfo> = {
  anthropic: {
    name: 'anthropic',
    display: 'Anthropic (Claude)',
    protocol: 'anthropic-messages',
    keyEnvs: ['ANTHROPIC_API_KEY'],
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    defaultBaseUrl: 'https://api.anthropic.com',
    keyUrl: 'https://platform.claude.com/settings/keys',
    defaultModel: DEFAULT_MODEL,
    modelsPath: '/v1/models',
  },
  openai: {
    name: 'openai',
    display: 'OpenAI',
    protocol: 'openai-responses',
    keyEnvs: ['OPENAI_API_KEY'],
    baseUrlEnv: 'OPENAI_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/settings/organization/api-keys',
    defaultModel: 'gpt-5.6-sol',
    modelsPath: '/models',
  },
  deepseek: {
    name: 'deepseek',
    display: 'DeepSeek',
    protocol: 'openai-chat',
    keyEnvs: ['DEEPSEEK_API_KEY'],
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    defaultBaseUrl: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    defaultModel: 'deepseek-v4-pro',
    modelsPath: '/models',
  },
  kimi: {
    name: 'kimi',
    display: 'Kimi (Moonshot AI)',
    protocol: 'openai-chat',
    keyEnvs: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    baseUrlEnv: 'MOONSHOT_BASE_URL',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    keyUrl: 'https://platform.kimi.ai/console/api-keys',
    defaultModel: 'kimi-k3',
    modelsPath: '/models',
  },
  glm: {
    name: 'glm',
    display: 'GLM (Z.AI / Zhipu)',
    protocol: 'openai-chat',
    keyEnvs: ['ZAI_API_KEY', 'ZHIPU_API_KEY'],
    baseUrlEnv: 'ZAI_BASE_URL',
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    keyUrl: 'https://z.ai (international) / https://open.bigmodel.cn (China)',
    defaultModel: 'glm-5.2',
    // No model-list endpoint exists on either GLM platform (verified 2026-07-29): key checks
    // are presence-only, and every switch surface says so.
  },
};

/** The model catalog, grouped per provider, in listing order. */
export const MODELS: Record<Exclude<ProviderName, 'mock'>, ModelCaps[]> = {
  anthropic: [
    {
      id: 'claude-opus-5',
      display: 'Claude Opus 5',
      lifecycle: 'ga',
      contextTokens: 1000 * K,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: true,
      toolResultImages: 'native',
      reasoning: { mode: 'on-by-default', replay: 'current-loop' },
      caching: 'explicit-breakpoints',
      budgetTokens: 250_000,
      notes: [
        'adaptive thinking on by default (round-tripped)',
        'refusal classifier possible',
        'separate rate bucket from Opus 4.x',
        'no long-context premium: flat pricing across the full 1M window (verified 2026-08-09)',
      ],
    },
    {
      id: 'claude-sonnet-5',
      display: 'Claude Sonnet 5',
      lifecycle: 'ga',
      contextTokens: 1000 * K,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: true,
      toolResultImages: 'native',
      reasoning: { mode: 'on-by-default', replay: 'current-loop' },
      caching: 'explicit-breakpoints',
      budgetTokens: 250_000,
      notes: ['intro pricing through 2026-08-31', 'new tokenizer (~30% more tokens than Sonnet 4.6)'],
    },
    {
      id: 'claude-fable-5',
      display: 'Claude Fable 5',
      lifecycle: 'ga',
      contextTokens: 1000 * K,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: true,
      toolResultImages: 'native',
      reasoning: { mode: 'forced', replay: 'current-loop' },
      caching: 'explicit-breakpoints',
      budgetTokens: 250_000,
      notes: [
        'thinking always on (cannot be disabled)',
        '2x Opus-5 price ($10/$50 per MTok); lower rate-limit bucket',
        'requires 30-day data retention (400 on zero-retention orgs)',
        'safety classifiers may refuse (stop reason: refusal)',
      ],
    },
    {
      id: 'claude-opus-4-8',
      display: 'Claude Opus 4.8',
      lifecycle: 'legacy',
      contextTokens: 1000 * K,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: true,
      toolResultImages: 'native',
      reasoning: { mode: 'off-by-default', replay: 'current-loop' },
      caching: 'explicit-breakpoints',
      budgetTokens: 250_000,
      notes: ['previous-generation Opus; thinking off unless enabled — the pre-v1.1 default'],
    },
    {
      id: 'claude-sonnet-4-6',
      display: 'Claude Sonnet 4.6',
      lifecycle: 'legacy',
      contextTokens: 1000 * K,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: true,
      toolResultImages: 'native',
      reasoning: { mode: 'off-by-default', replay: 'current-loop' },
      caching: 'explicit-breakpoints',
      budgetTokens: 250_000,
    },
    {
      id: 'claude-haiku-4-5',
      display: 'Claude Haiku 4.5',
      lifecycle: 'ga',
      contextTokens: 200 * K,
      maxOutputTokens: 64 * K,
      defaultMaxTokens: 32_000,
      visionInput: true,
      toolResultImages: 'native',
      reasoning: { mode: 'none', replay: 'none' },
      caching: 'explicit-breakpoints',
      budgetTokens: 100_000,
      notes: ['fast/cheap tier; 200K context'],
    },
  ],
  openai: [
    {
      id: 'gpt-5.6-sol',
      display: 'GPT-5.6 Sol',
      lifecycle: 'ga',
      contextTokens: 1_050_000,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: true,
      toolResultImages: 'rehomed',
      reasoning: { mode: 'on-by-default', replay: 'current-loop' },
      caching: 'automatic',
      budgetTokens: 180_000,
      notes: ['flagship (alias gpt-5.6)', 'input >272K tokens bills the WHOLE request 2x in / 1.5x out — the budget stays below it with chars/token slop (verified 2026-08-09)'],
    },
    {
      id: 'gpt-5.6-terra',
      display: 'GPT-5.6 Terra',
      lifecycle: 'ga',
      contextTokens: 1_050_000,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: true,
      toolResultImages: 'rehomed',
      reasoning: { mode: 'on-by-default', replay: 'current-loop' },
      caching: 'automatic',
      budgetTokens: 180_000,
      notes: ['mid-tier: balances intelligence and cost', 'same 272K long-context billing threshold as sol'],
    },
    {
      id: 'gpt-5.6-luna',
      display: 'GPT-5.6 Luna',
      lifecycle: 'ga',
      contextTokens: 1_050_000,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: true,
      toolResultImages: 'rehomed',
      reasoning: { mode: 'on-by-default', replay: 'current-loop' },
      caching: 'automatic',
      budgetTokens: 180_000,
      notes: ['cost-optimized high-volume tier', 'same 272K long-context billing threshold as sol'],
    },
  ],
  deepseek: [
    {
      id: 'deepseek-v4-pro',
      display: 'DeepSeek V4 Pro',
      lifecycle: 'preview',
      contextTokens: 1000 * K,
      maxOutputTokens: 384 * K,
      defaultMaxTokens: 64_000,
      visionInput: false,
      toolResultImages: 'none',
      reasoning: { mode: 'on-by-default', replay: 'current-loop' },
      caching: 'automatic',
      budgetTokens: 200_000,
      notes: ['no image input — screenshots degrade to recorded pointers', 'thinking on by default; reasoning echoed in tool loops', 'prepaid: 402 = balance'],
    },
    {
      id: 'deepseek-v4-flash',
      display: 'DeepSeek V4 Flash',
      lifecycle: 'preview',
      contextTokens: 1000 * K,
      maxOutputTokens: 384 * K,
      defaultMaxTokens: 64_000,
      visionInput: false,
      toolResultImages: 'none',
      reasoning: { mode: 'on-by-default', replay: 'current-loop' },
      caching: 'automatic',
      budgetTokens: 200_000,
      notes: ['fast/cheap tier ($0.14/$0.28 per MTok)', 'no image input'],
    },
  ],
  kimi: [
    {
      id: 'kimi-k3',
      display: 'Kimi K3',
      lifecycle: 'ga',
      contextTokens: 1_048_576,
      maxOutputTokens: 1_048_576,
      defaultMaxTokens: 64_000,
      visionInput: true,
      toolResultImages: 'rehomed',
      reasoning: { mode: 'forced', replay: 'all' },
      caching: 'automatic',
      budgetTokens: 150_000,
      notes: [
        'thinking always on; the COMPLETE assistant message (incl. reasoning) round-trips',
        'sampling params locked (never sent)',
        'images: base64 data URIs only',
        'agent loops need recharge Tier 1+ (Tier 0 is 3 requests/min)',
        'flat pricing across the 1M window; budget stays moderate because replay-all reasoning is un-elidable and grows the wire floor (verified 2026-08-09)',
      ],
    },
    {
      id: 'kimi-k2.7-code',
      display: 'Kimi K2.7 Code',
      lifecycle: 'ga',
      contextTokens: 256 * K,
      maxOutputTokens: 32_768,
      defaultMaxTokens: 32_768,
      visionInput: true,
      toolResultImages: 'rehomed',
      reasoning: { mode: 'forced', replay: 'all' },
      caching: 'automatic',
      budgetTokens: 100_000,
      notes: ['coding-dedicated; thinking cannot be disabled'],
    },
    {
      id: 'kimi-k2.7-code-highspeed',
      display: 'Kimi K2.7 Code Highspeed',
      lifecycle: 'ga',
      contextTokens: 256 * K,
      maxOutputTokens: 32_768,
      defaultMaxTokens: 32_768,
      visionInput: true,
      toolResultImages: 'rehomed',
      reasoning: { mode: 'forced', replay: 'all' },
      caching: 'automatic',
      budgetTokens: 100_000,
      notes: ['~180+ tok/s variant of k2.7-code'],
    },
    {
      id: 'kimi-k2.6',
      display: 'Kimi K2.6',
      lifecycle: 'ga',
      contextTokens: 256 * K,
      maxOutputTokens: 32_768,
      defaultMaxTokens: 32_768,
      visionInput: true,
      toolResultImages: 'rehomed',
      reasoning: { mode: 'on-by-default', replay: 'all' },
      caching: 'automatic',
      budgetTokens: 100_000,
    },
  ],
  glm: [
    {
      id: 'glm-5.2',
      display: 'GLM-5.2',
      lifecycle: 'ga',
      // 200K, not 1M: the 1M window belongs to the separate `glm-5.2[1m]` variant id — this base
      // id is what the harness selects, and claiming its sibling's window overflowed the budget
      // rule (verified 2026-08-09; the S20.5 catalog re-check found the overclaim).
      contextTokens: 200 * K,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: false,
      toolResultImages: 'none',
      reasoning: { mode: 'on-by-default', replay: 'none' },
      caching: 'automatic',
      budgetTokens: 75_000,
      notes: ['text flagship — NO image input (use glm-5v-turbo for vision)', 'server strips prior reasoning (no round-trip needed)', '1M context is the glm-5.2[1m] variant id, not this one'],
    },
    {
      id: 'glm-5.1',
      display: 'GLM-5.1',
      lifecycle: 'ga',
      contextTokens: 200 * K,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: false,
      toolResultImages: 'none',
      reasoning: { mode: 'on-by-default', replay: 'none' },
      caching: 'automatic',
      budgetTokens: 75_000,
    },
    {
      id: 'glm-5',
      display: 'GLM-5',
      lifecycle: 'ga',
      contextTokens: 200 * K,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: false,
      toolResultImages: 'none',
      reasoning: { mode: 'on-by-default', replay: 'none' },
      caching: 'automatic',
      budgetTokens: 75_000,
    },
    {
      id: 'glm-5-turbo',
      display: 'GLM-5 Turbo',
      lifecycle: 'ga',
      contextTokens: 200 * K,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: false,
      toolResultImages: 'none',
      reasoning: { mode: 'on-by-default', replay: 'none' },
      caching: 'automatic',
      budgetTokens: 75_000,
    },
    {
      id: 'glm-4.7',
      display: 'GLM-4.7',
      lifecycle: 'ga',
      contextTokens: 200 * K,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: false,
      toolResultImages: 'none',
      reasoning: { mode: 'forced', replay: 'none' },
      caching: 'automatic',
      budgetTokens: 75_000,
      notes: ['thinking cannot be disabled'],
    },
    {
      id: 'glm-4.7-flash',
      display: 'GLM-4.7 Flash',
      lifecycle: 'ga',
      contextTokens: 200 * K,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 32_000,
      visionInput: false,
      toolResultImages: 'none',
      reasoning: { mode: 'on-by-default', replay: 'none' },
      caching: 'automatic',
      budgetTokens: 60_000,
      notes: ['free tier'],
    },
    {
      id: 'glm-4.6',
      display: 'GLM-4.6',
      lifecycle: 'legacy',
      contextTokens: 200 * K,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 64_000,
      visionInput: false,
      toolResultImages: 'none',
      reasoning: { mode: 'on-by-default', replay: 'none' },
      caching: 'automatic',
      budgetTokens: 75_000,
    },
    {
      id: 'glm-4.5-air',
      display: 'GLM-4.5 Air',
      lifecycle: 'legacy',
      contextTokens: 128 * K,
      maxOutputTokens: 96 * K,
      defaultMaxTokens: 32_000,
      visionInput: false,
      toolResultImages: 'none',
      reasoning: { mode: 'on-by-default', replay: 'none' },
      caching: 'automatic',
      budgetTokens: 42_000,
    },
    {
      id: 'glm-5v-turbo',
      display: 'GLM-5V Turbo',
      lifecycle: 'ga',
      contextTokens: 200 * K,
      maxOutputTokens: 128 * K,
      defaultMaxTokens: 32_000,
      visionInput: true,
      toolResultImages: 'rehomed',
      reasoning: { mode: 'on-by-default', replay: 'none' },
      caching: 'automatic',
      budgetTokens: 100_000,
      notes: ['vision flagship'],
    },
    {
      id: 'glm-4.6v',
      display: 'GLM-4.6V',
      lifecycle: 'ga',
      contextTokens: 128 * K,
      maxOutputTokens: 32 * K,
      defaultMaxTokens: 16_000,
      visionInput: true,
      toolResultImages: 'rehomed',
      reasoning: { mode: 'on-by-default', replay: 'none' },
      caching: 'automatic',
      budgetTokens: 55_000,
    },
    {
      id: 'glm-4.6v-flash',
      display: 'GLM-4.6V Flash',
      lifecycle: 'ga',
      contextTokens: 128 * K,
      maxOutputTokens: 32 * K,
      defaultMaxTokens: 16_000,
      visionInput: true,
      toolResultImages: 'rehomed',
      reasoning: { mode: 'on-by-default', replay: 'none' },
      caching: 'automatic',
      budgetTokens: 55_000,
      notes: ['free vision tier'],
    },
  ],
};

/** Conservative fallback for models the catalog does not know (recorded as a warning upstream). */
export const UNKNOWN_MODEL_CAPS: Omit<ModelCaps, 'id' | 'display'> = {
  lifecycle: 'ga',
  contextTokens: 128 * K,
  maxOutputTokens: 16_384,
  defaultMaxTokens: 16_000,
  visionInput: false,
  toolResultImages: 'none',
  // If reasoning blocks appear, replaying them within the loop is the safe direction.
  reasoning: { mode: 'on-by-default', replay: 'current-loop' },
  caching: 'none',
  budgetTokens: 24_000,
  notes: ['not in the shipped catalog — conservative defaults in effect'],
};

/** The mock provider is the offline test backbone: fully capable by construction. */
const MOCK_CAPS: Omit<ModelCaps, 'id' | 'display'> = {
  lifecycle: 'ga',
  contextTokens: 200 * K,
  maxOutputTokens: 64 * K,
  defaultMaxTokens: 16_000,
  visionInput: true,
  toolResultImages: 'native',
  reasoning: { mode: 'on-by-default', replay: 'current-loop' },
  caching: 'none',
  budgetTokens: 100_000,
};

export function providerInfo(name: ProviderName): ProviderInfo | undefined {
  return name === 'mock' ? undefined : PROVIDERS[name];
}

export function modelsFor(name: ProviderName): ModelCaps[] {
  return name === 'mock' ? [] : MODELS[name];
}

/** Exact catalog hit, mock permissive default, or conservative unknown-model defaults. */
export function capsFor(provider: ProviderName, model: string): ModelCaps {
  if (provider === 'mock') return { id: model, display: model, ...MOCK_CAPS };
  const hit = MODELS[provider].find((m) => m.id === model);
  if (hit) return hit;
  return { id: model, display: model, ...UNKNOWN_MODEL_CAPS };
}

/** True when the id exists in SOME provider's catalog (used to refuse cross-provider picks). */
export function providersOfModel(model: string): Exclude<ProviderName, 'mock'>[] {
  return PROVIDER_NAMES.filter((p) => MODELS[p].some((m) => m.id === model));
}

export function defaultMaxTokensFor(provider: ProviderName, model: string): number {
  return capsFor(provider, model).defaultMaxTokens;
}

/**
 * The elision budget for a model — plain numbers, structurally compatible with ElisionOptions
 * (provider/ must not import runtime/). ×4 is the chars≈tokens heuristic elision documents; the
 * per-model budgets follow the derivation rule on `budgetTokens` (window fit + billing clamps +
 * a latency opinion on 1M windows), pinned in test/limits.test.ts (S20.5).
 */
export function contextBudgetFor(provider: ProviderName, model: string): { triggerChars: number; targetChars: number } {
  const budget = capsFor(provider, model).budgetTokens;
  const triggerChars = budget * 4;
  return { triggerChars, targetChars: Math.floor(triggerChars / 2) };
}
