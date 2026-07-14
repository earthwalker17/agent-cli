import { describe, it, expect } from 'vitest';
import { MockProvider, parseScript } from '../src/provider/mock.js';
import type { ProviderRequest } from '../src/types.js';

const req: ProviderRequest = { model: 'm', system: '', messages: [], tools: [], maxTokens: 100 };

describe('MockProvider', () => {
  it('emits text and stops end_turn', async () => {
    const p = new MockProvider([{ say: 'done' }]);
    const turn = await p.complete(req);
    expect(turn.stopReason).toBe('end_turn');
    expect(turn.blocks).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('emits tool_use blocks and stops tool_use, auto-assigning ids', async () => {
    const p = new MockProvider([{ say: 'reading', calls: [{ name: 'read_file', input: { path: 'a' } }] }]);
    const turn = await p.complete(req);
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.blocks[0]).toEqual({ type: 'text', text: 'reading' });
    expect(turn.blocks[1]).toMatchObject({ type: 'tool_use', name: 'read_file', input: { path: 'a' } });
    expect((turn.blocks[1] as { id: string }).id).toMatch(/^toolu_mock_/);
  });

  it('streams text to onText', async () => {
    const p = new MockProvider([{ say: 'hello' }]);
    const seen: string[] = [];
    await p.complete(req, (d) => seen.push(d));
    expect(seen).toEqual(['hello']);
  });

  it('can script a refusal stop reason', async () => {
    const p = new MockProvider([{ stopReason: 'refusal' }]);
    expect((await p.complete(req)).stopReason).toBe('refusal');
  });

  it('throws loudly when the script is exhausted', async () => {
    const p = new MockProvider([{ say: 'x' }]);
    await p.complete(req);
    await expect(p.complete(req)).rejects.toThrow(/exhausted/);
  });
});

describe('parseScript', () => {
  it('parses a valid script document', () => {
    const s = parseScript(JSON.stringify([{ say: 'hi' }, { calls: [{ name: 'search', input: { pattern: 'x' } }] }]));
    expect(s.length).toBe(2);
  });
  it('rejects a malformed script', () => {
    expect(() => parseScript(JSON.stringify([{ calls: 'nope' }]))).toThrow();
  });
});
