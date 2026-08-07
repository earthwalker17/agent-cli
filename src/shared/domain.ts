/**
 * Domain-suffix matching, shared by the policy engine and the research pack.
 *
 * It lives in `shared/` rather than in either caller because BOTH need it and they may not import
 * each other: the engine must not depend on a workflow pack (the dependency arrow points one way),
 * and a second copy of a security predicate is a predicate that will eventually disagree with
 * itself. One definition, two callers, one behaviour.
 */

/**
 * Whether `host` is `pattern` or a subdomain of it, matched on LABEL boundaries.
 *
 * The boundary is the whole point: a naive `endsWith` makes `notevil.com` match `evil.com`, which
 * over-blocks, and makes nothing match `evil.com.attacker.net`, which under-blocks in the
 * direction an attacker chooses. Case is folded and a leading or trailing dot is tolerated so an
 * operator's hand-written config entry behaves the way it reads.
 */
export function domainMatches(host: string, pattern: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  const p = pattern.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  if (p === '' || h === '') return false;
  return h === p || h.endsWith(`.${p}`);
}
