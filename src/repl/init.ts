import fs from 'node:fs';
import path from 'node:path';
import { writeDocAtomic } from '../shared/docio.js';
import { sanitizeLine } from '../shared/text.js';
import type { CommandContext } from './commands.js';

/**
 * /init (Session 21): the optional onboarding flow — a short, skippable Q&A that creates the
 * GLOBAL AGENT.md (the machine-wide user constitution) and, when the project has none, offers a
 * starter project AGENT.md. Rules, all load-bearing:
 *
 * - NEVER touches an existing AGENT.md, global or project. Both files are user-owned; /init
 *   creates, reports, and stops — there is no rewrite path (a proposed rewrite would need its
 *   own reviewed flow, deliberately not built in v1).
 * - Every question is skippable (blank = skip); EOF / Ctrl+C at ANY question aborts the whole
 *   flow with NOTHING written — a half-answered onboarding must not leave a half-written file.
 * - Stores preferences and instructions ONLY. The flow says so: secrets and credentials stay in
 *   the environment; authority (grants) lives in its own store with its own consent.
 * - Answers pass sanitizeLine before landing in a file that is injected into every prompt.
 */

interface InitAnswers {
  callMe: string | null;
  workingStyle: string | null;
  always: string | null;
  never: string | null;
}

/** null = the user aborted (EOF); string answers are sanitized, '' = skipped. */
async function askGlobalQuestions(ctx: CommandContext): Promise<InitAnswers | null> {
  const q = async (prompt: string): Promise<string | null> => {
    const a = await ctx.question!(prompt);
    return a === null ? null : sanitizeLine(a.trim());
  };
  const callMe = await q('  1/4 · What should the agent call you? (blank to skip)\n  > ');
  if (callMe === null) return null;
  const workingStyle = await q('  2/4 · Anything about how you like to work — style, verbosity, tools? (blank to skip)\n  > ');
  if (workingStyle === null) return null;
  const always = await q('  3/4 · Anything the agent should ALWAYS do, in every project? (blank to skip)\n  > ');
  if (always === null) return null;
  const never = await q('  4/4 · Anything the agent should NEVER do without asking you first? (blank to skip)\n  > ');
  if (never === null) return null;
  return {
    callMe: callMe.length > 0 ? callMe : null,
    workingStyle: workingStyle.length > 0 ? workingStyle : null,
    always: always.length > 0 ? always : null,
    never: never.length > 0 ? never : null,
  };
}

function globalDocText(a: InitAnswers, dateIso: string): string {
  const lines = [
    `<!-- created by /init on ${dateIso.slice(0, 10)}; hand-edit freely — this file is loaded into every session on this machine. -->`,
    '# Global instructions (all projects)',
    '',
  ];
  if (a.callMe !== null) lines.push('## About the user', '', `- Call me ${a.callMe}.`, '');
  if (a.workingStyle !== null) lines.push('## Working style', '', `- ${a.workingStyle}`, '');
  if (a.always !== null) lines.push('## Always', '', `- ${a.always}`, '');
  if (a.never !== null) lines.push('## Never (without asking first)', '', `- ${a.never}`, '');
  if (a.callMe === null && a.workingStyle === null && a.always === null && a.never === null) {
    lines.push(
      '<!-- Every question was skipped — this is a starter skeleton. Some ideas: -->',
      '<!-- ## About the user      (what to call you, your role) -->',
      '<!-- ## Working style       (verbosity, tools, conventions you care about) -->',
      '<!-- ## Always / ## Never   (standing instructions for every project) -->',
      '',
    );
  }
  lines.push('<!-- Secrets and credentials NEVER belong here: this text enters every model prompt. -->', '');
  return lines.join('\n');
}

function projectDocText(description: string | null): string {
  return [
    '# Project notes for the agent',
    '',
    ...(description !== null ? [description, ''] : []),
    '## Conventions',
    '',
    '<!-- durable instructions for every session in THIS project: build/test commands worth knowing,',
    '     code style, what to touch and what to leave alone. Hand-edit freely; the harness never',
    '     rewrites this file. -->',
    '',
  ].join('\n');
}

export async function runInit(ctx: CommandContext, nowIso: string): Promise<void> {
  const chrome = (t: string): void => ctx.renderer.chromeLine(t);
  if (ctx.question === undefined) {
    chrome('/init needs the interactive prompt (run the REPL on a terminal or with --interactive).');
    return;
  }
  const globalFile = path.join(ctx.layout.stateRoot, 'AGENT.md');
  const projectFile = path.join(ctx.session.workspaceRoot, 'AGENT.md');
  const wrote: string[] = [];

  // ── Global ────────────────────────────────────────────────────────────────────────────────
  if (fs.existsSync(globalFile)) {
    chrome(`global AGENT.md already exists — /init never rewrites it. Edit it directly:\n  ${globalFile}`);
  } else {
    chrome(
      'Creating your global AGENT.md — durable instructions for EVERY workspace on this machine.\n' +
        'Four questions, every one skippable (blank skips; Ctrl+C/Ctrl+D aborts with nothing written).\n' +
        'Preferences only — never put secrets or credentials here.',
    );
    const answers = await askGlobalQuestions(ctx);
    if (answers === null) {
      chrome('aborted — nothing was written.');
      return;
    }
    await writeDocAtomic(globalFile, globalDocText(answers, nowIso));
    wrote.push(`global AGENT.md → ${globalFile}`);
    chrome(`global AGENT.md created (${globalFile}) — hand-edit any time; it loads starting with the NEXT session.`);
  }

  // ── Project ───────────────────────────────────────────────────────────────────────────────
  if (fs.existsSync(projectFile)) {
    chrome(`project AGENT.md already exists — untouched (${projectFile}).`);
  } else {
    const yn = await ctx.question(`  Create a starter AGENT.md for THIS project (${sanitizeLine(ctx.session.workspaceRoot)})? [y/N]\n  > `);
    if (yn === null) {
      chrome(wrote.length > 0 ? 'stopped — the global AGENT.md above was already written.' : 'aborted — nothing was written.');
      return;
    }
    if (yn.trim().toLowerCase().startsWith('y')) {
      const desc = await ctx.question('  One line describing this project, for every future session (blank to skip)\n  > ');
      if (desc === null) {
        chrome(wrote.length > 0 ? 'stopped — the global AGENT.md above was already written.' : 'aborted — nothing was written.');
        return;
      }
      const clean = sanitizeLine(desc.trim());
      await writeDocAtomic(projectFile, projectDocText(clean.length > 0 ? clean : null));
      wrote.push(`project AGENT.md → ${projectFile}`);
      chrome(`project AGENT.md created (${projectFile}) — it is an ordinary workspace file; edit or delete it freely.`);
    }
  }

  if (wrote.length > 0) {
    // The current prompt was assembled before these files existed; the model must not act on
    // remembered instructions it never saw. Tell it what happened, attributably.
    ctx.pendingNotes.push(
      `the user ran /init and created: ${wrote.join('; ')}. These are user-owned instruction files loaded into future sessions' prompts (the global one applies machine-wide; the project one to this workspace). They are NOT loaded into the current session.`,
    );
  } else {
    chrome('nothing to create — both files already exist.');
  }
}
