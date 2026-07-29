import type { SessionEvent } from '../types.js';
import type { TurnResult } from '../runtime/session.js';
import { sanitizeLine } from '../shared/text.js';
import { fmtDuration, fmtTokens, toolLabel, type Style } from './format.js';

/**
 * The live view of the session: subscribes to EventLog.onAppend, so the screen renders exactly
 * what the evidence log persisted — never a parallel narrative (evidence over narration).
 *
 * Stream split (load-bearing for redirection and tests): assistant text goes to `modelOut`
 * (stdout) verbatim; ALL chrome — tool activity, approvals, summaries, banners — goes to
 * `chromeOut` (stderr). `agent --interactive < script > transcript.txt` captures only what the
 * model said plus explicitly requested artifacts.
 */

export interface Renderer {
  onText(delta: string): void;
  /** Live command output (render-only preview; the persisted evidence is the completed result). */
  onCommandOutput(chunk: string, stream: 'stdout' | 'stderr'): void;
  onEvent(e: SessionEvent): void;
  beginTurn(): void;
  endTurn(result: TurnResult, maxSteps: number): void;
  turnError(err: Error): void;
  banner(info: BannerInfo): void;
  chromeLine(text: string): void;
  /** Close any half-open output line (called before prompts). */
  flush(): void;
}

export interface BannerInfo {
  sessionId: string;
  resumed: boolean;
  model: string;
  /** Provider name (Session 15) — shown beside the model so the banner names who serves the session. */
  provider?: string;
  workspaceRoot: string;
  stateDir: string;
  network?: string;
  sandbox?: { summary: string; enforced: boolean };
  git?: { summary: string };
  /** Project-memory summary + optional crash note (yellow — it deserves the user's eye). */
  memory?: { summary: string; crashNote?: string };
  dangerous: boolean;
}

interface Counters {
  files: Set<string>;
  commands: number;
  denials: number;
  inTokens: number;
  outTokens: number;
  steps: number;
  tasks: number;
}

