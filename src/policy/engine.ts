import path from 'node:path';
import type { ActionClass, MutationPlan, PolicyDecision, Tool, ToolContext } from '../types.js';
import { validatePath } from './paths.js';
import { PathError } from '../shared/errors.js';
import { caseFold } from '../shared/pathutil.js';

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

export function isSecretName(p: string): boolean {
  const base = path.basename(p).toLowerCase();
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    /\.(pem|key)$/.test(base) ||
    base.includes('id_rsa') ||
    base.includes('credential') ||
    base.includes('secret')
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
      : /remove-item\b[^\n]*-(recurse|force)/i.test(c) ||
        /\bgit\s+(reset\s+--hard|clean)\b/i.test(c) ||
        /\b(format|dd|mkfs)\b/i.test(c);
  const external =
    /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod|scp|ssh)\b/i.test(c) ||
    /\bgit\s+(push|pull|fetch|clone)\b/i.test(c) ||
    /\b(npm|pnpm|yarn)\s+(install|i|ci|add|publish)\b/i.test(c) ||
    /\bnpx\b/i.test(c) ||
    /\b(pip|pip3)\s+install\b/i.test(c);

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
  const stateOpt = ctx.stateDir ? { stateDir: ctx.stateDir } : {};

  // 1. Shell command → always ask (no allowlist). Label informs the human only.
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
    return decision(
      label,
      'ask',
      'cmd.always-ask',
      'shell commands run with full user privilege and are NOT snapshotted or undoable',
      { noUndo: true },
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
    if (isSecretName(p)) {
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
