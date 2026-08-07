import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { truncateForModel } from '../shared/hash.js';
import { isProbablyBinary } from '../shared/diff.js';
import { isSecretName } from '../policy/engine.js';
import { rankForQuery, queryTerms } from '../retrieval/rank.js';
import { MAX_EXTRACT_BYTES } from '../retrieval/extract.js';
import type { RetrievalHandle } from '../retrieval/rank.js';
import type { Tool, ToolResult } from '../types.js';

/**
 * retrieve — task-directed repository lookup over the session's read-only index handle
 * (Session 10). A per-session factory like delegate_task: the handle is built at assembly and
 * NEVER written by this tool (a command-less observe tool must not mutate durable state).
 *
 * Two honesty rules are load-bearing:
 * - Candidates come from the index, but every line excerpt is read LIVE from disk at query
 *   time — a stale index can misrank, it can never produce a misleading line reference.
 * - The output states coverage (files indexed, languages, partial state) and drops hits whose
 *   files no longer exist, so ranking gaps are visible instead of silent.
 */

const RetrieveInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(400)
      .describe('The task or topic to find code for, in plain words (e.g. "context elision budget", "approval forwarding queue")'),
    max_results: z.number().int().min(1).max(50).optional().describe('Maximum ranked hits to return (default 15)'),
    scope_paths: z
      .array(z.string().min(1).max(260))
      .max(8)
      .optional()
      .describe('Optional workspace-relative path prefixes to limit the search (e.g. ["src/runtime"])'),
  })
  .strict();
type RetrieveInputT = z.infer<typeof RetrieveInput>;

const EXCERPT_FILE_CAP = 64;
const EXCERPT_WALL_MS = 500;
const EXCERPT_LINES_PER_FILE = 3;
const EXCERPT_LINE_CHARS = 300;

export function createRetrieveTool(handle: RetrievalHandle, opts: { now?: () => number } = {}): Tool<RetrieveInputT> {
  const now = opts.now ?? Date.now;
  return {
    name: 'retrieve',
    description:
      'Rank repository files for a task/topic using the session index (paths, symbols, import graph, git state). ' +
      'Every hit lists WHY it matched; line excerpts are read live from disk at query time. Use this FIRST to find ' +
      'where work should happen, then read the critical files yourself. Selective by design — search/list_files ' +
      'still see every file.',
    schema: RetrieveInput,
    mutates: () => ({ paths: [] }),
    readsPaths: (i) => (i.scope_paths !== undefined && i.scope_paths.length > 0 ? [...i.scope_paths] : ['.']),
    async execute(input, ctx): Promise<ToolResult> {
      const started = now();
      const limit = input.max_results ?? 15;
      const hits = rankForQuery(handle, input.query, {
        ...(input.scope_paths !== undefined ? { scopePaths: input.scope_paths } : {}),
        limit: limit + 8, // small over-fetch so secret/vanished drops do not shrink the answer
      });

      const kept: string[] = [];
      let dropped = 0;
      let secretSkipped = 0;
      let excerptFiles = 0;
      const terms = queryTerms(input.query);
      let rank = 0;
      for (const h of hits) {
        if (rank >= limit) break;
        const base = h.relPath.slice(h.relPath.lastIndexOf('/') + 1);
        if (isSecretName(base, ctx.rules?.secretPatterns)) {
          secretSkipped++;
          continue;
        }
        const abs = path.join(handle.root, h.relPath);
        let excerpts: string[] = [];
        let exists = true;
        if (excerptFiles < EXCERPT_FILE_CAP && now() - started < EXCERPT_WALL_MS) {
          try {
            const st = fs.statSync(abs);
            if (!st.isFile()) throw new Error('not a file');
            if (st.size <= MAX_EXTRACT_BYTES) {
              const buf = fs.readFileSync(abs);
              excerptFiles++;
              if (!isProbablyBinary(buf)) {
                const lines = buf.toString('utf8').split('\n');
                for (let i = 0; i < lines.length && excerpts.length < EXCERPT_LINES_PER_FILE; i++) {
                  const lower = lines[i]!.toLowerCase();
                  if (terms.some((t) => lower.includes(t))) {
                    excerpts.push(`     ${i + 1}: ${lines[i]!.trim().slice(0, EXCERPT_LINE_CHARS)}`);
                  }
                }
              }
            }
          } catch {
            exists = false;
          }
        } else {
          try {
            exists = fs.existsSync(abs);
          } catch {
            exists = false;
          }
        }
        if (!exists) {
          dropped++;
          continue; // the file the index knew is gone — dropping beats a misleading reference
        }
        rank++;
        kept.push(
          `${rank}. ${h.relPath} (score ${Math.round(h.score)}) — ${h.signals.join('; ')}` +
            (h.symbols.length > 0 ? `\n     symbols: ${h.symbols.join(', ')}` : '') +
            (excerpts.length > 0 ? `\n${excerpts.join('\n')}` : ''),
        );
      }

      const header =
        `retrieval over ${handle.inventory.files.length} files (symbols for ${handle.indexedFiles} ts/js/py/rust/go/c-cpp files; ` +
        `index ${handle.state === 'partial' ? 'PARTIAL — some files unindexed or stale-indexed until a later session (excerpts stay live)' : 'full'}): ` +
        `${rank} hit(s) for "${input.query}"`;
      const footerParts = [
        `indexed at ${handle.index.generatedAt}${handle.index.head !== null ? ` (head ${handle.index.head})` : ''}; excerpts read live from disk`,
      ];
      if (dropped > 0) footerParts.push(`${dropped} hit(s) dropped (files no longer on disk — reindex next session)`);
      if (secretSkipped > 0) footerParts.push(`${secretSkipped} secret-named file(s) omitted`);
      if (rank === 0) footerParts.push('no matches — try different terms, or search (regex) / list_files for exhaustive listing');

      const raw = [header, '', ...kept, '', footerParts.join('; ')].join('\n');
      const tr = truncateForModel(raw);
      return {
        ok: true,
        output: tr.text,
        truncated: tr.truncated,
        durationMs: Math.max(0, now() - started),
        ...(tr.fullSha256 !== undefined ? { fullOutputSha256: tr.fullSha256 } : {}),
      };
    },
  };
}
