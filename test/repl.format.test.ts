import { describe, expect, it } from 'vitest';
import { NO_STYLE, detectStyle, type StyleRole } from '../src/repl/format.js';
import { createTaskTable } from '../src/repl/live-tasks.js';

const ESC = String.fromCharCode(0x1b);

describe('style roles (S22)', () => {
  it('NO_STYLE is identity for every role and carries the Unicode glyph table', () => {
    const roles: StyleRole[] = ['ok', 'fail', 'warn', 'muted', 'heading', 'agent', 'user', 'accent'];
    for (const r of roles) expect(NO_STYLE.seg(r, 'text')).toBe('text');
    expect(NO_STYLE.colors).toBe(false);
    expect(NO_STYLE.glyph.ok).toBe('✓');
    expect(NO_STYLE.glyph.pointer).toBe('❯ ');
    expect(NO_STYLE.glyph.delta).toBe('±');
  });

  it('detectStyle paints roles with exactly one 16-color SGR open/close pair', () => {
    const style = detectStyle({ isTTY: true, env: {} });
    expect(style.colors).toBe(true);
    expect(style.seg('ok', 'x')).toBe(`${ESC}[32mx${ESC}[39m`);
    expect(style.seg('fail', 'x')).toBe(`${ESC}[31mx${ESC}[39m`);
    expect(style.seg('warn', 'x')).toBe(`${ESC}[33mx${ESC}[39m`);
    expect(style.seg('muted', 'x')).toBe(`${ESC}[2mx${ESC}[22m`);
    expect(style.seg('heading', 'x')).toBe(`${ESC}[1mx${ESC}[22m`);
    expect(style.seg('agent', 'x')).toBe(`${ESC}[35mx${ESC}[39m`);
    expect(style.seg('user', 'x')).toBe(`${ESC}[36mx${ESC}[39m`);
    expect(style.seg('accent', 'x')).toBe(`${ESC}[7mx${ESC}[27m`);
  });

  it('the legacy names are aliases of the roles — one emitter, not two', () => {
    const style = detectStyle({ isTTY: true, env: {} });
    expect(style.dim('x')).toBe(style.seg('muted', 'x'));
    expect(style.bold('x')).toBe(style.seg('heading', 'x'));
    expect(style.red('x')).toBe(style.seg('fail', 'x'));
    expect(style.green('x')).toBe(style.seg('ok', 'x'));
    expect(style.yellow('x')).toBe(style.seg('warn', 'x'));
    expect(style.cyan('x')).toBe(style.seg('user', 'x'));
  });

  it('NO_COLOR, TERM=dumb, and !isTTY each disable painting', () => {
    expect(detectStyle({ isTTY: true, env: { NO_COLOR: '1' } }).seg('ok', 'x')).toBe('x');
    expect(detectStyle({ isTTY: true, env: { NO_COLOR: '' } }).seg('ok', 'x')).toBe('x'); // any set value counts
    expect(detectStyle({ isTTY: true, env: { TERM: 'dumb' } }).seg('ok', 'x')).toBe('x');
    expect(detectStyle({ isTTY: false, env: {} }).seg('ok', 'x')).toBe('x');
  });

  it('non-TTY always gets the ASCII glyph table, including the S22 additions', () => {
    const g = detectStyle({ isTTY: false, env: {} }).glyph;
    expect(g.ok).toBe('ok');
    expect(g.agent).toBe('>');
    expect(g.flag).toBe('!');
    expect(g.dot).toBe('.');
    expect(g.delta).toBe('+-');
    expect(g.pointer).toBe('> ');
  });

  it('dim and bold share SGR close 22 — the documented reason seg never composes', () => {
    const style = detectStyle({ isTTY: true, env: {} });
    // Pinned as documentation: nesting muted inside heading would terminate BOTH at the inner
    // close. seg offers no compose API; this test records why that absence is deliberate.
    expect(style.seg('muted', 'x').endsWith(`${ESC}[22m`)).toBe(true);
    expect(style.seg('heading', 'x').endsWith(`${ESC}[22m`)).toBe(true);
  });
});

describe('glyph unification (S22)', () => {
  it('the task table defaults keep the pre-S22 Unicode markers byte-identical', () => {
    const table = createTaskTable(() => 1_000);
    table.update({ childSessionId: 'sess-abcd', role: 'executor', phase: 'running', steps: 1, outTokens: 10 });
    const lines = table.statusLines();
    expect(lines[0]).toContain('▸ 1 agent(s) running');
    expect(lines[1]).toContain('▸ executor·abcd');
  });

  it('an ASCII glyph table reaches every marker the table prints', () => {
    const table = createTaskTable(() => 1_000, { agent: '>', flag: '!', dot: '.' });
    table.update({ childSessionId: 'sess-abcd', role: 'executor', phase: 'running', steps: 1, outTokens: 10, supervision: 'idle' });
    const lines = table.statusLines();
    expect(lines.join('\n')).not.toContain('▸');
    expect(lines.join('\n')).not.toContain('⚑');
    expect(lines.join('\n')).not.toContain('·');
    expect(lines[1]).toContain('> executor.abcd');
    expect(lines[1]).toContain('! idle');
  });
});
