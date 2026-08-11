import path from 'node:path';
import { z } from 'zod';
import type { ProjectLayout } from '../store/layout.js';
import type { Session } from '../runtime/session.js';
import { elideHistory } from '../runtime/elision.js';
import { toToolSchema } from '../tools/index.js';
import { buildReport } from '../report/report.js';
import type { ContentBlock, ProviderRequest, Usage } from '../types.js';
import { buildEntry, parseJournal, rollJournal, type Narrative } from './journal.js';
import { stampCodebase } from './codebase.js';
import { parseLessons, rollLessons, MAX_LESSONS_PER_SESSION, type LessonProposal } from './lessons.js';
import { foldResearchDoc } from './research.js';
import { memoryDir, readDocCapped, writeDocAtomic } from './store.js';
import { readPlanState } from '../plan/canonical.js';
import { foldGraphState } from '../plan/graph-state.js';
import { computeAcceptance } from '../runtime/acceptance.js';

/**
 * End-of-session project-memory update. Runs BEFORE endSession (so the memory.* evidence lands
 * in the log) and NEVER throws or blocks the session end. The narrative comes from ONE bounded
 * provider call that reuses the session's exact cached prefix (same system, same tools, same
 * elided message view + one instruction message) — any failure degrades to a deterministic
 * skeleton entry that says so. The journal is re-read from disk at write time (another terminal
 * may have quit since this session started), rolled, and written atomically.
 */

const NARRATIVE_MAX_TOKENS = 4000;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Full-parse read budget for the roll (generous; the roll itself re-enforces the doc cap). */
const ROLL_READ_CAP_CHARS = 262_144;

const NarrativeResponse = z
  .object({
    objective: z.string().max(500),
    outcome: z.string().max(2000),
    decisions: z.array(z.string().max(500)).max(10),
    openIssues: z.array(z.string().max(500)).max(10),
    nextSteps: z.array(z.string().max(500)).max(10),
    codebaseUpdate: z.union([z.null(), z.object({ text: z.string().max(20_000) }).strict()]),
    // S21: durable lessons, OPTIONAL by design — .strict() degrades the WHOLE narrative to a
    // skeleton on any shape error, and "the model omitted a new key" must cost the lessons,
    // never the journal. Absence reads as null.
    lessons: z
      .union([
        z.null(),
        z
          .array(
            z
              .object({
                slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
                title: z.string().min(1).max(80),
                body: z.string().min(1).max(500),
              })
              .strict(),
          )
          .max(MAX_LESSONS_PER_SESSION),
      ])
      .optional(),
  })
  .strict();

export interface MemoryUpdateDeps {
  layout: ProjectLayout;
  /** config.memoryUpdates !== false — disabled sessions record a skip, never silence. */
  enabled: boolean;
  /** The session-end reason the caller is about to record (the update runs before endSession). */
  endedReason: string;
  announce?: (line: string) => void;
  timeoutMs?: number;
}

export async function runMemoryUpdate(session: Session, deps: MemoryUpdateDeps): Promise<void> {
  try {
    await runInner(session, deps);
  } catch (err) {
    // Memory must never block a session end. Try to leave a trace; swallow even that failing.
    try {
      session.log.append({ type: 'memory.updated', doc: 'journal', status: 'failed', detail: (err as Error).message });
    } catch {
      /* the log itself is failing; endSession will handle it */
    }
  }
}

