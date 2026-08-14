/**
 * The slash-command table (Session 22): ONE machine-readable description of the surface
 * `dispatchSlash` implements. It exists for the Tab completer and the `/` select menu, and a
 * drift test pins it against the dispatch switch in both directions — a command added to one
 * without the other fails the suite, never silently.
 *
 * Deliberately DATA, not behavior: dispatch stays in commands.ts, HELP stays hand-authored
 * prose (deriving it from this table was considered and rejected — curated ordering and the
 * S21.5 framing sentences carry more than a name/summary pair can). `midTurn` marks the two
 * commands the mid-turn handler owns; the menu shows them anyway, because typing them at idle
 * prints an honest pointer at their mid-turn form.
 */

export interface CommandSpec {
  /** Without the leading slash. */
  name: string;
  aliases?: readonly string[];
  /** Argument hint, shown dimmed in the menu ('' = takes none). */
  args?: string;
  /** One line, in the HELP voice. */
  summary: string;
  /** Owned by the mid-turn handler (TTY, while a turn runs). */
  midTurn?: boolean;
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'help', summary: 'the command and sigil reference' },
  { name: 'status', summary: 'session, model, cost, and only the axes that have state' },
  { name: 'diff', summary: 'what this session changed (unified diff vs the pre-images)' },
  { name: 'undo', args: '[all]', summary: 'revert the last (or every) file-tool change of this session' },
  { name: 'report', args: '[section]', summary: 'the evidence record; a section narrows it' },
  { name: 'expand', args: '[last | <n>]', summary: 'reprint a folded command/check output in full, from the record (Ctrl+E)' },
  { name: 'commit', args: '[-m "msg"] [--all]', summary: 'commit session-attributed changes after a preview + confirmation' },
  { name: 'checkpoint', args: '[label | list | restore <n>]', summary: 'capture the workspace to a hidden git ref, or return to one' },
  { name: 'plan', args: '[show | approve | discard]', summary: 'the plan document and its approval gate' },
  { name: 'accept', args: '[confirm]', summary: 'the completion boundary; confirm records a PARTIAL acceptance' },
  { name: 'review', summary: 'the adversarial-review gate: rounds, findings, blockers' },
  { name: 'repair', args: '[dismiss <n> <reason>]', summary: 'the repair ledger; dismissing an escalation is YOUR decision' },
  { name: 'checks', summary: 'the detected project and the latest verification evidence per kind' },
  { name: 'preview', args: '[stop <id>]', summary: 'managed preview servers: status, logs, stop' },
  { name: 'research', summary: 'the web-research audit: spend, queries, sources, findings' },
  { name: 'remote', summary: 'the remote-delivery audit: identity, allowance, reads, mutations' },
  { name: 'tasks', summary: 'delegated tasks — live table MID-TURN, evidence view at idle', midTurn: true },
  { name: 'cancel', args: '<ref>', summary: 'stop ONE delegated task while the turn continues (mid-turn, TTY)', midTurn: true },
  { name: 'map', summary: 'the ranked workspace map the model sees' },
  { name: 'provider', args: '[name [model]]', summary: 'list or switch providers, between turns (credentials are env-only)' },
  { name: 'model', args: '[id]', summary: 'list or switch models for the current provider' },
  { name: 'grants', args: '[revoke <id>]', summary: 'durable "always allow" records; a revoke applies next session' },
  { name: 'init', summary: 'create your global AGENT.md (and a starter project one)' },
  { name: 'quit', aliases: ['exit'], summary: 'end the session' },
];

/** `/name` completion candidates for a line like `/pl` — the readline completer's data half. */
export function completeSlash(line: string): [string[], string] {
  const m = /^\/(\S*)$/.exec(line);
  if (m === null) return [[], line];
  const prefix = m[1]!.toLowerCase();
  const names = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  const hits = names.filter((n) => n.startsWith(prefix)).map((n) => `/${n} `);
  return [hits, line];
}
