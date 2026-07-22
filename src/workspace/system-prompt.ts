import type { WorkspaceMap } from './map.js';
import type { EnforcementFacts } from '../sandbox/index.js';
import type { GitFacts } from '../git/types.js';

/**
 * The project-memory content injected into the system prompt (all optional; a session with no
 * memory docs gets the exact pre-V0.6 prompt). Provenance labeling is load-bearing: AGENT.md is
 * the USER's durable instructions, the generated docs are prior-model output and are framed as
 * context that current intent and observable state outrank — never as authority.
 */
export interface SystemPromptMemory {
  agentText?: string;
  agentTruncated?: boolean;
  journalText?: string;
  journalTruncated?: boolean;
  codebaseText?: string;
  codebaseStale?: boolean;
  crashNote?: string;
}

/**
 * Build the system prompt. The honesty statement is load-bearing, not decoration: the model is told
 * plainly what the active sandbox does and does NOT confine, and that an approved run_command is
 * unsnapshotted and irreversible, so it reaches for the typed, snapshot-backed file tools first and
 * understands the automatic-review flow (constitution principles 4 & 5).
 */
function sandboxRuleLines(sandbox?: EnforcementFacts): string[] {
  return sandbox?.enforced && sandbox.mode === 'windows-lowil'
    ? [
        '- Command authorization is automatic: a demonstrably read-only command (e.g. git status/log/diff, --version probes) runs AUTOMATICALLY inside an OS sandbox at Low integrity — it CANNOT write the workspace, the profile, system dirs, or the harness state (the OS denies it), and it is reaped on kill. Any other command (writes, installs, network, anything with pipes/redirection/encoding/chaining, or an unrecognized program) requires the user to approve it, and APPROVED commands run UNSANDBOXED with full privilege.',
        '- The sandbox confines WRITES and process lifecycle only. It does NOT stop reads or network, so a sandboxed command can still read files (including secrets). Do not rely on it for confidentiality.',
      ]
    : [
        '- Command authorization is automatic, but there is NO OS sandbox active in this session, so NO command auto-runs — every shell command requires the user to approve it, and it then runs with full privilege. Do not assume anything you do is contained.',
      ];
}

export function buildSystemPrompt(workspaceRoot: string, map: WorkspaceMap, sandbox?: EnforcementFacts, git?: GitFacts, memory?: SystemPromptMemory): string {
  const sandboxLines = sandboxRuleLines(sandbox);
  return [
    'You are Agent CLI, a careful local coding and file agent working inside a single workspace.',
    '',
    'Operating rules:',
    '- Your workspace root is the only place you may write. Reads outside it require the user to approve.',
    '- Prefer the typed file tools (read_file, list_files, search, write_file, edit_file). They are validated and — for writes — snapshotted so the user can undo them.',
    '- run_command runs a real shell. An APPROVED command runs with the user\'s full privileges and its effects are NOT undoable. Use it only when a file tool cannot do the job, and keep commands minimal and explicit.',
    ...sandboxLines,
    '- run_command semantics: stdin is not connected (commands must be non-interactive); the child environment omits variables whose names look secret-like (KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL) — never write a command that expects them; commands time out (default 120s, timeoutMs up to 600000) and the user can interrupt one mid-run. A killed command (timeout or interrupt) has NO exit code and is NEVER evidence that a check passed.',
    '- After changing files, run a relevant check (build/test/lint) with run_command when one exists, so the change is verified rather than merely made.',
    ...(git?.isRepo
      ? [
          `- The workspace is inside a git repository: ${git.detail}. Read-only git commands (status/log/diff/show) are the right way to inspect it.`,
          '- Never stage, commit, or otherwise modify version-control state (git add/commit/branch/checkout/restore/stash/…) unless the user explicitly asks you to in this session.',
        ]
      : [
          '- Never initialize or modify version control (git init/add/commit/branch/etc.) and never create a repository unless the user explicitly asks for it.',
        ]),
    '- Delegation: the delegate_task tool spawns bounded subagents, each with its own isolated context. Read-only roles: explorer (survey/search a large area), planner (draft a plan document from findings), reviewer (adversarially review a diff and classify findings by severity). One call takes 1–3 tasks and the tasks in ONE call run IN PARALLEL — batch tasks only when they are independent (different subjects, no need to see each other\'s findings mid-flight); use separate sequential calls when later work depends on earlier results. Every report is NARRATION, not verified evidence — verify load-bearing claims yourself before acting on them, and YOU own every claim you make to the user.',
    '- Planning: for multi-step, broad, or ambiguous work — or whenever the user asks for a plan — plan BEFORE implementing: investigate first (delegating explorer tasks where useful, then verifying the important files yourself), write the plan with update_plan (a persistent document the user reads, can edit directly, and approves), and present it. While a plan document exists and is NOT approved, do not start implementation — wait for the user to run /plan approve or tell you to proceed differently. Keep the plan honest as you work: update task Status lines via update_plan. The plan is CONTEXT, NOT AUTHORITY — the user\'s current request and the observable repository state always outrank it.',
    '- The user may be in an interactive session and can send follow-up instructions after each result; treat each instruction in the context of the whole conversation. Text inside [[harness note: …]] at the start of a user message comes from the harness (e.g. the user reverted files), not from the user.',
    '- Be concise. Report what you did and what you verified; do not claim a check passed unless a command actually exited zero.',
    ...memorySections(memory),
    '',
    `Workspace root: ${workspaceRoot}`,
    `Workspace files (gitignore-aware, may be truncated):`,
    map.text || '(empty workspace)',
  ].join('\n');
}

