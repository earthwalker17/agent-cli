import { describe, it, expect } from 'vitest';
import { createProviderRegistry } from '../src/provider/registry.js';
import { PROVIDERS, PROVIDER_NAMES } from '../src/provider/catalog.js';
import type { ChatMessage, ProviderRequest } from '../src/types.js';

/**
 * Opt-in per-provider live smokes (Session 15). Each provider's block runs ONLY when BOTH
 * AGENT_LIVE_TEST=1 AND that provider's key env var are set — otherwise it skips cleanly, so CI
 * stays hermetic and a missing key never fails the suite. Every test spends real money.
 *
 * Two proofs per provider, through the REAL adapter (streaming, retry, usage mapping):
 *  1. a trivial completion (key + endpoint + SSE parse + usage);
 *  2. ONE tool round-trip whose second request replays the first turn's blocks — including any
 *     reasoning — which is exactly the echo kimi/deepseek REQUIRE and Anthropic validates
 *     byte-verbatim. A wrong replay shape fails here, not in a user session.
 *
 * Windows (PowerShell): $env:AGENT_LIVE_TEST='1'; npx vitest run test/live-providers.test.ts
 */

const TRIVIAL_TIMEOUT = 120_000;
const LOOP_TIMEOUT = 300_000;

for (const name of PROVIDER_NAMES) {
  const info = PROVIDERS[name];
  const keyPresent = info.keyEnvs.some((k) => (process.env[k] ?? '').trim() !== '');
  const live = process.env['AGENT_LIVE_TEST'] && keyPresent ? it : it.skip;

  describe(`${name} live (${info.keyEnvs[0]})`, () => {
    live(
      `completes a trivial request on ${info.defaultModel}`,
      async () => {
        const provider = createProviderRegistry().create(name);
        const deltas: string[] = [];
        const turn = await provider.complete(
          {
            model: info.defaultModel,
            system: 'Reply with exactly the word: pong',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
            tools: [],
            // Thinking models (kimi-k3, deepseek default-on, opus-5 adaptive) spend output
            // tokens on reasoning before the word arrives — give real headroom.
            maxTokens: 16_000,
          },
          (d) => deltas.push(d),
        );
        expect(turn.blocks.some((b) => b.type === 'text')).toBe(true);
        expect(turn.usage.outputTokens).toBeGreaterThan(0);
        // Streaming really streamed (the mock path can't fake this here).
        expect(deltas.join('').length).toBeGreaterThan(0);
      },
      TRIVIAL_TIMEOUT,
    );

    live(
      `runs one tool round-trip on ${info.defaultModel} (reasoning replay accepted)`,
      async () => {
        const provider = createProviderRegistry().create(name);
        const req: ProviderRequest = {
          model: info.defaultModel,
          system:
            'You MUST call the get_answer tool exactly once, then reply with EXACTLY the string it returned and nothing else.',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'fetch the answer via the tool' }] }],
          tools: [
            {
              name: 'get_answer',
              description: 'Returns the secret answer string. Always call this when asked for the answer.',
              input_schema: { type: 'object', properties: {}, additionalProperties: false },
            },
          ],
          maxTokens: 16_000,
        };
        const first = await provider.complete(req);
        const call = first.blocks.find((b) => b.type === 'tool_use');
        expect(call, `expected a tool_use block, got: ${JSON.stringify(first.blocks.map((b) => b.type))}`).toBeDefined();
        if (call?.type !== 'tool_use') throw new Error('unreachable');

        const history: ChatMessage[] = [
          ...req.messages,
          { role: 'assistant', content: first.blocks }, // reasoning blocks ride back VERBATIM
          { role: 'user', content: [{ type: 'tool_result', toolUseId: call.id, content: 'XYZZY-4242' }] },
        ];
        const second = await provider.complete({ ...req, messages: history });
        const text = second.blocks
          .filter((b): b is Extract<(typeof second.blocks)[number], { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('');
        expect(text).toContain('XYZZY-4242');
      },
      LOOP_TIMEOUT,
    );
  });
}
