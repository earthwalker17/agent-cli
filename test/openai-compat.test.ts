import { describe, it, expect } from 'vitest';
import { OpenAiCompatProvider, buildCompatRequest } from '../src/provider/openai-compat.js';
import { COMPAT_PROFILES } from '../src/provider/profiles.js';
import { capsFor } from '../src/provider/catalog.js';
import { ProviderError } from '../src/provider/errors.js';
import type { ChatMessage, ProviderRequest } from '../src/types.js';

const mkReq = (model: string, messages: ChatMessage[], overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model,
  system: 'sys prompt',
  messages,
  tools: [{ name: 'read_file', description: 'read', input_schema: { type: 'object', properties: {} } }],
  maxTokens: 4096,
  ...overrides,
});

const userText = (t: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text: t }] });

// ── Request goldens ────────────────────────────────────────────────────────────────────────

describe('buildCompatRequest goldens', () => {
  it('deepseek: max_tokens, include_usage, nested tools WITHOUT strict, no sampling params', () => {
    const body = buildCompatRequest(COMPAT_PROFILES.deepseek, mkReq('deepseek-v4-pro', [userText('hi')]), capsFor('deepseek', 'deepseek-v4-pro'));
    expect(body.model).toBe('deepseek-v4-pro');
    expect(body['max_tokens']).toBe(4096);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys prompt' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(body.tools?.[0]).toEqual({
      type: 'function',
      function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
    });
    for (const k of ['temperature', 'top_p', 'tool_choice', 'thinking', 'n']) expect(k in body).toBe(false);
  });

  it('kimi: max_completion_tokens and an EXPLICIT strict:false (their default is strict:true)', () => {
    const body = buildCompatRequest(COMPAT_PROFILES.kimi, mkReq('kimi-k3', [userText('hi')]), capsFor('kimi', 'kimi-k3'));
    expect(body['max_completion_tokens']).toBe(4096);
    expect('max_tokens' in body).toBe(false);
    expect((body.tools?.[0]?.function as { strict?: boolean }).strict).toBe(false);
  });

  it('glm: NO stream_options (undocumented there); max_tokens param', () => {
    const body = buildCompatRequest(COMPAT_PROFILES.glm, mkReq('glm-5.2', [userText('hi')]), capsFor('glm', 'glm-5.2'));
    expect('stream_options' in body).toBe(false);
    expect(body['max_tokens']).toBe(4096);
  });

  it('each tool_result becomes its OWN role:tool message, before any user text from the same message', () => {
    const history: ChatMessage[] = [
      userText('task'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a' } },
          { type: 'tool_use', id: 'c2', name: 'read_file', input: { path: 'b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'c1', content: 'A' },
          { type: 'tool_result', toolUseId: 'c2', content: 'B' },
          { type: 'text', text: '[[harness note: something]]' },
        ],
      },
    ];
    const body = buildCompatRequest(COMPAT_PROFILES.deepseek, mkReq('deepseek-v4-pro', history), capsFor('deepseek', 'deepseek-v4-pro'));
    const roles = body.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    expect(body.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'A' });
    expect(body.messages[4]).toMatchObject({ role: 'tool', tool_call_id: 'c2', content: 'B' });
    expect(body.messages[5]).toMatchObject({ role: 'user', content: '[[harness note: something]]' });
    const assistant = body.messages[2]!;
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
      { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
    ]);
  });

  it('reasoning replay: kimi replays ALL matching reasoning; deepseek only the current loop; glm never', () => {
    const mk = (model: string, provider: string): ChatMessage[] => [
      userText('turn 1'),
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', providerName: provider, model, payload: 'old-thought' },
          { type: 'text', text: 'earlier answer' },
        ],
      },
      userText('turn 2'),
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', providerName: provider, model, payload: 'loop-thought' },
          { type: 'tool_use', id: 'c1', name: 'read_file', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'r' }] },
    ];

    const kimi = buildCompatRequest(COMPAT_PROFILES.kimi, mkReq('kimi-k3', mk('kimi-k3', 'kimi')), capsFor('kimi', 'kimi-k3'));
    const kimiAssistants = kimi.messages.filter((m) => m.role === 'assistant');
    expect(kimiAssistants[0]?.reasoning_content).toBe('old-thought'); // replay: 'all'
    expect(kimiAssistants[1]?.reasoning_content).toBe('loop-thought');

    const ds = buildCompatRequest(
      COMPAT_PROFILES.deepseek,
      mkReq('deepseek-v4-pro', mk('deepseek-v4-pro', 'deepseek')),
      capsFor('deepseek', 'deepseek-v4-pro'),
    );
    const dsAssistants = ds.messages.filter((m) => m.role === 'assistant');
    expect('reasoning_content' in dsAssistants[0]!).toBe(false); // out of the current loop
    expect(dsAssistants[1]?.reasoning_content).toBe('loop-thought');

    const glm = buildCompatRequest(COMPAT_PROFILES.glm, mkReq('glm-5.2', mk('glm-5.2', 'glm')), capsFor('glm', 'glm-5.2'));
    for (const a of glm.messages.filter((m) => m.role === 'assistant')) {
      expect('reasoning_content' in a).toBe(false); // clear_thinking strips server-side
    }
  });

  it('REGRESSION: a thinking-only assistant turn is DROPPED, never sent as {content:null} with no tool_calls', () => {
    // This family requires content or tool_calls; a bare {content:null} would 400 every later
    // request in the session.
    const history: ChatMessage[] = [
      userText('go'),
      { role: 'assistant', content: [{ type: 'reasoning', providerName: 'deepseek', model: 'deepseek-v4-pro', payload: 'thought only' }] },
      userText('again'),
    ];
    const body = buildCompatRequest(COMPAT_PROFILES.deepseek, mkReq('deepseek-v4-pro', history), capsFor('deepseek', 'deepseek-v4-pro'));
    expect(body.messages.some((m) => m.role === 'assistant')).toBe(false);
    for (const m of body.messages) {
      if (m.role === 'assistant') expect(m.content !== null || m.tool_calls !== undefined).toBe(true);
    }
  });

  it('foreign-tagged reasoning (other provider or model) is never replayed', () => {
    const history: ChatMessage[] = [
      userText('t'),
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', providerName: 'anthropic', model: 'claude-opus-5', payload: 'not-ours' },
          { type: 'reasoning', providerName: 'kimi', model: 'kimi-k2.6', payload: 'other-model' },
          { type: 'tool_use', id: 'c1', name: 'read_file', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'r' }] },
    ];
    const body = buildCompatRequest(COMPAT_PROFILES.kimi, mkReq('kimi-k3', history), capsFor('kimi', 'kimi-k3'));
    const assistant = body.messages.find((m) => m.role === 'assistant')!;
    expect('reasoning_content' in assistant).toBe(false);
  });

  it('images: vision models get a re-homed data-URI user message; text-only models get honest pointers', () => {
    const history: ChatMessage[] = [
      userText('look'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'browser_flow', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'c1',
            content: [
              { type: 'text', text: 'flow passed' },
              { type: 'image', mediaType: 'image/png', dataBase64: 'QUJD', sha256: 'ab'.repeat(32), label: 'home' },
            ],
          },
        ],
      },
    ];
    const kimi = buildCompatRequest(COMPAT_PROFILES.kimi, mkReq('kimi-k3', history), capsFor('kimi', 'kimi-k3'));
    const toolMsg = kimi.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toContain('screenshot(s) attached in the next message');
    const imgMsg = kimi.messages[kimi.messages.length - 1]!;
    expect(imgMsg.role).toBe('user');
    expect(imgMsg.content).toEqual([
      { type: 'text', text: 'screenshots from tool call c1:' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);

    const ds = buildCompatRequest(COMPAT_PROFILES.deepseek, mkReq('deepseek-v4-pro', history), capsFor('deepseek', 'deepseek-v4-pro'));
    const dsTool = ds.messages.find((m) => m.role === 'tool')!;
    expect(dsTool.content).toContain('this model has no image input');
    expect(ds.messages[ds.messages.length - 1]!.role).toBe('tool'); // no re-homed message
  });
});

