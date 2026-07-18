import type { ExecSpec } from '../exec/run.js';
import type { EnforcementFacts, SandboxBackend } from './types.js';

/**
 * The honest no-enforcement backend. Selected on any non-Windows platform and whenever the enforced
 * Windows backend cannot be established. It NEVER pretends to confine anything: `enforced` is false,
 * `wrapSpec` is identity, and the facts say plainly that only policy + approval apply. The runtime
 * reads `enforced === false` and disables command auto-run entirely (fail closed).
 */
export function createNoneSandbox(reason: string): SandboxBackend {
  const facts: EnforcementFacts = {
    mode: 'none',
    enforced: false,
    summary: 'no OS sandbox — approval is the only control',
    confines: [],
    doesNotConfine: ['writes', 'reads', 'network', 'process lifecycle'],
    detail: reason,
  };
  return {
    mode: 'none',
    async ensureAvailable() {
      return facts;
    },
    facts() {
      return facts;
    },
    wrapSpec(spec: ExecSpec) {
      return spec;
    },
  };
}
