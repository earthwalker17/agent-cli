import type { z } from 'zod';

/**
 * One-level tolerant decode for DOUBLE-ENCODED tool arguments (S16.5b, found live).
 *
 * The chat-compat family emits tool arguments as one JSON string, which the adapter decodes
 * once. Some models (kimi-k3, live-observed) additionally serialize NESTED object arguments —
 * `{"plan": "{\"version\":1,…}"}` — and when the schema error says "expected object, received
 * string" they treat it as a format-discovery puzzle: the live run watched kimi cycle YAML,
 * single-quoted JSON, XML-ish tags and entry-pair arrays for twelve minutes without ever
 * un-stringifying the value. A plan could never be written; the whole workflow was unreachable.
 *
 * Rules, deliberately narrow so this stays a DECODE and never becomes intent-guessing:
 * - fires only after the schema REJECTED the input, and only for `invalid_type` issues that
 *   expected object/array while the value actually present at that path is a string;
 * - each such string must itself `JSON.parse` to an object/array — nothing else is accepted
 *   (no YAML, no quasi-JSON: those still fail, now with a plain-language hint);
 * - the caller re-validates the coerced input against the SAME schema exactly once; on any
 *   remaining failure the original error is reported (plus the hint);
 * - the original input object is never mutated — the wire history and the recorded
 *   `tool.requested` stay byte-faithful to what the model actually sent.
 */

export interface CoerceOutcome {
  /** A candidate input with stringified values decoded — present only when something changed. */
  data?: unknown;
  /** A plain-language hint for the model when string-shaped values were seen at failing paths. */
  hint?: string;
}

function tryParseStructured(s: string): unknown | undefined {
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return typeof v === 'object' && v !== null ? v : undefined;
  } catch {
    return undefined;
  }
}

function getAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const k of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  return cur;
}

/** Clone-along-the-path set: the original object graph is shared where untouched, never mutated. */
function setAt(root: unknown, path: readonly PropertyKey[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [PropertyKey, ...PropertyKey[]];
  if (Array.isArray(root)) {
    const copy = [...root] as unknown[];
    copy[head as number] = setAt(copy[head as number], rest, value);
    return copy;
  }
  if (typeof root === 'object' && root !== null) {
    const copy: Record<PropertyKey, unknown> = { ...(root as Record<PropertyKey, unknown>) };
    copy[head] = setAt(copy[head], rest, value);
    return copy;
  }
  return root; // path does not exist — leave unchanged
}

export function coerceStringifiedInput(input: unknown, error: z.ZodError): CoerceOutcome {
  // The WHOLE argument object double-encoded: a string where the schema wanted the input object.
  if (typeof input === 'string') {
    const parsed = tryParseStructured(input);
    return parsed !== undefined
      ? { data: parsed, hint: hintFor(['(the whole input)']) }
      : { hint: hintFor(['(the whole input)']) };
  }
  if (typeof input !== 'object' || input === null) return {};

  const stringifiedPaths: string[] = [];
  let out: unknown = input;
  let changed = false;
  for (const issue of error.issues) {
    if (issue.code !== 'invalid_type') continue;
    const expected = (issue as { expected?: string }).expected;
    if (expected !== 'object' && expected !== 'array') continue;
    const value = getAt(input, issue.path as PropertyKey[]);
    if (typeof value !== 'string') continue;
    stringifiedPaths.push(issue.path.join('.') || '(root)');
    const parsed = tryParseStructured(value);
    if (parsed === undefined) continue;
    out = setAt(out, issue.path as PropertyKey[], parsed);
    changed = true;
  }
  return {
    ...(changed ? { data: out } : {}),
    ...(stringifiedPaths.length > 0 ? { hint: hintFor(stringifiedPaths) } : {}),
  };
}

function hintFor(paths: string[]): string {
  return (
    `hint: the value at ${paths.map((p) => `'${p}'`).join(', ')} arrived as a STRING where the schema wants a JSON ` +
    'object/array. Pass the structure itself as the tool-call argument value — not its serialized text ' +
    '(no JSON-in-a-string, no YAML, no XML, no quoting).'
  );
}
