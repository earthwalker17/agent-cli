import { SUBAGENT_ROLES, type SubagentRoleAccess, type SubagentRoleName, type TaskBudget } from '../types.js';
import {
  buildExecutorSystemPrompt,
  buildExplorerSystemPrompt,
  buildPlannerSystemPrompt,
  buildResearcherSystemPrompt,
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
  /**
   * Session 19: whether this child's registry actually includes the research tools. Same reason
   * `retrieve` is per-instance — `childTools` drops an instance the role did not name or that the
   * assembly could not build (no credential configured), and the prompt must describe the
   * registry the child really got, not the one the contract hoped for.
   */
  webSearch?: boolean | undefined;
  webExtract?: boolean | undefined;
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
/**
 * 'web_search' / 'web_extract' / 'record_source' (Session 19) follow the same named-instance
 * discipline as 'retrieve' and 'report_finding': ONLY the researcher contract names them, and the
 * runner admits each from the research factory iff named AND structurally free of every fact but
 * `research`. `record_source` is the researcher's only findings channel — recorded notes are what
 * the parent reads as evidence; prose stays narration.
 *
 * The workspace read tools are kept deliberately: research that ignores what the project actually
 * pins produces generic answers. The point is to compare the two.
 */
const RESEARCHER_TOOLS = [...READ_ONLY_TOOLS, 'web_search', 'web_extract', 'record_source'] as const;
const EXECUTOR_TOOLS = ['read_file', 'list_files', 'search', 'run_command', 'write_file', 'edit_file'] as const;
const READ_ONLY_BUDGET: TaskBudget = { maxSteps: 15, timeoutMs: 300_000, maxOutputTokens: 30_000 };
/**
 * The reviewer budget is deliberately larger than the other read-only roles (S14.5): its brief
 * DEMANDS interleaved work — read the code, record a finding through report_finding AS YOU
 * CONFIRM IT, read on — so a thorough lens spends roughly two steps per finding plus
 * orientation and the final report. 15 steps starved exactly the diligent lenses: they ended
 * 'budget-steps', and a round whose every lens died cannot qualify no matter what it recorded.
 */
/** S20.5: 8 → 12 min. Two of three kimi lenses hit the 8-minute wall in S15's live review —
 *  an always-thinking model spends wall clock on reasoning the step count cannot see. */
const REVIEWER_BUDGET: TaskBudget = { maxSteps: 24, timeoutMs: 720_000, maxOutputTokens: 30_000 };
/**
 * Session 19: research is interleaved like review (search → read → corroborate → record → search
 * again), so it needs more than the 15-step read-only budget. The wall clock is generous relative
 * to the step count because a research step includes provider latency the child cannot control,
 * while the step count stays modest on purpose: a bounded question should not become a crawl.
 *
 * 420s → 600s after the live S19 run, where a researcher timed out mid-reading with NOTHING
 * recorded. Raising the ceiling alone would only have moved the cliff, so it landed with two
 * structural fixes: a per-task page cap (EXTRACTS_PER_RESEARCH_TASK) and a per-call extract
 * timeout that no longer exceeds the provider's own. The budget-pressure supervision note reaches
 * the PARENT, not the child, so a child cannot pace itself — the bounds have to do that for it.
 */
const RESEARCHER_BUDGET: TaskBudget = { maxSteps: 20, timeoutMs: 600_000, maxOutputTokens: 30_000 };

/**
 * Executor budget is larger: mutating work takes more steps. Since S20.5 the wall clock EXCLUDES
 * time spent waiting on a forwarded approval (the runner subtracts measured wait — an away human
 * used to kill the executor mid-work, which turned a consent pause into a task failure), so this
 * bound is genuinely about the work again.
 */
/** S16: 30 steps / 12 min → 40 / 20 min. S20.5: 20 → 30 min — real multi-file worktree work on
 *  an installed project, under an always-thinking model, legitimately spends more wall than the
 *  demo fixtures did; the step ceiling is unchanged, so this buys patience, not more actions. */
export const EXECUTOR_BUDGET: TaskBudget = { maxSteps: 40, timeoutMs: 1_800_000, maxOutputTokens: 50_000 };

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
  /**
   * Session 19. Read-only in the workspace, external on the network — the only role that can
   * reach outside this machine, and the reason `read-only-external` exists as its own access
   * class. Its budget sits between the explorer's and the reviewer's: research is interleaved
   * work (search, read, corroborate, record, search again) like a review is, but a bounded
   * question should not become an open-ended crawl, and provider latency spends wall clock the
   * child cannot control — hence the generous timeout against a modest step count.
   */
  researcher: {
    name: 'researcher',
    access: 'read-only-external',
    toolNames: RESEARCHER_TOOLS,
    budget: RESEARCHER_BUDGET,
    approvals: 'auto-deny',
    buildPrompt: (a) => buildResearcherSystemPrompt(a.workspaceRoot, a.map, a.sandbox, a.git, a.agentMd, a.retrieve, a.webExtract),
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
