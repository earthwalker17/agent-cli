import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { buildApiParams, toApiMessage, toProviderTurn, AnthropicProvider } from '../src/provider/anthropic.js';
import type { ChatMessage, ProviderRequest } from '../src/types.js';

describe('AnthropicProvider mapping', () => {
  it('maps harness messages to API content blocks', () => {
    const m: ChatMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
      ],
    };
    expect(toApiMessage(m)).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
      ],
    });
  });

  it('maps tool_result blocks including the error flag', () => {
    const m: ChatMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 't1', content: 'ok' },
        { type: 'tool_result', toolUseId: 't2', content: 'boom', isError: true },
      ],
    };
    expect(toApiMessage(m).content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true },
    ]);
  });

  it('maps an API response to a ProviderTurn (dropping non-text/tool blocks)', () => {
    const msg = {
      content: [
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'x', name: 'search', input: { pattern: 'q' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
    } as unknown as Anthropic.Message;
    expect(toProviderTurn(msg)).toEqual({
      blocks: [
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'x', name: 'search', input: { pattern: 'q' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 34, cacheReadInputTokens: 500, cacheCreationInputTokens: 100 },
    });
  });

  it('maps absent/null cache usage to explicit zeros', () => {
    const msg = {
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null },
    } as unknown as Anthropic.Message;
    expect(toProviderTurn(msg).usage).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  });

  it('maps refusal and unknown stop reasons', () => {
    const mk = (r: string): Anthropic.Message =>
      ({ content: [], stop_reason: r, usage: { input_tokens: 0, output_tokens: 0 } }) as unknown as Anthropic.Message;
    expect(toProviderTurn(mk('refusal')).stopReason).toBe('refusal');
    expect(toProviderTurn(mk('something_new')).stopReason).toBe('other');
  });
});

describe('buildApiParams prompt caching', () => {
  const req = (messages: ChatMessage[], system = 'sys'): ProviderRequest => ({
    model: 'm', system, messages, tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }], maxTokens: 10,
  });

  it('marks the system block and ONLY the final content block of the final message', () => {
    const p = buildApiParams(
      req([
        { role: 'user', content: [{ type: 'text', text: 'q1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'x', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: 'r' }] },
      ]),
    );
    expect(p.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    const blocks = p.messages.flatMap((m) => m.content as Anthropic.ContentBlockParam[]);
    const marked = blocks.filter((b) => (b as { cache_control?: unknown }).cache_control !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'x' });
  });

  it('attaches the moving marker AFTER coalescing, so it lands on the true final wire block', () => {
    // Consecutive user messages (abort/resume shape) coalesce into ONE wire message; the marker
    // must be on that merged message's last block, not on the pre-merge fragment.
    const p = buildApiParams(
      req([
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
      ]),
    );
    expect(p.messages).toHaveLength(1);
    const content = p.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect((content[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((content[1] as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits an empty system rather than sending an uncacheable empty block', () => {
    const p = buildApiParams(req([{ role: 'user', content: [{ type: 'text', text: 'q' }] }], ''));
    expect(p.system).toBeUndefined();
  });
});

// Opt-in live smoke: one real API call. Excluded from CI; run with AGENT_LIVE_TEST=1.
const live = process.env['AGENT_LIVE_TEST'] ? it : it.skip;
describe('AnthropicProvider live', () => {
  live('completes a trivial request against the real API', async () => {
    const provider = new AnthropicProvider();
    const turn = await provider.complete({
      model: 'claude-opus-4-8',
      system: 'Reply with exactly the word: pong',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [],
      maxTokens: 64,
    });
    expect(turn.blocks.some((b) => b.type === 'text')).toBe(true);
    expect(turn.usage.outputTokens).toBeGreaterThan(0);
  }, 60000);
});
