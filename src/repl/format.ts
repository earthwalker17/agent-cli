import { sanitizeLine } from '../shared/text.js';

/**
 * Pure presentation helpers for the REPL: glyphs, colors, and one-line labels. No I/O.
 *
 * Glyph strategy: Unicode chrome (✓ → •) renders as boxes or mojibake on legacy Windows consoles
 * (cp936/GBK conhost) and through PowerShell 5.1 pipelines, so ASCII is the fallback whenever we
 * are not confident of the terminal — non-TTY streams always get ASCII so piped transcripts and
 * test goldens are stable.
 */

export interface Glyphs {
  prompt: string;
  bullet: string;
  ok: string;
  fail: string;
  warn: string;
  arrow: string;
  rule: string;
}

const UNICODE: Glyphs = { prompt: '› ', bullet: '•', ok: '✓', fail: '✗', warn: '⚠', arrow: '→', rule: '─' };
const ASCII: Glyphs = { prompt: '> ', bullet: '*', ok: 'ok', fail: 'x', warn: '!', arrow: '->', rule: '-' };

export interface Style {
  colors: boolean;
  glyph: Glyphs;
  dim(s: string): string;
  bold(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

function paint(enabled: boolean, open: string, close: string): (s: string) => string {
  return enabled ? (s) => `\u001b[${open}m${s}\u001b[${close}m` : (s) => s;
}

export function detectStyle(opts: { isTTY: boolean; env?: NodeJS.ProcessEnv }): Style {
  const env = opts.env ?? process.env;
  const colors = opts.isTTY && env['NO_COLOR'] === undefined && env['TERM'] !== 'dumb';
  const modernWindowsTerminal =
    env['WT_SESSION'] !== undefined || env['TERM_PROGRAM'] !== undefined || env['ConEmuANSI'] === 'ON';
  const unicode = opts.isTTY && (process.platform !== 'win32' || modernWindowsTerminal);
  return {
    colors,
    glyph: unicode ? UNICODE : ASCII,
    dim: paint(colors, '2', '22'),
    bold: paint(colors, '1', '22'),
    red: paint(colors, '31', '39'),
    green: paint(colors, '32', '39'),
    yellow: paint(colors, '33', '39'),
    cyan: paint(colors, '36', '39'),
  };
}

/** One safe display line describing a tool call (input is untrusted model output). */
export function toolLabel(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (typeof i['command'] === 'string') return sanitizeLine(`run: ${(i['command'] as string).slice(0, 100)}`);
  const p = typeof i['path'] === 'string' ? (i['path'] as string) : '';
  if (tool === 'search' && typeof i['pattern'] === 'string') {
    return sanitizeLine(`search /${(i['pattern'] as string).slice(0, 60)}/ ${p}`.trim());
  }
  return sanitizeLine(`${tool} ${p}`.trim());
}

export function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}
