import { applyUndo } from '../runtime/undo.js';
import { buildReport } from '../report/report.js';
import { buildSessionDiff, renderSessionDiff } from '../report/diff.js';
import { runCommitFlow } from '../git/commit.js';
import { createCheckpoint, listCheckpoints, runRestoreFlow, type CheckpointContext } from '../git/checkpoint.js';
import { buildWorkspaceMapAuto } from '../workspace/map.js';
import { sanitizeLine } from '../shared/text.js';
import type { Session } from '../runtime/session.js';
import type { Renderer } from './render.js';

/**
 * Slash commands are thin adapters over existing kernel functions, run against the session's OWN
 * open EventLog (which is live — never a second EventLog.open, which would deadlock on the lock).
 */

export interface CommandContext {
  session: Session;
  renderer: Renderer;
  modelOut: NodeJS.WritableStream;
  /** Notes to prepend (clearly delimited) to the next user message so the model learns of
   *  out-of-band changes like /undo. Logged verbatim inside user.message — attributable. */
  pendingNotes: string[];
  /** Interactive confirmation seam (the REPL's shared readline); null answer = EOF = decline. */
  question?: (q: string) => Promise<string | null>;
}

export const HELP = [
  'commands:',
  '  /help           this help',
  '  /status         session, model, workspace, token usage',
  '  /undo [all]     revert the last (or all) file-tool change(s) of this session',
  '  /diff           show what this session changed (unified diff vs the session pre-images)',
  '  /commit [-m "msg"] [--all] [--no-trailer]',
  '                  commit session-attributed changes (or --all) after a preview + confirmation',
  '  /checkpoint [label | list | restore <n>]',
  '                  capture the workspace to a hidden git ref (recovery point; no history',
  '                  touched); restore <n> returns to a checkpoint as one undoable batch',
  '  /report         print the evidence report for this session',
  '  /map            print the workspace map the model receives',
  '  /quit           end the session (Ctrl+D on an empty line also works)',
  'keys: Ctrl+C interrupts the running turn; at the idle prompt press it twice to quit.',
  'note: shell commands always ask; their effects are never undoable.',
].join('\n');

export type SlashOutcome = 'continue' | 'quit';

/** Parse `/commit` arguments: [-m "msg"] [--all] [--no-trailer]. Exported for tests. */
export function parseCommitArgs(arg: string): { all: boolean; noTrailer: boolean; message?: string; error?: string } {
  let all = false;
  let noTrailer = false;
  let message: string | undefined;
  const tokens = arg.match(/"[^"]*"|\S+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '--all') all = true;
    else if (t === '--no-trailer') noTrailer = true;
    else if (t === '-m') {
      const rest = tokens
        .slice(i + 1)
        .join(' ')
        .replace(/^"|"$/g, '');
      if (rest.length === 0) return { all, noTrailer, error: 'usage: /commit [-m "msg"] [--all] [--no-trailer] — -m needs a message' };
      message = rest;
      break;
    } else return { all, noTrailer, error: `unknown /commit argument: ${t}` };
  }
  return { all, noTrailer, ...(message !== undefined ? { message } : {}) };
}

