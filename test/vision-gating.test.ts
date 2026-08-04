import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { startSession, endSession, runTurn } from '../src/runtime/session.js';
import { createViewImageTool } from '../src/tools/view-image.js';
import { TOOLS } from '../src/tools/index.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { ContentBlock, Provider, ProviderTurn, Tool, ToolResult } from '../src/types.js';

/**
 * Session 15 vision gating: a model without image input NEVER receives pixels — the wire view
 * degrades to honest pointers at the runtime choke, view_image refuses the LOOK step, and the
 * evidence (blobs + image metadata on tool.completed) is unchanged. Nothing else degrades.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-vision-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A minimal scripted provider whose NAME is a real provider id (the choke keys on it). */
function inlineProvider(name: string, turns: ProviderTurn[]): Provider {
  let i = 0;
  return {
    name,
    complete: async () => {
      if (i >= turns.length) throw new Error('inline script exhausted');
      return turns[i++]!;
    },
  };
}

/** A harmless observe-class tool that attaches one screenshot to its result. */
function snapTool(): Tool<Record<string, never>> {
  return {
    name: 'snap',
    description: 'test tool attaching an image',
    schema: z.object({}).strict(),
    mutates: () => ({ paths: [] }),
    execute: (): Promise<ToolResult> =>
      Promise.resolve({
        ok: true,
        output: 'captured',
        durationMs: 1,
        truncated: false,
        images: [{ mediaType: 'image/png', dataBase64: 'QUJD', sha256: 'ab'.repeat(32), label: 'home' }],
      }),
  };
}

const toolUse = (id: string, name: string): ContentBlock => ({ type: 'tool_use', id, name, input: {} });

describe('the runtime vision choke', () => {
  it('a text-only model gets pointers instead of pixels; evidence still records the image metadata', async () => {
    const session = startSession({
      workspaceRoot: ws,
      layout,
      model: 'deepseek-v4-pro', // catalog: visionInput false
      mode: 'non-interactive',
      provider: inlineProvider('deepseek', [
        { blocks: [toolUse('c1', 'snap')], stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } },
        { blocks: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
      ]),
      approver: autoDenyApprover,
      saltHex: '0'.repeat(32),
      maxSteps: 5,
      clock: fixedClock(0, 1),
      idGen: seededIdGen(),
      tools: [...TOOLS, snapTool()],
    });
    await runTurn(session, 'snap it');
    // Wire view: the tool_result is a plain STRING with the honest pointer — no image parts.
    const resultMsg = session.messages.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'));
    const block = resultMsg!.content.find((b) => b.type === 'tool_result')!;
    if (block.type !== 'tool_result') throw new Error('unreachable');
    expect(typeof block.content).toBe('string');
    expect(block.content).toContain("model 'deepseek-v4-pro' has no image input");
    expect(block.content).toContain(`objects/${'ab'.repeat(32)}`);
    // Evidence unchanged: tool.completed still records the image metadata.
    const completed = session.log.events.find((e) => e.type === 'tool.completed' && e.callId === 'c1');
    if (completed?.type !== 'tool.completed') throw new Error('unreachable');
    expect(completed.images?.[0]).toMatchObject({ sha256: 'ab'.repeat(32), mediaType: 'image/png' });
    endSession(session, 'completed');
  });

  it('a vision-capable model (mock caps) still receives real image parts', async () => {
    const session = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'non-interactive',
      provider: inlineProvider('mock', [
        { blocks: [toolUse('c1', 'snap')], stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } },
        { blocks: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
      ]),
      approver: autoDenyApprover,
      saltHex: '0'.repeat(32),
      maxSteps: 5,
      clock: fixedClock(0, 1),
      idGen: seededIdGen(),
      tools: [...TOOLS, snapTool()],
    });
    await runTurn(session, 'snap it');
    const resultMsg = session.messages.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'));
    const block = resultMsg!.content.find((b) => b.type === 'tool_result')!;
    if (block.type !== 'tool_result') throw new Error('unreachable');
    expect(Array.isArray(block.content)).toBe(true);
    expect((block.content as { type: string }[]).some((p) => p.type === 'image')).toBe(true);
    endSession(session, 'completed');
  });
});

describe('view_image refusal on text-only models', () => {
  it('refuses the LOOK with the pointer intact; a vision model proceeds', async () => {
    const gated = createViewImageTool({
      getBlob: () => Buffer.from('png-bytes'),
      events: () => [],
      modelInfo: () => ({ model: 'glm-5.2', visionInput: false }),
    });
    const refused = await gated.execute({ sha256: 'cd'.repeat(32) }, {} as never);
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('unsupported: model has no image input');
    expect(refused.output).toContain(`objects/${'cd'.repeat(32)}`);
    expect(refused.output).toContain('deterministic browser assertions are unaffected');

    const open = createViewImageTool({
      getBlob: () => Buffer.from('png-bytes'),
      events: () => [],
      modelInfo: () => ({ model: 'glm-5v-turbo', visionInput: true }),
    });
    const notAdmitted = await open.execute({ sha256: 'cd'.repeat(32) }, {} as never);
    // Falls through to the normal admission check (not the vision gate).
    expect(notAdmitted.error).toBe('not a session image artifact');
  });
});
