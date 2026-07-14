/**
 * Injectable clock. All timestamps flow through a Clock so tests can pin time and
 * produce byte-identical event logs and reports (constitution: deterministic evidence).
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** ISO-8601 timestamp for the current instant. */
  iso(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

/** A deterministic clock for tests: starts at `startMs`, advances `stepMs` per read. */
export function fixedClock(startMs = 0, stepMs = 0): Clock {
  let t = startMs;
  return {
    now() {
      const v = t;
      t += stepMs;
      return v;
    },
    iso() {
      const v = t;
      t += stepMs;
      return new Date(v).toISOString();
    },
  };
}