// ── Streaming ──────────────────────────────────────────────────────────────────────────────

function sseResponse(events: string[], status = 200): Response {
  const body = events.join('');
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

const chunk = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';

function makeProvider(profileKey: 'deepseek' | 'kimi' | 'glm', responses: Response[]): { provider: OpenAiCompatProvider; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const provider = new OpenAiCompatProvider({
    profile: COMPAT_PROFILES[profileKey],
    baseUrl: 'https://example.test/v1',
    apiKey: 'sk-test-not-real',
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), ...(init !== undefined ? { init } : {}) });
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return r;
    },
  });
  return { provider, calls };
}

describe('OpenAiCompatProvider streaming', () => {
  it('deepseek-shaped stream: reasoning deltas captured (not rendered), tool-call deltas accumulated by index, usage from the pre-[DONE] chunk', async () => {
    const events = [
      chunk({ choices: [{ delta: { role: 'assistant' } }] }),
      ': keep-alive\n\n',
      chunk({ choices: [{ delta: { reasoning_content: 'think ' } }] }),
      chunk({ choices: [{ delta: { reasoning_content: 'hard' } }] }),
      chunk({ choices: [{ delta: { content: 'I will ' } }] }),
      chunk({ choices: [{ delta: { content: 'read it' } }] }),
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] }),
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] }),
      chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40, completion_tokens_details: { reasoning_tokens: 12 } } }),
      DONE,
    ];
    const { provider } = makeProvider('deepseek', [sseResponse(events)]);
    const deltas: string[] = [];
    const turn = await provider.complete(mkReq('deepseek-v4-pro', [userText('go')]), (d) => deltas.push(d));
    expect(deltas.join('')).toBe('I will read it'); // reasoning NEVER reaches onText
    expect(turn.blocks).toEqual([
      { type: 'reasoning', providerName: 'deepseek', model: 'deepseek-v4-pro', payload: 'think hard', text: 'think hard' },
      { type: 'text', text: 'I will read it' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
    ]);
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.usage).toEqual({ inputTokens: 40, outputTokens: 30, cacheReadInputTokens: 60, reasoningTokens: 12 });
  });

  it('kimi-shaped stream: usage nested at choices[0].usage in the final chunk', async () => {
    const events = [
      chunk({ choices: [{ delta: { content: 'ok' } }] }),
      chunk({ choices: [{ delta: {}, finish_reason: 'stop', usage: { prompt_tokens: 50, completion_tokens: 5, cached_tokens: 30 } }] }),
      DONE,
    ];
    const { provider } = makeProvider('kimi', [sseResponse(events)]);
    const turn = await provider.complete(mkReq('kimi-k3', [userText('go')]));
    expect(turn.stopReason).toBe('end_turn');
    expect(turn.usage).toEqual({ inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 30 });
  });

  it('glm-shaped stream: usage on the final chunk without stream_options; sensitive maps to refusal', async () => {
    const events = [
      chunk({ choices: [{ delta: { content: 'no' } }] }),
      chunk({ choices: [{ delta: {}, finish_reason: 'sensitive' }], usage: { prompt_tokens: 10, completion_tokens: 1 } }),
      DONE,
    ];
    const { provider } = makeProvider('glm', [sseResponse(events)]);
    const turn = await provider.complete(mkReq('glm-5.2', [userText('go')]));
    expect(turn.stopReason).toBe('refusal');
    expect(turn.usage.inputTokens).toBe(10);
  });

  it('glm model_context_window_exceeded finish THROWS a typed context-window error', async () => {
    const events = [chunk({ choices: [{ delta: {}, finish_reason: 'model_context_window_exceeded' }] }), DONE];
    const { provider } = makeProvider('glm', [sseResponse(events)]);
    await expect(provider.complete(mkReq('glm-5.2', [userText('go')]))).rejects.toMatchObject({ kind: 'context-window' });
  });

  it('unparseable accumulated tool arguments degrade to {_unparsed} instead of throwing the turn', async () => {
    const events = [
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read_file', arguments: '{broken' } }] } }] }),
      chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      DONE,
    ];
    const { provider } = makeProvider('deepseek', [sseResponse(events)]);
    const turn = await provider.complete(mkReq('deepseek-v4-pro', [userText('go')]));
    expect(turn.blocks[0]).toMatchObject({ type: 'tool_use', input: { _unparsed: '{broken' } });
  });

  it('402 classifies as balance with the prepaid hint and is NOT retried', async () => {
    const { provider, calls } = makeProvider('deepseek', [
      new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 }),
    ]);
    await expect(provider.complete(mkReq('deepseek-v4-pro', [userText('go')]))).rejects.toMatchObject({
      kind: 'balance',
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('a 500 retries (bounded) and then succeeds', async () => {
    const ok = sseResponse([chunk({ choices: [{ delta: { content: 'fine' } }] }), chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }), DONE]);
    const { provider, calls } = makeProvider('deepseek', [
      new Response(JSON.stringify({ error: { message: 'oops' } }), { status: 500 }),
      ok,
    ]);
    const turn = await provider.complete(mkReq('deepseek-v4-pro', [userText('go')]));
    expect(turn.blocks[0]).toMatchObject({ type: 'text', text: 'fine' });
    expect(calls).toHaveLength(2);
  }, 15_000);

  it('kimi auth errors classify by type string; the request carried Bearer auth and the accept header', async () => {
    const { provider, calls } = makeProvider('kimi', [
      new Response(JSON.stringify({ error: { type: 'incorrect_api_key_error', message: 'bad' } }), { status: 401 }),
    ]);
    await expect(provider.complete(mkReq('kimi-k3', [userText('go')]))).rejects.toMatchObject({
      kind: 'auth',
      providerCode: 'incorrect_api_key_error',
    });
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test-not-real');
    expect(headers['accept']).toBe('text/event-stream');
    expect(calls[0]!.url).toBe('https://example.test/v1/chat/completions');
  });

  it('a GLM mid-stream error envelope throws typed instead of fabricating a turn', async () => {
    const events = [
      chunk({ choices: [{ delta: { content: 'part' } }] }),
      chunk({ error: { code: '1200', message: 'internal' } }),
    ];
    const { provider } = makeProvider('glm', [sseResponse(events)]);
    await expect(provider.complete(mkReq('glm-5.2', [userText('go')]))).rejects.toBeInstanceOf(ProviderError);
  });
});
