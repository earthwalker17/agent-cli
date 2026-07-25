import type { CheckKind, FailureClass } from '../types.js';

/**
 * The recovery catalogue (Session 12): one entry per typed failure class, as DATA.
 *
 * This is deliberately not prompt prose and not a library of shell snippets. It is a table the
 * workflow reads: the classifier picks the class, the repair evaluator reads `autoEligible` /
 * `stopConditions` to decide eligibility, the DAG gate quotes `requiredEvidence` and `diagnostics`
 * in its refusals, and the failing tool result renders the entry so the guidance arrives exactly
 * when it is needed. Changing recovery behavior means editing this table, not hunting for
 * instructions scattered across prompts.
 *
 * `autoEligible: false` does not mean "give up" — it means a bounded automatic repair loop is the
 * wrong instrument, and the honest move is `recover escalate` or asking the user. Every entry
 * names what would have to be true instead.
 */

export interface RecoveryEntry {
  class: FailureClass;
  label: string;
  /** Signal ids and structural facts that typically indicate this class. */
  signals: string[];
  /** What must be present before a repair may even be planned. */
  requiredEvidence: string[];
  /** Cheap, bounded steps that turn a guess into a diagnosis. */
  diagnostics: string[];
  /** Repair actions that are appropriate for this class. */
  actions: string[];
  /** What must pass to prove the repair worked. */
  regressionChecks: CheckKind[];
  /** Whether a bounded automatic repair attempt is appropriate at all. */
  autoEligible: boolean;
  /** Cases that always require the user, regardless of budgets. */
  requiresConfirmation: string[];
  /** When to stop and escalate instead of trying again. */
  stopConditions: string[];
}

const COMMON_STOPS = [
  'the same failure signature recurs after a repair attempt with no materially different hypothesis',
  'changes are spreading outside the declared repair scope',
  'the attempt, wall-time, or session repair budget is exhausted',
];

