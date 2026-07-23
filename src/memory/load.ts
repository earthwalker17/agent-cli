import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../store/event-log.js';
import type { ProjectLayout } from '../store/layout.js';
import { memoryDir, readDocCapped, type MemoryDoc } from './store.js';
import { parseCodebase, isStale } from './codebase.js';

/**
 * Session-start memory load: the three project-memory documents, read with hard caps and
 * never-throwing degrades (memory is context — a broken doc must not block a session), plus a
 * crash note derived from LOG evidence (a recent session whose log never recorded session.ended),
 * never from journal absence — child task sessions and legitimately-skipped sessions must not
 * read as crashes.
 */

export const AGENT_MD_CAP_CHARS = 24_576;
export const JOURNAL_INJECT_CAP_CHARS = 12_288;
export const CODEBASE_CAP_CHARS = 16_384;
/** How many recent sibling logs the crash check inspects (bounded first/last-line reads only). */
const CRASH_SCAN_LOGS = 5;

export interface LoadedMemory {
  agent: MemoryDoc;
  journal: MemoryDoc & { sessionCount: number };
  codebase: MemoryDoc & { stale: boolean };
  /** One-line banner summary, e.g. "AGENT.md 2.1k · journal 8.4k (3 sessions) · codebase (stale)". */
  bannerLine: string;
  /** Honest note about a recent sibling log with no recorded clean end; null when none. */
  crashNote: string | null;
}

export interface LoadMemoryOptions {
  /** The session being resumed (its own log legitimately has no session.ended yet). */
  resumeId?: string;
  /** The current workspace-map digest, for codebase staleness labeling. */
  currentMapSha256: string;
  /** Session 10 (additive): the current inventory digest — preferred staleness basis when the stamp has one. */
  currentInventorySha256?: string;
}

export function loadMemory(layout: ProjectLayout, workspaceRoot: string, opts: LoadMemoryOptions): LoadedMemory {
  const dir = memoryDir(layout.projectDir);
  const agent = readDocCapped(path.join(workspaceRoot, 'AGENT.md'), 'AGENT.md', AGENT_MD_CAP_CHARS);
  // The journal is newest-first by construction, so a top slice keeps the most recent entries.
  const journalDoc = readDocCapped(path.join(dir, 'JOURNAL.md'), 'JOURNAL.md', JOURNAL_INJECT_CAP_CHARS);
  const codebaseDoc = readDocCapped(path.join(dir, 'CODEBASE.md'), 'CODEBASE.md', CODEBASE_CAP_CHARS);

  const sessionCount = (journalDoc.text.match(/^## Session /gm) ?? []).length;
  const { stamp } = parseCodebase(codebaseDoc.text);
  const stale =
    codebaseDoc.status === 'ok' || codebaseDoc.status === 'oversize'
      ? isStale(stamp, opts.currentMapSha256, opts.currentInventorySha256)
      : false;

  const journal = { ...journalDoc, sessionCount };
  const codebase = { ...codebaseDoc, stale };
  return {
    agent,
    journal,
    codebase,
    bannerLine: bannerLine(agent, journal, codebase),
    crashNote: detectCrashNote(layout, opts.resumeId),
  };
}

function bannerLine(agent: MemoryDoc, journal: MemoryDoc & { sessionCount: number }, codebase: MemoryDoc & { stale: boolean }): string {
  const parts: string[] = [];
  if (loaded(agent)) parts.push(`AGENT.md ${kb(agent.bytes)}${flag(agent)}`);
  if (loaded(journal)) parts.push(`journal ${kb(journal.bytes)} (${journal.sessionCount} session${journal.sessionCount === 1 ? '' : 's'})${flag(journal)}`);
  if (loaded(codebase)) parts.push(`codebase ${kb(codebase.bytes)} (${codebase.stale ? 'may be stale' : 'fresh'})${flag(codebase)}`);
  for (const d of [agent, journal, codebase]) {
    if (d.status === 'unreadable') parts.push(`${d.name} UNREADABLE (skipped)`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'none';
}

function loaded(d: MemoryDoc): boolean {
  return d.status === 'ok' || d.status === 'oversize';
}

function flag(d: MemoryDoc): string {
  return d.truncated ? ' [truncated]' : '';
}

function kb(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}k` : `${bytes}b`;
}

/**
 * A recent sibling log that never recorded session.ended is reported honestly. Bounded reads
 * only; subagent child logs (lineage on session.started) and the resume target are skipped.
 * The wording covers both true crashes and sessions still live in another terminal — this is
 * a note, not a verdict.
 */
function detectCrashNote(layout: ProjectLayout, resumeId?: string): string | null {
  let ids: string[];
  try {
    ids = fs
      .readdirSync(layout.sessionsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .sort()
      .reverse()
      .slice(0, CRASH_SCAN_LOGS);
  } catch {
    return null;
  }
  for (const id of ids) {
    if (id === resumeId) continue;
    const file = layout.sessionFile(id);
    const first = EventLog.readFirstEvent(file);
    if (first === undefined || first.type !== 'session.started') continue;
    if ((first as { lineage?: unknown }).lineage !== undefined) continue; // a subagent task session
    const last = EventLog.readLastEvent(file);
    if (last !== undefined && last.type === 'session.ended') return null; // newest non-child session ended cleanly
    return (
      `previous session ${id} did not record a clean end (it may have crashed, or may still be ` +
      `running elsewhere). Its evidence log survives: agent report ${id}`
    );
  }
  return null;
}
