import type { Provider } from '../types.js';
import { ConfigError } from '../shared/errors.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatProvider } from './openai-compat.js';
import { OpenAiResponsesProvider } from './openai-responses.js';
import { COMPAT_PROFILES } from './profiles.js';
import { PROVIDERS, PROVIDER_NAMES, type ProviderInfo, type ProviderName } from './catalog.js';

/**
 * The ONE provider construction/discovery seam (Session 15). Key discovery is env-only —
 * availability reports the env var NAME and presence, never a value; a key can never arrive via
 * argv or config. Injectable env/fetch make every flow hermetically testable.
 */

export type RealProviderName = Exclude<ProviderName, 'mock'>;

export interface ProviderAvailability {
  name: RealProviderName;
  info: ProviderInfo;
  /** The FIRST present key env var name; undefined when none is set. */
  keyEnv?: string;
  present: boolean;
  /** Effective base URL (env override or the built-in default). */
  baseUrl: string;
  baseUrlOverridden: boolean;
}

export interface KeyValidation {
  /** models-list = probed a live list; presence-only = no list endpoint exists (glm);
   *  unverified-network = the probe failed non-definitively and the switch may proceed. */
  verification: 'models-list' | 'presence-only' | 'unverified-network';
  /** False ONLY on a definitive credential rejection (401/403). */
  ok: boolean;
  /** Live model ids when the probe returned them. */
  modelIds?: string[];
  detail: string;
}

export interface ProviderRegistry {
  names(): RealProviderName[];
  availability(name: RealProviderName): ProviderAvailability;
  /** Throws ConfigError (env var name + key URL, never a value) when the credential is absent. */
  create(name: RealProviderName): Provider;
  /** Bounded key-validation probe (~8s). Never throws; the outcome is data. */
  validateKey(name: RealProviderName, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<KeyValidation>;
}

/** CLI aliases accepted for provider names (BLUEPRINT names Kimi and GLM; vendors differ). */
export function resolveProviderName(raw: string): RealProviderName | 'mock' | undefined {
  const name = raw.trim().toLowerCase();
  if (name === 'mock') return 'mock';
  const aliases: Record<string, RealProviderName> = { moonshot: 'kimi', zhipu: 'glm', zai: 'glm', 'z.ai': 'glm' };
  if ((PROVIDER_NAMES as readonly string[]).includes(name)) return name as RealProviderName;
  return aliases[name];
}

export interface RegistryOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch for hermetic tests of validateKey. */
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export function createProviderRegistry(opts: RegistryOptions = {}): ProviderRegistry {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? ((input: string | URL, init?: RequestInit) => globalThis.fetch(input as never, init as never));

  const availability = (name: RealProviderName): ProviderAvailability => {
    const info = PROVIDERS[name];
    const keyEnv = info.keyEnvs.find((k) => (env[k] ?? '').trim() !== '');
    const override = info.baseUrlEnv !== undefined ? (env[info.baseUrlEnv] ?? '').trim() : '';
    return {
      name,
      info,
      ...(keyEnv !== undefined ? { keyEnv } : {}),
      present: keyEnv !== undefined,
      baseUrl: override !== '' ? override.replace(/\/+$/, '') : (info.defaultBaseUrl ?? ''),
      baseUrlOverridden: override !== '',
    };
  };

  const keyOf = (a: ProviderAvailability): string => {
    if (a.keyEnv === undefined) {
      throw new ConfigError(
        `provider '${a.name}' needs a credential: set ${a.info.keyEnvs.join(' or ')} in your environment` +
          (a.info.keyUrl !== undefined ? ` (get a key: ${a.info.keyUrl})` : ''),
      );
    }
    return (env[a.keyEnv] ?? '').trim();
  };

  return {
    names: () => [...PROVIDER_NAMES],
    availability,
    create(name) {
      const a = availability(name);
      const apiKey = keyOf(a);
      switch (name) {
        case 'anthropic':
          // The SDK reads ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL from env itself; the presence
          // check above just turns a mid-turn SDK failure into an upfront, actionable refusal.
          return new AnthropicProvider();
        case 'openai':
          return new OpenAiResponsesProvider({ apiKey, baseUrl: a.baseUrl });
        case 'deepseek':
        case 'kimi':
        case 'glm':
          return new OpenAiCompatProvider({ profile: COMPAT_PROFILES[name], apiKey, baseUrl: a.baseUrl });
      }
    },
    async validateKey(name, vOpts = {}) {
      const a = availability(name);
      if (!a.present) return { verification: 'presence-only', ok: false, detail: `no key: set ${a.info.keyEnvs.join(' or ')}` };
      if (a.info.modelsPath === undefined) {
        return {
          verification: 'presence-only',
          ok: true,
          detail: `${a.keyEnv} present (no model-list endpoint on this platform — verified at first use)`,
        };
      }
      const timeoutMs = vOpts.timeoutMs ?? 8_000;
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = vOpts.signal !== undefined ? AbortSignal.any([vOpts.signal, timeout]) : timeout;
      // Anthropic authenticates model listing with x-api-key + anthropic-version; the rest are Bearer.
      const headers: Record<string, string> =
        name === 'anthropic'
          ? { 'x-api-key': keyOf(a), 'anthropic-version': '2023-06-01' }
          : { authorization: `Bearer ${keyOf(a)}` };
      const url = `${a.baseUrl}${a.info.modelsPath}`;
      try {
        const res = await fetchImpl(url, { method: 'GET', headers, signal });
        if (res.status === 401 || res.status === 403) {
          return { verification: 'models-list', ok: false, detail: `${a.keyEnv} present but REJECTED (HTTP ${res.status})` };
        }
        if (!res.ok) {
          return {
            verification: 'unverified-network',
            ok: true,
            detail: `model-list probe answered HTTP ${res.status} — key not verified, proceeding`,
          };
        }
        const body = (await res.json()) as { data?: { id?: string }[] };
        const ids = Array.isArray(body.data) ? body.data.map((m) => m.id).filter((id): id is string => typeof id === 'string') : [];
        return { verification: 'models-list', ok: true, modelIds: ids, detail: `${a.keyEnv} verified via models list (${ids.length} model(s) visible)` };
      } catch {
        return {
          verification: 'unverified-network',
          ok: true,
          detail: 'model-list probe failed (network) — key not verified, proceeding',
        };
      }
    },
  };
}
