import { sanitizeLine } from '../shared/text.js';

/**
 * Pure presentation helpers for the REPL: glyphs, colors, and one-line labels. No I/O.
 *
 * Glyph strategy: Unicode chrome (✓ → •) renders as boxes or mojibake on legacy Windows consoles
 * (cp936/GBK conhost) and through PowerShell 5.1 pipelines, so ASCII is the fallback whenever we
 * are not confident of the terminal — non-TTY streams always get ASCII so piped transcripts and
 * test goldens are stable.
 *
 * Roles, not colors (Session 22): chrome names WHAT a line is — a success, a failure, agent
 * identity, the user's own composer — and this module maps the role to SGR exactly once. Two
 * rules are load-bearing:
 *
 * - `seg` applies exactly ONE open/close pair and there is no compose API. `dim` and `bold`
 *   share the SGR close code 22, so nesting them would terminate both — the absence of nesting
 *   is enforced by the shape, not by discipline.
 * - Severity is never color-only: every fail/warn keeps its glyph (and, where worded, its word),
 *   so a NO_COLOR or TERM=dumb terminal loses nothing but emphasis.
 */

export interface Glyphs {
  prompt: string;
  bullet: string;
  ok: string;
  fail: string;
  warn: string;
  arrow: string;
  rule: string;
  /** Agent/task identity marker (status area rows, task lines). */
  agent: string;
  /** Supervision flag marker (status area rows). */
  flag: string;
  /** Separator/heartbeat dot. */
  dot: string;
  /** Captured-changes marker (task.changes chrome). */
  delta: string;
  /** Select-widget highlight pointer (Session 22). */
  pointer: string;
}

const UNICODE: Glyphs = {
  prompt: '› ',
  bullet: '•',
  ok: '✓',
  fail: '✗',
  warn: '⚠',
  arrow: '→',
  rule: '─',
  agent: '▸',
  flag: '⚑',
  dot: '·',
  delta: '±',
  pointer: '❯ ',
};
const ASCII: Glyphs = {
  prompt: '> ',
  bullet: '*',
  ok: 'ok',
  fail: 'x',
  warn: '!',
  arrow: '->',
  rule: '-',
  agent: '>',
  flag: '!',
  dot: '.',
  delta: '+-',
  pointer: '> ',
};

/** Semantic chrome roles. The mapping to SGR lives in ROLE_SGR and nowhere else. */
export type StyleRole = 'ok' | 'fail' | 'warn' | 'muted' | 'heading' | 'agent' | 'user' | 'accent';

/** The CSI introducer, built programmatically so no raw control byte sits in the source. */
const CSI = `${String.fromCharCode(0x1b)}[`;

/** 16-color SGR only; `accent` is inverse video (7/27), safe on any palette. */
const ROLE_SGR: Record<StyleRole, readonly [string, string]> = {
  ok: ['32', '39'],
  fail: ['31', '39'],
  warn: ['33', '39'],
  muted: ['2', '22'],
  heading: ['1', '22'],
  agent: ['35', '39'],
  user: ['36', '39'],
  accent: ['7', '27'],
};

export interface Style {
  colors: boolean;
  glyph: Glyphs;
  /** The one paint primitive: one role, one open/close pair, identity when colors are off. */
  seg(role: StyleRole, s: string): string;
  dim(s: string): string;
  bold(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

function makeStyle(colors: boolean, glyph: Glyphs): Style {
  const seg = (role: StyleRole, s: string): string => {
    if (!colors) return s;
    const [open, close] = ROLE_SGR[role];
    return `${CSI}${open}m${s}${CSI}${close}m`;
  };
  return {
    colors,
    glyph,
    seg,
    // The pre-S22 names, kept as aliases so ninety-odd call sites did not churn in the same
    // change that introduced the roles. New code names the role.
    dim: (s) => seg('muted', s),
    bold: (s) => seg('heading', s),
    red: (s) => seg('fail', s),
    green: (s) => seg('ok', s),
    yellow: (s) => seg('warn', s),
    cyan: (s) => seg('user', s),
  };
}

/**
 * The no-style style: identity paints, Unicode glyphs, `colors: false`. The default everywhere a
 * Style is optional (tests building a bare CommandContext, pure prompt formatting) so that
 * output without an explicit style is byte-identical to pre-S22 output.
 */
export const NO_STYLE: Style = makeStyle(false, UNICODE);

export function detectStyle(opts: { isTTY: boolean; env?: NodeJS.ProcessEnv }): Style {
  const env = opts.env ?? process.env;
  const colors = opts.isTTY && env['NO_COLOR'] === undefined && env['TERM'] !== 'dumb';
  const modernWindowsTerminal =
    env['WT_SESSION'] !== undefined || env['TERM_PROGRAM'] !== undefined || env['ConEmuANSI'] === 'ON';
  const unicode = opts.isTTY && (process.platform !== 'win32' || modernWindowsTerminal);
  return makeStyle(colors, unicode ? UNICODE : ASCII);
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
