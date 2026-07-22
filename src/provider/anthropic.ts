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
 * Extended/adaptive thinking stays deliberately OFF (still true at V0.7): omitting the
 * `thinking` param avoids the thinking-block round-trip that a tool-use loop would otherwise
 * have to preserve. Enabling it (with block preservation) remains in the deferred pool.
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
    const stream = this.client.messages.stream(buildApiParams(req), signal ? { signal } : undefined);
    if (onText) stream.on('text', (delta) => onText(delta));
    const msg = await stream.finalMessage();
    return toProviderTurn(msg);
  }
}

/**
 * Build the wire request — pure and unit-testable. Prompt caching (V0.5): two ephemeral
 * cache_control breakpoints (of the API's four): one on the system block (tools + system form
 * the stable prefix) and a MOVING one on the last content block of the final message, so each
 * step re-reads the whole prior conversation from cache and pays uncached price only for the
 * newest message. The marker must be attached AFTER coalescing — coalescing merges consecutive
 * same-role messages, and a pre-attached marker could end up mid-message, silently caching a
 * shorter prefix.
 */
export function buildApiParams(req: ProviderRequest): Anthropic.MessageCreateParamsStreaming {
  const messages = coalesceUserMessages(req.messages).map(toApiMessage);
  const last = messages[messages.length - 1];
  const lastBlock = last?.content[last.content.length - 1];
  if (lastBlock && typeof lastBlock === 'object') {
    (lastBlock as { cache_control?: Anthropic.CacheControlEphemeral }).cache_control = { type: 'ephemeral' };
  }
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    stream: true,
    ...(req.system.length > 0
      ? { system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }] }
      : {}),
    messages,
    tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema })),
  };
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

export function toApiMessage(m: ChatMessage): { role: 'user' | 'assistant'; content: Anthropic.ContentBlockParam[] } {
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
    usage: {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      // The SDK reports null when caching did not apply; record explicit zeros (additive fields).
      cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
    },
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
