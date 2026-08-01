import { stampsEqual } from './detect.js';
import { detectWorkspace, probeWorkspaceStamps } from './workspace.js';
import type { DetectedWorkspace, ManifestStamp } from './types.js';

/**
 * The session's ONE live view of what projects exist and what each can run (Session 16.5).
 *
 * Session 16 already detected once at assembly and handed the same immutable result to the system
 * prompt and to `run_check`, `preview` and `project_setup` — but each tool then kept its own
 * mutable copy, advanced only by its own TOCTOU probe. That produced a defect with no attacker in
 * it, only sequence:
 *
 *   `project_setup install api` succeeds and creates `api/node_modules`. Only the setup tool's
 *   copy advances. The next `run_check {checks:['build'], project:'api'}` resolves against a
 *   snapshot that still says dependencies are absent, so nothing resolves, so policy allows with
 *   "nothing to run" and never asks. Execute then re-probes, finds node_modules, re-resolves to a
 *   real `npm run build` — and refuses with *"the project changed after this call was approved"*
 *   for a call that was never approved and a project nobody changed.
 *
 * The message is false, it costs a step of the turn budget at the busiest point of a run, and a
 * model that believes it goes looking for a manifest edit that never happened. Three tools times
 * the first call after each install.
 *
 * A shared holder removes the lag. It does NOT weaken the drift guard, because the window the old
 * per-tool copies were protecting against does not exist: tool calls in a turn are executed
 * strictly one at a time, so `decide()` and `execute()` for one call are back-to-back with no
 * other tool's refresh able to interleave. What the human approved is what this holder said at the
 * top of that same call, and the stamp comparison inside `execute` still refuses anything that
 * genuinely moved underneath it.
 *
 * The injectable `detect`/`probe` seams are kept so every tool test can still drive a synthetic
 * workspace, and a tool constructed WITHOUT a shared holder builds a private one — behaviour
 * identical to before.
 */
export interface SharedWorkspace {
  /** The current snapshot. Cheap: no I/O. */
  current(): DetectedWorkspace;
  /** Re-detect unconditionally and publish. */
  refresh(): DetectedWorkspace;
  /** Has anything in the cheap stat fingerprint moved since the current snapshot? */
  stale(): boolean;
  /** `stale()` and then `refresh()`; returns true when it re-detected. */
  refreshIfStale(): boolean;
}

export interface SharedWorkspaceOptions {
  initial?: DetectedWorkspace;
  detect?: (root: string) => DetectedWorkspace;
  probe?: (root: string) => ManifestStamp[];
}

export function createSharedWorkspace(root: string, opts: SharedWorkspaceOptions = {}): SharedWorkspace {
  const detect = opts.detect ?? detectWorkspace;
  const probe = opts.probe ?? probeWorkspaceStamps;
  let current = opts.initial ?? detect(root);

  const stale = (): boolean => !stampsEqual(current.stamps, probe(root));
  const refresh = (): DetectedWorkspace => {
    current = detect(root);
    return current;
  };

  return {
    current: () => current,
    refresh,
    stale,
    refreshIfStale: () => {
      if (!stale()) return false;
      refresh();
      return true;
    },
  };
}
