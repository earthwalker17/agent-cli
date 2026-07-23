import path from 'node:path';
import { sha256 } from '../shared/hash.js';
import { buildInventory } from './inventory.js';
import { loadOrBuildIndex, DEFAULT_BUILD_BUDGET_MS } from './store.js';
import { buildRetrievalHandle, type RetrievalHandle } from './rank.js';
import { renderRepoMap, RANKED_MAP_BUDGET } from './render.js';
import { buildWorkspaceMapAuto, type WorkspaceMap } from '../workspace/map.js';
import type { GitFacts } from '../git/types.js';
import type { PolicyRules } from '../types.js';

/**
 * The ranked-map assembly entry point (Session 10) — used ONLY by session assembly
 * (cli/assemble.ts). Everything else (pre-trust `agent map`, executor worktrees, non-repo
 * workspaces) keeps the flat `buildWorkspaceMapAuto` path, and ANY failure here falls back to
 * it too: the pre-Session-10 behavior is always reachable.
 *
 * Index writes happen HERE, harness-owned and pre-turn. The returned handle is a read-only
 * in-memory view for the retrieve tool and /map — a model-initiated call never mutates
 * durable state (the S6 observe-trap, kept closed).
 */

export interface RankedMapResult {
  map: WorkspaceMap;
  /** null = fell back to the flat map (no usable git listing / index failure). */
  handle: RetrievalHandle | null;
  /** One-line chrome note (first-run indexing, partial state); null when unremarkable. */
  note: string | null;
}

export function indexFilePath(projectDir: string): string {
  return path.join(projectDir, 'index', 'retrieval.json');
}

export async function buildRankedMap(opts: {
  root: string;
  git: GitFacts;
  projectDir: string;
  budget?: number;
  buildBudgetMs?: number;
  rules?: PolicyRules;
}): Promise<RankedMapResult> {
  const fallback = async (): Promise<RankedMapResult> => ({
    map: await buildWorkspaceMapAuto(opts.root, {}, opts.git),
    handle: null,
    note: null,
  });
  if (!opts.git.isRepo || opts.git.gitPath === null || opts.git.probeFailed) return fallback();

  try {
    const inventory = await buildInventory(opts.root, opts.git);
    if (inventory === null) return fallback();
    const build = loadOrBuildIndex({
      indexFile: indexFilePath(opts.projectDir),
      root: opts.root,
      inventory,
      head: opts.git.head,
      budgetMs: opts.buildBudgetMs ?? DEFAULT_BUILD_BUDGET_MS,
      ...(opts.rules !== undefined ? { rules: opts.rules } : {}),
    });
    const handle = buildRetrievalHandle(opts.root, inventory, build);
    const rendered = renderRepoMap(handle, { budget: opts.budget ?? RANKED_MAP_BUDGET });

    const map: WorkspaceMap = {
      text: rendered.text,
      fileCount: inventory.files.length,
      truncated: rendered.truncated,
      sha256: sha256(rendered.text),
      inventorySha256: inventory.inventorySha256,
      indexedFiles: handle.indexedFiles,
      indexState: build.state,
    };
    const noteParts: string[] = [];
    if (build.cache === 'cold' && build.extracted > 0) {
      noteParts.push(`repository index built: ${build.extracted} file(s) extracted in ${build.durationMs}ms`);
    }
    if (build.state === 'partial') noteParts.push(`index PARTIAL (${build.skippedBudget} file(s) deferred to the next session)`);
    if (!build.persisted) noteParts.push('index cache not persisted (in-memory only this session)');
    return { map, handle, note: noteParts.length > 0 ? noteParts.join('; ') : null };
  } catch {
    return fallback(); // the ranked path must never block a session
  }
}
