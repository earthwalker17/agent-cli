import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { toApiMessage, toProviderTurn, AnthropicProvider } from '../src/provider/anthropic.js';
import type { ChatMessage } from '../src/types.js';

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
      usage: { input_tokens: 12, output_tokens: 34 },
    } as unknown as Anthropic.Message;
    expect(toProviderTurn(msg)).toEqual({
      blocks: [
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'x', name: 'search', input: { pattern: 'q' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 34 },
    });
  });

  it('maps refusal and unknown stop reasons', () => {
    const mk = (r: string): Anthropic.Message =>
      ({ content: [], stop_reason: r, usage: { input_tokens: 0, output_tokens: 0 } }) as unknown as Anthropic.Message;
    expect(toProviderTurn(mk('refusal')).stopReason).toBe('refusal');
    expect(toProviderTurn(mk('something_new')).stopReason).toBe('other');
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
