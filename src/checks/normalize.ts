import { sanitizeLine } from '../shared/text.js';
import type { ExecOutcome } from '../exec/run.js';
import type { CheckFinding, CheckKind, CheckResult, CheckStatus, ResolvedCheck } from './types.js';

/**
 * Normalizing a check outcome (Session 12). The contract that makes a typed check worth gating on:
 *
 *   THE EXIT CODE IS THE VERDICT. Parsing only enriches `summary`, `findings`, and `signals`.
 *
 * A parser that could flip a verdict would turn verification back into narration — exactly what
 * the report's CHECKED rule has refused since V0.3 ("a killed command has NO exit code and is
 * NEVER evidence that a check passed"). So: `exited` + 0 ⇒ pass, `exited` + non-zero ⇒ fail, and
 * every non-exit termination (timeout, abort, spawn failure) ⇒ `error`, never `pass`.
 *
 * `signals` are the durable half. The full output is truncated for the model and only spilled to a
 * blob, but failure CLASSIFICATION must stay derivable from the event log alone — so the named
 * signal ids computed here are persisted on `check.completed` and are what the recovery
 * classifier reads later.
 */

const MAX_SIGNALS = 6;
const MAX_FINDINGS = 8;
const MAX_FINDING_CHARS = 200;
const MAX_SUMMARY_CHARS = 400;
/** Scan window per end of the captured output — bounded work regardless of output size. */
const SCAN_WINDOW = 32 * 1024;

interface SignalRule {
  id: string;
  re: RegExp;
}

/**
 * Named signal rules, in a FIXED order (the emitted list is deterministic for a given output).
 * Each id is a stable vocabulary word the recovery catalogue keys on; the regexes are deliberately
 * broad-but-cheap — a signal is evidence that a class is likely, never proof on its own.
 */
