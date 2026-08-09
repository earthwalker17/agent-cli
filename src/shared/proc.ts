/**
 * Process-liveness probe — moved here from exec/kill.ts (S20.5): shared/registry-lock.ts needed
 * it, and that import was the ONE edge keeping shared/ from being a true leaf module. A signal-0
 * probe has no exec semantics; the kill machinery re-exports it.
 */

/** Liveness probe. EPERM means "exists but not ours" → alive. PID reuse makes this heuristic. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
