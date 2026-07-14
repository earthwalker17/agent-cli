import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { EVENT_SCHEMA_VERSION, type EventBody, type SessionEvent } from '../types.js';
import type { Clock } from '../shared/clock.js';
import { systemClock } from '../shared/clock.js';
import { CorruptLogError, SchemaVersionError, SessionLockedError } from '../shared/errors.js';

interface LockInfo {
  pid: number;
  startedAt: string;
  token: string;
}

interface ParseResult {
  events: SessionEvent[];
  truncatedTail: boolean;
  bad?: { line: number; kind: 'json' | 'version'; found?: number };
  /** Byte length of the committed (newline-terminated) portion of the file. */
  committedBytes: number;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM => the process exists but we may not signal it: treat as alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseRaw(raw: string): ParseResult {
  const events: SessionEvent[] = [];
  let truncatedTail = false;

  const lastNl = raw.lastIndexOf('\n');
  const committed = lastNl >= 0 ? raw.slice(0, lastNl + 1) : '';
  const trailing = raw.slice(committed.length);
  if (trailing.length > 0) truncatedTail = true; // partial final line (crash mid-append)
  const committedBytes = Buffer.byteLength(committed, 'utf8');

  const lines = committed.length > 0 ? committed.slice(0, -1).split('\n') : [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue; // tolerate stray blank lines
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return { events, truncatedTail, bad: { line: i + 1, kind: 'json' }, committedBytes };
    }
    const v = (obj as { v?: unknown }).v;
    if (typeof v === 'number' && v > EVENT_SCHEMA_VERSION) {
      return { events, truncatedTail, bad: { line: i + 1, kind: 'version', found: v }, committedBytes };
    }
    events.push(obj as SessionEvent);
  }
  return { events, truncatedTail, committedBytes };
}

/**
 * Append-only JSONL session log with single-writer locking, tail repair, and strict
 * corruption/version handling. The log is a versioned public contract (evidence is the product),
 * so it is never silently rewritten — repairs and undos are recorded, not hidden.
 */
export class EventLog {
  private lastSeq: number;
  private closed = false;

  private constructor(
    private readonly file: string,
    private readonly lockFilePath: string,
    private readonly clock: Clock,
    /** Committed events present when the log was opened (empty for a fresh session). */
    readonly events: readonly SessionEvent[],
    /** A partial trailing line was discarded on open. */
    readonly repairedTail: boolean,
    /** A stale lock from a dead process was reclaimed. */
    readonly stoleLock: boolean,
  ) {
    this.lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
  }

  static open(opts: {
    file: string;
    lockFile: string;
    clock?: Clock;
    /** Liveness probe for the lock holder; defaults to a real signal-0 check. Injected in tests. */
    isAlive?: (pid: number) => boolean;
  }): EventLog {
    const clock = opts.clock ?? systemClock;
    const stoleLock = EventLog.acquireLock(opts.lockFile, clock, opts.isAlive ?? isPidAlive);

    let events: readonly SessionEvent[] = [];
    let repairedTail = false;
    if (fs.existsSync(opts.file)) {
      const raw = fs.readFileSync(opts.file, 'utf8');
      const parsed = parseRaw(raw);
      if (parsed.bad) {
        EventLog.releaseLock(opts.lockFile);
        if (parsed.bad.kind === 'version') {
          throw new SchemaVersionError(
            `event log written by a newer schema version (found v${parsed.bad.found}, ` +
              `supported v${EVENT_SCHEMA_VERSION}); refusing to read`,
            parsed.bad.found ?? -1,
            EVENT_SCHEMA_VERSION,
          );
        }
        throw new CorruptLogError(
          `event log is corrupt at line ${parsed.bad.line}; refusing to resume`,
          parsed.bad.line,
        );
      }
      if (parsed.truncatedTail) {
        // Discard the partial final line BEFORE any append, so the next line cannot
        // concatenate onto it and turn a tolerable crash into hard corruption.
        fs.truncateSync(opts.file, parsed.committedBytes);
        repairedTail = true;
      }
      events = parsed.events;
    }

    return new EventLog(opts.file, opts.lockFile, clock, events, repairedTail, stoleLock);
  }

  private static acquireLock(
    lockFile: string,
    clock: Clock,
    isAlive: (pid: number) => boolean,
  ): boolean {
    const info: LockInfo = {
      pid: process.pid,
      startedAt: clock.iso(),
      token: randomBytes(8).toString('hex'),
    };
    try {
      fs.writeFileSync(lockFile, JSON.stringify(info), { flag: 'wx' });
      return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    // Lock exists: refuse if a live foreign process holds it; steal if stale.
    let holder: LockInfo | undefined;
    try {
      holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as LockInfo;
    } catch {
      holder = undefined;
    }
    if (holder && holder.pid !== process.pid && isAlive(holder.pid)) {
      throw new SessionLockedError(
        `session is locked by a live process (pid ${holder.pid}); ` +
          `close it or resume a different session`,
        holder.pid,
      );
    }
    fs.writeFileSync(lockFile, JSON.stringify(info)); // reclaim stale/own lock
    return true;
  }

  private static releaseLock(lockFile: string): void {
    try {
      fs.rmSync(lockFile, { force: true });
    } catch {
      /* best effort */
    }
  }

  append(body: EventBody): SessionEvent {
    if (this.closed) throw new Error('append after close');
    const event: SessionEvent = {
      v: EVENT_SCHEMA_VERSION,
      seq: ++this.lastSeq,
      ts: this.clock.iso(),
      ...body,
    };
    fs.appendFileSync(this.file, JSON.stringify(event) + '\n');
    return event;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    EventLog.releaseLock(this.lockFilePath);
  }

  /**
   * Read a log WITHOUT locking or repairing — for the report and session listing, which must
   * work on crashed/active sessions. Never throws: returns everything up to the first bad line.
   */
  static readLenient(file: string): {
    events: SessionEvent[];
    truncatedTail: boolean;
    corruptAt?: { line: number; kind: 'json' | 'version'; found?: number };
  } {
    if (!fs.existsSync(file)) return { events: [], truncatedTail: false };
    const parsed = parseRaw(fs.readFileSync(file, 'utf8'));
    return parsed.bad
      ? { events: parsed.events, truncatedTail: parsed.truncatedTail, corruptAt: parsed.bad }
      : { events: parsed.events, truncatedTail: parsed.truncatedTail };
  }
}
