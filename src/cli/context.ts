import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../store/event-log.js';
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
  help?: boolean;
  version?: boolean;
  m?: string;
  yes?: boolean;
  'no-trailer'?: boolean;
}

export const DEFAULT_MODEL = 'claude-opus-4-8';

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

export function makeProvider(values: CliValues): Provider {
  const kind = values.provider ?? 'anthropic';
  if (kind === 'mock') {
    if (!values.script) throw new ConfigError('--provider mock requires --script <file>');
    return new MockProvider(parseScript(fs.readFileSync(values.script, 'utf8')));
  }
  if (kind === 'anthropic') return new AnthropicProvider();
  throw new ConfigError(`unknown provider: ${kind}`);
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
}

export interface RunContextOptions {
  /** Resolved config preferences (flags still win): from loadConfig, which runs post-trust. */
  config?: { model?: string; maxSteps?: number };
  /** REPL approval routing through its one persistent readline. */
  io?: { question: (q: string) => Promise<string> };
  /** One-shot turn-abort signal: Ctrl+C resolves a pending approval prompt as deny-stop (V0.7.1). */
  approvalSignal?: AbortSignal;
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
  const approver = makeApprover(values, mode, opts.io, opts.approvalSignal);
  const model = values.model ?? opts.config?.model ?? DEFAULT_MODEL;
  // --max-steps is the honest name (the value bounds model steps per turn, not turns);
  // --max-turns stays accepted as the legacy alias. A non-numeric value used to become NaN,
  // and `NaN > maxSteps` comparisons made every turn end after ZERO steps — refuse loudly.
  if (values['max-steps'] !== undefined && values['max-turns'] !== undefined && values['max-steps'] !== values['max-turns']) {
    throw new Error(`--max-steps and --max-turns are aliases for the same limit; got conflicting values '${values['max-steps']}' and '${values['max-turns']}'`);
  }
  const stepsRaw = values['max-steps'] ?? values['max-turns'];
  const maxSteps = stepsRaw !== undefined ? parseCountFlag(values['max-steps'] !== undefined ? 'max-steps' : 'max-turns', stepsRaw) : (opts.config?.maxSteps ?? 20);
  const maxTokens = provider.name === 'anthropic' ? 64_000 : 16_000;
  return { ws, mode, provider, approver, model, maxSteps, maxTokens };
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
