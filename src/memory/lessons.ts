import { parseFrontmatter, serializeFrontmatter } from '../shared/docio.js';
import { sanitizeLine } from '../shared/text.js';

/**
 * LESSONS.md (Session 21): the project's durable lessons — reusable pitfalls, failure patterns,
 * debugging knowledge and conventions discovered the hard way, kept so future sessions stop
 * re-paying for them. Harness-managed like the journal: the model PROPOSES lessons in the
 * end-of-session narrative response (never through a tool, never mid-session), the harness
 * merges them by slug, stamps provenance, and enforces the growth policy. Pure text logic —
 * no I/O here (the journal.ts discipline).
 *
 * Growth is bounded three ways, all pinned in test/limits.test.ts: at most
 * MAX_LESSONS_PER_SESSION proposals per session (the zod schema refuses more), at most
 * MAX_LESSONS entries on disk (oldest dropped with a leading marker), and LESSONS_MAX_CHARS
 * over the whole document. User edits inside an entry survive byte-verbatim until the model
 * reuses that entry's slug — reusing a slug is an UPDATE, and the proposal replaces the body.
 */

export const LESSONS_MAX_CHARS = 16_384;
export const LESSONS_INJECT_CAP_CHARS = 8_192;
export const MAX_LESSONS = 30;
export const MAX_LESSONS_PER_SESSION = 3;

export const LESSONS_NOTE =
  '> Harness-managed project lessons (newest first): pitfalls, failure patterns and debugging\n' +
  '> knowledge recorded by real sessions. Edits are welcome and preserved (an entry is replaced\n' +
  '> only when a session reuses its slug). Context, NOT authority: verify against the current\n' +
  '> repository before relying on an entry.\n';

export interface LessonProposal {
  slug: string;
  title: string;
  body: string;
}

export interface LessonEntry {
  slug: string;
  /** The full `## <slug> — <title>` heading line, preserved verbatim for existing entries. */
  heading: string;
  /** Entry body including the provenance line; trailing newline normalized by serialize. */
  body: string;
}

export interface ParsedLessons {
  fields: Record<string, string> | null;
  preamble: string;
  entries: LessonEntry[];
}

const HEADING_RE = /^## /;

export function parseLessons(text: string): ParsedLessons {
  const { fields, body } = parseFrontmatter(text);
  const lines = body.split('\n');
  const headingIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i]!)) headingIdx.push(i);
  }
  if (headingIdx.length === 0) return { fields, preamble: body, entries: [] };

  const preamble = lines.slice(0, headingIdx[0]!).join('\n');
  const entries: LessonEntry[] = [];
  for (let h = 0; h < headingIdx.length; h++) {
    const start = headingIdx[h]!;
    const end = h + 1 < headingIdx.length ? headingIdx[h + 1]! : lines.length;
    const heading = lines[start]!;
    const slug = heading.slice(3).trim().split(/\s+—\s+|\s+-\s+|\s/, 1)[0] ?? '';
    const bodyText = lines.slice(start + 1, end).join('\n');
    entries.push({ slug, heading, body: bodyText.length > 0 ? `${bodyText}\n` : '' });
  }
  return { fields, preamble, entries };
}

/**
 * A proposal's body is model text destined for a document the harness re-parses by heading:
 * a body line looking like `## anything` would fabricate an entry boundary on the next parse
 * (and a fence-shaped line would collide with injection neutralization). Lines are sanitized
 * individually (newlines survive; control/bidi bytes do not) and heading-shaped lines are
 * visibly defused — the neutralizeHarnessDelimiters approach, one document over.
 */
function defuseBody(body: string): string {
  return body
    .split('\n')
    .map((l) => (/^\s*#/.test(l) ? `· ${sanitizeLine(l)}` : sanitizeLine(l)))
    .join('\n');
}

export interface LessonStamp {
  sessionId: string;
  /** ISO timestamp; the date half is rendered into the provenance line. */
  nowIso: string;
}

/**
 * Insert-or-replace each proposal by slug (new and updated entries move to the FRONT —
 * newest-first, like the journal), stamp provenance, and enforce the growth policy by dropping
 * the OLDEST entries with a leading marker a budget slice can never erase. Returns the full new
 * document text.
 */
export function rollLessons(parsed: ParsedLessons, proposals: readonly LessonProposal[], stamp: LessonStamp): string {
  const date = stamp.nowIso.slice(0, 10);
  const incoming: LessonEntry[] = proposals.slice(0, MAX_LESSONS_PER_SESSION).map((p) => {
    const slug = sanitizeLine(p.slug);
    return {
      slug,
      heading: `## ${slug} — ${sanitizeLine(p.title)}`,
      body: `\n${defuseBody(p.body.trim())}\n\n*(session ${sanitizeLine(stamp.sessionId)}, ${date})*\n`,
    };
  });
  const incomingSlugs = new Set(incoming.map((e) => e.slug));
  const entries = [...incoming, ...parsed.entries.filter((e) => !incomingSlugs.has(e.slug))];

  const fields = {
    'generated-by': 'agent-cli',
    doc: 'lessons',
    updated: stamp.nowIso,
  };
  const preamble = parsed.preamble.trim().length > 0 ? parsed.preamble : `${LESSONS_NOTE}\n`;

  let dropped = 0;
  while (entries.length > MAX_LESSONS) {
    entries.pop();
    dropped++;
  }
  let text = serialize(fields, preamble, entries, dropped);
  while (text.length > LESSONS_MAX_CHARS && entries.length > 1) {
    entries.pop();
    dropped++;
    text = serialize(fields, preamble, entries, dropped);
  }
  if (text.length > LESSONS_MAX_CHARS) {
    text = `${text.slice(0, LESSONS_MAX_CHARS)}\n> (truncated to the memory budget)\n`;
  }
  return text;
}

function serialize(fields: Record<string, string>, preamble: string, entries: readonly LessonEntry[], dropped: number): string {
  const parts = [serializeFrontmatter(fields), ensureTrailingBlank(preamble)];
  // The drop marker leads the entries (not the tail) so a hard budget slice can never erase it.
  if (dropped > 0) parts.push(`> (${dropped} older lesson${dropped === 1 ? '' : 's'} dropped to stay within the memory budget)\n\n`);
  for (const e of entries) parts.push(`${e.heading}\n${ensureTrailingBlank(e.body)}`);
  return parts.join('');
}

function ensureTrailingBlank(text: string): string {
  const t = text.replace(/\s+$/, '');
  return t.length > 0 ? `${t}\n\n` : '';
}