export const SIGNAL_RULES: readonly SignalRule[] = [
  { id: 'command-not-found', re: /is not recognized as (?:the name of )?a|command not found|\bENOENT\b|No such file or directory/i },
  { id: 'module-not-found', re: /Cannot find module|MODULE_NOT_FOUND|Cannot find package|ModuleNotFoundError|No module named/i },
  { id: 'missing-dependency', re: /npm ERR!|Could not resolve dependency|Cannot resolve dependency|peer dep missing/i },
  { id: 'ts-error', re: /error TS\d{4}/ },
  { id: 'type-error', re: /\bTypeError\b|is not assignable to|Argument of type/ },
  { id: 'syntax-error', re: /\bSyntaxError\b|Unexpected token|Parsing error:/ },
  { id: 'assertion-failed', re: /AssertionError|expected .{0,60}to (?:be|equal|contain)|assert(?:ion)? failed|^\s*(?:FAIL|FAILED|×|✕)\s/im },
  { id: 'lint-violation', re: /\d+ problems? \(|✖ \d+ problem|Code style issues found|would reformat/i },
  { id: 'permission-denied', re: /\bEACCES\b|\bEPERM\b|Access is denied|Permission denied/i },
  { id: 'port-in-use', re: /\bEADDRINUSE\b/ },
  { id: 'out-of-memory', re: /JavaScript heap out of memory|\bENOMEM\b|MemoryError/i },
  { id: 'network-error', re: /\bETIMEDOUT\b|\bECONNREFUSED\b|\bENOTFOUND\b|getaddrinfo/i },
];

function scanText(output: string): string {
  if (output.length <= SCAN_WINDOW * 2) return output;
  return `${output.slice(0, SCAN_WINDOW)}\n${output.slice(output.length - SCAN_WINDOW)}`;
}

/** Named signals that fired, in table order, capped. Pure and deterministic. */
export function extractSignals(output: string): string[] {
  const text = scanText(output);
  const hits: string[] = [];
  for (const rule of SIGNAL_RULES) {
    if (hits.length >= MAX_SIGNALS) break;
    if (rule.re.test(text)) hits.push(rule.id);
  }
  return hits;
}

function finding(message: string, file?: string, line?: number): CheckFinding {
  return {
    ...(file !== undefined ? { file: sanitizeLine(file).slice(0, 200) } : {}),
    ...(line !== undefined ? { line } : {}),
    message: sanitizeLine(message).slice(0, MAX_FINDING_CHARS),
  };
}

const TS_RE = /^(.+?)\((\d+),\d+\): error (TS\d+): (.+)$/gm;
const ESLINT_POS_RE = /^\s+(\d+):(\d+)\s+(?:error|warning)\s+(.+?)(?:\s\s+|$)/gm;
const VITEST_FAIL_RE = /^\s*(?:FAIL|×|✕)\s+(.+)$/gm;
const PYTEST_FAIL_RE = /^FAILED\s+(\S+)(?:\s+-\s+(.*))?$/gm;
const PRETTIER_RE = /^\[warn\]\s+(.+)$/gm;
const GENERIC_ERR_RE = /^.{0,240}?(?:\berror\b|\bError:).{0,240}$/gim;

/**
 * Bounded, deterministic finding extraction. Ecosystem-shaped patterns first, then one generic
 * "a line mentioning an error" fallback so an unrecognized tool still yields something pointable.
 * Findings are EVIDENCE for the human and the classifier — they never move the verdict.
 */
export function extractFindings(kind: CheckKind, output: string): CheckFinding[] {
  const text = scanText(output);
  const out: CheckFinding[] = [];
  const push = (f: CheckFinding): void => {
    if (out.length < MAX_FINDINGS && !out.some((e) => e.message === f.message && e.file === f.file)) out.push(f);
  };

  for (const m of text.matchAll(TS_RE)) push(finding(`${m[3]!}: ${m[4]!}`, m[1]!, Number(m[2])));
  for (const m of text.matchAll(PYTEST_FAIL_RE)) push(finding(m[2] ?? 'test failed', m[1]!));
  if (kind === 'lint' || kind === 'static-analysis') {
    for (const m of text.matchAll(ESLINT_POS_RE)) push(finding(m[3]!, undefined, Number(m[1])));
  }
  if (kind === 'format') {
    for (const m of text.matchAll(PRETTIER_RE)) push(finding('would reformat', m[1]!));
  }
  if (kind === 'test' || kind === 'test-targeted') {
    for (const m of text.matchAll(VITEST_FAIL_RE)) push(finding(m[1]!));
  }
  if (out.length === 0) {
    for (const m of text.matchAll(GENERIC_ERR_RE)) {
      push(finding(m[0]!.trim()));
      if (out.length >= 3) break; // a generic scan is weak evidence; keep it short
    }
  }
  return out;
}

function statusOf(outcome: ExecOutcome): CheckStatus {
  if (outcome.termination !== 'exited') return 'error';
  return outcome.exitCode === 0 ? 'pass' : 'fail';
}

function terminationNote(outcome: ExecOutcome, timeoutMs: number): string {
  switch (outcome.termination) {
    case 'timeout':
      return `timed out after ${timeoutMs}ms; no exit code`;
    case 'aborted':
      return `aborted after ${outcome.durationMs}ms; no exit code`;
    case 'spawn-error':
      return outcome.spawnError ?? 'failed to spawn';
    default:
      return `exit ${String(outcome.exitCode)}`;
  }
}

/** Build the normalized result for a check that actually ran. */
export function normalizeCheckOutcome(resolved: ResolvedCheck, outcome: ExecOutcome): CheckResult {
  const status = statusOf(outcome);
  const signals = extractSignals(outcome.combined);
  const findings = status === 'pass' ? [] : extractFindings(resolved.kind, outcome.combined);
  const head = `${resolved.kind} ${status.toUpperCase()} — ${resolved.recipeId}: ${terminationNote(outcome, resolved.timeoutMs)} in ${outcome.durationMs}ms`;
  const detail =
    findings.length > 0
      ? `; ${findings.length} finding(s), first: ${findings[0]!.file !== undefined ? `${findings[0]!.file}${findings[0]!.line !== undefined ? `:${String(findings[0]!.line)}` : ''} — ` : ''}${findings[0]!.message}`
      : signals.length > 0
        ? `; signals: ${signals.join(', ')}`
        : '';
  return {
    kind: resolved.kind,
    recipeId: resolved.recipeId,
    command: resolved.command,
    status,
    exitCode: outcome.termination === 'exited' ? outcome.exitCode : null,
    termination: outcome.termination,
    durationMs: outcome.durationMs,
    summary: `${head}${detail}`.slice(0, MAX_SUMMARY_CHARS),
    findings,
    signals,
  };
}

/** The result for a kind that could not run at all — never executed, never a pass. */
export function unsupportedResult(kind: CheckKind, reason: string): CheckResult {
  return {
    kind,
    recipeId: '(none)',
    command: '',
    status: 'unsupported',
    exitCode: null,
    termination: null,
    durationMs: 0,
    summary: `${kind} UNSUPPORTED — ${sanitizeLine(reason).slice(0, 300)}`,
    findings: [],
    signals: [],
  };
}
