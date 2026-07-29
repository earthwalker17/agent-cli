import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../store/event-log.js';
import { MockProvider, parseScript } from '../provider/mock.js';
import { autoDenyApprover, dangerousApprover, createInteractiveApprover } from '../runtime/approvals.js';
import { ConfigError } from '../shared/errors.js';
import {
  DEFAULT_MODEL,
  PROVIDERS,
  contextBudgetFor,
  defaultMaxTokensFor,
  providersOfModel,
  type ProviderName,
} from '../provider/catalog.js';
import { createProviderRegistry, resolveProviderName, type ProviderRegistry } from '../provider/registry.js';
import type { ProjectLayout } from '../store/layout.js';
import type { Approver, Provider, SessionMode } from '../types.js';

export { DEFAULT_MODEL };

/** The parsed CLI values shared across commands (kept in one place; index.ts owns parsing). */
export interface CliValues {
  C?: string;
  provider?: string;
  script?: string;
  model?: string;
  'no-input'?: boolean;
  interactive?: boolean;
  'max-steps'?: string;
  'max-turns'?: string;
  'dangerously-allow-all'?: boolean;
  'trust-this-workspace'?: boolean;
  revoke?: boolean;
  list?: boolean;
  session?: string;
  budget?: string;
  json?: boolean;
  all?: boolean;
  continue?: boolean;
  'include-delivery'?: boolean;
  help?: boolean;
  version?: boolean;
  m?: string;
  yes?: boolean;
  'no-trailer'?: boolean;
}

/** A count-valued CLI flag must be a positive integer; anything else refuses loudly (never NaN). */
export function parseCountFlag(flag: string, raw: string): number {
  if (!/^[0-9]+$/.test(raw.trim()) || Number(raw) < 1) {
    throw new Error(`--${flag} requires a positive integer (got '${raw}')`);
  }
  return Number(raw);
}

export function workspaceRoot(values: CliValues): string {
  const dir = values.C ? path.resolve(values.C) : process.cwd();
  if (!fs.existsSync(dir)) throw new ConfigError(`workspace directory does not exist: ${dir}`);
  return fs.realpathSync.native(dir);
}

/**
 * Session-mode precedence: --no-input > --interactive > the isTTY heuristic. The two flags
 * together are a contradiction, not a tiebreak. `--interactive` forces mode 'interactive' for
 * piped/expect-style driving — this also selects the real approver and governs the
 * snapshot-failure escalation path, so piped tests exercise the same code as a real TTY.
 */
export function resolveMode(values: CliValues): SessionMode {
  if (values['no-input'] && values.interactive) {
    throw new ConfigError('--no-input and --interactive are contradictory; pass at most one');
  }
  if (values['no-input']) return 'non-interactive';
  if (values.interactive) return 'interactive';
  return process.stdin.isTTY ? 'interactive' : 'non-interactive';
}

/**
 * Resolve the provider name (Session 15): CLI flag > user config > 'anthropic'. Aliases
 * (moonshot→kimi, zhipu/zai→glm) are accepted; an unknown name refuses loudly, listing the
 * valid ids. 'mock' is flag-only — a config file cannot select it.
 */
export function resolveProvider(values: CliValues, config?: { provider?: string }): ProviderName {
  const raw = values.provider ?? config?.provider ?? 'anthropic';
  const name = resolveProviderName(raw);
  if (name === undefined) {
    throw new ConfigError(`unknown provider: ${raw} (valid: anthropic, openai, deepseek, kimi, glm, mock)`);
  }
  if (name === 'mock' && values.provider === undefined) {
    throw new ConfigError(`provider 'mock' is flag-only (--provider mock --script <file>)`);
  }
  return name;
}

export function makeProvider(values: CliValues, config?: { provider?: string }, registry?: ProviderRegistry): Provider {
  const kind = resolveProvider(values, config);
  if (kind === 'mock') {
    if (!values.script) throw new ConfigError('--provider mock requires --script <file>');
    return new MockProvider(parseScript(fs.readFileSync(values.script, 'utf8')));
  }
  // Missing credentials refuse HERE — upfront and actionable (env var name + key URL, never a
  // value) — instead of surfacing as a mid-turn SDK error after assembly already ran.
  return (registry ?? createProviderRegistry()).create(kind);
}

export function makeApprover(
  values: CliValues,
  mode: SessionMode,
  io?: { question: (q: string) => Promise<string> },
  approvalSignal?: AbortSignal,
): Approver {
  if (values['dangerously-allow-all']) return dangerousApprover;
  if (mode === 'non-interactive') return autoDenyApprover;
  return createInteractiveApprover(io, approvalSignal);
}

export interface RunContext {
  ws: string;
  mode: SessionMode;
  provider: Provider;
  approver: Approver;
  model: string;
  maxSteps: number;
  maxTokens: number;
  /** Elision thresholds derived from the model's catalog budget (Session 15). */
  contextBudget: { triggerChars: number; targetChars: number };
  /** Startup notes the interface prints as chrome — e.g. a config model skipped for a
   *  cross-provider mismatch, or an uncataloged model running on conservative defaults. */
  notes: string[];
}

