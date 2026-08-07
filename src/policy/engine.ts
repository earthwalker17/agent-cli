import path from 'node:path';
import { SETUP_ACTIONS, subagentRoleAccess } from '../types.js';
import type { ActionClass, ArtifactFact, MutationPlan, PolicyDecision, ResearchFact, ResolvedCheckFact, Tool, ToolContext } from '../types.js';
import { validatePath } from './paths.js';
import { PathError } from '../shared/errors.js';
import { domainMatches as hostUnder } from '../shared/domain.js';
import { caseFold } from '../shared/pathutil.js';
import { sha256 } from '../shared/hash.js';
import { analyzeCommand } from './command-review.js';

/**
 * The single policy choke point. `decide()` classifies every tool call and returns
 * allow / ask / deny. It is pure over (tool, input, ctx, grants) — no I/O beyond the shared
 * path validator. Tools declare facts (mutates / readsPaths / command / delegates / planDoc /
 * check); policy alone decides. A fact needing project state (`check`) must read a snapshot
 * captured elsewhere: filesystem I/O here would break both the purity contract and the guarantee
 * that what the human approved is exactly what executes.
 *
 * KNOWN EXCEPTION (honest, S16.5b): run_check's fact resolves a bound `test-targeted` scope via
 * a planTouches lookup that reads the PLAN DOCUMENT — one bounded file read per decide, not a
 * workspace probe. The plan file is not covered by the workspace drift stamps, so an external
 * plan edit during an open approval prompt could alter the executed scope without tripping the
 * TOCTOU guard; tool calls are otherwise strictly serialized, so the window is exactly the
 * prompt wait. Recorded in the deferred pool rather than papered over here.
 *
 * Approval and sandbox are SEPARATE axes (V0.4+): this engine is the approval control, and it
 * additionally READS `ctx.sandbox.enforced` to gate command auto-run — a provably-safe command
 * auto-runs only INSIDE an OS-enforced boundary; with no enforcement every command asks (fail
 * closed). An approved command still runs with full user privilege and is neither snapshotted
 * nor undoable — approval is consent, never containment.
 */

/**
 * Every optional policy FACT a tool may declare. Exactly one may be present: each fact gets its
 * own fail-closed branch, and a tool declaring two would be gated by whichever branch happens to
 * run first — a decision record that describes one consequence while another one executes.
 *
 * Derived from ONE table on purpose (Session 19). Until now each of the six branches carried a
 * hand-written list of the other five, which is fail-OPEN by construction: a seventh fact is
 * absent from all six until someone remembers to add it, and nothing fails if they do not. With
 * the table, adding a member to `FactKind` breaks the `FACT_LABELS` record at compile time.
 */
