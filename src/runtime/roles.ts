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
  /** Session 10: whether this child's registry actually includes the retrieve tool. */
  retrieve?: boolean | undefined;
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

/**
 * 'retrieve' (Session 10) is named here but exists only as a per-session instance — the
 * subagent runner admits it from SubagentDeps.retrieveTool iff the role contract names it AND
 * the instance is structurally command/delegates/planDoc-free. The EXECUTOR list deliberately
 * omits it: the parent's index describes the parent workspace, not the executor's worktree —
 * wrong-tree line references by construction.
 */
const READ_ONLY_TOOLS = ['read_file', 'list_files', 'search', 'run_command', 'retrieve'] as const;
/**
 * 'report_finding' (Session 14) follows the same named-instance discipline as 'retrieve': only
 * the REVIEWER contract names it, and the runner admits it from SubagentDeps.reportFindingTool
 * iff named AND structurally fact-free. It is the reviewer's ONLY findings channel — recorded
 * findings are what the review gate reads; prose stays narration.
 */
const REVIEWER_TOOLS = [...READ_ONLY_TOOLS, 'report_finding'] as const;
const EXECUTOR_TOOLS = ['read_file', 'list_files', 'search', 'run_command', 'write_file', 'edit_file'] as const;
const READ_ONLY_BUDGET: TaskBudget = { maxSteps: 15, timeoutMs: 300_000, maxOutputTokens: 30_000 };
/**
 * The reviewer budget is deliberately larger than the other read-only roles (S14.5): its brief
 * DEMANDS interleaved work — read the code, record a finding through report_finding AS YOU
 * CONFIRM IT, read on — so a thorough lens spends roughly two steps per finding plus
 * orientation and the final report. 15 steps starved exactly the diligent lenses: they ended
 * 'budget-steps', and a round whose every lens died cannot qualify no matter what it recorded.
 */
const REVIEWER_BUDGET: TaskBudget = { maxSteps: 24, timeoutMs: 480_000, maxOutputTokens: 30_000 };

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
    buildPrompt: (a) => buildExplorerSystemPrompt(a.workspaceRoot, a.map, a.sandbox, a.git, a.agentMd, a.retrieve),
  },
  planner: {
    name: 'planner',
    access: 'read-only',
    toolNames: READ_ONLY_TOOLS,
    budget: READ_ONLY_BUDGET,
    approvals: 'auto-deny',
    buildPrompt: (a) => buildPlannerSystemPrompt(a.workspaceRoot, a.map, a.sandbox, a.git, a.agentMd, a.retrieve),
  },
  reviewer: {
    name: 'reviewer',
    access: 'read-only',
    toolNames: REVIEWER_TOOLS,
    budget: REVIEWER_BUDGET,
    approvals: 'auto-deny',
    buildPrompt: (a) => buildReviewerSystemPrompt(a.workspaceRoot, a.map, a.sandbox, a.git, a.agentMd, a.retrieve),
  },
  executor: {
    name: 'executor',
    access: 'mutating-worktree',
    toolNames: EXECUTOR_TOOLS,
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
