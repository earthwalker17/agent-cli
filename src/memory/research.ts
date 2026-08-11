import { parseFrontmatter, serializeFrontmatter } from '../shared/docio.js';
import { sanitizeLine } from '../shared/text.js';
import type { ResearchNote } from '../types.js';

/**
 * RESEARCH.md (Session 21; the durable surface Session 19 deliberately deferred to land beside
 * these staleness/provenance semantics): source-backed findings recorded by researcher subagents,
 * folded into a document future sessions can read instead of re-searching — or worse, trusting
 * recall. Before this, findings lived in events alone and vanished from cross-session memory at
 * quit.
 *
 * Everything here is a DETERMINISTIC fold over recorded `research.findings` notes — no model
 * call, no rewriting. A research note is PERISHABLE in a way a lesson is not: every entry keeps
 * its harness-stamped retrieval date, and entries older than RESEARCH_STALE_DAYS are dropped at
 * the next write with an honest count — the stale-confidence failure S19 exists to prevent must
 * not re-enter through the memory system. Entries whose heading has lost its parseable date
 * (hand-edited) are never age-dropped — user content errs toward preservation — but the entry
 * cap still bounds them.
 */

export const RESEARCH_MAX_CHARS = 16_384;
export const RESEARCH_INJECT_CAP_CHARS = 8_192;
export const MAX_RESEARCH_ENTRIES = 50;
export const RESEARCH_STALE_DAYS = 30;

export const RESEARCH_NOTE =
  '> Harness-managed research findings (newest first), recorded by researcher subagents with\n' +
  '> their sources and retrieval dates. PERISHABLE: the web moves — entries older than\n' +
  `> ~${RESEARCH_STALE_DAYS} days are dropped at the next update, and even fresh entries are context,\n` +
  '> NOT authority. Verify anything load-bearing against the current sources before relying on it.\n';

export interface ResearchFoldResult {
  text: string;
  added: number;
  droppedStale: number;
  droppedOverflow: number;
}

interface ResearchEntry {
  noteId: string;
  /** Epoch ms parsed from the heading's retrieval date; null = unparseable (never age-dropped). */
  retrievedMs: number | null;
  heading: string;
  body: string;
}

const HEADING_RE = /^## /;
const HEADING_DATE_RE = /—\s+retrieved\s+(\d{4}-\d{2}-\d{2})/;

function parseEntries(text: string): { fields: Record<string, string> | null; preamble: string; entries: ResearchEntry[] } {
  const { fields, body } = parseFrontmatter(text);
  const lines = body.split('\n');
  const headingIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i]!)) headingIdx.push(i);
  }
  if (headingIdx.length === 0) return { fields, preamble: body, entries: [] };
  const preamble = lines.slice(0, headingIdx[0]!).join('\n');
  const entries: ResearchEntry[] = [];
  for (let h = 0; h < headingIdx.length; h++) {
    const start = headingIdx[h]!;
    const end = h + 1 < headingIdx.length ? headingIdx[h + 1]! : lines.length;
    const heading = lines[start]!;
    const noteId = heading.slice(3).trim().split(/\s/, 1)[0] ?? '';
    const dateMatch = HEADING_DATE_RE.exec(heading);
    const parsedMs = dateMatch !== null ? Date.parse(`${dateMatch[1]!}T00:00:00.000Z`) : Number.NaN;
    const bodyText = lines.slice(start + 1, end).join('\n');
    entries.push({
      noteId,
      retrievedMs: Number.isFinite(parsedMs) ? parsedMs : null,
      heading,
      body: bodyText.length > 0 ? `${bodyText}\n` : '',
    });
  }
  return { fields, preamble, entries };
}

