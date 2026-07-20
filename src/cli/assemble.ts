import { startSession, resumeSession, recordWorkspaceMap, recordSandboxStatus, recordGitContext, type Session } from '../runtime/session.js';
import { selectSandbox, type SandboxBackend, type EnforcementFacts } from '../sandbox/index.js';
import { detectGitFacts } from '../git/facts.js';
import type { GitFacts } from '../git/types.js';
import { buildWorkspaceMapAuto, type WorkspaceMap } from '../workspace/map.js';
import { buildSystemPrompt } from '../workspace/system-prompt.js';
import { randomSaltHex } from '../shared/hash.js';
import type { ProjectLayout } from '../store/layout.js';
import type { ResolvedConfig } from '../config/config.js';
import type { TrustDecision } from '../trust/gate.js';
import type { SessionEvent } from '../types.js';
import type { RunContext } from './context.js';

/**
 * The ONE session-assembly path shared by the one-shot CLI and the REPL, so the two interfaces
 * cannot drift into parallel construction. Order is load-bearing: sandbox select + PROBE and the
 * git probe run before the map and system prompt so both report the truth; the post-start records
 * land in a fixed order the report and tests rely on.
 */

export interface AssembleDeps {
  /** Structural proof the trust gate ran and PASSED — assembly is impossible untrusted. */
  trust: Extract<TrustDecision, { trusted: true }>;
  config: ResolvedConfig;
  ctx: RunContext;
  layout: ProjectLayout;
  /** Resume this session instead of starting a fresh one. */
  resumeId?: string;
  argv?: string[];
  onText?: (delta: string) => void;
  onCommandOutput?: (callId: string, chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Live log observer (the REPL renderer); assigned BEFORE the post-start records so it misses nothing. */
  onLogEvent?: (e: SessionEvent) => void;
  /** Injectable for deterministic, platform-independent tests; defaults to selectSandbox. */
  sandbox?: SandboxBackend;
  /** Injectable for deterministic tests; defaults to a real detectGitFacts probe. */
  gitFacts?: GitFacts;
}

export interface Assembled {
  session: Session;
  sandboxFacts: EnforcementFacts;
  gitFacts: GitFacts;
  map: WorkspaceMap;
}

export async function assembleSession(deps: AssembleDeps): Promise<Assembled> {
  const { ctx, layout } = deps;

  // Establish + probe the execution sandbox before the first turn, so the banner and system
  // prompt report the truth. Then the git probe (post-trust — it executes git against the repo).
  const sandbox = deps.sandbox ?? selectSandbox({ stateRoot: layout.stateRoot });
  const sandboxFacts = await sandbox.ensureAvailable();
  const gitFacts = deps.gitFacts ?? (await detectGitFacts(ctx.ws));
  const map = await buildWorkspaceMapAuto(ctx.ws, {}, gitFacts);
  const system = buildSystemPrompt(ctx.ws, map, sandboxFacts, gitFacts);

  const common = {
    workspaceRoot: ctx.ws,
    layout,
    model: ctx.model,
    mode: ctx.mode,
    provider: ctx.provider,
    approver: ctx.approver,
    system,
    maxSteps: ctx.maxSteps,
    maxTokens: ctx.maxTokens,
    saltHex: randomSaltHex(),
    rules: deps.config.rules,
    sandbox,
    sandboxFacts,
    gitFacts,
    ...(deps.onText !== undefined ? { onText: deps.onText } : {}),
    ...(deps.onCommandOutput !== undefined ? { onCommandOutput: deps.onCommandOutput } : {}),
  };

  const session = deps.resumeId !== undefined
    ? resumeSession({ ...common, sessionId: deps.resumeId })
    : startSession({ ...common, argv: deps.argv ?? [] });

  if (deps.onLogEvent !== undefined) session.log.onAppend = deps.onLogEvent;
  session.log.append({ type: 'trust.verified', source: deps.trust.source });
  session.log.append({ type: 'config.loaded', sources: deps.config.sources });
  recordSandboxStatus(session, sandboxFacts);
  recordGitContext(session, gitFacts);
  recordWorkspaceMap(session, map);

  return { session, sandboxFacts, gitFacts, map };
}