async function runInner(session: Session, deps: MemoryUpdateDeps): Promise<void> {
  if (!deps.enabled) {
    session.log.append({ type: 'memory.narrative', status: 'skipped', durationMs: 0, detail: 'disabled by config (memoryUpdates: false)' });
    session.log.append({ type: 'memory.updated', doc: 'journal', status: 'skipped', detail: 'disabled by config' });
    return;
  }
  if (!isProductive(session)) {
    session.log.append({ type: 'memory.narrative', status: 'skipped', durationMs: 0, detail: 'no productive activity (no executed tool, mutation, or command)' });
    session.log.append({ type: 'memory.updated', doc: 'journal', status: 'skipped', detail: 'no productive activity' });
    return;
  }

  deps.announce?.('updating project memory…');
  const dir = memoryDir(deps.layout.projectDir);
  const codebaseFile = path.join(dir, 'CODEBASE.md');
  const codebaseExists = readDocCapped(codebaseFile, 'CODEBASE.md', 1).status !== 'missing';

  const outcome = await requestNarrative(session, codebaseExists, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  session.log.append({
    type: 'memory.narrative',
    status: outcome.narrative !== null ? 'ok' : 'failed',
    durationMs: outcome.durationMs,
    ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
    ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
  });

  // Journal: derive the evidence from the log, re-read the doc from disk, roll, write atomically.
  const nowIso = session.clock.iso();
  const entry = buildEntry({
    sessionId: session.id,
    endedAt: nowIso,
    endedReason: deps.endedReason,
    report: buildReport({ events: session.log.events }).json,
    logPath: deps.layout.sessionFile(session.id),
    narrative: outcome.narrative,
    ...(outcome.narrative === null && outcome.detail !== undefined ? { narrativeUnavailableReason: outcome.detail } : {}),
    handoff: buildHandoffLines(deps.layout, session),
  });
  const journalFile = path.join(dir, 'JOURNAL.md');
  const current = readDocCapped(journalFile, 'JOURNAL.md', ROLL_READ_CAP_CHARS);
  if (current.status === 'unreadable') {
    // Refusing to overwrite bytes we could not read (the snapshot-store drift-refusal instinct).
    session.log.append({ type: 'memory.updated', doc: 'journal', status: 'failed', detail: 'existing JOURNAL.md unreadable; refusing to overwrite it' });
  } else {
    try {
      const rolled = rollJournal(parseJournal(current.text), entry, nowIso);
      const written = await writeDocAtomic(journalFile, rolled);
      session.log.append({ type: 'memory.updated', doc: 'journal', status: 'written', sha256: written.sha256, bytes: written.bytes });
      const count = (rolled.match(/^## Session /gm) ?? []).length;
      deps.announce?.(`memory: journal updated (${count} session${count === 1 ? '' : 's'} on record)`);
    } catch (err) {
      session.log.append({ type: 'memory.updated', doc: 'journal', status: 'failed', detail: (err as Error).message });
      deps.announce?.('memory: journal update FAILED (see the session log)');
    }
  }

  // Lessons (S21): merged only when the model proposed any — the same disk discipline as the
  // journal (re-read, refuse-if-unreadable, roll, atomic write). A skipped write is recorded,
  // matching the codebase pattern, so "no lessons" is evidence rather than silence.
  const lessonsFile = path.join(dir, 'LESSONS.md');
  if (outcome.lessons === null || outcome.lessons.length === 0) {
    session.log.append({ type: 'memory.updated', doc: 'lessons', status: 'skipped', detail: outcome.narrative === null ? 'no narrative' : 'no lessons proposed' });
  } else {
    const currentLessons = readDocCapped(lessonsFile, 'LESSONS.md', ROLL_READ_CAP_CHARS);
    if (currentLessons.status === 'unreadable') {
      session.log.append({ type: 'memory.updated', doc: 'lessons', status: 'failed', detail: 'existing LESSONS.md unreadable; refusing to overwrite it' });
    } else {
      try {
        const rolled = rollLessons(parseLessons(currentLessons.text), outcome.lessons, { sessionId: session.id, nowIso });
        const written = await writeDocAtomic(lessonsFile, rolled);
        session.log.append({ type: 'memory.updated', doc: 'lessons', status: 'written', sha256: written.sha256, bytes: written.bytes });
        deps.announce?.(`memory: ${outcome.lessons.length} lesson${outcome.lessons.length === 1 ? '' : 's'} recorded`);
      } catch (err) {
        session.log.append({ type: 'memory.updated', doc: 'lessons', status: 'failed', detail: (err as Error).message });
      }
    }
  }

  // Research (S21): a DETERMINISTIC fold over this session's recorded findings — no model call
  // involved, so it succeeds even when the narrative failed. Notes were sanitized and
  // harness-stamped at record time; dedupe by noteId keeps resume re-folds idempotent.
  const researchNotes = session.log.events.flatMap((e) => (e.type === 'research.findings' ? e.notes : []));
  const researchFile = path.join(dir, 'RESEARCH.md');
  if (researchNotes.length === 0) {
    session.log.append({ type: 'memory.updated', doc: 'research', status: 'skipped', detail: 'no research findings recorded this session' });
  } else {
    const currentResearch = readDocCapped(researchFile, 'RESEARCH.md', ROLL_READ_CAP_CHARS);
    if (currentResearch.status === 'unreadable') {
      session.log.append({ type: 'memory.updated', doc: 'research', status: 'failed', detail: 'existing RESEARCH.md unreadable; refusing to overwrite it' });
    } else {
      try {
        const folded = foldResearchDoc(currentResearch.text, researchNotes, nowIso);
        const written = await writeDocAtomic(researchFile, folded.text);
        session.log.append({
          type: 'memory.updated',
          doc: 'research',
          status: 'written',
          sha256: written.sha256,
          bytes: written.bytes,
          detail: `${folded.added} added${folded.droppedStale > 0 ? `; ${folded.droppedStale} stale dropped` : ''}${folded.droppedOverflow > 0 ? `; ${folded.droppedOverflow} dropped to budget` : ''}`,
        });
        if (folded.added > 0) deps.announce?.(`memory: ${folded.added} research finding${folded.added === 1 ? '' : 's'} recorded`);
      } catch (err) {
        session.log.append({ type: 'memory.updated', doc: 'research', status: 'failed', detail: (err as Error).message });
      }
    }
  }

  // Codebase: rewritten only when the model proposed an update (or supplied the missing doc).
  if (outcome.codebaseUpdate === null) {
    session.log.append({ type: 'memory.updated', doc: 'codebase', status: 'skipped', detail: outcome.narrative === null ? 'no narrative' : 'no update proposed' });
    return;
  }
  try {
    const mapped = session.log.events.find((e) => e.type === 'workspace.mapped');
    const gitCtx = session.log.events.find((e) => e.type === 'git.context');
    const stamped = stampCodebase(outcome.codebaseUpdate.text, {
      sessionId: session.id,
      updatedAt: nowIso,
      mapSha256: mapped !== undefined && mapped.type === 'workspace.mapped' ? mapped.sha256 : '',
      inventorySha256:
        mapped !== undefined && mapped.type === 'workspace.mapped' ? (mapped.inventorySha256 ?? null) : null,
      head: gitCtx !== undefined && gitCtx.type === 'git.context' ? gitCtx.head : null,
    });
    const written = await writeDocAtomic(codebaseFile, stamped);
    session.log.append({ type: 'memory.updated', doc: 'codebase', status: 'written', sha256: written.sha256, bytes: written.bytes });
    deps.announce?.('memory: codebase summary updated');
  } catch (err) {
    session.log.append({ type: 'memory.updated', doc: 'codebase', status: 'failed', detail: (err as Error).message });
  }
}

/**
 * The deterministic Handoff block (Session 11.5): acceptance state, plan execution, unfinished
 * work, and the resume pointer — derived from events + the plan file, one code path for the
 * REPL and one-shot alike. The LIVE derivation governs the unfinished list and the resume
 * pointer (review F1: a recorded acceptance freezes ITS list, but work after it must never
 * hide behind a stale "accepted (complete)"). Never throws (memory must never block an end).
 * Exported for tests.
 */
export function buildHandoffLines(layout: ProjectLayout, session: Session): string[] {
  try {
    const events = session.log.events;
    const state = readPlanState(layout, session.id, events);
    const graph = state.canonical?.graph ?? null;
    const acc = computeAcceptance(state, graph !== null ? foldGraphState(graph, events) : null, events);
    const lines: string[] = [];
    if (acc.accepted !== null) {
      lines.push(
        `- accepted: yes (${acc.accepted.complete ? 'complete' : `partial — ${acc.accepted.unfinished.length} unfinished item(s) recorded`})` +
          (acc.acceptedStale ? ' — work has happened SINCE the acceptance; it covers only work up to that point' : ''),
      );
    } else if (session.mode === 'non-interactive') {
      lines.push('- accepted: not applicable (one-shot session — /accept is a REPL boundary)');
    } else {
      lines.push(`- accepted: no — ${acc.complete ? 'work is complete but was not accepted' : `${acc.unfinished.length} unfinished item(s)`}`);
    }
    lines.push(`- completion: ${acc.summary}`);
    for (const u of acc.unfinished.slice(0, 8)) lines.push(`  - ${u}`);
    if (acc.unfinished.length > 8) lines.push(`  - (+${acc.unfinished.length - 8} more — see the session log)`);
    if (!acc.complete) {
      lines.push(`- resume: agent resume ${session.id}`);
    }
    return lines;
  } catch {
    return [];
  }
}

/** Productive = something actually executed. Skipped/denied calls record ok:false completions. */
function isProductive(session: Session): boolean {
  return session.log.events.some(
    (e) => (e.type === 'tool.completed' && e.ok) || e.type === 'file.mutated' || e.type === 'command.started',
  );
}

interface NarrativeOutcome {
  narrative: Narrative | null;
  codebaseUpdate: { text: string } | null;
  /** S21: proposed durable lessons; null/absent = none this session. */
  lessons: LessonProposal[] | null;
  durationMs: number;
  usage?: Usage;
  detail?: string;
}

async function requestNarrative(session: Session, codebaseExists: boolean, timeoutMs: number): Promise<NarrativeOutcome> {
  const started = session.clock.now();
  const done = (partial: Omit<NarrativeOutcome, 'durationMs'>): NarrativeOutcome => ({
    ...partial,
    durationMs: Math.max(0, session.clock.now() - started),
  });
  try {
    // The exact cached prefix: same system, same tools, same elided view — plus one instruction.
    // The sticky set is part of "same elided view": without it the image pass frees budget and
    // this request RESTORES previously-elided outputs — a divergent view that re-bills the whole
    // suffix uncached on the most expensive call of the session (S20.5 review).
    const elided = elideHistory(session.messages, {
      ...session.contextBudget,
      alreadyElided: [...(session.elidedCallIds ?? new Set<string>())],
    });
    const req: ProviderRequest = {
      model: session.model,
      system: session.system,
      messages: [...elided.messages, { role: 'user', content: [{ type: 'text', text: instruction(codebaseExists) }] }],
      tools: session.tools.map(toToolSchema),
      maxTokens: NARRATIVE_MAX_TOKENS,
    };
    const turn = await session.provider.complete(req, undefined, AbortSignal.timeout(timeoutMs));
    if (turn.stopReason === 'tool_use') {
      return done({ narrative: null, codebaseUpdate: null, lessons: null, usage: turn.usage, detail: 'model attempted tool use instead of answering' });
    }
    const text = turn.blocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const parsed = NarrativeResponse.safeParse(JSON.parse(stripFences(text)));
    if (!parsed.success) {
      return done({ narrative: null, codebaseUpdate: null, lessons: null, usage: turn.usage, detail: 'response failed schema validation' });
    }
    const { codebaseUpdate, lessons, ...narrative } = parsed.data;
    return done({ narrative, codebaseUpdate, lessons: lessons ?? null, usage: turn.usage });
  } catch (err) {
    return done({ narrative: null, codebaseUpdate: null, lessons: null, detail: `narrative call failed: ${(err as Error).message}` });
  }
}

function stripFences(text: string): string {
  const t = text.trim();
  if (!t.startsWith('```')) return t;
  const firstNl = t.indexOf('\n');
  const lastFence = t.lastIndexOf('```');
  if (firstNl === -1 || lastFence <= firstNl) return t;
  return t.slice(firstNl + 1, lastFence).trim();
}

function instruction(codebaseExists: boolean): string {
  return [
    'The session is ending. Write the project-memory journal entry for THIS session.',
    'Respond with ONLY a JSON object (no prose, no code fences, no tool calls) of this exact shape:',
    '{',
    '  "objective": string,          // one line: what this session set out to do',
    '  "outcome": string,            // short paragraph: what actually happened, grounded in what you verified',
    '  "decisions": string[],        // lasting decisions made (with the why, briefly); [] if none',
    '  "openIssues": string[],       // known problems / unverified work left behind; [] if none',
    '  "nextSteps": string[],        // the recommended next actions; [] if none',
    `  "codebaseUpdate": null | { "text": string }  // full replacement CODEBASE.md body (markdown: repo shape, modules, key flows). Provide it ONLY if the repository structure materially changed this session${codebaseExists ? '' : ' or because no codebase document exists yet (it is currently missing — provide one if you understand the repository)'}; otherwise null`,
    `  "lessons": null | [ { "slug": string, "title": string, "body": string } ]  // up to ${String(MAX_LESSONS_PER_SESSION)} DURABLE, NON-OBVIOUS lessons about working in THIS repository that would save a future session real time: pitfalls actually hit, failure patterns diagnosed, debugging tricks that worked, conventions discovered the hard way. Ground each in something that HAPPENED this session; slug is a short kebab-case id (reusing a slug from the injected LESSONS.md UPDATES that entry); title ≤80 chars, body ≤500 chars. null when this session taught nothing durable — most sessions teach nothing durable, and an obvious or session-specific "lesson" is noise that crowds out real ones`,
    '}',
    'Report honestly: do not claim verification that did not happen; unverified work belongs in openIssues.',
  ].join('\n');
}
