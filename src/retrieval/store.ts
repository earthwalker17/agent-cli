import fs from 'node:fs';
import path from 'node:path';
import { isProbablyBinary } from '../shared/diff.js';
import { isSecretName } from '../policy/engine.js';
import { extractFileFacts, langForPath, MAX_EXTRACT_BYTES, type FileFacts } from './extract.js';
import type { Inventory } from './inventory.js';
import type { PolicyRules } from '../types.js';

/**
 * The persisted retrieval index (Session 10): derived, idempotent cache of per-file extraction
 * facts at `<projectDir>/index/retrieval.json`. Written ONLY at session assembly (harness-owned,
 * pre-turn) — the model-facing retrieve tool holds a read-only in-memory handle, so a
 * command-less observe tool never mutates durable state (the S6 trap).
 *
 * No lock, deliberately — contrast runtime/worktrees.ts, whose registry needs a locked
 * read-modify-write because concurrent entries must MERGE and a lost entry breaks the crash
 * sweep. This file is idempotent derived data: any consistent snapshot is valid, atomic
 * tmp+rename prevents torn reads, rebuild is the recovery, and the single write point makes a
 * concurrent-writer race rare and harmless (last writer wins).
 */

export const INDEX_VERSION = 1;

export interface IndexEntry extends FileFacts {
  size: number;
  mtimeMs: number;
}

export interface RetrievalIndex {
  version: number;
  /** Repo HEAD at the last write; disclosure only (staleness is per-file stat-diff). */
  head: string | null;
  generatedAt: string;
  entries: Record<string, IndexEntry>;
}

export interface IndexBuildResult {
  index: RetrievalIndex;
  /** 'partial' = the wall budget left eligible files unextracted (converges next session). */
  state: 'full' | 'partial';
  /** 'cold' = no usable prior file existed (missing, corrupt, or version-mismatched). */
  cache: 'cold' | 'warm';
  /** Files (re)extracted during THIS load. */
  extracted: number;
  /** Eligible files skipped by the wall budget this load. */
  skippedBudget: number;
  /** False when the index could not be persisted (session proceeds; cache is advisory). */
  persisted: boolean;
  durationMs: number;
}

export const DEFAULT_BUILD_BUDGET_MS = 10_000;

export interface LoadIndexOptions {
  indexFile: string;
  root: string;
  inventory: Inventory;
  head: string | null;
  budgetMs?: number;
  rules?: PolicyRules;
  /** Injectable time for deterministic budget tests. */
  now?: () => number;
  clockIso?: () => string;
}

function readPrior(indexFile: string): RetrievalIndex | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as RetrievalIndex;
    if (parsed === null || typeof parsed !== 'object') return null;
    if (parsed.version !== INDEX_VERSION) return null;
    if (parsed.entries === null || typeof parsed.entries !== 'object') return null;
    return parsed;
  } catch {
    return null; // missing/corrupt ⇒ cold rebuild; a cache failure must never block a session
  }
}

/** Eligible = supported language, small enough to read, never secret-named. */
function eligible(relPath: string, size: number, rules?: PolicyRules): boolean {
  if (langForPath(relPath) === null) return false;
  if (size > MAX_EXTRACT_BYTES) return false;
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  return !isSecretName(base, rules?.secretPatterns);
}

export function loadOrBuildIndex(opts: LoadIndexOptions): IndexBuildResult {
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUILD_BUDGET_MS;
  const started = now();
  const prior = readPrior(opts.indexFile);
  const cache: 'cold' | 'warm' = prior !== null ? 'warm' : 'cold';

  const entries: Record<string, IndexEntry> = {};
  let extracted = 0;
  let skippedBudget = 0;
  let dirty = prior === null;

  for (const f of opts.inventory.files) {
    if (!eligible(f.relPath, f.size, opts.rules)) continue;
    const old = prior?.entries[f.relPath];
    if (old !== undefined && old.size === f.size && old.mtimeMs === f.mtimeMs) {
      entries[f.relPath] = old;
      continue;
    }
    if (now() - started > budgetMs) {
      skippedBudget++;
      // A stale prior entry still beats nothing for ranking; 'partial' discloses it.
      if (old !== undefined) entries[f.relPath] = old;
      continue;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(opts.root, f.relPath));
    } catch {
      dirty = true;
      continue; // vanished mid-build
    }
    const facts: FileFacts = isProbablyBinary(buf)
      ? { lang: null, symbols: [], imports: [] }
      : extractFileFacts(f.relPath, buf.subarray(0, MAX_EXTRACT_BYTES).toString('utf8'));
    entries[f.relPath] = { size: f.size, mtimeMs: f.mtimeMs, ...facts };
    extracted++;
    dirty = true;
  }

  // Entries for files no longer in the inventory are dropped simply by not carrying them over.
  if (prior !== null && Object.keys(prior.entries).length !== Object.keys(entries).length) dirty = true;

  const generatedAt = dirty ? (opts.clockIso?.() ?? new Date().toISOString()) : prior!.generatedAt;
  const index: RetrievalIndex = { version: INDEX_VERSION, head: opts.head, generatedAt, entries };

  let persisted = true;
  if (dirty) {
    const tmp = opts.indexFile + `.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
    try {
      fs.mkdirSync(path.dirname(opts.indexFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(index));
      fs.renameSync(tmp, opts.indexFile);
    } catch {
      persisted = false; // advisory cache; the in-memory index still serves this session
      try {
        fs.rmSync(tmp, { force: true }); // never leave orphan tmp files accumulating
      } catch {
        /* best effort */
      }
    }
  }

  return {
    index,
    state: skippedBudget > 0 ? 'partial' : 'full',
    cache,
    extracted,
    skippedBudget,
    persisted,
    durationMs: Math.max(0, now() - started),
  };
}