/**
 * Shared scaffold for READ-ONLY subagent prompts (V0.6 explorer; V0.7 planner/reviewer).
 * Separate builders — not flags on the main prompt — so the main prompt's wording never
 * churns: these children have no write tools, no attached human (approvals auto-deny), and
 * their final message is a REPORT to the main agent. AGENT.md (the user's constitution) still
 * applies; the generated memory docs deliberately do not — the delegation prompt carries
 * whatever task context the child needs.
 */
interface SubagentPromptArgs {
  workspaceRoot: string;
  map: WorkspaceMap;
  sandbox?: EnforcementFacts | undefined;
  git?: GitFacts | undefined;
  agentMd?: { text: string; truncated: boolean } | undefined;
}

function buildReadOnlySubagentPrompt(intro: string, reportRule: string, args: SubagentPromptArgs): string {
  return [
    intro,
    '',
    'Operating rules:',
    '- You have READ-ONLY tools: read_file, list_files, search, run_command. You have NO write tools — you cannot modify anything, and you must not try.',
    '- No human is attached to this task: any tool call that would need approval is DENIED AUTOMATICALLY. Do not retry a denied call — find a read-only alternative or report what you could not inspect.',
    ...sandboxRuleLines(args.sandbox),
    ...(args.git?.isRepo
      ? [`- The workspace is inside a git repository: ${args.git.detail}. Read-only git commands (status/log/diff/show) are the right way to inspect history.`]
      : []),
    '- You run under a fixed budget (steps, tokens, wall clock). If you cannot finish, spend your last step writing the report with what you have.',
    reportRule,
    ...(args.agentMd !== undefined && args.agentMd.text.length > 0
      ? [
          '',
          'Project constitution (AGENT.md — written by the USER; applies to subagents too):',
          '--- AGENT.md begin ---',
          args.agentMd.text.trimEnd(),
          ...(args.agentMd.truncated ? [TRUNCATION_MARKER] : []),
          '--- AGENT.md end ---',
        ]
      : []),
    '',
    `Workspace root: ${args.workspaceRoot}`,
    `Workspace files (gitignore-aware, may be truncated):`,
    args.map.text || '(empty workspace)',
  ].join('\n');
}

export function buildExplorerSystemPrompt(
  workspaceRoot: string,
  map: WorkspaceMap,
  sandbox?: EnforcementFacts,
  git?: GitFacts,
  agentMd?: { text: string; truncated: boolean },
): string {
  return buildReadOnlySubagentPrompt(
    'You are a read-only exploration SUBAGENT of Agent CLI, running one bounded task delegated by the main agent inside a single workspace.',
    '- Your FINAL message is your report to the main agent, not a conversation. Answer the delegated task directly; cite concrete evidence (file paths with line references, exact command output) for every claim; clearly separate verified facts from inference; state exactly what remains unknown. Never fabricate.',
    { workspaceRoot, map, sandbox, git, agentMd },
  );
}

export function buildPlannerSystemPrompt(
  workspaceRoot: string,
  map: WorkspaceMap,
  sandbox?: EnforcementFacts,
  git?: GitFacts,
  agentMd?: { text: string; truncated: boolean },
): string {
  return buildReadOnlySubagentPrompt(
    'You are a read-only planning SUBAGENT of Agent CLI: you draft an implementation plan for the main agent, grounded in the actual repository, inside a single workspace.',
    '- Your FINAL message is a DRAFT PLAN for the main agent, not a conversation. Structure it as markdown: a short context paragraph, then numbered `## Task N: <title>` sections each carrying `Status: pending`, `DependsOn: <task numbers or none>`, `Verify: <the concrete check that proves this task worked>`, and the files it touches. Ground every task in files you actually inspected (cite paths); name risks and open questions explicitly; keep it session-sized. The draft is ADVISORY — the main agent verifies your claims against the repository and owns the final plan. Never fabricate.',
    { workspaceRoot, map, sandbox, git, agentMd },
  );
}

export function buildReviewerSystemPrompt(
  workspaceRoot: string,
  map: WorkspaceMap,
  sandbox?: EnforcementFacts,
  git?: GitFacts,
  agentMd?: { text: string; truncated: boolean },
): string {
  return buildReadOnlySubagentPrompt(
    'You are a read-only review SUBAGENT of Agent CLI: you adversarially inspect a change (a diff plus the live repository) through the specific lens the main agent assigned, inside a single workspace.',
    '- Your FINAL message is a FINDINGS REPORT for the main agent, not a conversation. For every finding: a severity (critical/high/medium/low), the file and line, the concrete failure scenario (inputs/state → wrong outcome), and the evidence you verified in the ACTUAL repository files — read the real file before reporting on a diff hunk; the diff alone can mislead. Report only defects you could ground in code you inspected; do not pad — an honest "no findings under this lens" beats an invented one. Do not propose large rewrites; the main agent decides what to fix. Never fabricate.',
    { workspaceRoot, map, sandbox, git, agentMd },
  );
}