export const FACT_KINDS = ['command', 'delegates', 'planDoc', 'check', 'browser', 'evidenceRead', 'artifact', 'research'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

const FACT_LABELS: Record<FactKind, string> = {
  command: 'a shell command',
  delegates: 'delegation',
  planDoc: 'a plan-document write',
  check: 'typed checks',
  browser: 'a browser flow',
  evidenceRead: 'an evidence read',
  artifact: 'a document-artifact operation',
  research: 'a bounded external read',
};

/** The facts this tool declares OTHER than `self`. Non-empty means a conflicting contract. */
function otherFacts<I>(tool: Tool<I>, self: FactKind): FactKind[] {
  return FACT_KINDS.filter((k) => k !== self && tool[k] !== undefined);
}

/** The deny reason for a tool that declared more than one fact. Names both sides, always. */
function conflictReason(self: FactKind, others: readonly FactKind[]): string {
  return (
    `a tool may declare ${FACT_LABELS[self]} or ${others.map((k) => FACT_LABELS[k]).join(' or ')} — never a combination ` +
    `(each is gated by its own rule, and a call cannot be two consequences at once)`
  );
}

// Classes that may be carried by a session grant. Never `destructive` (no-undo) or `reversible`.
const GRANTABLE: readonly ActionClass[] = ['sensitive', 'external'];

/** Whether an `ask` of this class can be granted for the session — the prompt hides [s] otherwise. */
export function isGrantable(cls: ActionClass): boolean {
  return GRANTABLE.includes(cls);
}

/** In-memory, session-scoped approval grants. Not persisted; not restored on resume. */
export class Grants {
  private readonly set = new Set<string>();
  /**
   * Replay consent for typed checks (Session 12), kept in a SEPARATE set with no ActionClass in
   * the key. Widening GRANTABLE to cover checks would have been the cheap route and would have
   * silently broken an unrelated consent: the executor-spawn ask is classified `reversible` and
   * is deliberately non-grantable, but the approval prompt offers `[s]` whenever
   * `isGrantable(classification)` holds — so a widened class would render an `[s]` that stores a
   * grant the delegates branch never reads. Consent that does nothing is worse than no consent.
   */
  private readonly checkReplays = new Set<string>();
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
  /** Record consent to re-run one byte-identical harness-resolved check command. */
  addCheckReplay(key: string): void {
    if (key.length > 0) this.checkReplays.add(key);
  }
  hasCheckReplay(key: string): boolean {
    return this.checkReplays.has(key);
  }
}

/**
 * The replay-consent identity of one resolved check: the recipe, the exact command, AND — for a
 * workspace-authored script — the sha of the script BODY that command invokes.
 *
 * The body is the load-bearing part. `npm run test` is a stable string whose behavior lives in
 * package.json, which the agent can rewrite through the ordinary auto-allowed in-workspace
 * mutation branch. Keying on the command alone would let one `[s]` become standing consent to
 * execute whatever that script is later changed to say — exactly the standing shell authority
 * `run_command` is denied by design. Binding the body means a rewritten script re-asks.
 *
 * The project unit (Session 16) is the same argument one level out: in a workspace holding `web/`
 * and `api/`, `npm run test` names two different scripts running two different bodies at full
 * user privilege. Recipe ids are already unit-qualified, so this component is redundant TODAY —
 * and it is included anyway, because "provably disjoint somewhere else" is exactly the kind of
 * coupling that quietly stops being true.
 */
export function checkReplayKey(recipeId: string, command: string, bodySha?: string, projectId?: string): string {
  return sha256(`${recipeId}\n${command}\n${bodySha ?? ''}\n${projectId ?? ''}`);
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
    const conflicts = otherFacts(tool, 'delegates');
    if (conflicts.length > 0) {
      return decision('sensitive', 'deny', 'task.conflicting-contract', conflictReason('delegates', conflicts));
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
    // A researcher is read-only in the WORKSPACE and external on the network — two different
    // authorities, and only the first is covered by the read-only allow below. Spawning one must
    // therefore ask, because this ask IS the consent for every search the child will run: the
    // child has no approver of its own (read-only roles auto-deny), so if the spawn does not
    // carry the authority, nothing does. Placed AFTER the mutating check on purpose — a group
    // holding both roles is governed by the stricter one, and a stored `delegate_task::external`
    // grant must never satisfy a mutating spawn (pinned by test).
    const external = delegation.roles.find((r) => subagentRoleAccess(r) === 'read-only-external');
    if (external !== undefined) {
      return applyGrant(
        decision(
          'external',
          'ask',
          'task.research-role',
          'spawns a READ-ONLY RESEARCH subagent: it can reach the web through the bounded research provider and can ' +
            'read this workspace, but it holds no tool that writes, runs, or delegates anything. Its searches spend the ' +
            'SAME session research budget shown at the first research approval, and every query and source is recorded. ' +
            'What it returns is source-backed context, never verification',
          { noUndo: true },
        ),
        tool,
        grants,
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
    const conflicts = otherFacts(tool, 'planDoc');
    if (conflicts.length > 0) {
      return decision('sensitive', 'deny', 'plan.conflicting-contract', conflictReason('planDoc', conflicts));
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

  // 0c. Typed project checks → explicit fail-closed branch (Session 12), before the command
  //     branch and before every fall-through. A check SPAWNS A PROCESS, so reaching the observe
  //     fall-through would be the S6 trap with real execution behind it.
  //
  //     Consent model: `ask` by default, and `allow` only when EVERY resolved command in the call
  //     already carries replay consent from an earlier `session`-scope approval in this session.
  //     The key binds `(recipeId, exact command)`, so an edited manifest that changes what the
  //     recipe resolves to asks again. The classification is `reversible` (checks build/test the
  //     workspace and their outputs are ordinary files), but `noUndo` is true and honest: a check
  //     runs project code at full user privilege and is not snapshotted. It never runs inside the
  //     sandbox — the Low-IL boundary denies workspace writes, so a build could not even work
  //     there; the boundary is recorded as 'unsandboxed' rather than implied.
  if (tool.check !== undefined) {
    let fact: { resolved: readonly ResolvedCheckFact[]; manage?: boolean };
    try {
      fact = tool.check(input);
    } catch (e) {
      return decision('sensitive', 'deny', 'check.invalid-contract', `check() threw: ${(e as Error).message}`);
    }
    const conflicts = otherFacts(tool, 'check');
    if (conflicts.length > 0) {
      return decision('sensitive', 'deny', 'check.conflicting-contract', conflictReason('check', conflicts));
    }
    if (fact.resolved.length === 0) {
      // Nothing resolved ⇒ nothing to run ⇒ nothing to consent to — but the RECORD must not
      // misclassify: stopping/inspecting a session-owned preview process is a manage action
      // (reversible in the session sense: the resource is the session's own and re-startable),
      // not an observation, while run_check's all-unsupported case genuinely observes nothing.
      if (fact.manage === true) {
        return decision(
          'reversible',
          'allow',
          'preview.manage',
          'manages a preview process this session itself started (stop or inspect); reaches no other process',
        );
      }
      return decision('observe', 'allow', 'check.nothing-to-run', 'the call resolves no command to run (nothing to consent to)');
    }
    const keys = fact.resolved.map((r) => checkReplayKey(r.recipeId, r.command, r.bodySha, r.projectId));
    const summary = fact.resolved.map((r) => `${r.kind} → ${r.recipeId}`).join('; ');
    // A row may opt OUT of replay consent entirely (Session 16: migrations and seeds, and an
    // install whose lockfile could not be hashed). When any row does, the call issues NO keys —
    // which is also what hides `[s]`, since the prompt offers it off the keys, not off the class.
    const replayable = fact.resolved.every((r) => r.replayable !== false);

    // ── Project setup (Session 16) ──────────────────────────────────────────────────────────
    // The same trust shape as a check — a harness-resolved command with body-bound consent — and
    // a materially different CONSEQUENCE, so it gets its own rule ids and its own words. An
    // install fetches and EXECUTES third-party code over the network; a migration changes local
    // data the harness cannot snapshot. Neither is verification and neither may ever read as it.
    const setupRow = fact.resolved.find((r) => (SETUP_ACTIONS as readonly string[]).includes(r.kind));
    if (setupRow !== undefined) {
      const where = setupRow.cwd !== undefined ? ` in ${setupRow.cwd}` : '';
      if (setupRow.kind === 'install') {
        if (replayable && keys.every((k) => grants.hasCheckReplay(k))) {
          return decision('external', 'allow', 'setup.install-replay-consent', `re-running an install already approved this session (${summary})`, {
            noUndo: true,
            execBoundary: 'unsandboxed',
            checkReplayKeys: keys,
          });
        }
        return decision(
          'external',
          'ask',
          'setup.install-approval-required',
          `installs dependencies${where} with a harness-resolved command (${summary}); this DOWNLOADS AND EXECUTES ` +
            'third-party package code, including lifecycle scripts, at full user privilege with network access; ' +
            'NOT sandboxed, NOT snapshotted, NOT undoable' +
            (replayable
              ? '; a session-scope answer covers re-runs only while the lockfile is unchanged'
              : '; this approval covers THIS CALL ONLY (no lockfile identity to bind re-runs to)'),
          { noUndo: true, execBoundary: 'unsandboxed', ...(replayable ? { checkReplayKeys: keys } : {}) },
        );
      }
      // migrate / seed: `destructive` is the honest class — irreversible local state change — and
      // it is structurally non-grantable, which agrees with issuing no replay keys. Two
      // independent reasons for the same answer, so neither can drift into offering a silent [s].
      return decision(
        'destructive',
        'ask',
        'setup.state-change-approval-required',
        `runs this project's ${setupRow.kind} script${where} (${summary}) — a script DEFINED BY THIS WORKSPACE, whose ` +
          'real effects are whatever that script says; it changes local database or application state that the ' +
          'harness does NOT snapshot and CANNOT undo, it is not idempotent, and it therefore asks EVERY time; ' +
          'NOT sandboxed',
        { noUndo: true, execBoundary: 'unsandboxed' },
      );
    }
    // A PREVIEW row (kind 'preview', Session 13) is the same trust shape — a harness-resolved
    // command with body-bound replay consent — but a materially different CONSEQUENCE: the
    // process deliberately keeps running and binds a port. The persisted decision must say so
    // (an honest screen over a dishonest event would be the double-truth this project refuses),
    // hence distinct rule ids and reasons. Mixed rows take the preview wording: the strictest
    // consequence governs the whole call.
    const isPreview = fact.resolved.some((r) => r.kind === 'preview');
    if (replayable && keys.every((k) => grants.hasCheckReplay(k))) {
      return decision(
        'reversible',
        'allow',
        isPreview ? 'preview.replay-consent' : 'check.replay-consent',
        isPreview
          ? `re-starting preview server command(s) already approved this session (${summary})`
          : `re-running check command(s) already approved this session (${summary})`,
        {
          noUndo: true,
          execBoundary: 'unsandboxed',
          checkReplayKeys: keys,
        },
      );
    }
    if (isPreview) {
      return decision(
        'reversible',
        'ask',
        'preview.approval-required',
        `starts a harness-resolved preview server (${summary}) that KEEPS RUNNING after this call — until stopped, ` +
          'the session ends, or its bounded lifetime expires — binds a local port, and executes a script defined by ' +
          'this workspace at full user privilege; browser verification may drive it once running; ' +
          'a session-scope answer also covers re-starts after ordinary workspace edits (only rewriting the script ' +
          'itself, or changing the declared port, re-asks); NOT sandboxed, NOT snapshotted or undoable',
        { noUndo: true, execBoundary: 'unsandboxed', checkReplayKeys: keys },
      );
    }
    const authored = fact.resolved.some((r) => r.effects.workspaceAuthored);
    return decision(
      'reversible',
      'ask',
      'check.approval-required',
      `runs harness-resolved project check(s) (${summary})` +
        `${authored ? ', including a script defined by this workspace whose real effects are whatever that script does' : ''}` +
        '; checks run with full user privilege, are NOT sandboxed, and are NOT snapshotted or undoable',
      { noUndo: true, execBoundary: 'unsandboxed', checkReplayKeys: keys },
    );
  }

  // 0d. Browser flow → explicit fail-closed branch (Session 13), before the command branch and
  //     every fall-through: a flow executes application JavaScript and drives real UI, so
  //     reaching the observe fall-through would be the S6 trap with a browser behind it.
  //     Consent model (user decision, Session 13): a flow bound to a RUNNING harness-managed
  //     preview INHERITS the preview's consent — the preview approval prompt states that
  //     browser verification is included — and is origin-locked by the executor (an off-origin
  //     top-level navigation aborts the flow as a typed failure). Anything not bound to a
  //     managed preview is DENIED, not asked: arbitrary-origin browsing is out of scope.
  if (tool.browser !== undefined) {
    let fact: {
      flowName: string;
      stepCount: number;
      previewBound: boolean;
      requestedPreviewId?: string;
      readyPreviews?: readonly { previewId: string; projectId: string }[];
    };
    try {
      fact = tool.browser(input);
    } catch (e) {
      return decision('sensitive', 'deny', 'browser.invalid-contract', `browser() threw: ${(e as Error).message}`);
    }
    const conflicts = otherFacts(tool, 'browser');
    if (conflicts.length > 0) {
      return decision('sensitive', 'deny', 'browser.conflicting-contract', conflictReason('browser', conflicts));
    }
    if (!fact.previewBound) {
      const ready = fact.readyPreviews ?? [];
      // A denial that names nothing is what turned "two servers are running" into "start one
      // first" — advice whose most plausible reading is to start a third. The three cases are
      // genuinely different acts, so they get three different sentences.
      const detail =
        fact.requestedPreviewId !== undefined
          ? `no READY preview with id '${fact.requestedPreviewId}' is running` +
            (ready.length > 0 ? ` (ready now: ${ready.map((p) => `${p.previewId} [project ${p.projectId}]`).join(', ')})` : '')
          : ready.length > 1
            ? `${String(ready.length)} previews are running (${ready.map((p) => `${p.previewId} [project ${p.projectId}]`).join(', ')}) and the flow named none — ` +
              'set `preview_id` to the one this flow means. Guessing which service a UI flow belongs to is not something the harness will do for you'
            : 'no harness-managed preview is running and ready; start one with the preview tool first';
      return decision(
        'sensitive',
        'deny',
        'browser.no-preview',
        `browser flows run only against a RUNNING harness-managed preview (whose approval included browser verification): ${detail}`,
      );
    }
    const bound = fact.readyPreviews?.find((p) => p.previewId === fact.requestedPreviewId) ?? fact.readyPreviews?.[0];
    return decision(
      'reversible',
      'allow',
      'browser.preview-bound',
      `drives the running managed preview${bound !== undefined ? ` ${bound.previewId} [project ${bound.projectId}]` : ''} in a headless browser ` +
        `(flow '${fact.flowName}', ${fact.stepCount} step(s)); ` +
        'TOP-LEVEL navigation is locked to the preview origin (the page\'s own subresource/XHR requests to other ' +
        'origins are RECORDED, not blocked, and the lock binds the port, not the socket owner); app-side effects are ' +
        'the consented server code acting on its own state; not undoable',
      { noUndo: true },
    );
  }

  // 0e. Session-evidence read (Session 13: view_image) → its own branch purely for HONEST
  //     evidence: the observe fall-through's "read-only workspace access" reason would be false
  //     for state-dir blob bytes. The sha-bound admission (only shas this session's browser
  //     artifacts recorded) is enforced structurally by the tool and pinned by tests.
  if (tool.evidenceRead !== undefined) {
    let fact: { sha256: string; admitted?: boolean };
    try {
      fact = tool.evidenceRead(input);
    } catch (e) {
      return decision('sensitive', 'deny', 'evidence.invalid-contract', `evidenceRead() threw: ${(e as Error).message}`);
    }
    const conflicts = otherFacts(tool, 'evidenceRead');
    if (conflicts.length > 0) {
      return decision('sensitive', 'deny', 'evidence.conflicting-contract', conflictReason('evidenceRead', conflicts));
    }
    // An evidence READER must not write: a declared mutation plan (or an undeclarable one)
    // through this branch would bypass path validation and snapshots entirely.
    let plan: MutationPlan | null;
    try {
      plan = tool.mutates(input, ctx);
    } catch (e) {
      return decision('sensitive', 'deny', 'evidence.invalid-contract', `mutates() threw: ${(e as Error).message}`);
    }
    if (plan === null || plan.paths.length > 0) {
      return decision('sensitive', 'deny', 'evidence.mutating-contract', 'an evidence-read tool must declare an empty mutation plan');
    }
    if (fact.admitted === false) {
      // The record must never claim an allowed re-read of bytes that were refused: the shared
      // blob store also holds spilled output and snapshot pre-images deliberately withheld
      // from the model.
      return decision(
        'sensitive',
        'deny',
        'evidence.not-session-artifact',
        `objects/${fact.sha256.slice(0, 12)}… is not a screenshot or inspected page image this session recorded; other evidence blobs are deliberately not model-readable`,
      );
    }
    return decision(
      'observe',
      'allow',
      'observe.session-evidence',
      `re-reads image evidence this session recorded (objects/${fact.sha256.slice(0, 12)}…); no workspace or process access`,
    );
  }

  // 0f. Document-artifact operation (Session 17) → explicit fail-closed branch, before the
  //     command branch and every fall-through. Two consequence shapes, neither of which the
  //     generic branches can describe honestly:
  //     - 'render' writes workspace artifacts (snapshot-backed like any mutation) AND may launch
  //       the headless system browser to print the PDF — the mutation branch's "in-workspace
  //       file change" reason says nothing about a browser, and the engine structurally never
  //       evaluates readsPaths on a tool with a non-empty mutation plan, so this rule's reason
  //       states where the spec-referenced reads ARE enforced (at execute).
  //     - 'inspect' is command-less and mutation-less — the S6 trap with a browser behind it.
  //       Admission splits on provenance: a document THIS SESSION rendered inherits its render's
  //       consent (decide admits by path over the in-memory events; execute re-verifies by
  //       CONTENT sha — the preview-drift pattern); any other workspace document asks, grantable
  //       (`sensitive` — pixels of arbitrary workspace bytes go to the model through a real
  //       renderer); outside the workspace denies.
  if (tool.artifact !== undefined) {
    let fact: ArtifactFact;
    try {
      fact = tool.artifact(input);
    } catch (e) {
      return decision('sensitive', 'deny', 'artifact.invalid-contract', `artifact() threw: ${(e as Error).message}`);
    }
    const conflicts = otherFacts(tool, 'artifact');
    if (conflicts.length > 0) {
      return decision('sensitive', 'deny', 'artifact.conflicting-contract', conflictReason('artifact', conflicts));
    }
    let plan: MutationPlan | null;
    try {
      plan = tool.mutates(input, ctx);
    } catch (e) {
      return decision('sensitive', 'deny', 'artifact.invalid-contract', `mutates() threw: ${(e as Error).message}`);
    }
    if (fact.kind === 'render') {
      const outputs = fact.outputs ?? [];
      if (outputs.length === 0) {
        return decision('sensitive', 'deny', 'artifact.no-outputs', 'a render must declare the artifact paths it will write');
      }
      const resolvedFact: string[] = [];
      for (const p of outputs) {
        let v;
        try {
          v = validatePath(ctx.workspaceRoot, p, stateOpt);
        } catch (e) {
          return denyFromError(e);
        }
        if (!v.inWorkspace) {
          return decision('destructive', 'deny', 'artifact.output-outside-workspace', 'rendering an artifact outside the workspace is not allowed');
        }
        if (v.protectedPath) {
          return decision('destructive', 'deny', 'artifact.output-protected', 'rendering an artifact to a protected path (.git / state dir) is not allowed');
        }
        resolvedFact.push(caseFold(v.resolved));
      }
      // The runtime snapshots from mutates(); a fact/mutates divergence would let a declared
      // output escape snapshot coverage (or snapshot a path the fact never showed the human).
      // Compared RESOLVED (the fact may declare workspace-relative paths; mutates resolves).
      if (plan === null) {
        return decision(
          'sensitive',
          'deny',
          'artifact.inconsistent-contract',
          'a render must declare the SAME paths through artifact() and mutates() — the snapshot machinery follows mutates()',
        );
      }
      const resolvedPlan: string[] = [];
      for (const p of plan.paths) {
        try {
          resolvedPlan.push(caseFold(validatePath(ctx.workspaceRoot, p, stateOpt).resolved));
        } catch (e) {
          return denyFromError(e);
        }
      }
      resolvedFact.sort();
      resolvedPlan.sort();
      if (resolvedPlan.length !== resolvedFact.length || resolvedPlan.some((p, i) => p !== resolvedFact[i])) {
        return decision(
          'sensitive',
          'deny',
          'artifact.inconsistent-contract',
          'a render must declare the SAME paths through artifact() and mutates() — the snapshot machinery follows mutates()',
        );
      }
      return decision(
        'reversible',
        'allow',
        'artifact.render',
        'renders document artifact(s) into the workspace from the session-authored spec (snapshot first, undoable)' +
          (fact.usesBrowser === true
            ? '; the PDF prints via the system browser, HEADLESS, loading only harness-generated content with network access blocked'
            : '') +
          '; spec-referenced image reads are validated at execute — out-of-workspace and secret-named paths refuse into the validation errors',
        { requiresSnapshot: true },
      );
    }
    // kind 'inspect'
    if (fact.path === undefined) {
      return decision('sensitive', 'deny', 'artifact.invalid-contract', 'an inspect must name the document path it rasterizes');
    }
    // An inspector must not write: blobs go to the evidence store through the runtime, never
    // through a mutation plan this branch did not validate.
    if (plan === null || plan.paths.length > 0) {
      return decision('sensitive', 'deny', 'artifact.mutating-contract', 'an inspect tool must declare an empty mutation plan');
    }
    let v;
    try {
      v = validatePath(ctx.workspaceRoot, fact.path, stateOpt);
    } catch (e) {
      return denyFromError(e);
    }
    if (!v.inWorkspace) {
      return decision(
        'sensitive',
        'deny',
        'artifact.inspect-outside-workspace',
        'page inspection reads workspace documents only; files outside the workspace are not rasterized',
      );
    }
    if (isSecretName(fact.path, ctx.rules?.secretPatterns) || isSecretName(v.resolved, ctx.rules?.secretPatterns)) {
      // Pixels are not redactable the way text is: a rasterized .env is the secret, verbatim,
      // in a form the redaction machinery cannot touch. Deny rather than ask-with-redaction.
      return decision('sensitive', 'deny', 'artifact.inspect-secret-name', 'this file may contain secrets; pixels cannot be redacted, so it is not rasterized');
    }
    if (fact.sessionRendered === true) {
      return decision(
        'reversible',
        'allow',
        'artifact.inspect-session-artifact',
        'rasterizes pages of an artifact THIS SESSION rendered (consent inherited from the render; content identity re-verified at execute) ' +
          'in the headless system browser with network access blocked; page images are stored as session evidence and shown to the model',
        { noUndo: true },
      );
    }
    return applyGrant(
      decision(
        'sensitive',
        'ask',
        'artifact.inspect-approval-required',
        (fact.renderedWithEmbeddedImages === true
          ? 'rasterizes pages of an artifact this session rendered — but its spec EMBEDDED workspace image files the harness ' +
            'did not produce, so their pixels reach the model through this call and are not covered by the render approval'
          : 'rasterizes pages of a workspace document the harness did NOT produce') +
          ', in the headless system browser (network access blocked, script evaluation disabled in the PDF engine); the ' +
          'rendered pixels are shown to the model and stored as session evidence; a session-scope answer covers further ' +
          'documents this session',
        { noUndo: true },
      ),
      tool,
      grants,
    );
  }

  // 0g. Bounded external read (Session 19) → explicit fail-closed branch, before the command
  //     branch and every fall-through.
  //
  //     Why it cannot ride an existing branch: a research call is command-less and mutation-less,
  //     so it would auto-allow as `observe` with the reason "read-only workspace access". That
  //     sentence is not merely imprecise for a call that ships model-authored text to a third
  //     party — it is false about the only consequence that matters. Reading is not the risk;
  //     SENDING is, and the network is the one boundary the OS sandbox explicitly does not
  //     confine (see sandboxRuleLines).
  //
  //     Consent model — the BUDGET is the consent. The first call asks, `external` and grantable,
  //     with the query verbatim and both the per-call and per-session ceilings in the prompt; a
  //     session grant then means "the bounded research capability is authorized this session",
  //     bounded by a real shared counter rather than by good intentions. Inside a researcher
  //     subagent there is no approver at all (read-only roles auto-deny), so the authority comes
  //     from the SPAWN the engine already gated — stated as "the spawn was allowed", never "the
  //     human approved", because under --dangerously-allow-all no human approved anything.
  if (tool.research !== undefined) {
    let fact: ResearchFact;
    try {
      fact = tool.research(input);
    } catch (e) {
      return decision('sensitive', 'deny', 'research.invalid-contract', `research() threw: ${(e as Error).message}`);
    }
    const conflicts = otherFacts(tool, 'research');
    if (conflicts.length > 0) {
      return decision('sensitive', 'deny', 'research.conflicting-contract', conflictReason('research', conflicts));
    }
    // A research tool writes nothing. Findings reach the log through the evidence channel, whose
    // callId the runtime binds — never through a mutation plan this branch did not validate.
    let plan: MutationPlan | null;
    try {
      plan = tool.mutates(input, ctx);
    } catch (e) {
      return decision('sensitive', 'deny', 'research.invalid-contract', `mutates() threw: ${(e as Error).message}`);
    }
    if (plan === null || plan.paths.length > 0) {
      return decision('sensitive', 'deny', 'research.mutating-contract', 'a research tool must declare an empty mutation plan');
    }

    const blocked = ctx.rules?.researchBlockedDomains ?? [];
    const blockedBy = (host: string): string | undefined => blocked.find((d) => hostUnder(host, d));

    if (fact.kind === 'search') {
      const query = (fact.query ?? '').trim();
      if (query === '') {
        return decision('sensitive', 'deny', 'research.empty-request', 'a search must carry a non-empty query');
      }
      for (const d of fact.domains ?? []) {
        const hit = blockedBy(d);
        if (hit !== undefined) {
          return decision(
            'sensitive',
            'deny',
            'research.blocked-domain',
            `'${d}' is under '${hit}', which this workspace's configuration forbids research from reaching; a model-chosen domain list never overrides it`,
          );
        }
      }
    } else {
      const targets = fact.targets ?? [];
      if (targets.length === 0) {
        return decision('sensitive', 'deny', 'research.empty-request', 'an extract must name at least one URL');
      }
      // One bad URL denies the whole call. A partial success would teach a model nothing from
      // naming an internal host, and "3 of 5 were fetched" is harder to act on than a refusal
      // that names the offender.
      const bad = targets.find((t) => t.refusedReason !== undefined);
      if (bad !== undefined) {
        return decision(
          'sensitive',
          'deny',
          'research.unusable-target',
          `'${bad.url}' is not a citable public source (${bad.refusedReason ?? 'refused'}); the whole call is refused — re-issue it without that URL`,
        );
      }
      for (const t of targets) {
        const hit = t.host !== undefined ? blockedBy(t.host) : undefined;
        if (hit !== undefined) {
          return decision(
            'sensitive',
            'deny',
            'research.blocked-domain',
            `'${t.url}' is under '${hit}', which this workspace's configuration forbids research from reaching`,
          );
        }
      }
    }

    if (fact.budgetExhausted !== undefined) {
      return decision(
        'sensitive',
        'deny',
        'research.budget-exhausted',
        // The fact's own sentence says WHICH ceiling was hit, and the two mean different things:
        // a spent SESSION budget ends research for the session, while a spent per-TASK page cap
        // only ends this task's reading. Asserting the former for both told a researcher its
        // session was over when it still had 8 searches left (S19 review).
        `a research bound is spent (${fact.budgetExhausted}); this call is refused`,
      );
    }

    const shape =
      fact.kind === 'search'
        ? `sends the query verbatim to ${fact.providerHost} and returns at most ${String(fact.bounds.maxResults ?? 0)} source snippet(s)`
        : `asks ${fact.providerHost} to fetch ${String((fact.targets ?? []).length)} page(s) and returns their text`;
    const cost =
      `bounds: ≤${String(fact.bounds.maxContentChars)} retrieved chars, ${String(fact.bounds.timeoutMs)} ms, ` +
      `~${String(fact.bounds.credits)} provider credit(s)`;

    // Inside a researcher child the spawn already carried this authority through the engine, and
    // there is no approver to ask (read-only roles auto-deny — an ask here is a refusal, not a
    // prompt). Every bound above still applies, and every call is still recorded.
    if (ctx.lineage?.role === 'researcher') {
      return decision(
        'external',
        'allow',
        'research.delegated-role',
        `${shape}; runs inside a research subagent whose spawn this engine allowed, under the same session budget as the parent (${cost})`,
        { noUndo: true },
      );
    }

    return applyGrant(
      decision(
        'external',
        'ask',
        'research.approval-required',
        `${shape}. The text above LEAVES THIS MACHINE. Retrieved content is untrusted data, is never treated as ` +
          `instructions, and never verifies anything. ${cost}` +
          (fact.budgetRemaining !== undefined
            ? `; a session-scope answer covers further research this session within the remaining budget (${fact.budgetRemaining})`
            : ''),
        { noUndo: true },
      ),
      tool,
      grants,
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
    // Classify on BOTH the raw request and the RESOLVED path (S14.5 review finding): the
    // resolver expands symlinks and Windows 8.3 short names, so `ENV~1` or a checked-in
    // `config/local.json -> ../.env.production` reached `.env` bytes while the basename test
    // saw an innocent name — no ask, no redaction, secrets verbatim into the log.
    if (isSecretName(p, ctx.rules?.secretPatterns) || isSecretName(v.resolved, ctx.rules?.secretPatterns)) {
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