function renderNote(n: ResearchNote): ResearchEntry {
  const date = n.retrievedAt.slice(0, 10);
  const parsedMs = Date.parse(`${date}T00:00:00.000Z`);
  const lines = [
    '',
    sanitizeLine(n.claim),
    '',
    `- ${n.corroboration} · confidence ${n.confidence}`,
    `- sources: ${n.sources.map((s) => sanitizeLine(s)).join(' · ')}`,
    `- relevance: ${sanitizeLine(n.relevance)}`,
    '',
  ];
  return {
    noteId: sanitizeLine(n.noteId),
    retrievedMs: Number.isFinite(parsedMs) ? parsedMs : null,
    heading: `## ${sanitizeLine(n.noteId)} — retrieved ${date}`,
    body: `${lines.join('\n')}`,
  };
}

/**
 * Fold this session's recorded notes into the document: insert-by-noteId (idempotent across
 * resume re-folds — the same log re-folded adds nothing), newest-first by retrieval date,
 * age-drop past RESEARCH_STALE_DAYS with an honest count, then the entry and char caps
 * drop-oldest. Returns the counts alongside the text so the write site can record them.
 */
export function foldResearchDoc(currentText: string, notes: readonly ResearchNote[], nowIso: string): ResearchFoldResult {
  const parsed = parseEntries(currentText);
  const existing = new Set(parsed.entries.map((e) => e.noteId));
  const incoming = notes.filter((n) => !existing.has(sanitizeLine(n.noteId))).map(renderNote);
  const added = incoming.length;

  let entries = [...incoming, ...parsed.entries];
  // Newest first. Entries without a parseable date sort AFTER dated ones (they cannot claim
  // freshness) but are never age-dropped below.
  entries.sort((a, b) => (b.retrievedMs ?? Number.MIN_SAFE_INTEGER) - (a.retrievedMs ?? Number.MIN_SAFE_INTEGER));

  const nowMs = Date.parse(nowIso);
  const staleBefore = Number.isFinite(nowMs) ? nowMs - RESEARCH_STALE_DAYS * 24 * 60 * 60 * 1000 : Number.MIN_SAFE_INTEGER;
  const fresh = entries.filter((e) => e.retrievedMs === null || e.retrievedMs >= staleBefore);
  const droppedStale = entries.length - fresh.length;
  entries = fresh;

  let droppedOverflow = 0;
  while (entries.length > MAX_RESEARCH_ENTRIES) {
    entries.pop();
    droppedOverflow++;
  }

  const fields = { 'generated-by': 'agent-cli', doc: 'research', updated: nowIso };
  const preamble = parsed.preamble.trim().length > 0 ? parsed.preamble : `${RESEARCH_NOTE}\n`;
  let text = serialize(fields, preamble, entries, droppedStale, droppedOverflow);
  while (text.length > RESEARCH_MAX_CHARS && entries.length > 1) {
    entries.pop();
    droppedOverflow++;
    text = serialize(fields, preamble, entries, droppedStale, droppedOverflow);
  }
  if (text.length > RESEARCH_MAX_CHARS) {
    text = `${text.slice(0, RESEARCH_MAX_CHARS)}\n> (truncated to the memory budget)\n`;
  }
  return { text, added, droppedStale, droppedOverflow };
}

function serialize(
  fields: Record<string, string>,
  preamble: string,
  entries: readonly ResearchEntry[],
  droppedStale: number,
  droppedOverflow: number,
): string {
  const parts = [serializeFrontmatter(fields), ensureTrailingBlank(preamble)];
  // Leading markers (the journal discipline): a hard budget slice can never erase them.
  if (droppedStale > 0) parts.push(`> (${droppedStale} entr${droppedStale === 1 ? 'y' : 'ies'} older than ${RESEARCH_STALE_DAYS} days dropped as stale)\n\n`);
  if (droppedOverflow > 0) parts.push(`> (${droppedOverflow} older entr${droppedOverflow === 1 ? 'y' : 'ies'} dropped to stay within the memory budget)\n\n`);
  for (const e of entries) parts.push(`${e.heading}\n${ensureTrailingBlank(e.body)}`);
  return parts.join('');
}

function ensureTrailingBlank(text: string): string {
  const t = text.replace(/\s+$/, '');
  return t.length > 0 ? `${t}\n\n` : '';
}