export const RECOVERY_CATALOGUE: Record<FailureClass, RecoveryEntry> = {
  'dependency-setup': {
    class: 'dependency-setup',
    label: 'dependency / setup',
    signals: ['command-not-found', 'module-not-found', 'missing-dependency', 'network-error', 'spawn-error termination'],
    requiredEvidence: [
      'the exact missing name (module, binary, or package) from the check output',
      'whether the toolchain is absent or merely unresolved (does the manifest list it?)',
    ],
    diagnostics: [
      'read the manifest (package.json / pyproject.toml) and confirm whether the missing name is declared',
      'list the expected location (node_modules/.bin, the venv) with list_files rather than assuming',
    ],
    actions: [
      'add the missing declaration to the manifest if the code genuinely needs it',
      'correct an import/require path that names something that never existed',
      'ask the user to install dependencies — this harness deliberately has no install check kind, because installing runs third-party code with network access',
    ],
    regressionChecks: ['build', 'typecheck'],
    autoEligible: false,
    requiresConfirmation: [
      'anything that installs packages or reaches the network',
      'changing dependency versions in a lockfile',
    ],
    stopConditions: [...COMMON_STOPS, 'the environment is missing a toolchain only the user can install'],
  },

  'compile-type': {
    class: 'compile-type',
    label: 'compile / type',
    signals: ['ts-error', 'syntax-error', 'type-error', 'a failing typecheck or build check'],
    requiredEvidence: [
      'the first few diagnostics with file, line, and error code (the check findings carry them)',
      'the current bytes of each named file — read them, do not repair from memory',
    ],
    diagnostics: [
      'read every file named in the diagnostics before editing',
      're-run the narrowest check (typecheck) to confirm the diagnostic set is stable',
    ],
    actions: [
      'fix the specific diagnostics; keep each edit local to a named file',
      'if a type is genuinely wrong at its declaration, fix the declaration rather than casting at every call site',
    ],
    regressionChecks: ['typecheck', 'build'],
    autoEligible: true,
    requiresConfirmation: ['suppressing diagnostics (ts-ignore, any, eslint-disable) instead of fixing them'],
    stopConditions: [...COMMON_STOPS, 'the diagnostic count is growing rather than shrinking between attempts'],
  },

  'test-assertion': {
    class: 'test-assertion',
    label: 'test / assertion',
    signals: ['assertion-failed', 'a failing test or test-targeted check', 'named failing test cases in the findings'],
    requiredEvidence: [
      'the failing test names and their expected-vs-actual values',
      'whether the test or the implementation encodes the intended behavior',
    ],
    diagnostics: [
      'run the narrowest test-targeted check on the failing file to iterate cheaply',
      'read the failing test and the code under test together before deciding which one is wrong',
    ],
    actions: [
      'fix the implementation when the test states the intended behavior',
      'fix the test when it encodes an assumption the user did not ask for — and say plainly that you changed a test',
    ],
    regressionChecks: ['test'],
    autoEligible: true,
    requiresConfirmation: [
      'deleting, skipping, or weakening a test to make a suite pass',
      'changing behavior the user explicitly specified',
    ],
    stopConditions: [...COMMON_STOPS, 'the same test fails with the same message after a repair — the hypothesis was wrong, not incomplete'],
  },

  'lint-format': {
    class: 'lint-format',
    label: 'lint / format',
    signals: ['lint-violation', 'a failing lint, format, or static-analysis check'],
    requiredEvidence: ['the rule ids and locations from the findings'],
    diagnostics: ['re-run the check to get the current violation list; do not fix from a stale list'],
    actions: [
      'apply the mechanical fix at each reported location',
      'if the project ships a formatter write mode, prefer running it over hand-editing whitespace',
    ],
    regressionChecks: ['lint', 'format'],
    autoEligible: true,
    requiresConfirmation: ['relaxing or disabling a rule instead of satisfying it'],
    stopConditions: [...COMMON_STOPS],
  },

  'runtime-process': {
    class: 'runtime-process',
    label: 'runtime / process',
    signals: ['permission-denied', 'a non-zero exit with no diagnostic pattern', 'a supervisor loop intervention'],
    requiredEvidence: [
      'a reproduction: the same check failing the same way, with its output preserved',
      'the exit code and termination — a killed process has NO exit code and proves nothing',
    ],
    diagnostics: [
      're-run the failing check once to establish whether it is deterministic',
      'read the tail of the preserved output rather than guessing from the summary',
    ],
    actions: ['fix the specific runtime error at its source', 'correct a wrong path, permission, or environment assumption in the code'],
    regressionChecks: ['test', 'build'],
    autoEligible: true,
    requiresConfirmation: ['anything that changes files outside the workspace, or system state'],
    stopConditions: [...COMMON_STOPS, 'the failure is not reproducible — a flaky failure must be reported, not repaired blind'],
  },

  'integration-conflict': {
    class: 'integration-conflict',
    label: 'integration / conflict',
    signals: ['apply refusals (drift: the workspace file no longer holds the task base bytes)', 'overlapping declared touches between tasks'],
    requiredEvidence: [
      'the exact refused paths and their refusal reasons from task.applied',
      'what changed those files after the task captured its base',
    ],
    diagnostics: [
      'read the refused files as they now stand and compare against what the task intended',
      'check whether another task in the same wave declared overlapping touches',
    ],
    actions: [
      're-run the task from the current base so its capture is built on the real tree',
      'apply the intended change by hand as the parent when the diff is small and unambiguous',
    ],
    regressionChecks: ['build', 'test'],
    autoEligible: false,
    requiresConfirmation: ['discarding a task capture', 'overwriting a file whose current content nobody has read'],
    stopConditions: [...COMMON_STOPS, 'two tasks are fighting over the same files — the plan needs amending, not retrying'],
  },

  'policy-approval': {
    class: 'policy-approval',
    label: 'policy / approval',
    signals: ['a policy deny', 'a user denial or deny-&-stop at an approval prompt', 'a child ended user-stopped'],
    requiredEvidence: ['the policy rule id or the approval that was denied'],
    diagnostics: ['re-read what was actually requested and why the boundary refused it'],
    actions: [
      'find a route that does not need the refused authority (a typed file tool instead of a shell command)',
      'ask the user directly — a denial is a decision, not an obstacle to work around',
    ],
    regressionChecks: [],
    autoEligible: false,
    requiresConfirmation: ['re-requesting the same authority the user just denied'],
    stopConditions: ['always: a refused boundary is the user’s call, and retrying it silently is the failure mode this class exists to prevent'],
  },

  'timeout-resource': {
    class: 'timeout-resource',
    label: 'timeout / resource',
    signals: ['timeout termination', 'budget-steps / budget-tokens', 'out-of-memory', 'port-in-use'],
    requiredEvidence: [
      'which limit was hit (wall clock, tokens, steps, memory, port) — they need different answers',
      'whether the work was genuinely too large or was looping',
    ],
    diagnostics: [
      'narrow the scope: run a test-targeted check instead of the whole suite',
      'check the supervision notes for a loop intervention before assuming the budget was simply small',
    ],
    actions: [
      'split the work into smaller tasks and amend the plan',
      'reduce the scope of the check being run rather than raising limits',
    ],
    regressionChecks: ['test-targeted'],
    autoEligible: false,
    requiresConfirmation: ['raising a harness budget', 'killing or restarting long-running processes the user owns'],
    stopConditions: [...COMMON_STOPS, 'a second timeout at the same scope — the scope is wrong, not the timeout'],
  },

  unknown: {
    class: 'unknown',
    label: 'unknown',
    signals: ['no classification rule fired: no recognizable diagnostic pattern in the evidence'],
    requiredEvidence: ['there is not enough structured evidence to name a failure class — that IS the finding'],
    diagnostics: [
      'read the preserved output blob or the child evidence log directly',
      'reproduce the failure with the narrowest check available so it can be classified',
    ],
    actions: ['gather evidence until the failure classifies, or report it to the user with what is known'],
    regressionChecks: [],
    autoEligible: false,
    requiresConfirmation: ['any repair attempt — repairing an unclassified failure is guessing with the user’s code'],
    stopConditions: ['always: an unknown classification stops and escalates rather than looping'],
  },
};

export function recoveryEntry(cls: FailureClass): RecoveryEntry {
  return RECOVERY_CATALOGUE[cls];
}

/**
 * Render one entry as compact guidance for a tool result or a gate refusal. Bounded on purpose:
 * this text lands in the model's context at the exact moment of failure, so it must be short
 * enough to read and specific enough to act on.
 */
export function renderRecoveryGuidance(cls: FailureClass, opts: { includeStops?: boolean } = {}): string {
  const e = recoveryEntry(cls);
  const lines = [
    `failure class: ${e.class} (${e.label})${e.autoEligible ? '' : ' — NOT eligible for automatic repair'}`,
    `required evidence: ${e.requiredEvidence.join('; ')}`,
    `diagnose first: ${e.diagnostics.join('; ')}`,
    `eligible actions: ${e.actions.join('; ')}`,
  ];
  if (e.regressionChecks.length > 0) lines.push(`prove the repair with: run_check ${e.regressionChecks.join(', ')}`);
  if (e.requiresConfirmation.length > 0) lines.push(`ask the user first for: ${e.requiresConfirmation.join('; ')}`);
  if (opts.includeStops === true) lines.push(`stop and escalate when: ${e.stopConditions.join('; ')}`);
  return lines.join('\n');
}
