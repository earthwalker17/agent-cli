import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coerceStringifiedInput } from '../src/runtime/input-coerce.js';
import { startSession, runTurn, endSession } from '../src/runtime/session.js';
import { MockProvider } from '../src/provider/mock.js';
import { resolveLayout } from '../src/store/layout.js';
import type { Tool, ToolResult } from '../src/types.js';

/**
 * One-level tolerant decode for DOUBLE-ENCODED tool arguments (S16.5b, found live).
 *
 * kimi-k3 serialized update_plan's nested `plan` object as a string and then, fed the zod
 * "expected object, received string" error, cycled YAML / single-quoted JSON / XML-ish tags /
 * entry-pair arrays for TWELVE MINUTES without ever un-stringifying the value — no plan could
 * ever be written, so the entire planned workflow was unreachable on this provider. The decode
 * accepts exactly one unambiguous case (a string that JSON.parses to the expected structure),
 * re-validates once, and otherwise reports the ORIGINAL error plus a plain-language hint.
 */

const schema = z.object({ plan: z.object({ version: z.number(), tasks: z.array(z.object({ id: z.string() })) }), reason: z.string().optional() }).strict();

function coerce(input: unknown): { data?: unknown; hint?: string } {
  const r = schema.safeParse(input);
  if (r.success) throw new Error('test setup error: input unexpectedly valid');
  return coerceStringifiedInput(input, r.error);
}

describe('coerceStringifiedInput', () => {
  it('decodes a JSON-stringified nested object and the result validates', () => {
    const original = { plan: '{"version":1,"tasks":[{"id":"a"}]}' };
    const c = coerce(original);
    expect(c.data).toEqual({ plan: { version: 1, tasks: [{ id: 'a' }] } });
    expect(schema.safeParse(c.data).success).toBe(true);
    // The model's original bytes are untouched — the wire history stays byte-faithful.
    expect(original.plan).toBe('{"version":1,"tasks":[{"id":"a"}]}');
  });

  it('decodes a stringified ARRAY at a nested path', () => {
    const s = z.object({ plan: z.object({ version: z.number(), tasks: z.array(z.object({ id: z.string() })) }) });
    const input = { plan: { version: 1, tasks: '[{"id":"a"},{"id":"b"}]' } };
    const r = s.safeParse(input);
    expect(r.success).toBe(false);
    const c = coerceStringifiedInput(input, (r as { error: z.ZodError }).error);
    expect(s.safeParse(c.data).success).toBe(true);
  });

  it('YAML / quasi-JSON / XML-ish strings are NOT decoded — the hint tells the model plainly', () => {
    for (const bad of ['version: 1\ntasks:\n  - id: a', "{'version':1}", '<objective>x</objective>', '"version":1']) {
      const c = coerce({ plan: bad });
      expect(c.data).toBeUndefined();
      expect(c.hint).toContain("'plan'");
      expect(c.hint).toContain('not its serialized text');
    }
  });

  it('the WHOLE input double-encoded as one string is decoded too', () => {
    const c = coerceStringifiedInput('{"plan":{"version":1,"tasks":[]}}', schema.safeParse('x').success ? (undefined as never) : (schema.safeParse('x') as { error: z.ZodError }).error);
    expect(c.data).toEqual({ plan: { version: 1, tasks: [] } });
  });

  it('a genuinely wrong input (no strings involved) is left alone — no data, no hint', () => {
    const c = coerce({ plan: 42 });
    expect(c.data).toBeUndefined();
    expect(c.hint).toBeUndefined();
  });
});

describe('the runtime loop accepts a double-encoded argument end to end', () => {
  it('a tool whose object argument arrived stringified executes; the log keeps the original', async () => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-coerce-')));
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(ws);
    const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
    const seen: unknown[] = [];
    const cfgTool: Tool<{ cfg: { n: number } }> = {
      name: 'cfg_tool',
      description: 'test tool with a nested object argument',
      schema: z.object({ cfg: z.object({ n: z.number() }) }).strict() as never,
      mutates: () => ({ paths: [] }),
      execute: (input): Promise<ToolResult> => {
        seen.push(input);
        return Promise.resolve({ ok: true, output: `n=${String(input.cfg.n)}`, durationMs: 0, truncated: false });
      },
    };
    const session = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'interactive',
      provider: new MockProvider([
        { calls: [{ name: 'cfg_tool', input: { cfg: '{"n":7}' } as never }] },
        { say: 'done' },
      ]),
      approver: async () => ({ decision: 'deny', scope: 'once', source: 'user' }),
      tools: [cfgTool],
      saltHex: 'ab'.repeat(16),
    });
    const result = await runTurn(session, 'go');
    endSession(session, 'completed');
    expect(result.finalText).toBe('done');
    expect(seen).toEqual([{ cfg: { n: 7 } }]); // the tool saw the DECODED structure
    const events = session.log.events;
    const requested = events.find((e) => e.type === 'tool.requested') as { input: unknown };
    expect(requested.input).toEqual({ cfg: '{"n":7}' }); // the evidence keeps the model's bytes
    const completed = events.find((e) => e.type === 'tool.completed') as { ok: boolean; outputPreview: string };
    expect(completed.ok).toBe(true);
    expect(completed.outputPreview).toBe('n=7');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