export interface RunContextOptions {
  /** Resolved config preferences (flags still win): from loadConfig, which runs post-trust. */
  config?: { provider?: string; model?: string; maxSteps?: number };
  /** REPL approval routing through its one persistent readline. */
  io?: { question: (q: string) => Promise<string> };
  /** One-shot turn-abort signal: Ctrl+C resolves a pending approval prompt as deny-stop (V0.7.1). */
  approvalSignal?: AbortSignal;
  /** Injectable provider registry (hermetic tests; the REPL shares one instance with /provider). */
  registry?: ProviderRegistry;
}

/**
 * Resolve the model for a provider (Session 15). Precedence: --model > config model > the
 * provider's catalog default. An EXPLICIT flag naming another provider's model refuses (a
 * contradiction the user must resolve); a CONFIG model belonging to another provider is skipped
 * with a note (the config was written for a different provider — refusing would make
 * `--provider X` unusable); an id unknown to every catalog proceeds with conservative defaults
 * and a note (catalogs go stale before harnesses do). Mock accepts anything.
 */
export function resolveModel(
  providerName: ProviderName,
  values: Pick<CliValues, 'model'>,
  config?: { model?: string },
): { model: string; notes: string[] } {
  const notes: string[] = [];
  const defaultFor = providerName === 'mock' ? DEFAULT_MODEL : PROVIDERS[providerName].defaultModel;
  if (values.model !== undefined) {
    const owners = providersOfModel(values.model);
    if (providerName !== 'mock' && owners.length > 0 && !owners.includes(providerName)) {
      throw new ConfigError(
        `model '${values.model}' belongs to provider '${owners[0]}' — pass --provider ${owners[0]} (selected: ${providerName})`,
      );
    }
    if (providerName !== 'mock' && owners.length === 0) {
      notes.push(`model '${values.model}' is not in the shipped catalog — conservative defaults in effect`);
    }
    return { model: values.model, notes };
  }
  if (config?.model !== undefined) {
    const owners = providersOfModel(config.model);
    if (providerName === 'mock' || owners.length === 0 || owners.includes(providerName)) {
      if (providerName !== 'mock' && owners.length === 0) {
        notes.push(`config model '${config.model}' is not in the shipped catalog — conservative defaults in effect`);
      }
      return { model: config.model, notes };
    }
    notes.push(
      `config model '${config.model}' belongs to provider '${owners[0]}' — using ${providerName}'s default '${defaultFor}'`,
    );
    return { model: defaultFor, notes };
  }
  return { model: defaultFor, notes };
}

/**
 * Assemble the pieces every session-running entry point (one-shot and REPL) shares, so the two
 * cannot drift into parallel construction paths. Preference precedence: CLI flag > user config >
 * built-in default.
 */
export function buildRunContext(values: CliValues, opts: RunContextOptions = {}): RunContext {
  const ws = workspaceRoot(values);
  const mode = resolveMode(values);
  const provider = makeProvider(values, opts.config, opts.registry);
  const approver = makeApprover(values, mode, opts.io, opts.approvalSignal);
  const providerName = provider.name as ProviderName;
  const { model, notes } = resolveModel(providerName, values, opts.config);
  // --max-steps is the honest name (the value bounds model steps per turn, not turns);
  // --max-turns stays accepted as the legacy alias. A non-numeric value used to become NaN,
  // and `NaN > maxSteps` comparisons made every turn end after ZERO steps — refuse loudly.
  if (values['max-steps'] !== undefined && values['max-turns'] !== undefined && values['max-steps'] !== values['max-turns']) {
    throw new Error(`--max-steps and --max-turns are aliases for the same limit; got conflicting values '${values['max-steps']}' and '${values['max-turns']}'`);
  }
  const stepsRaw = values['max-steps'] ?? values['max-turns'];
  const maxSteps = stepsRaw !== undefined ? parseCountFlag(values['max-steps'] !== undefined ? 'max-steps' : 'max-turns', stepsRaw) : (opts.config?.maxSteps ?? 20);
  // Output cap and elision budget come from the capability catalog — the former
  // `name === 'anthropic' ? 64_000 : 16_000` branch, generalized into data.
  const maxTokens = defaultMaxTokensFor(providerName, model);
  const contextBudget = contextBudgetFor(providerName, model);
  return { ws, mode, provider, approver, model, maxSteps, maxTokens, contextBudget, notes };
}

/**
 * The newest MAIN session. Subagent child logs live in the same directory and, being created
 * mid-parent-session, always sort newest — without the lineage skip, every "latest session"
 * default (`--continue`, undo, diff, commit, report) would silently target the newest CHILD.
 */
export function latestSessionId(layout: ProjectLayout): string | undefined {
  try {
    return fs
      .readdirSync(layout.sessionsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .sort()
      .reverse()
      .find((id) => {
        const first = EventLog.readFirstEvent(layout.sessionFile(id));
        return !(first !== undefined && first.type === 'session.started' && first.lineage !== undefined);
      });
  } catch {
    return undefined;
  }
}
