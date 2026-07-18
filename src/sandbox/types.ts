import type { ExecSpec } from '../exec/run.js';
export type { ExecSandbox } from '../types.js';

/**
 * Sandbox contracts. A sandbox defines what a process can TECHNICALLY do (OS enforcement); it is
 * a different axis from approval/policy (constitution principle 4). This module owns the honest
 * distinction between "we asked a human" and "the OS will stop it".
 *
 * V0.4 ships exactly two modes:
 *  - 'none'          : no OS enforcement. The only controls are policy + approval (stated, never hidden).
 *  - 'windows-lowil' : a genuinely OS-enforced boundary — the command runs at Low integrity
 *                      (Mandatory Integrity Control denies writes to Medium+ objects) inside a Job
 *                      Object (kill-on-close reaping + resource caps). Windows-only; no admin needed.
 *
 * The mode is reported truthfully everywhere and is established by a real runtime PROBE, never
 * assumed from the platform name.
 */
export type SandboxMode = 'none' | 'windows-lowil';

/**
 * What an active boundary actually guarantees. `confines`/`doesNotConfine` are the honesty
 * surface: they are rendered verbatim into banners, the report, and the system prompt so no
 * consumer can imply a protection the OS does not provide.
 */
export interface EnforcementFacts {
  mode: SandboxMode;
  /** True ONLY when a runtime probe confirmed the OS is actively confining the child. */
  enforced: boolean;
  /** One-line human summary (banner/report). */
  summary: string;
  /** What the OS boundary genuinely prevents (empty for 'none'). */
  confines: string[];
  /** What it deliberately does NOT prevent — stated, never omitted. */
  doesNotConfine: string[];
  /** Probe detail / failure reason for the audit log. */
  detail: string;
}

/**
 * A sandbox backend. Constructed once per session. `ensureAvailable` runs (and caches) the real
 * probe; `wrapSpec` is the enforced transform. Backends are policy-free and log-free — they only
 * shape the ExecSpec and answer "can I actually enforce here?".
 */
export interface SandboxBackend {
  readonly mode: SandboxMode;
  /** Probe once (cached) whether genuine enforcement can be established on this machine. */
  ensureAvailable(): Promise<EnforcementFacts>;
  /** The last known facts (call after ensureAvailable; pre-probe returns enforced:false). */
  facts(): EnforcementFacts;
  /** Enforced transform-at-spawn. For 'none' this is identity. */
  wrapSpec(spec: ExecSpec): ExecSpec;
}
