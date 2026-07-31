import { sha256 } from '../shared/hash.js';
import { qualifyRecipeId, toCommand } from '../checks/recipes.js';
import type { DetectedProject } from '../checks/types.js';
import type { ResolvedCheckFact } from '../types.js';

/**
 * Preview recipe resolution (Session 13) — the checks-table inversion applied to dev servers:
 * the model may name WHICH declared script to serve from (bounded to a fixed allowlist of
 * conventional names), and the harness composes the command from the detected project. Consent
 * binds `(recipeId, command, bodySha)` exactly as checks do, so rewriting the script re-asks.
 *
 * Deliberately narrow: ONLY package.json scripts with conventional preview-shaped names. An
 * arbitrary script name is refused as a bad request — `preview` must never become a euphemism
 * for "run any script" (`npm run deploy` is not a preview, even though the prompt would show
 * the command: the framing itself would be dishonest).
 */

export const PREVIEW_SCRIPT_PREFERENCE = ['dev', 'preview', 'serve', 'start'] as const;

const NEEDS_NODE_MODULES =
  'dependencies are not installed (node_modules is absent) — install them, then start the preview again';

export interface ResolvedPreview {
  /**
   * `preview.script.<name>` (`…@<unit>` outside the root) — the `preview.` prefix keeps replay
   * keys disjoint from check consent, and the unit suffix keeps `web`'s dev server disjoint from
   * `api`'s. Both are the same argument: a replay key is an authority, and two different servers
   * must never share one.
   */
  recipeId: string;
  scriptName: string;
  /** `<pm> run <name>` — composed by the harness, shown verbatim to the human. */
  command: string;
  /** The script body consent binds (the command is stable; its behavior lives here). */
  body: string;
  bodySha: string;
  /** The project unit this serves, and the directory the server actually runs in. */
  projectId: string;
  cwd: string;
}

export interface PreviewResolution {
  /** Preview-capable script names present in this project, preference-ordered. */
  candidates: string[];
  resolved: ResolvedPreview | null;
  /** Why nothing resolved. `badRequest` = the caller asked wrong; otherwise a project capability gap. */
  reason?: string;
  badRequest?: boolean;
}

export function resolvePreview(p: DetectedProject, requestedScript?: string): PreviewResolution {
  const candidates = PREVIEW_SCRIPT_PREFERENCE.filter((n) => p.scripts[n] !== undefined);
  if (requestedScript !== undefined && !(PREVIEW_SCRIPT_PREFERENCE as readonly string[]).includes(requestedScript)) {
    return {
      candidates,
      resolved: null,
      reason: `script '${requestedScript}' is not a preview-capable script name (allowed: ${PREVIEW_SCRIPT_PREFERENCE.join(', ')})`,
      badRequest: true,
    };
  }
  if (p.packageManager === null || candidates.length === 0) {
    return {
      candidates,
      resolved: null,
      reason:
        'this project declares no preview-capable script (looked for package.json scripts: ' +
        `${PREVIEW_SCRIPT_PREFERENCE.join(', ')})`,
    };
  }
  const name = requestedScript ?? candidates[0]!;
  if (p.scripts[name] === undefined) {
    return {
      candidates,
      resolved: null,
      reason: `script '${name}' is not declared in package.json (declared preview-capable scripts: ${candidates.join(', ')})`,
      badRequest: true,
    };
  }
  if (p.hasDependencies && !p.hasNodeModules) {
    return { candidates, resolved: null, reason: NEEDS_NODE_MODULES };
  }
  const body = p.scripts[name]!; // display text (bounded)
  return {
    candidates,
    resolved: {
      recipeId: qualifyRecipeId(`preview.script.${name}`, p.id),
      scriptName: name,
      command: toCommand([p.packageManager, 'run', name]),
      body,
      projectId: p.id,
      cwd: p.root,
      // Consent binds the UNTRUNCATED body (S14.5): `scripts` is display-capped at 200 chars,
      // so hashing it let an append past the cap ride the earlier `[s]` with no prompt — the
      // exact authority this prompt promises rewriting the script would revoke.
      bodySha: p.scriptShas[name] ?? sha256(body),
    },
  };
}

/**
 * The policy-fact form of a resolved preview (kind 'preview'; the engine words consent from it).
 * A DECLARED port is folded into the recipeId: it changes what the harness will probe (and
 * export as PORT), so it is part of the consent identity — a different port re-asks — and the
 * prompt's recipeId display shows it to the human.
 */
export function previewFact(r: ResolvedPreview, ttlMs: number, port?: number): ResolvedCheckFact {
  return {
    recipeId: port !== undefined ? `${r.recipeId}:port${String(port)}` : r.recipeId,
    kind: 'preview',
    command: r.command,
    bodySha: r.bodySha,
    projectId: r.projectId,
    cwd: r.cwd,
    timeoutMs: ttlMs,
    effects: { writesOutputs: true, network: true, workspaceAuthored: true },
  };
}
