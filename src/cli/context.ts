import fs from 'node:fs';
import path from 'node:path';
import { MockProvider, parseScript } from '../provider/mock.js';
import { AnthropicProvider } from '../provider/anthropic.js';
import { autoDenyApprover, dangerousApprover, createInteractiveApprover } from '../runtime/approvals.js';
import { ConfigError } from '../shared/errors.js';
import type { ProjectLayout } from '../store/layout.js';
import type { Approver, Provider, SessionMode } from '../types.js';

/** The parsed CLI values shared across commands (kept in one place; index.ts owns parsing). */
export interface CliValues {
  C?: string;
  provider?: string;
  script?: string;
  model?: string;
  'no-input'?: boolean;
  interactive?: boolean;
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
  help?: boolean;
}

export const DEFAULT_MODEL = 'claude-opus-4-8';

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

export function makeProvider(values: CliValues): Provider {
  const kind = values.provider ?? 'anthropic';
  if (kind === 'mock') {
    if (!values.script) throw new ConfigError('--provider mock requires --script <file>');
    return new MockProvider(parseScript(fs.readFileSync(values.script, 'utf8')));
  }
  if (kind === 'anthropic') return new AnthropicProvider();
  throw new ConfigError(`unknown provider: ${kind}`);
}

export function makeApprover(values: CliValues, mode: SessionMode, io?: { question: (q: string) => Promise<string> }): Approver {
  if (values['dangerously-allow-all']) return dangerousApprover;
  if (mode === 'non-interactive') return autoDenyApprover;
  return createInteractiveApprover(io);
}

export interface RunContext {
  ws: string;
  mode: SessionMode;
  provider: Provider;
  approver: Approver;
  model: string;
  maxSteps: number;
  maxTokens: number;
}

export interface RunContextOptions {
  /** Resolved config preferences (flags still win): from loadConfig, which runs post-trust. */
  config?: { model?: string; maxSteps?: number };
  /** REPL approval routing through its one persistent readline. */
  io?: { question: (q: string) => Promise<string> };
}

/**
 * Assemble the pieces every session-running entry point (one-shot and REPL) shares, so the two
 * cannot drift into parallel construction paths. Preference precedence: CLI flag > user config >
 * built-in default.
 */
export function buildRunContext(values: CliValues, opts: RunContextOptions = {}): RunContext {
  const ws = workspaceRoot(values);
  const mode = resolveMode(values);
  const provider = makeProvider(values);
  const approver = makeApprover(values, mode, opts.io);
  const model = values.model ?? opts.config?.model ?? DEFAULT_MODEL;
  const maxSteps = values['max-turns'] ? Number(values['max-turns']) : (opts.config?.maxSteps ?? 20);
  const maxTokens = provider.name === 'anthropic' ? 64_000 : 16_000;
  return { ws, mode, provider, approver, model, maxSteps, maxTokens };
}

export function latestSessionId(layout: ProjectLayout): string | undefined {
  try {
    return fs
      .readdirSync(layout.sessionsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .sort()
      .pop();
  } catch {
    return undefined;
  }
}
