import type { StatusArea } from './status.js';
import type { Style } from './format.js';

/**
 * The "model working" heartbeat (S16.5b) — one dim status line, `· model working (Ns)`, shown
 * while a model request is in flight and NO text delta has arrived yet.
 *
 * Why it exists: an always-thinking model (kimi-k3 thinks before every reply, and between every
 * pair of tool steps) streams nothing until its reasoning ends, so the REPL looked frozen for
 * stretches of a real session. The line says "working", not "thinking" — the wait includes the
 * network and the provider queue, and the harness must not claim to know which.
 *
 * The safety argument, inherited from the sticky status area whose invariant this must preserve
 * ("stderr cursor movement never interleaves with stdout content"):
 *
 * - The line is drawn ONLY between a request starting and its first text delta — a window in
 *   which nothing writes to stdout (tool_call deltas never render).
 * - `textArrived()` runs SYNCHRONOUSLY before the renderer's first stdout write of the step
 *   (the REPL wraps onText), erasing the region and killing the timer — so no redraw can land
 *   while model text streams.
 * - Non-TTY: the StatusArea is a pass-through that emits ZERO escape bytes, so piped transcripts
 *   stay byte-identical; the timer is unref'd and cannot hold the process open.
 */

export interface WorkingHeartbeat {
  /** A provider request just went out. */
  modelCallStarted(): void;
  /** The first stdout byte of this step is imminent — erase now, stay quiet until the next call. */
  textArrived(): void;
  /** The request settled (success, error, or abort). */
  modelCallEnded(): void;
}

export function createWorkingHeartbeat(opts: {
  area: Pick<StatusArea, 'setLines' | 'clear'>;
  style: Pick<Style, 'dim'>;
  /** Delay before the line first appears — a fast response should never flash it. */
  graceMs?: number;
  tickMs?: number;
}): WorkingHeartbeat {
  const grace = opts.graceMs ?? 2_000;
  const tick = opts.tickMs ?? 1_000;
  let timer: NodeJS.Timeout | null = null;
  let visible = false;
  let startedAt = 0;

  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (visible) {
      opts.area.clear();
      visible = false;
    }
  };

  return {
    modelCallStarted(): void {
      stop();
      startedAt = Date.now();
      timer = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        if (elapsed < grace) return;
        visible = true;
        opts.area.setLines([opts.style.dim(`· model working (${String(Math.round(elapsed / 1000))}s)`)]);
      }, tick);
      timer.unref?.();
    },
    textArrived: stop,
    modelCallEnded: stop,
  };
}
