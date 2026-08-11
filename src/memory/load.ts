import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../store/event-log.js';
import type { ProjectLayout } from '../store/layout.js';
import { memoryDir, readDocCapped, type MemoryDoc } from './store.js';
import { parseCodebase, isStale } from './codebase.js';
import { LESSONS_INJECT_CAP_CHARS } from './lessons.js';
import { RESEARCH_INJECT_CAP_CHARS } from './research.js';

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
/**
 * The GLOBAL user constitution (S21): `<stateRoot>/AGENT.md` — the user's durable instructions
 * for every workspace on this machine, layered BELOW the project AGENT.md (the ecosystem's
 * local-wins convention). Deliberately smaller than the project cap: a machine-wide profile is
 * prose about the person, not a project constitution.
 */
export const USER_AGENT_CAP_CHARS = 16_384;
/** How many recent sibling logs the crash check inspects (bounded first/last-line reads only). */
const CRASH_SCAN_LOGS = 5;

export interface LoadedMemory {
  /** S21: the global user constitution from the state root (name 'AGENT.md', scope user). */
  user: MemoryDoc;
  agent: MemoryDoc;
  journal: MemoryDoc & { sessionCount: number };
  codebase: MemoryDoc & { stale: boolean };
  /** S21: durable project lessons (harness-managed, newest first). */
  lessons: MemoryDoc;
  /** S21: durable research findings (harness-managed, newest first, perishable by design). */
  research: MemoryDoc;
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
  const user = readDocCapped(path.join(layout.stateRoot, 'AGENT.md'), 'AGENT.md', USER_AGENT_CAP_CHARS);
  const agent = readDocCapped(path.join(workspaceRoot, 'AGENT.md'), 'AGENT.md', AGENT_MD_CAP_CHARS);
  // The journal is newest-first by construction, so a top slice keeps the most recent entries.
  const journalDoc = readDocCapped(path.join(dir, 'JOURNAL.md'), 'JOURNAL.md', JOURNAL_INJECT_CAP_CHARS);
  const codebaseDoc = readDocCapped(path.join(dir, 'CODEBASE.md'), 'CODEBASE.md', CODEBASE_CAP_CHARS);
  // Newest-first by construction (like the journal), so the top slice keeps the newest entries.
  const lessonsDoc = readDocCapped(path.join(dir, 'LESSONS.md'), 'LESSONS.md', LESSONS_INJECT_CAP_CHARS);
  const researchDoc = readDocCapped(path.join(dir, 'RESEARCH.md'), 'RESEARCH.md', RESEARCH_INJECT_CAP_CHARS);

  const sessionCount = (journalDoc.text.match(/^## Session /gm) ?? []).length;
  const { stamp } = parseCodebase(codebaseDoc.text);
  const stale =
    codebaseDoc.status === 'ok' || codebaseDoc.status === 'oversize'
      ? isStale(stamp, opts.currentMapSha256, opts.currentInventorySha256)
      : false;

  const journal = { ...journalDoc, sessionCount };
  const codebase = { ...codebaseDoc, stale };
  return {
    user,
    agent,
    journal,
    codebase,
    lessons: lessonsDoc,
    research: researchDoc,
    bannerLine: bannerLine(user, agent, journal, codebase, lessonsDoc, researchDoc),
    crashNote: detectCrashNote(layout, opts.resumeId),
  };
}

function bannerLine(
  user: MemoryDoc,
  agent: MemoryDoc,
  journal: MemoryDoc & { sessionCount: number },
  codebase: MemoryDoc & { stale: boolean },
  lessons: MemoryDoc,
  research: MemoryDoc,
): string {
  const parts: string[] = [];
  if (loaded(user)) parts.push(`global AGENT.md ${kb(user.bytes)}${flag(user)}`);
  if (loaded(agent)) parts.push(`AGENT.md ${kb(agent.bytes)}${flag(agent)}`);
  if (loaded(journal)) parts.push(`journal ${kb(journal.bytes)} (${journal.sessionCount} session${journal.sessionCount === 1 ? '' : 's'})${flag(journal)}`);
  if (loaded(codebase)) parts.push(`codebase ${kb(codebase.bytes)} (${codebase.stale ? 'may be stale' : 'fresh'})${flag(codebase)}`);
  if (loaded(lessons)) parts.push(`lessons ${kb(lessons.bytes)}${flag(lessons)}`);
  if (loaded(research)) parts.push(`research ${kb(research.bytes)}${flag(research)}`);
  for (const d of [user, agent, journal, codebase, lessons, research]) {
    if (d.status === 'unreadable') parts.push(`${d.name === 'AGENT.md' && d === user ? 'global AGENT.md' : d.name} UNREADABLE (skipped)`);
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
    // Clean-end predicate: the newest LIFECYCLE event decides. The plain last-line check
    // accused sessions falsely — `agent checkpoint/undo/commit` append provenance events to an
    // ended log, so "last event is not session.ended" does not mean the session never ended.
    // A resumed-and-killed session correctly stays a note (its newest lifecycle event is
    // session.resumed); an empty scan (no lifecycle event inside the bounded window) keeps the
    // note too — a long crashed session's lifecycle events sit far behind its tool-event tail.
    const lastLifecycle = EventLog.readLastEventOfTypes(file, ['session.started', 'session.resumed', 'session.ended']);
    if (lastLifecycle !== undefined && lastLifecycle.type === 'session.ended') return null; // ended cleanly
    return (
      `previous session ${id} did not record a clean end (it may have crashed, or may still be ` +
      `running elsewhere). Its evidence log survives: agent report ${id}`
    );
  }
  return null;
}
