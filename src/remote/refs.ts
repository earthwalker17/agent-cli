/**
 * Ref-name handling for the remote pack.
 *
 * Every refspec this harness sends is composed here from a validated, FULLY QUALIFIED ref name.
 * That is deliberate: git's short forms are convenient and ambiguous — `v1.6.0` resolves to a tag
 * if one exists and a branch otherwise, and `main:other` expands differently depending on what the
 * remote already has. A delivery capability must not depend on "whatever git decides this means",
 * because the thing being decided is where a human's work gets published.
 *
 * The validator is deliberately STRICTER than `git check-ref-format`. Nothing is lost by refusing
 * an exotic-but-legal name, and a refspec assembled from model-supplied text is exactly the place
 * where "technically allowed" is the wrong bar.
 */

/**
 * Characters git forbids in a ref name, plus every ASCII control character.
 *
 * Built from an explicit escaped string rather than a regex literal — the `shared/text.ts` idiom —
 * so no raw control byte ever sits in this source file.
 *
 * `-` is deliberately absent: it is legal and common inside a name (`session-20`). Only a LEADING
 * `-` is refused, and that check lives in `refNameProblem`, where the whole name is visible; a
 * component-level rule could not tell the two apart.
 */
const FORBIDDEN_CHARS = new RegExp('[' + '\\s~^:?*\\[\\]\\\\' + '\\u0000-\\u001f\\u007f' + ']', 'u');

/**
 * Validate ONE component of a ref path (the text between slashes).
 * Rejects: empty, leading/trailing `.`, a `.lock` suffix, `..`, `@{`, a bare `@`, forbidden chars.
 */
function validComponent(part: string): boolean {
  if (part === '' || part === '@') return false;
  if (part.startsWith('.') || part.endsWith('.')) return false;
  if (part.endsWith('.lock')) return false;
  if (part.includes('..') || part.includes('@{')) return false;
  if (FORBIDDEN_CHARS.test(part)) return false;
  return true;
}

/**
 * Validate a ref NAME (the part after `refs/heads/` or `refs/tags/`, or a fully qualified ref).
 * Returns a refusal reason, or undefined when the name is usable.
 */
export function refNameProblem(name: string): string | undefined {
  if (name === '') return 'a ref name may not be empty';
  if (name.length > 255) return 'a ref name may not exceed 255 characters';
  if (name.startsWith('-')) return `'${name}' begins with '-', which cannot be distinguished from a command-line flag`;
  if (name.startsWith('/') || name.endsWith('/')) return `'${name}' may not begin or end with '/'`;
  for (const part of name.split('/')) {
    if (!validComponent(part)) return `'${name}' is not a usable ref name (rejected component '${part}')`;
  }
  return undefined;
}

/**
 * Fully qualify a branch name. Accepts either a short name (`session-20`, `feat/x`) or an
 * already-qualified `refs/heads/...`; anything else is refused rather than coerced, because
 * silently turning `refs/tags/v1` into `refs/heads/refs/tags/v1` is how a tag becomes a branch.
 */
export function qualifyBranch(input: string): { ref: string } | { error: string } {
  const raw = input.trim();
  if (raw.startsWith('refs/heads/')) {
    const problem = refNameProblem(raw.slice('refs/heads/'.length));
    return problem !== undefined ? { error: problem } : { ref: raw };
  }
  if (raw.startsWith('refs/')) {
    return { error: `'${raw}' is a fully qualified ref that is not a branch; use the branch's own name or a refs/heads/ ref` };
  }
  const problem = refNameProblem(raw);
  return problem !== undefined ? { error: problem } : { ref: `refs/heads/${raw}` };
}

/** Fully qualify a tag name. Same contract as `qualifyBranch`. */
export function qualifyTag(input: string): { ref: string } | { error: string } {
  const raw = input.trim();
  if (raw.startsWith('refs/tags/')) {
    const problem = refNameProblem(raw.slice('refs/tags/'.length));
    return problem !== undefined ? { error: problem } : { ref: raw };
  }
  if (raw.startsWith('refs/')) {
    return { error: `'${raw}' is a fully qualified ref that is not a tag; use the tag's own name or a refs/tags/ ref` };
  }
  const problem = refNameProblem(raw);
  return problem !== undefined ? { error: problem } : { ref: `refs/tags/${raw}` };
}

/** `refs/heads/x` -> `x`, `refs/tags/v1` -> `v1`, anything else unchanged. */
export function shortRef(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/tags/')) return ref.slice('refs/tags/'.length);
  return ref;
}

/**
 * Validate a git remote NAME (`origin`). Remote names reach argv positions, so the same
 * leading-`-` and metacharacter discipline applies.
 */
export function remoteNameProblem(name: string): string | undefined {
  if (name === '') return 'a remote name may not be empty';
  if (name.length > 100) return 'a remote name may not exceed 100 characters';
  if (name.startsWith('-')) return `'${name}' begins with '-', which cannot be distinguished from a command-line flag`;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return `'${name}' is not a usable remote name`;
  return undefined;
}

/** A 40- or 64-hex object id (sha1 and sha256 repositories). */
export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s) || /^[0-9a-f]{64}$/.test(s);
}

/** 12 characters is git's own abbreviation length in this harness (see `git/facts.ts`). */
export function shortOid(oid: string | null): string {
  return oid === null ? '(absent)' : oid.slice(0, 12);
}