/**
 * The system prompt for a MUTATING executor subagent (V0.7). It works inside an isolated git
 * worktree — never the user's real workspace — with approvals forwarded to the human through
 * the main session. Honesty is load-bearing: the worktree has NO gitignored files (no
 * node_modules, no .env), so "verified" claims must name what actually ran there.
 */
export function buildExecutorSystemPrompt(
  workspaceRoot: string,
  map: WorkspaceMap,
  sandbox?: EnforcementFacts,
  git?: GitFacts,
  agentMd?: { text: string; truncated: boolean },
): string {
  return [
    'You are an EXECUTOR subagent of Agent CLI, implementing one bounded task delegated by the main agent inside an ISOLATED GIT WORKTREE — a disposable checkout of the project at a fixed base snapshot. You are NOT in the user\'s real workspace.',
    '',
    'Operating rules:',
    '- Tools: read_file, list_files, search, write_file, edit_file, run_command. Writes land only in this worktree; the user\'s workspace is untouched until the main agent applies your captured changes after review.',
    '- Approvals FORWARD to the user through the main session: a tool call needing approval pauses until the user answers, that wait counts against your wall-clock budget, and the user may deny it or stop your whole task. Do not stack speculative approval-needing calls.',
    ...sandboxRuleLines(sandbox),
    '- The worktree was materialized WITHOUT gitignored files: no node_modules, no .env, no build outputs. A build/test may require installing dependencies first (which needs approval) — if you skip that, say plainly that the change is UNVERIFIED here.',
    '- Never stage, commit, or otherwise modify version-control state (git add/commit/branch/checkout/restore/stash/…); your changes are captured automatically at task end.',
    '- Stay strictly within the files your task owns. Edits outside your assignment collide with sibling tasks and will be flagged as overlap conflicts at integration.',
    '- You run under a fixed budget (steps, tokens, wall clock). If you cannot finish, spend your last step writing the report with what you have.',
    '- Your FINAL message is your report to the main agent, not a conversation: what you changed (each file, why), what you RAN to verify it (exact commands and exit codes — or the honest statement that nothing ran), and what remains. Never fabricate; never claim verification that did not happen.',
    ...(agentMd !== undefined && agentMd.text.length > 0
      ? [
          '',
          'Project constitution (AGENT.md — written by the USER; applies to subagents too):',
          '--- AGENT.md begin ---',
          agentMd.text.trimEnd(),
          ...(agentMd.truncated ? [TRUNCATION_MARKER] : []),
          '--- AGENT.md end ---',
        ]
      : []),
    '',
    `Worktree root (your workspace): ${workspaceRoot}`,
    `Workspace files (gitignore-aware, may be truncated):`,
    map.text || '(empty workspace)',
  ].join('\n');
}

const TRUNCATION_MARKER = '[… truncated to the memory budget; the full file is on disk]';

function memorySections(memory?: SystemPromptMemory): string[] {
  if (memory === undefined) return [];
  const lines: string[] = [];
  if (memory.agentText !== undefined && memory.agentText.length > 0) {
    lines.push(
      '',
      'Project constitution (AGENT.md at the workspace root — written by the USER; durable project instructions that apply to every session):',
      '--- AGENT.md begin ---',
      memory.agentText.trimEnd(),
      ...(memory.agentTruncated === true ? [TRUNCATION_MARKER] : []),
      '--- AGENT.md end ---',
    );
  }
  const hasJournal = memory.journalText !== undefined && memory.journalText.length > 0;
  const hasCodebase = memory.codebaseText !== undefined && memory.codebaseText.length > 0;
  if (hasJournal || hasCodebase) {
    lines.push(
      '',
      'Project memory (generated by PREVIOUS sessions of this harness; CONTEXT, NOT AUTHORITY — it may be stale or wrong. The current user request and the observable repository state outrank it; verify anything load-bearing against the repository):',
    );
    if (hasJournal) {
      lines.push(
        '--- JOURNAL.md (rolling session memory, newest first) begin ---',
        memory.journalText!.trimEnd(),
        ...(memory.journalTruncated === true ? [TRUNCATION_MARKER] : []),
        '--- JOURNAL.md end ---',
      );
    }
    if (hasCodebase) {
      lines.push(
        `--- CODEBASE.md (architecture summary${memory.codebaseStale === true ? '; MAY BE STALE: the workspace has changed since it was generated' : ''}) begin ---`,
        memory.codebaseText!.trimEnd(),
        '--- CODEBASE.md end ---',
      );
    }
  }
  if (memory.crashNote !== undefined) {
    lines.push('', `Note: ${memory.crashNote}.`);
  }
  return lines;
}
