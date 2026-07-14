import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ContentBlock, Provider, ProviderRequest, ProviderTurn, StopReason } from '../types.js';

/**
 * The Anthropic provider. Streams so large `max_tokens` never hits an HTTP timeout, surfaces text
 * deltas for live rendering, and maps the SDK response to the harness's plain ProviderTurn.
 *
 * V0.1 deliberately does NOT enable extended/adaptive thinking: on Opus 4.8, omitting the
 * `thinking` param runs without thinking, which avoids the thinking-block round-trip that a
 * tool-use loop would otherwise have to preserve. Adaptive thinking (with block preservation) is
 * a documented V0.2 enhancement.
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(opts: { apiKey?: string } = {}) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async complete(req: ProviderRequest, onText?: (delta: string) => void): Promise<ProviderTurn> {
    const stream = this.client.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages.map(toApiMessage),
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema })),
    });
    if (onText) stream.on('text', (delta) => onText(delta));
    const msg = await stream.finalMessage();
    return toProviderTurn(msg);
  }
}

export function toApiMessage(m: ChatMessage): Anthropic.MessageParam {
  const content = m.content.map((b): Anthropic.ContentBlockParam => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'tool_use':
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      case 'tool_result':
        return b.isError
          ? { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: true }
          : { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content };
    }
  });
  return { role: m.role, content };
}

export function toProviderTurn(msg: Anthropic.Message): ProviderTurn {
  const blocks: ContentBlock[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    // thinking / other block types are not produced (thinking is off) and are ignored if present.
  }
  return {
    blocks,
    stopReason: mapStopReason(msg.stop_reason),
    usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
  };
}

function mapStopReason(reason: Anthropic.Message['stop_reason']): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause_turn';
    default:
      return 'other';
  }
}