export async function dispatchSlash(line: string, ctx: CommandContext): Promise<SlashOutcome> {
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');

  switch ((cmd ?? '').toLowerCase()) {
    case 'help':
      ctx.renderer.chromeLine(HELP);
      return 'continue';

    case 'status': {
      const s = ctx.session;
      let inTok = 0;
      let outTok = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let turns = 0;
      for (const e of s.log.events) {
        if (e.type === 'assistant.message') {
          inTok += e.usage.inputTokens;
          outTok += e.usage.outputTokens;
          cacheRead += e.usage.cacheReadInputTokens ?? 0;
          cacheWrite += e.usage.cacheCreationInputTokens ?? 0;
        } else if (e.type === 'user.message') turns++;
      }
      const cache = cacheRead + cacheWrite > 0 ? ` (cache: ${cacheRead} read / ${cacheWrite} written)` : '';
      ctx.renderer.chromeLine(
        [
          `session ${s.id} (${s.mode})`,
          `  workspace: ${sanitizeLine(s.workspaceRoot)}`,
          `  model: ${s.model} · provider: ${s.provider.name}`,
          `  user messages: ${turns} · tokens: ${inTok} in / ${outTok} out${cache}`,
          ...(s.gitFacts?.isRepo ? [`  git (at session start): ${sanitizeLine(s.gitFacts.detail)}`] : []),
          `  state: ${sanitizeLine(s.stateDir)}`,
        ].join('\n'),
      );
      return 'continue';
    }

    case 'undo': {
      const target = arg.trim().toLowerCase() === 'all' ? 'all' : 'last';
      const outcome = applyUndo(ctx.session.log.events, ctx.session.snapshots, target);
      // The append renders the restored/refused lines via the log observer.
      ctx.session.log.append({ type: 'undo.applied', target: outcome.target, restored: outcome.restored, refused: outcome.refused });
      if (outcome.restored.length > 0) {
        ctx.pendingNotes.push(
          `the user ran /undo: ${outcome.restored.map((r) => r.path).join(', ')} ` +
            `restored to pre-change content. Re-read before editing them again.`,
        );
        ctx.renderer.chromeLine('  note: undo covers only file-tool changes; run_command side effects are not captured.');
      }
      return 'continue';
    }

    case 'diff': {
      const files = buildSessionDiff(ctx.session.log.events, ctx.session.snapshots, ctx.session.workspaceRoot);
      ctx.renderer.flush();
      // Diff lines are workspace bytes — untrusted content headed for a terminal; sanitize each line.
      ctx.modelOut.write(renderSessionDiff(files).split('\n').map(sanitizeLine).join('\n') + '\n');
      return 'continue';
    }

    case 'commit': {
      const g = ctx.session.gitFacts;
      if (!g?.isRepo || g.gitPath === null || g.repoRoot === null) {
        ctx.renderer.chromeLine('  /commit needs a git repository (this workspace is not inside one)');
        return 'continue';
      }
      const flags = parseCommitArgs(arg);
      if (flags.error) {
        ctx.renderer.chromeLine(`  ${flags.error}`);
        return 'continue';
      }
      const outcome = await runCommitFlow(
        { gitPath: g.gitPath, repoRoot: g.repoRoot, workspaceRoot: ctx.session.workspaceRoot, messageDir: ctx.session.stateDir },
        ctx.session.log.events,
        {
          scope: flags.all ? 'all' : 'session',
          ...(flags.message !== undefined ? { subject: flags.message } : {}),
          trailer: !flags.noTrailer,
          sessionId: ctx.session.id,
          io: {
            info: (line) => ctx.renderer.chromeLine(sanitizeLine(line)),
            question: ctx.question ?? null,
            assumeYes: false,
          },
        },
      );
      if (outcome.committed && outcome.result?.oid) {
        ctx.session.log.append({
          type: 'git.commit',
          oid: outcome.result.oid,
          subject: outcome.subject ?? '',
          files: outcome.result.files,
          scope: flags.all ? 'all' : 'session',
          trailer: !flags.noTrailer,
        });
        ctx.pendingNotes.push(`the user committed ${outcome.result.files.length} file(s) as ${outcome.result.oid.slice(0, 12)} ("${outcome.subject}")`);
      }
      return 'continue';
    }

    case 'checkpoint': {
      const g = ctx.session.gitFacts;
      if (!g?.isRepo || g.gitPath === null || g.repoRoot === null) {
        ctx.renderer.chromeLine('  /checkpoint needs a git repository (this workspace is not inside one)');
        return 'continue';
      }
      const cctx: CheckpointContext = { gitPath: g.gitPath, repoRoot: g.repoRoot, workspaceRoot: ctx.session.workspaceRoot, stateDir: ctx.session.stateDir };
      if (arg.trim().toLowerCase() === 'list') {
        const list = await listCheckpoints(cctx);
        if (list.length === 0) ctx.renderer.chromeLine('  no checkpoints in this repository');
        for (const c of list) ctx.renderer.chromeLine(`  ${c.oid.slice(0, 12)}  ${sanitizeLine(c.subject)}  (${c.createdAt})`);
        return 'continue';
      }
      const restoreMatch = /^restore\s+(\d+)$/i.exec(arg.trim());
      if (restoreMatch || /^restore\b/i.test(arg.trim())) {
        const n = restoreMatch ? Number(restoreMatch[1]) : NaN;
        if (!Number.isInteger(n) || n < 1) {
          ctx.renderer.chromeLine('  usage: /checkpoint restore <n>  (see /checkpoint list)');
          return 'continue';
        }
        const mine = await listCheckpoints(cctx, ctx.session.id);
        const ckpt = mine.find((c) => c.n === n);
        if (!ckpt) {
          ctx.renderer.chromeLine(`  no checkpoint ${n} for THIS session (use /checkpoint list; cross-session restore: agent checkpoint restore <n> --session <id>)`);
          return 'continue';
        }
        const r = await runRestoreFlow(cctx, ckpt, {
          snapshots: ctx.session.snapshots,
          appendEvent: (e) => ctx.session.log.append(e),
          callId: `git-restore-${ctx.session.log.events.length}`,
          info: (l) => ctx.renderer.chromeLine(sanitizeLine(l)),
          question: ctx.question ?? null,
          assumeYes: false,
        });
        if (r.performed && r.restored.length > 0) {
          ctx.pendingNotes.push(
            `the user restored ${r.restored.length} file(s) to checkpoint ${n} (${ckpt.oid.slice(0, 12)}). Re-read files before editing them again.`,
          );
        }
        return 'continue';
      }
      const label = arg.trim().length > 0 ? arg.trim() : undefined;
      const r = await createCheckpoint(cctx, ctx.session.id, {
        ...(label !== undefined ? { label } : {}),
        confirmLargeUntracked: async (count) => {
          if (!ctx.question) return false;
          const a = await ctx.question(`  capture ${count} untracked files too? (is something big not gitignored?) [y/N] `);
          return a !== null && /^y(es)?$/i.test(a.trim());
        },
      });
      if (r.ok && r.ref && r.oid) {
        ctx.session.log.append({ type: 'git.checkpoint', ref: r.ref, oid: r.oid, label: label ?? null, filesChanged: r.filesChanged ?? 0 });
      } else {
        ctx.renderer.chromeLine(`  checkpoint not created: ${r.error}`);
      }
      return 'continue';
    }

    case 'report': {
      const { md } = buildReport({ events: ctx.session.log.events });
      ctx.renderer.flush();
      ctx.modelOut.write(md + '\n');
      return 'continue';
    }

    case 'map': {
      const map = await buildWorkspaceMapAuto(ctx.session.workspaceRoot, {}, ctx.session.gitFacts);
      ctx.renderer.flush();
      ctx.modelOut.write(
        map.text.split('\n').map(sanitizeLine).join('\n') +
          `\n\n(${map.fileCount} files${map.truncated ? ', truncated' : ''})\n`,
      );
      return 'continue';
    }

    case 'quit':
    case 'exit':
      return 'quit';

    default:
      ctx.renderer.chromeLine(`unknown command: /${cmd ?? ''} — try /help`);
      return 'continue';
  }
}
