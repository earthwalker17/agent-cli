import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { elideHistory, IMAGE_KEEP_LAST_STEPS } from '../src/runtime/elision.js';
import { buildApiParams, toApiMessage } from '../src/provider/anthropic.js';
import { startSession, endSession, runTurn, reconstruct } from '../src/runtime/session.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { TOOLS } from '../src/tools/index.js';
import { EventLog } from '../src/store/event-log.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import { sha256 } from '../src/shared/hash.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import type { ChatMessage, Tool, ToolResultPart } from '../src/types.js';

/**
 * Wire-image support (Session 13): the model can SEE screenshots live; the persisted log never
 * carries base64; images age out of the wire view into text markers; resume degrades to
 * pointers by construction.
 */

const PNG_BASE64 = Buffer.from('fake-png-bytes-'.repeat(64)).toString('base64');
const PNG_SHA = 'a'.repeat(64);

function imageResult(id: string): { type: 'tool_result'; toolUseId: string; content: ToolResultPart[] } {
  return {
    type: 'tool_result',
    toolUseId: id,
    content: [
      { type: 'text', text: `screenshot captured: objects/${PNG_SHA}` },
      { type: 'image', mediaType: 'image/png', dataBase64: PNG_BASE64, sha256: PNG_SHA, label: 'after-submit' },
    ],
  };
}

/** N assistant steps, each a tool_use answered by an image-bearing result. */
function imageHistory(steps: number): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
  for (let i = 0; i < steps; i++) {
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `call-${i}`, name: 'view_image', input: {} }] });
    msgs.push({ role: 'user', content: [imageResult(`call-${i}`)] });
  }
  return msgs;
}

describe('elision — the image pass', () => {
  it('replaces image parts outside the window with markers EVEN BELOW the char trigger', () => {
    const msgs = imageHistory(4); // raw size far below the 400k default trigger
    const r = elideHistory(msgs);
    expect(r.elidedCallIds).toEqual([]); // the char walk never armed
    expect(r.imageElidedCallIds).toEqual(['call-0', 'call-1']); // outside the last-2 window
    const parts = (r.messages[2]!.content[0] as { content: ToolResultPart[] }).content;
    expect(parts.some((p) => p.type === 'image')).toBe(false);
    const markerText = (parts.find((p) => p.type === 'text' && p.text.includes('viewed live')) as { text: string }).text;
    expect(markerText).toContain(`objects/${PNG_SHA}`);
    expect(markerText).toContain('after-submit');
    // The TEXT part of the result stays verbatim — image elision is partial, not full elision.
    expect(parts.some((p) => p.type === 'text' && p.text === `screenshot captured: objects/${PNG_SHA}`)).toBe(true);
    // Recent images stay pixels.
    const recent = (r.messages[r.messages.length - 1]!.content[0] as { content: ToolResultPart[] }).content;
    expect(recent.some((p) => p.type === 'image')).toBe(true);
  });

  it('is monotone: recomputation after appending steps never un-elides an image', () => {
    const full = imageHistory(6);
    let prev = new Set<string>();
    for (let cut = 1; cut <= full.length; cut++) {
      const r = elideHistory(full.slice(0, cut));
      const cur = new Set(r.imageElidedCallIds);
      for (const id of prev) expect(cur.has(id), `image ${id} stayed elided at cut ${cut}`).toBe(true);
      prev = cur;
    }
    expect(prev.size).toBe(6 - IMAGE_KEEP_LAST_STEPS);
  });

  it('the char walk sizes image parts by weight and the whole-result marker counts images', () => {
    const msgs = imageHistory(6);
    const r = elideHistory(msgs, { triggerChars: 100, targetChars: 50, keepLastSteps: 0, imageKeepLastSteps: 0 });
    expect(r.elidedCallIds.length).toBeGreaterThan(0);
    const first = (r.messages[2]!.content[0] as { content: string }).content;
    expect(typeof first).toBe('string');
    expect(first).toContain('[elided to save context');
    // sentChars dropped relative to raw (images weighted into rawChars, then replaced); the
    // floor is the marker texts themselves, so assert direction, not an arbitrary ratio.
    expect(r.sentChars).toBeLessThan(r.rawChars / 2);
  });

  it('deterministic: identical input yields identical output', () => {
    const msgs = imageHistory(5);
    expect(elideHistory(msgs)).toEqual(elideHistory(msgs));
  });
});

describe('provider mapping', () => {
  it('maps structured tool_result content to SDK text/image params, dropping harness enrichment', () => {
    const m = toApiMessage({ role: 'user', content: [imageResult('c1')] });
    const block = m.content[0] as {
      type: string;
      content: ({ type: 'text'; text: string } | { type: 'image'; source: { type: string; media_type: string; data: string } })[];
    };
    expect(block.type).toBe('tool_result');
    expect(block.content[0]).toEqual({ type: 'text', text: `screenshot captured: objects/${PNG_SHA}` });
    expect(block.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } });
    // The harness-internal enrichment FIELDS never reach the wire (the text pointer may).
    expect(JSON.stringify(block)).not.toContain('"sha256"');
    expect(JSON.stringify(block)).not.toContain('"label"');
  });

  it('the moving cache marker lands on the top-level tool_result block, never a nested part', () => {
    const params = buildApiParams({
      model: 'm',
      system: 's',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'view_image', input: {} }] },
        { role: 'user', content: [imageResult('c1')] },
      ],
      tools: [],
      maxTokens: 100,
    });
    const last = params.messages[params.messages.length - 1]!;
    const lastBlock = last.content[last.content.length - 1] as { type: string; cache_control?: unknown; content: unknown[] };
    expect(lastBlock.type).toBe('tool_result');
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
    for (const part of lastBlock.content) {
      expect((part as { cache_control?: unknown }).cache_control).toBeUndefined();
    }
  });
});

