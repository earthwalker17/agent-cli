import { applyUndo } from '../runtime/undo.js';
import { buildReport } from '../report/report.js';
import { buildSessionDiff, renderSessionDiff } from '../report/diff.js';
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
}

export const HELP = [
  'commands:',
  '  /help           this help',
  '  /status         session, model, workspace, token usage',
  '  /undo [all]     revert the last (or all) file-tool change(s) of this session',
  '  /diff           show what this session changed (unified diff vs the session pre-images)',
  '  /report         print the evidence report for this session',
  '  /map            print the workspace map the model receives',
  '  /quit           end the session (Ctrl+D on an empty line also works)',
  'keys: Ctrl+C interrupts the running turn; at the idle prompt press it twice to quit.',
  'note: shell commands always ask; their effects are never undoable.',
].join('\n');

export type SlashOutcome = 'continue' | 'quit';

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
