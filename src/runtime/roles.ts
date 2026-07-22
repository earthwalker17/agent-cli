import { SUBAGENT_ROLES, type SubagentRoleAccess, type SubagentRoleName, type TaskBudget } from '../types.js';
import {
  buildExecutorSystemPrompt,
  buildExplorerSystemPrompt,
  buildPlannerSystemPrompt,
  buildReviewerSystemPrompt,
} from '../workspace/system-prompt.js';
import type { WorkspaceMap } from '../workspace/map.js';
import type { EnforcementFacts } from '../sandbox/index.js';
import type { GitFacts } from '../git/types.js';

/**
 * Runtime role contracts (V0.7): what each subagent role actually GETS — tool registry, system
 * prompt, harness-fixed budget, approval mode. The POLICY fact (which roles exist, read-only vs
 * mutating) lives in `types.ts` SUBAGENT_ROLES and is enforced by decide() before any of this
 * is consulted; this table must stay consistent with it (pinned by a test). Roles are explicit
 * contracts, not prompt aliases: adding a role means adding a row here AND a policy-table entry,
 * and the engine fails closed on anything it does not recognize.
 */

export interface RolePromptArgs {
  workspaceRoot: string;
  map: WorkspaceMap;
  sandbox?: EnforcementFacts | undefined;
  git?: GitFacts | undefined;
  agentMd?: { text: string; truncated: boolean } | undefined;
}

export interface RoleContract {
  name: SubagentRoleName;
  access: SubagentRoleAccess;
  /** The child's complete tool registry — a subset of the static TOOLS, never the delegate/apply tools (depth 1). */
  toolNames: readonly string[];
  /** Harness-fixed; never model-controlled. Tests may narrow via SubagentDeps.budget. */
  budget: TaskBudget;
  /** 'auto-deny' = no human attached; 'forward' = asks queue to the parent's approver (V0.7 Stage C). */
  approvals: 'auto-deny' | 'forward';
  buildPrompt(args: RolePromptArgs): string;
}

const READ_ONLY_TOOLS = ['read_file', 'list_files', 'search', 'run_command'] as const;
const READ_ONLY_BUDGET: TaskBudget = { maxSteps: 15, timeoutMs: 300_000, maxOutputTokens: 30_000 };

/**
 * Executor budget is larger: mutating work takes more steps, and time spent WAITING on a
 * forwarded approval counts against the task's wall clock (documented limitation).
 */
export const EXECUTOR_BUDGET: TaskBudget = { maxSteps: 30, timeoutMs: 720_000, maxOutputTokens: 50_000 };

export const ROLE_CONTRACTS: Record<SubagentRoleName, RoleContract> = {
  explorer: {
    name: 'explorer',
    access: 'read-only',
    toolNames: READ_ONLY_TOOLS,
    budget: READ_ONLY_BUDGET,
    approvals: 'auto-deny',
    buildPrompt: (a) => buildExplorerSystemPrompt(a.workspaceRoot, a.map, a.sandbox, a.git, a.agentMd),
  },
  planner: {
    name: 'planner',
    access: 'read-only',
    toolNames: READ_ONLY_TOOLS,
    budget: READ_ONLY_BUDGET,
    approvals: 'auto-deny',
    buildPrompt: (a) => buildPlannerSystemPrompt(a.workspaceRoot, a.map, a.sandbox, a.git, a.agentMd),
  },
  reviewer: {
    name: 'reviewer',
    access: 'read-only',
    toolNames: READ_ONLY_TOOLS,
    budget: READ_ONLY_BUDGET,
    approvals: 'auto-deny',
    buildPrompt: (a) => buildReviewerSystemPrompt(a.workspaceRoot, a.map, a.sandbox, a.git, a.agentMd),
  },
  executor: {
    name: 'executor',
    access: 'mutating-worktree',
    toolNames: [...READ_ONLY_TOOLS, 'write_file', 'edit_file'],
    budget: EXECUTOR_BUDGET,
    approvals: 'forward',
    buildPrompt: (a) => buildExecutorSystemPrompt(a.workspaceRoot, a.map, a.sandbox, a.git, a.agentMd),
  },
};

/** Sanity: the runtime table and the policy fact table must describe the same roles. */
for (const [name, contract] of Object.entries(ROLE_CONTRACTS)) {
  const policy = SUBAGENT_ROLES[name as SubagentRoleName];
  if (policy === undefined || policy.access !== contract.access) {
    throw new Error(`role table mismatch for '${name}': runtime says ${contract.access}, policy says ${policy?.access}`);
  }
}
