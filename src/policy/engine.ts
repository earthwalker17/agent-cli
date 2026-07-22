import path from 'node:path';
import { subagentRoleAccess } from '../types.js';
import type { ActionClass, MutationPlan, PolicyDecision, Tool, ToolContext } from '../types.js';
import { validatePath } from './paths.js';
import { PathError } from '../shared/errors.js';
import { caseFold } from '../shared/pathutil.js';
import { analyzeCommand } from './command-review.js';

/**
 * The single policy choke point. `decide()` classifies every tool call and returns
 * allow / ask / deny. It is pure over (tool, input, ctx, grants) — no I/O beyond the shared
 * path validator. Tools declare facts (mutates / readsPaths / command); policy alone decides.
 *
 * V0.1 posture (honest): this is the APPROVAL control only. There is NO OS sandbox — an approved
 * shell command runs with full user privilege and is neither snapshotted nor undoable.
 */

// Classes that may be carried by a session grant. Never `destructive` (no-undo) or `reversible`.
const GRANTABLE: readonly ActionClass[] = ['sensitive', 'external'];

/** Whether an `ask` of this class can be granted for the session — the prompt hides [s] otherwise. */
export function isGrantable(cls: ActionClass): boolean {
  return GRANTABLE.includes(cls);
}

/** In-memory, session-scoped approval grants. Not persisted; not restored on resume. */
export class Grants {
  private readonly set = new Set<string>();
  private key(tool: string, cls: ActionClass): string {
    return `${tool}::${cls}`;
  }
  has(tool: string, cls: ActionClass): boolean {
    return this.set.has(this.key(tool, cls));
  }
  /** run_command is never grantable; only sensitive/external file-tool classes are stored. */
  add(tool: string, cls: ActionClass): void {
    if (tool !== 'run_command' && GRANTABLE.includes(cls)) this.set.add(this.key(tool, cls));
  }
}

export function isSecretName(p: string, extraPatterns?: readonly string[]): boolean {
  const base = path.basename(p).toLowerCase();
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    /\.(pem|key)$/.test(base) ||
    base.includes('id_rsa') ||
    base.includes('credential') ||
    base.includes('secret') ||
    (extraPatterns ?? []).some((pat) => pat.length > 0 && base.includes(pat))
  );
}

function decision(
  classification: ActionClass,
  d: 'allow' | 'ask' | 'deny',
  rule: string,
  reason: string,
  extra: Partial<PolicyDecision> = {},
): PolicyDecision {
  return { classification, decision: d, rule, reason, requiresSnapshot: false, ...extra };
}

interface CommandLabel {
  label: ActionClass;
  circuitBreaker: boolean;
}

/**
 * Best-effort command labelling. The label only INFORMS the human prompt — it never grants,
 * because every command is `ask`. Documented as string matching over untrusted model output,
 * i.e. bypassable and NOT a security boundary.
 */
export function classifyCommand(command: string, workspaceRoot: string): CommandLabel {
  const c = command;
  // Circuit-breaker: refuse a few catastrophic forms even interactively (still best-effort).
  const drives = /\bformat\s+[a-z]:/i;
  const rmRoot = /\brm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$)/i;
  const wsLc = caseFold(path.resolve(workspaceRoot));
  const cLc = caseFold(command);
  const deleteVerb = /\b(rm|del|remove-item|rd|rmdir)\b/i;
  const recursiveForce = /(-r\b|-rf\b|-recurse\b|-force\b|\/s\b|\/q\b|-f\b)/i;
  const workspaceWipe =
    cLc.includes(wsLc) && deleteVerb.test(command) && recursiveForce.test(command);
  const circuitBreaker = drives.test(c) || rmRoot.test(c) || workspaceWipe;

  const destructive =
    /\b(rm|del|rmdir|rd)\b/i.test(c) && recursiveForce.test(c)
      ? true
      : /remove-item\b[\s\S]*-(recurse|force)/i.test(c) ||
        // git commands that discard or destroy work: reset --hard / clean / restore /
        // checkout -- <path> (the discard form) / stash drop|clear / force pushes.
        // The Codex `git restore` data-loss incident is why these read as destructive,
        // never as benign "observe" — the label still only informs the human.
        /\bgit\s+(reset\s+--hard|clean|restore\b|checkout\s+--(\s|$)|stash\s+(drop|clear)\b)/i.test(c) ||
        /\bgit\s+push\b[\s\S]*(\s--force(-with-lease)?\b|\s-f\b)/i.test(c) ||
        /\b(format|dd|mkfs)\b/i.test(c);
  const external =
    /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod|scp|ssh|nc|ncat|telnet|ftp|tftp)\b/i.test(c) ||
    /\bgit\s+(push|pull|fetch|clone)\b/i.test(c) ||
    /\b(npm|pnpm|yarn)\s+(install|i|ci|add|publish)\b/i.test(c) ||
    /\bnpx\b/i.test(c) ||
    /\b(pip|pip3)\s+install\b/i.test(c) ||
    // LOLBAS download / proxy-exec / persistence — string matching only INFORMS the human (these
    // are bypassable by obfuscation and are NOT auto-runnable regardless; the label helps the human
    // and prevents these from reading as benign "observe").
    /\b(certutil|bitsadmin|start-bitstransfer|mshta|rundll32|regsvr32|wmic|msiexec|installutil|cscript|wscript|schtasks|New-Service|sc)\b/i.test(c) ||
    // Encoded / runtime-constructed commands (obfuscation): never benign to a reviewer.
    /(-e(nc|ncodedcommand)?\b)|(\biex\b)|(\binvoke-expression\b)/i.test(c);

  const label: ActionClass = destructive ? 'destructive' : external ? 'external' : 'observe';
  return { label, circuitBreaker };
}

