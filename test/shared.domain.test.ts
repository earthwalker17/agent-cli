import { describe, it, expect } from 'vitest';
import { domainMatches } from '../src/shared/domain.js';

/**
 * One definition, two callers (the policy engine and the research pack), so this predicate is
 * pinned once here rather than twice in their suites. The label boundary is the whole point: a
 * naive endsWith over-blocks in one direction and under-blocks in the direction an attacker picks.
 */
describe('domainMatches', () => {
  it('matches the domain itself', () => {
    expect(domainMatches('evil.com', 'evil.com')).toBe(true);
  });

  it('matches subdomains at any depth', () => {
    expect(domainMatches('www.evil.com', 'evil.com')).toBe(true);
    expect(domainMatches('a.b.c.evil.com', 'evil.com')).toBe(true);
  });

  it('does not over-block: a name merely ENDING in the pattern is not a subdomain', () => {
    expect(domainMatches('notevil.com', 'evil.com')).toBe(false);
    expect(domainMatches('myevil.com', 'evil.com')).toBe(false);
  });

  it('does not under-block: the pattern appearing as a PREFIX label is not a match either', () => {
    expect(domainMatches('evil.com.attacker.net', 'evil.com')).toBe(false);
  });

  it('folds case and tolerates a leading or trailing dot', () => {
    expect(domainMatches('WWW.Evil.COM', 'evil.com')).toBe(true);
    expect(domainMatches('www.evil.com', '.EVIL.com')).toBe(true);
    expect(domainMatches('evil.com.', 'evil.com')).toBe(true);
    expect(domainMatches('www.evil.com', 'evil.com.')).toBe(true);
  });

  it('tolerates surrounding whitespace in a hand-written config entry', () => {
    expect(domainMatches('www.evil.com', '  evil.com  ')).toBe(true);
  });

  it('never matches on an empty pattern or an empty host', () => {
    expect(domainMatches('example.com', '')).toBe(false);
    expect(domainMatches('example.com', '   ')).toBe(false);
    expect(domainMatches('', 'example.com')).toBe(false);
  });
});
