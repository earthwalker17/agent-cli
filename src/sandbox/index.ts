import { createNoneSandbox } from './none.js';
import { createWindowsLowIlSandbox } from './windows-lowil.js';
import type { SandboxBackend } from './types.js';

export type { SandboxBackend, SandboxMode, EnforcementFacts } from './types.js';
export type { ExecSandbox } from '../types.js';

export interface SelectSandboxOptions {
  /** State root, where the host script + Low-labeled scratch live (Medium, outside every workspace). */
  stateRoot: string;
  /** Override the platform (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * Choose the sandbox backend for this session. Windows gets the enforced Low-IL backend; every other
 * platform gets the honest 'none' backend (this mechanism is Windows-only — no simulated parity).
 * Selection does NOT probe; the caller runs `ensureAvailable()` and reports the real result. If the
 * enforced backend fails its probe it degrades to 'none' semantics (enforced:false), and the runtime
 * then disables auto-run (fail closed) — never a silent unsandboxed auto-run.
 */
export function selectSandbox(opts: SelectSandboxOptions): SandboxBackend {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return createWindowsLowIlSandbox(opts.stateRoot);
  return createNoneSandbox(`no enforced sandbox on ${platform}; this mechanism is Windows-only`);
}