function denyFromError(e: unknown): PolicyDecision {
  if (e instanceof PathError) return decision('sensitive', 'deny', e.rule, e.message);
  return decision('sensitive', 'deny', 'path.invalid', (e as Error).message);
}

/** Decide the policy verdict for one tool call. */
export function decide<I>(
  tool: Tool<I>,
  input: I,
  ctx: ToolContext,
  grants: Grants,
): PolicyDecision {
  const stateOpt = {
    ...(ctx.stateDir ? { stateDir: ctx.stateDir } : {}),
    ...(ctx.rules && ctx.rules.protectedPaths.length > 0 ? { extraProtected: ctx.rules.protectedPaths } : {}),
  };

  // 0. Delegation → explicit fail-closed branch, FIRST (before the command branch, so a tool
  //    declaring both contracts can never reach the auto-run path disguised as a provably-safe
  //    command; before the fall-throughs, so a command-less mutation-less delegating tool can
  //    never auto-classify as plain observe — the S6 trap, handled deliberately). V0.7: one
  //    call may spawn a parallel GROUP, so every role in the batch is checked and the
  //    STRICTEST member governs; any unknown role denies the whole group. `delegates` runs
  //    over model-shaped input, so a throw is a deny, never an escape into the fall-throughs.
  if (tool.delegates !== undefined) {
    let delegation: { roles: readonly string[] };
    try {
      delegation = tool.delegates(input);
    } catch (e) {
      return decision('sensitive', 'deny', 'task.invalid-contract', `delegates() threw: ${(e as Error).message}`);
    }
    if (tool.command !== undefined || tool.planDoc !== undefined) {
      return decision(
        'sensitive',
        'deny',
        'task.conflicting-contract',
        'a tool may declare delegation, a shell command, or a plan-document write — never a combination',
      );
    }
    if (delegation.roles.length === 0) {
      return decision('sensitive', 'deny', 'task.empty-group', 'a delegation must name at least one role');
    }
    for (const role of delegation.roles) {
      if (subagentRoleAccess(role) === undefined) {
        return decision(
          'sensitive',
          'deny',
          'task.unknown-role',
          `unknown subagent role '${role}'; the group is refused (fail closed)`,
        );
      }
    }
    const mutating = delegation.roles.find((r) => subagentRoleAccess(r) === 'mutating-worktree');
    if (mutating !== undefined) {
      // Mutating roles ask EVERY time (the strictest member governs the whole group).
      // 'reversible' is honest — the children write only inside disposable worktrees, and their
      // changes enter the real workspace solely through the snapshot-backed apply tool — and it
      // is deliberately NOT session-grantable (engine rule): each spawn is a human decision.
      return decision(
        'reversible',
        'ask',
        'task.mutating-role',
        `spawns MUTATING subagent(s) in isolated git worktree(s); their approvals forward to you, their changes are captured for review and enter the workspace only through apply_task_changes`,
      );
    }
    return decision(
      'observe',
      'allow',
      'task.readonly-role',
      'delegated read-only work: each child session gets read-only tools, auto-denied approvals, and a fixed harness budget',
    );
  }

  // 0b. Plan-document write → explicit fail-closed branch (V0.7). Same trap-avoidance as
  //     delegation: update_plan mutates persistent harness state (the plan file in the state
  //     dir, which declared-mutation validation would DENY as protected), so without its own
  //     branch it would fall through to observe/auto-allow. Reversible honestly: prior bytes
  //     are blob-archived by the store, and the write cannot touch workspace files.
  if (tool.planDoc !== undefined) {
    let planDoc: { action: 'update' };
    try {
      planDoc = tool.planDoc(input);
    } catch (e) {
      return decision('sensitive', 'deny', 'plan.invalid-contract', `planDoc() threw: ${(e as Error).message}`);
    }
    if (tool.command !== undefined) {
      return decision(
        'sensitive',
        'deny',
        'plan.conflicting-contract',
        'a tool may declare a plan-document write or a shell command, never both',
      );
    }
    if (planDoc.action !== 'update') {
      return decision('sensitive', 'deny', 'plan.unknown-action', `unknown plan action '${String(planDoc.action)}'`);
    }
    return decision(
      'reversible',
      'allow',
      'plan.update',
      'writes the harness-owned plan document at the state root (prior bytes archived; user edits outrank; status only changes by user command) — never workspace files',
    );
  }

  // 1. Shell command → AUTOMATIC REVIEW (the single default flow; no separate "mode").
  //    - circuit-breaker → deny (absolute; never overridden by anything downstream).
  //    - a command the deterministic analyzer PROVES safe MAY auto-run, but ONLY inside an active
  //      OS boundary that contains a misjudgment. The model's opinion is never consulted; the label
  //      only informs the human prompt (it is bypassable string matching, not a boundary).
  //    - everything else → ask. No enforced sandbox ⇒ auto-run is disabled and every command asks
  //      (fail closed) — Agent CLI never auto-runs a command with nothing enforcing the boundary.
  const command = tool.command?.(input);
  if (command !== undefined) {
    const { label, circuitBreaker } = classifyCommand(command, ctx.workspaceRoot);
    if (circuitBreaker) {
      return decision(
        'destructive',
        'deny',
        'cmd.circuit-breaker',
        'matches a hardcoded catastrophic pattern (workspace/drive deletion or format); refused',
      );
    }
    const analysis = analyzeCommand(command);
    if (analysis.autoAllowable && ctx.sandbox?.enforced) {
      return decision(label, 'allow', 'cmd.auto-review-allow', analysis.reason, { execBoundary: 'sandbox' });
    }
    const why = analysis.autoAllowable
      ? 'demonstrably read-only, but no enforced sandbox is active, so it cannot auto-run'
      : analysis.reason;
    return decision(
      label,
      'ask',
      'cmd.auto-review-ask',
      `${why}; approval required. Approved commands run with full user privilege and are NOT snapshotted or undoable`,
      { noUndo: true, execBoundary: 'unsandboxed' },
    );
  }

  // 2. Declared mutation → validate each write target, then auto-allow (snapshot-backed).
  // The tool's own path resolution may throw for structurally invalid paths — treat as deny.
  let plan: MutationPlan | null;
  try {
    plan = tool.mutates(input, ctx);
  } catch (e) {
    return denyFromError(e);
  }
  if (plan && plan.paths.length > 0) {
    for (const p of plan.paths) {
      let v;
      try {
        v = validatePath(ctx.workspaceRoot, p, stateOpt);
      } catch (e) {
        return denyFromError(e);
      }
      if (!v.inWorkspace) {
        return decision('destructive', 'deny', 'path.outside-workspace', 'writing outside the workspace is not allowed');
      }
      if (v.protectedPath) {
        return decision('destructive', 'deny', 'path.protected', 'writing to a protected path (.git / state dir) is not allowed');
      }
    }
    return decision(
      'reversible',
      'allow',
      'mutation.in-workspace',
      'in-workspace file change; a snapshot is captured first so it can be undone',
      { requiresSnapshot: true },
    );
  }

  // 3. Read paths → out-of-workspace or secret-named require approval; else observe.
  const reads = tool.readsPaths?.(input) ?? [];
  for (const p of reads) {
    let v;
    try {
      v = validatePath(ctx.workspaceRoot, p, stateOpt);
    } catch (e) {
      return denyFromError(e);
    }
    if (!v.inWorkspace) {
      return applyGrant(
        decision('sensitive', 'ask', 'path.outside-workspace-read', 'reading outside the workspace requires approval'),
        tool,
        grants,
      );
    }
    if (isSecretName(p, ctx.rules?.secretPatterns)) {
      return applyGrant(
        decision(
          'sensitive',
          'ask',
          'path.secret-name',
          'this file may contain secrets; approval required and its contents are redacted from the log',
          { redactOutput: true },
        ),
        tool,
        grants,
      );
    }
  }

  return decision('observe', 'allow', 'observe.in-workspace', 'read-only workspace access');
}

function applyGrant<I>(base: PolicyDecision, tool: Tool<I>, grants: Grants): PolicyDecision {
  if (base.decision === 'ask' && grants.has(tool.name, base.classification)) {
    return { ...base, decision: 'allow', rule: `${base.rule}+grant` };
  }
  return base;
}

/**
 * Escalation when a pre-mutation snapshot could not be captured: the change is no longer
 * undoable, so it must not proceed silently — it becomes a destructive ask with a no-undo warning.
 */
export function escalateOnSnapshotFailure(): PolicyDecision {
  return decision(
    'destructive',
    'ask',
    'mutation.snapshot-failed',
    'a snapshot could not be captured; this change will NOT be undoable',
    { noUndo: true },
  );
}