export function createRenderer(opts: {
  modelOut: NodeJS.WritableStream;
  chromeOut: NodeJS.WritableStream;
  style: Style;
  /**
   * Session 11: the status-aware chrome sink (the sticky status area's write). When present,
   * EVERY chrome byte goes through it so the area can erase/redraw around ordinary chrome;
   * absent (tests, one-shot) chrome writes go straight to chromeOut. modelOut is untouched.
   */
  chromeSink?: { write(chunk: string): void };
}): Renderer {
  const { modelOut, style } = opts;
  const chromeOut = opts.chromeSink ?? opts.chromeOut;
  const g = style.glyph;
  let textOpen = false; // assistant text column open on modelOut
  let toolOpen = false; // an unterminated tool line open on chromeOut
  let counters: Counters = { files: new Set(), commands: 0, denials: 0, inTokens: 0, outTokens: 0, steps: 0, tasks: 0 };

  // Live command-output preview state (per command; reset on command.started).
  const CMD_FLUSH_MS = 100;
  const CMD_DISPLAY_CAP = 8 * 1024;
  const CMD_LINE_CAP = 200;
  let cmdBuf = '';
  let cmdShown = 0;
  let cmdSuppressed = false;
  let lastCmdFlush = 0;

  const flushCmdOutput = (final: boolean): void => {
    lastCmdFlush = Date.now();
    let text = cmdBuf;
    let rest = '';
    if (!final) {
      const idx = text.lastIndexOf('\n');
      if (idx === -1) {
        if (text.length <= 2048) return; // wait for a newline unless the line is oversized
      } else {
        rest = text.slice(idx + 1);
        text = text.slice(0, idx);
      }
    }
    cmdBuf = rest;
    if (text.length === 0 || cmdSuppressed) return;
    if (toolOpen) {
      chromeOut.write('\n');
      toolOpen = false;
    }
    for (const line of text.split('\n')) {
      const shown = sanitizeLine(line);
      chromeOut.write(style.dim(`    ${shown.slice(0, CMD_LINE_CAP)}${shown.length > CMD_LINE_CAP ? '…' : ''}`) + '\n');
      cmdShown += line.length;
      if (cmdShown > CMD_DISPLAY_CAP) {
        chromeOut.write(style.dim('    … live output display capped (the full output is in the tool result)') + '\n');
        cmdSuppressed = true;
        cmdBuf = '';
        return;
      }
    }
  };

  const flush = (): void => {
    if (textOpen) {
      modelOut.write('\n');
      textOpen = false;
    }
    if (toolOpen) {
      chromeOut.write('\n');
      toolOpen = false;
    }
  };
  const chromeLine = (text: string): void => {
    flush();
    chromeOut.write(text + '\n');
  };

  return {
    flush,
    chromeLine,

    onText(delta) {
      if (delta.length === 0) return;
      if (toolOpen) {
        chromeOut.write('\n');
        toolOpen = false;
      }
      modelOut.write(delta);
      textOpen = !delta.endsWith('\n');
    },

    onCommandOutput(chunk) {
      if (cmdSuppressed || chunk.length === 0) return;
      cmdBuf += chunk;
      if (Date.now() - lastCmdFlush >= CMD_FLUSH_MS || cmdBuf.length > 2048) flushCmdOutput(false);
    },

    onEvent(e) {
      switch (e.type) {
        case 'tool.requested': {
          flush();
          chromeOut.write(style.dim(`  ${g.bullet} ${toolLabel(e.tool, e.input)} `));
          toolOpen = true;
          if (e.tool === 'run_command') counters.commands++;
          break;
        }
        case 'tool.completed': {
          const mark = e.ok ? style.green(g.ok) : style.red(g.fail);
          const dur = e.durationMs > 0 ? ` ${style.dim(fmtDuration(e.durationMs))}` : '';
          const note = e.ok ? '' : ` ${style.dim(sanitizeLine(e.outputPreview.slice(0, 80)))}`;
          if (toolOpen) {
            chromeOut.write(`${mark}${dur}${note}\n`);
            toolOpen = false;
          } else {
            chromeLine(`  ${mark}${dur}${note}`);
          }
          break;
        }
        case 'policy.decision': {
          if (e.decision === 'deny') counters.denials++;
          break;
        }
        case 'approval.resolved': {
          if (e.decision !== 'allow') counters.denials++;
          chromeLine(style.dim(`  ${g.arrow} ${e.decision}${e.scope === 'session' ? ' (rest of session)' : ''}`));
          break;
        }
        case 'file.mutated': {
          counters.files.add(e.path);
          break;
        }
        case 'assistant.message': {
          counters.steps++;
          counters.inTokens += e.usage.inputTokens;
          counters.outTokens += e.usage.outputTokens;
          break;
        }
        case 'command.started': {
          cmdBuf = '';
          cmdShown = 0;
          cmdSuppressed = false;
          lastCmdFlush = Date.now();
          const box = e.sandbox === 'windows-lowil' ? ', sandboxed' : '';
          // For an asked command the approval line already closed the tool line; give the pid its own line.
          if (toolOpen) chromeOut.write(style.dim(`(pid ${e.pid}${box}) `));
          else chromeLine(style.dim(`  ${g.arrow} running (pid ${e.pid}${box})`));
          break;
        }
        case 'command.ended': {
          flushCmdOutput(true);
          if (e.termination === 'timeout' || e.termination === 'aborted') {
            const why = e.termination === 'timeout' ? `timed out after ${fmtDuration(e.durationMs)}` : 'aborted by user';
            chromeLine(style.yellow(`  ${g.warn} command ${why} — process tree force-killed (best effort); no exit code`));
          }
          break;
        }
        case 'check.started': {
          // A typed check reuses the live command-output preview channel: it is a real process,
          // and watching a build/test scroll is exactly as useful as watching a command.
          cmdBuf = '';
          cmdShown = 0;
          cmdSuppressed = false;
          lastCmdFlush = Date.now();
          chromeLine(style.dim(`  ${g.arrow} check ${e.check} — ${sanitizeLine(e.command)}`));
          break;
        }
        case 'check.completed': {
          flushCmdOutput(true);
          const mark =
            e.status === 'pass'
              ? style.green(g.ok)
              : e.status === 'unsupported'
                ? style.yellow(g.warn)
                : style.red(g.fail);
          chromeLine(`  ${mark} ${sanitizeLine(e.summary)}`);
          for (const f of e.findings ?? []) {
            const where = f.file !== undefined ? `${sanitizeLine(f.file)}${f.line !== undefined ? `:${String(f.line)}` : ''} — ` : '';
            chromeLine(style.dim(`      ${where}${sanitizeLine(f.message)}`));
          }
          break;
        }
        case 'preview.started': {
          // No live output channel: a preview logs to a FILE (see preview/process.ts), so the
          // chrome shows lifecycle boundaries and /preview shows the tail.
          chromeLine(style.dim(`  ${g.arrow} preview ${e.previewId} — ${sanitizeLine(e.command)} (pid ${String(e.pid)})`));
          break;
        }
        case 'preview.ready': {
          chromeLine(`  ${style.green(g.ok)} preview ${e.previewId} ready at ${sanitizeLine(e.url)} (${sanitizeLine(e.probeDetail)}, waited ${String(e.waitedMs)}ms)`);
          break;
        }
        case 'preview.ended': {
          const benign = e.reason === 'stopped' || e.reason === 'session-end';
          const line = `preview ${e.previewId} ended: ${e.reason}${e.exitCode !== null ? ` (exit ${String(e.exitCode)})` : ''}`;
          chromeLine(benign ? style.dim(`  ${g.bullet} ${line}`) : style.yellow(`  ${g.warn} ${line}`));
          break;
        }
        case 'browser.flow': {
          const mark = e.status === 'pass' ? style.green(g.ok) : e.status === 'unsupported' ? style.yellow(g.warn) : style.red(g.fail);
          const shots = e.artifacts.filter((a) => a.kind === 'screenshot').length;
          chromeLine(
            `  ${mark} flow ${sanitizeLine(e.flowName)}: ${e.status} — ${e.steps.filter((s) => s.ok).length}/${e.steps.length} step(s)` +
              `${shots > 0 ? `, ${shots} screenshot(s)` : ''}${e.pageErrors.length > 0 ? `, ${e.pageErrors.length} page error(s)` : ''}`,
          );
          for (const s of e.steps.filter((x) => !x.ok)) {
            chromeLine(style.dim(`      step ${s.n} (${s.kind} ${sanitizeLine(s.target ?? '')}): [${s.failure?.class ?? '?'}] ${sanitizeLine(s.failure?.detail ?? '')}`));
          }
          break;
        }
        case 'preview.swept': {
          const bits = [
            e.killed.length > 0 ? `stopped ${String(e.killed.length)} orphan(s)` : '',
            e.killFailed.length > 0 ? `${String(e.killFailed.length)} kill(s) failed` : '',
            e.skippedUnverified.length > 0 ? `${String(e.skippedUnverified.length)} left (unverified identity)` : '',
            e.droppedDead.length > 0 ? `${String(e.droppedDead.length)} stale record(s) cleared` : '',
            (e.retiredStale?.length ?? 0) > 0 ? `${String(e.retiredStale!.length)} deregistered as stale (nothing killed)` : '',
            (e.unaccountedLogs?.length ?? 0) > 0 ? `${String(e.unaccountedLogs!.length)} unaccounted preview log(s) — a start may have been lost` : '',
          ].filter((s) => s !== '');
          if (bits.length > 0) chromeLine(style.dim(`  ${g.bullet} preview sweep: ${bits.join('; ')}`));
          break;
        }
        case 'repair.attempted': {
          chromeLine(
            style.dim(`  ${g.arrow} repair attempt ${e.attempt} on ${sanitizeLine(e.target)} [${e.failureClass}] — prove with ${e.regressionChecks.join(', ')}`),
          );
          break;
        }
        case 'repair.escalated': {
          chromeLine(style.yellow(`  ${g.warn} repair ESCALATED on ${sanitizeLine(e.target)} [${e.failureClass}]: ${sanitizeLine(e.reason)}`));
          break;
        }
        case 'turn.aborted': {
          chromeLine(style.yellow(`  ${g.warn} turn interrupted`));
          break;
        }
        case 'snapshot.failed': {
          chromeLine(style.yellow(`  ${g.warn} snapshot failed for ${sanitizeLine(e.path)} — change would NOT be undoable`));
          break;
        }
        case 'undo.applied': {
          for (const r of e.restored) chromeLine(`  ${style.green(g.ok)} restored ${sanitizeLine(r.path)}`);
          for (const r of e.refused) chromeLine(`  ${style.red(g.fail)} refused ${sanitizeLine(r.path)}: ${r.reason}`);
          if (e.restored.length === 0 && e.refused.length === 0) chromeLine(style.dim('  nothing to undo'));
          break;
        }
        case 'git.commit': {
          chromeLine(`  ${style.green(g.ok)} committed ${e.oid.slice(0, 12)} — ${e.files.length} file(s): ${sanitizeLine(e.subject)}`);
          break;
        }
        case 'git.restore': {
          chromeLine(
            `  ${style.green(g.ok)} restored ${e.restored.length} file(s) to checkpoint ${e.oid.slice(0, 12)}${e.refused.length > 0 ? `; ${e.refused.length} refused` : ''} (undo with /undo)`,
          );
          for (const r of e.refused) chromeLine(`  ${style.red(g.fail)} refused ${sanitizeLine(r.path)}: ${r.reason}`);
          break;
        }
        case 'git.checkpoint': {
          chromeLine(
            `  ${style.green(g.ok)} checkpoint ${e.oid.slice(0, 12)}${e.label ? ` (${sanitizeLine(e.label)})` : ''} — ${e.filesChanged} file(s) differ from HEAD; hidden ref, no history touched`,
          );
          break;
        }
        case 'task.base-checkpoint': {
          chromeLine(style.dim(`  ${g.bullet} task-base checkpoint ${e.oid.slice(0, 12)} (harness recovery point; pruned at session end)`));
          break;
        }
        case 'harness.checkpoint': {
          chromeLine(
            style.dim(
              e.kind === 'delivery'
                ? `  ${g.bullet} delivery checkpoint ${e.oid.slice(0, 12)} (the accepted state; SURVIVES the session — agent checkpoint list)`
                : `  ${g.bullet} pre-integration checkpoint ${e.oid.slice(0, 12)} (whole-workspace recovery point; pruned at session end)`,
            ),
          );
          break;
        }
        case 'review.findings': {
          const sevCounts = new Map<string, number>();
          for (const f of e.findings) sevCounts.set(f.severity, (sevCounts.get(f.severity) ?? 0) + 1);
          const counts = [...sevCounts.entries()].map(([s, n]) => `${n} ${s}`).join(', ');
          chromeLine(
            e.findings.length === 0
              ? style.dim(`  ${g.bullet} review lens ${sanitizeLine(e.childSessionId.slice(-4))}: clean (zero findings recorded)`)
              : style.yellow(`  ${g.warn} review lens ${sanitizeLine(e.childSessionId.slice(-4))}: ${e.findings.length} finding(s) recorded — ${counts}`),
          );
          break;
        }
        case 'review.triage': {
          chromeLine(style.dim(`  ${g.bullet} review triage: ${sanitizeLine(e.findingId)} → ${e.action} (see /review)`));
          break;
        }
        case 'task.started': {
          counters.tasks++;
          chromeLine(style.dim(`  ${g.bullet} task ${sanitizeLine(e.role)}·${sanitizeLine(e.childSessionId.slice(-4))} started — child session ${sanitizeLine(e.childSessionId)}`));
          break;
        }
        case 'task.ended': {
          const ok = e.status === 'completed';
          const mark = ok ? style.green(g.ok) : style.yellow(g.warn);
          chromeLine(
            `  ${mark} task ${sanitizeLine(e.childSessionId.slice(-4))} ${e.status} — ${e.steps} step(s), ${fmtTokens(e.usage.outputTokens)} out tok (evidence: agent report ${sanitizeLine(e.childSessionId)})`,
          );
          break;
        }
        case 'task.supervision': {
          chromeLine(style.yellow(`  ${g.warn} task ${sanitizeLine(e.childSessionId.slice(-4))} supervision: ${e.kind}${e.detail !== undefined ? ` — ${sanitizeLine(e.detail)}` : ''}`));
          break;
        }
        case 'task.changes': {
          chromeLine(
            style.dim(
              `  ± task ${sanitizeLine(e.childSessionId.slice(-4))} captured ${e.files.length} changed file(s)${(e.omittedCount ?? 0) > 0 ? ` (+${e.omittedCount} omitted)` : ''} — integrate with apply_task_changes`,
            ),
          );
          break;
        }
        case 'task.applied': {
          const mark = e.refused.length === 0 ? style.green(g.ok) : style.yellow(g.warn);
          chromeLine(`  ${mark} applied ${e.applied.length} change(s) from task ${sanitizeLine(e.childSessionId.slice(-4))}${e.refused.length > 0 ? `; ${e.refused.length} REFUSED` : ''} (undo with /undo)`);
          for (const r of e.refused) chromeLine(style.yellow(`    refused ${sanitizeLine(r.relPath)}: ${sanitizeLine(r.reason)}`));
          break;
        }
        case 'worktree.removed': {
          if (!e.ok) chromeLine(style.yellow(`  ${g.warn} task worktree could not be removed (${sanitizeLine(e.detail ?? 'unknown')}); it will be swept next session`));
          break;
        }
        case 'context.compacted': {
          const pct = e.rawChars > 0 ? Math.round((100 * e.sentChars) / e.rawChars) : 100;
          const imgBit = (e.newlyImageElidedCallIds?.length ?? 0) > 0 ? `, ${e.newlyImageElidedCallIds!.length} screenshot(s) aged to pointers` : '';
          chromeLine(
            style.dim(`  context compacted: ${e.elidedCount} older tool output(s) elided${imgBit} (history ${e.rawChars} → ${e.sentChars} chars, ${pct}%); full outputs stay in the log`),
          );
          if (e.exhausted) chromeLine(style.yellow(`  ${g.warn} history still exceeds the context target after eliding all old tool outputs — consider a fresh session`));
          break;
        }
        default:
          break;
      }
    },

    beginTurn() {
      counters = { files: new Set(), commands: 0, denials: 0, inTokens: 0, outTokens: 0, steps: 0, tasks: 0 };
    },

    endTurn(result, maxSteps) {
      flush();
      const bits = [
        `${counters.files.size} file(s)`,
        `${counters.commands} cmd`,
        `${counters.steps} step(s)`,
        `${fmtTokens(counters.inTokens)}/${fmtTokens(counters.outTokens)} tok`,
      ];
      if (counters.tasks > 0) bits.splice(2, 0, `${counters.tasks} task(s)`);
      if (counters.denials > 0) bits.push(`${counters.denials} denied`);
      let status = '';
      if (result.aborted) status = ` ${g.warn} interrupted`;
      else if (result.stopReason === 'refusal')
        // Session 15: classifier declines (claude-opus-5/fable-5) are HTTP-200 turns that would
        // otherwise end silently — say so honestly instead of looking like a finished answer.
        status = ` ${g.warn} the model declined this request (stop reason: refusal) — rephrase or narrow the task`;
      else if (result.stopped && result.steps >= maxSteps) status = ` ${g.warn} step budget reached — continue with another instruction`;
      else if (result.stopped) status = ` ${g.warn} stopped`;
      chromeLine(style.dim(`${g.rule.repeat(2)} ${bits.join(' · ')}`) + (status ? style.yellow(status) : ''));
    },

    turnError(err) {
      chromeLine(style.red(`${g.fail} turn failed: ${sanitizeLine(err.message)}`) + style.dim(' (session continues; evidence is in the log)'));
    },

    banner(info) {
      chromeLine(style.bold(`agent ${info.resumed ? 'resumed' : 'session'} ${info.sessionId}`));
      chromeLine(style.dim(`  workspace: ${sanitizeLine(info.workspaceRoot)}`));
      chromeLine(
        style.dim(
          `  model: ${info.model}${info.provider !== undefined ? ` · provider: ${info.provider}` : ''} · state: ${sanitizeLine(info.stateDir)}`,
        ),
      );
      if (info.network) chromeLine(style.dim(`  network: ${info.network}`));
      if (info.sandbox) {
        const line = `  sandbox: ${info.sandbox.summary}`;
        chromeLine(info.sandbox.enforced ? style.dim(line) : style.yellow(line));
      }
      if (info.git) chromeLine(style.dim(`  git: ${sanitizeLine(info.git.summary)}`));
      if (info.memory) {
        chromeLine(style.dim(`  memory: ${sanitizeLine(info.memory.summary)}`));
        if (info.memory.crashNote !== undefined) chromeLine(style.yellow(`  ${g.warn} ${sanitizeLine(info.memory.crashNote)}`));
      }
      if (info.dangerous) chromeLine(style.red(`  ${g.warn} approvals BYPASSED (--dangerously-allow-all)`));
      chromeLine(style.dim(`  /help for commands · Ctrl+C interrupts a running turn · /quit to leave`));
    },
  };
}