describe('runtime: live wire vs persisted log vs resume', () => {
  let tmp: string;
  let ws: string;
  let layout: ProjectLayout;

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-wireimg-')));
    ws = path.join(tmp, 'ws');
    fs.mkdirSync(ws);
    layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const imageTool: Tool<Record<string, never>> = {
    name: 'fake_image_tool',
    description: 'test tool returning an image',
    schema: z.object({}).strict() as unknown as Tool<Record<string, never>>['schema'],
    mutates: () => ({ paths: [] }),
    execute: () =>
      Promise.resolve({
        ok: true,
        output: `screenshot after-submit: objects/${PNG_SHA} (1 image attached)`,
        durationMs: 1,
        truncated: false,
        images: [{ mediaType: 'image/png', dataBase64: PNG_BASE64, sha256: PNG_SHA, label: 'after-submit' }],
      }),
  };

  function run(script: ScriptTurn[]) {
    const session = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'non-interactive',
      provider: new MockProvider(script),
      approver: autoDenyApprover, // never reached: an empty declared mutation auto-allows
      saltHex: '0'.repeat(32),
      maxSteps: 6,
      clock: fixedClock(0, 1),
      idGen: seededIdGen(),
      tools: [...TOOLS, imageTool],
    });
    return session;
  }

  it('the model sees pixels live; the log carries metadata + pointer only; resume degrades to text', async () => {
    const session = run([{ say: 'looking', calls: [{ name: 'fake_image_tool', input: {} }] }, { say: 'done' }]);
    await runTurn(session, 'look at the screenshot');

    // Live history: the tool_result is structured with a real image part.
    const live = session.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    expect(live !== undefined && typeof live.content !== 'string').toBe(true);
    const parts = (live as { content: ToolResultPart[] }).content;
    expect(parts.filter((p) => p.type === 'image')).toHaveLength(1);

    // Persisted log: image METADATA, never base64 (scan the raw file bytes).
    const completed = session.log.events.find((e) => e.type === 'tool.completed' && e.callId === (live as { toolUseId: string }).toolUseId);
    expect(completed).toMatchObject({
      images: [{ sha256: PNG_SHA, mediaType: 'image/png', label: 'after-submit', bytes: Math.floor((PNG_BASE64.length * 3) / 4) }],
    });
    const raw = fs.readFileSync(layout.sessionFile(session.id), 'utf8');
    expect(raw).not.toContain(PNG_BASE64.slice(0, 48));
    expect(raw).toContain(PNG_SHA); // the pointer IS recorded

    const id = session.id;
    endSession(session, 'completed');

    // Resume: reconstruct rebuilds from outputPreview — text pointer, zero image parts.
    const { events } = EventLog.readLenient(layout.sessionFile(id));
    const rec = reconstruct(events, ws);
    const rebuilt = rec.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(rebuilt.length).toBeGreaterThan(0);
    for (const b of rebuilt) {
      expect(typeof b.content).toBe('string');
      expect(b.content as string).not.toContain(PNG_BASE64.slice(0, 24));
    }
    expect(rebuilt.some((b) => (b.content as string).includes(`objects/${PNG_SHA}`))).toBe(true);
  });

  it('image aging is recorded on context.compacted (newlyImageElidedCallIds), once', async () => {
    // Three steps after the image step push it outside IMAGE_KEEP_LAST_STEPS=2.
    const session = run([
      { say: 's1', calls: [{ name: 'fake_image_tool', input: {} }] },
      { say: 's2', calls: [{ name: 'fake_image_tool', input: {} }] },
      { say: 's3', calls: [{ name: 'fake_image_tool', input: {} }] },
      { say: 's4', calls: [{ name: 'fake_image_tool', input: {} }] },
      { say: 'done' },
    ]);
    await runTurn(session, 'four screenshots');
    const compactions = session.log.events.filter((e) => e.type === 'context.compacted');
    const withImages = compactions.filter((e) => (e as { newlyImageElidedCallIds?: string[] }).newlyImageElidedCallIds !== undefined);
    expect(withImages.length).toBeGreaterThan(0);
    const allNewly = withImages.flatMap((e) => (e as { newlyImageElidedCallIds: string[] }).newlyImageElidedCallIds);
    expect(new Set(allNewly).size).toBe(allNewly.length); // each callId reported exactly once
    endSession(session, 'completed');
  });
});

describe('marker honesty', () => {
  it('the string-content marker wording is byte-stable (V0.5 contract untouched)', () => {
    const content = 'x'.repeat(5000);
    const msgs: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c0', name: 't', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c0', content }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    const r = elideHistory(msgs, { triggerChars: 100, targetChars: 10, keepLastSteps: 0 });
    const m = (r.messages[2]!.content[0] as { content: string }).content;
    expect(m).toBe(
      `[elided to save context: tool output of 5000 chars, sha256=${sha256(Buffer.from(content, 'utf8')).slice(0, 12)}…; the full output remains in the session evidence log]`,
    );
  });
});
