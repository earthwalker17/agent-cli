import { describe, it, expect } from 'vitest';
import { OpenAiResponsesProvider, buildResponsesRequest, mapResponsesResult } from '../src/provider/openai-responses.js';
import type { ChatMessage, ProviderRequest } from '../src/types.js';

const mkReq = (messages: ChatMessage[], overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: 'gpt-5.6-sol',
  system: 'sys prompt',
  messages,
  tools: [{ name: 'read_file', description: 'read', input_schema: { type: 'object', properties: {} } }],
  maxTokens: 4096,
  ...overrides,
});

const userText = (t: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text: t }] });

describe('buildResponsesRequest goldens', () => {
  it('statelessness contract: store:false, encrypted reasoning include, instructions, flat strict:false tools', () => {
    const body = buildResponsesRequest(mkReq([userText('hi')]));
    expect(body['store']).toBe(false);
    expect(body['include']).toEqual(['reasoning.encrypted_content']);
    expect(body['instructions']).toBe('sys prompt');
    expect(body['max_output_tokens']).toBe(4096);
    expect(body['tools']).toEqual([
      { type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} }, strict: false },
    ]);
    expect(body['input']).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
    for (const k of ['temperature', 'top_p', 'reasoning', 'tool_choice']) expect(k in body).toBe(false);
  });

  it('replays the tool loop as items: reasoning VERBATIM (in-window only), function_call, function_call_output', () => {
    const reasoningItem = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] };
    const history: ChatMessage[] = [
      userText('old turn'),
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', providerName: 'openai', model: 'gpt-5.6-sol', payload: { type: 'reasoning', id: 'rs_0', encrypted_content: 'stale' } },
          { type: 'text', text: 'old answer' },
        ],
      },
      userText('current turn'),
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', providerName: 'openai', model: 'gpt-5.6-sol', payload: reasoningItem },
          { type: 'reasoning', providerName: 'openai', model: 'gpt-5.6-terra', payload: { type: 'reasoning', id: 'rs_x' } },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'file body' }] },
    ];
    const body = buildResponsesRequest(mkReq(history));
    const input = body['input'] as Record<string, unknown>[];
    expect(input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'old turn' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'old answer' }] }, // stale reasoning dropped
      { role: 'user', content: [{ type: 'input_text', text: 'current turn' }] },
      reasoningItem, // verbatim, same object shape — the store:false replay requirement
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
    ]);
  });

  it('re-homes tool_result screenshots as input_image data URIs after the function output', () => {
    const history: ChatMessage[] = [
      userText('look'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'view_image', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'c1',
            content: [
              { type: 'text', text: 'ok' },
              { type: 'image', mediaType: 'image/png', dataBase64: 'QUJD' },
            ],
          },
        ],
      },
    ];
    const input = buildResponsesRequest(mkReq(history))['input'] as Record<string, unknown>[];
    expect(input[input.length - 2]).toEqual({
      type: 'function_call_output',
      call_id: 'c1',
      output: 'ok\n[1 screenshot(s) attached in the next message]',
    });
    expect(input[input.length - 1]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'screenshots from tool call c1:' },
        { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
      ],
    });
  });
});

describe('mapResponsesResult', () => {
  it('maps reasoning/message/function_call output items and the usage breakdown', () => {
    const turn = mapResponsesResult(
      {
        status: 'completed',
        output: [
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'x', summary: [{ type: 'summary_text', text: 'thought about it' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
          { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'read_file', arguments: '{"path":"a"}' },
        ],
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 900, cache_write_tokens: 50 },
          output_tokens: 40,
          output_tokens_details: { reasoning_tokens: 25 },
        },
      },
      'gpt-5.6-sol',
    );
    expect(turn.blocks[0]).toMatchObject({ type: 'reasoning', providerName: 'openai', model: 'gpt-5.6-sol', text: 'thought about it' });
    expect(turn.blocks[1]).toEqual({ type: 'text', text: 'answer' });
    expect(turn.blocks[2]).toEqual({ type: 'tool_use', id: 'call_9', name: 'read_file', input: { path: 'a' } });
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 50,
      reasoningTokens: 25,
    });
  });

  it('incomplete maps honestly: max_output_tokens → max_tokens, content_filter → refusal', () => {
    const base = { output: [], usage: { input_tokens: 1, output_tokens: 1 } };
    expect(mapResponsesResult({ ...base, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'm').stopReason).toBe('max_tokens');
    expect(mapResponsesResult({ ...base, status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'm').stopReason).toBe('refusal');
  });
});

// ── Streaming ──────────────────────────────────────────────────────────────────────────────

const ev = (type: string, obj: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;

function makeProvider(responses: Response[]): { provider: OpenAiResponsesProvider; calls: { url: string; body?: unknown }[] } {
  const calls: { url: string; body?: unknown }[] = [];
  let i = 0;
  const provider = new OpenAiResponsesProvider({
    // Synthetic key fixture — never a live credential.
    apiKey: 'sk-test-not-real',
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), ...(init?.body !== undefined ? { body: JSON.parse(init.body as string) } : {}) });
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return r;
    },
  });
  return { provider, calls };
}

describe('OpenAiResponsesProvider streaming', () => {
  it('streams text deltas to onText; the terminal response.completed payload is authoritative', async () => {
    const stream = [
      ev('response.created', { response: { id: 'r1' } }),
      ev('response.output_item.added', { output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '' } }),
      ev('response.function_call_arguments.delta', { output_index: 0, delta: '{"path":' }),
      ev('response.output_text.delta', { delta: 'work' }),
      ev('response.output_text.delta', { delta: 'ing' }),
      ev('response.completed', {
        response: {
          status: 'completed',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working' }] },
            { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ];
    const { provider, calls } = makeProvider([new Response(stream.join(''), { status: 200 })]);
    const deltas: string[] = [];
    const turn = await provider.complete(mkReq([userText('go')]), (d) => deltas.push(d));
    expect(deltas.join('')).toBe('working');
    expect(turn.blocks).toEqual([
      { type: 'text', text: 'working' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a' } },
    ]);
    expect(turn.stopReason).toBe('tool_use');
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
  });

  it('response.failed throws typed instead of fabricating a turn', async () => {
    const stream = [ev('response.failed', { response: { status: 'failed', error: { code: 'server_error', message: 'boom' } } })];
    const { provider } = makeProvider([new Response(stream.join(''), { status: 200 })]);
    await expect(provider.complete(mkReq([userText('go')]))).rejects.toMatchObject({ kind: 'server', providerCode: 'server_error' });
  });

  it('a stream with no terminal event is a typed server error, never a silent empty turn', async () => {
    const stream = [ev('response.output_text.delta', { delta: 'partial' })];
    const { provider } = makeProvider([new Response(stream.join(''), { status: 200 })]);
    await expect(provider.complete(mkReq([userText('go')]))).rejects.toMatchObject({ kind: 'server' });
  });

  it('429 insufficient_quota classifies as balance (not retried); 400 context_length_exceeded as context-window', async () => {
    const quota = makeProvider([
      new Response(JSON.stringify({ error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'no credit' } }), { status: 429 }),
    ]);
    await expect(quota.provider.complete(mkReq([userText('go')]))).rejects.toMatchObject({ kind: 'balance' });
    expect(quota.calls).toHaveLength(1);

    const ctx = makeProvider([
      new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'too long' } }), { status: 400 }),
    ]);
    await expect(ctx.provider.complete(mkReq([userText('go')]))).rejects.toMatchObject({ kind: 'context-window' });
  });
});
