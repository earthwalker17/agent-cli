import { z } from 'zod';
import type { ContentBlock, Provider, ProviderRequest, ProviderTurn, StopReason, Usage } from '../types.js';

/**
 * A scripted turn. The convenience form covers the common cases; `say` emits assistant text and
 * `calls` emit tool_use blocks. Provide `stopReason` explicitly to script refusal/max_tokens paths.
 */
export interface ScriptTurn {
  say?: string;
  calls?: { name: string; input: unknown; id?: string }[];
  stopReason?: StopReason;
  usage?: Usage;
}

const ScriptTurnSchema = z.object({
  say: z.string().optional(),
  calls: z
    .array(z.object({ name: z.string(), input: z.unknown(), id: z.string().optional() }))
    .optional(),
  stopReason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'refusal', 'pause_turn', 'other']).optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
});
const ScriptSchema = z.array(ScriptTurnSchema);

/** Parse and validate a scripted-turns JSON document (used by `--provider mock --script <file>`). */
export function parseScript(json: string): ScriptTurn[] {
  return ScriptSchema.parse(JSON.parse(json)) as ScriptTurn[];
}

/**
 * A deterministic, offline Provider that replays scripted turns. It is the backbone of the
 * end-to-end tests and the CLI smoke test: no network, no timers, fully reproducible. Throws
 * loudly if the script is exhausted so a test can never silently pass on an unplanned turn.
 */
export class MockProvider implements Provider {
  readonly name = 'mock';
  private i = 0;
  private toolSeq = 0;

  constructor(private readonly turns: ScriptTurn[]) {}

  async complete(_req: ProviderRequest, onText?: (delta: string) => void): Promise<ProviderTurn> {
    if (this.i >= this.turns.length) {
      throw new Error(`MockProvider script exhausted after ${this.turns.length} turn(s)`);
    }
    const turn = this.turns[this.i++]!;
    const blocks: ContentBlock[] = [];
    if (turn.say !== undefined) {
      blocks.push({ type: 'text', text: turn.say });
      onText?.(turn.say);
    }
    for (const c of turn.calls ?? []) {
      blocks.push({ type: 'tool_use', id: c.id ?? `toolu_mock_${++this.toolSeq}`, name: c.name, input: c.input });
    }
    const stopReason: StopReason = turn.stopReason ?? ((turn.calls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn');
    return { blocks, stopReason, usage: turn.usage ?? { inputTokens: 0, outputTokens: 0 } };
  }
}
