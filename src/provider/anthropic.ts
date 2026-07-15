import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import type { ChatMessage, ContentBlock, Provider, ProviderRequest, ProviderTurn, StopReason } from '../types.js';
import { createTransport, type Transport } from '../net/transport.js';

/**
 * The Anthropic provider. Streams so large `max_tokens` never hits an HTTP timeout, surfaces text
 * deltas for live rendering, and maps the SDK response to the harness's plain ProviderTurn.
 *
 * Networking (proxy detection, direct vs proxied) is delegated to the shared transport factory —
 * this class contains no proxy logic, so future providers can reuse the same infrastructure.
 *
 * V0.1 deliberately does NOT enable extended/adaptive thinking: on Opus 4.8, omitting the
 * `thinking` param runs without thinking, which avoids the thinking-block round-trip that a
 * tool-use loop would otherwise have to preserve. Adaptive thinking (with block preservation) is
 * a documented V0.2 enhancement.
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  /** Credential-redacted description of the network path (e.g. "proxy … (via https_proxy)"). */
  readonly transport: string;
  private readonly client: Anthropic;

  constructor(opts: { apiKey?: string; transport?: Transport } = {}) {
    const transport = opts.transport ?? createTransport();
    const clientOpts: ClientOptions = {};
    if (opts.apiKey) clientOpts.apiKey = opts.apiKey;
    if (transport.fetch) clientOpts.fetch = transport.fetch as ClientOptions['fetch'];
    this.client = new Anthropic(clientOpts);
    this.transport = transport.describe();
  }

  async complete(req: ProviderRequest, onText?: (delta: string) => void, signal?: AbortSignal): Promise<ProviderTurn> {
    const stream = this.client.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: coalesceUserMessages(req.messages).map(toApiMessage),
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema })),
      },
      signal ? { signal } : undefined,
    );
    if (onText) stream.on('text', (delta) => onText(delta));
    const msg = await stream.finalMessage();
    return toProviderTurn(msg);
  }
}

/**
 * Merge consecutive same-role messages into one (concatenating their content blocks). An aborted
 * turn — and a crash-resume before the first assistant reply — legitimately leaves consecutive
 * user messages in the history; the Messages API requires alternating roles, so this is the wire
 * normalization. Pure; the harness's own history is left untouched.
 */
export function coalesceUserMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      out[out.length - 1] = { role: prev.role, content: [...prev.content, ...m.content] };
    } else {
      out.push(m);
    }
  }
  return out;
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
