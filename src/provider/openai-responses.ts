import type { ChatMessage, ContentBlock, Provider, ProviderRequest, ProviderTurn, StopReason, ToolResultPart } from '../types.js';
import { createTransport, type Transport } from '../net/transport.js';
import { capsFor } from './catalog.js';
import { ProviderError, classifyHttpStatus, retryAfterMs, withRetry } from './errors.js';
import { sseEvents, SSE_DONE } from './sse.js';

/**
 * The OpenAI adapter (Session 15) — Responses API, deliberately NOT Chat Completions: since
 * GPT-5.4, Chat Completions does not support tool calls with reasoning off, and reasoning-item
 * replay (required for stateless multi-step tool use) is a Responses-only concept.
 *
 * Statelessness is a harness contract: `store:false` + `include:['reasoning.encrypted_content']`
 * — nothing persists server-side, and every request replays the items since the last real user
 * message: reasoning items VERBATIM (our opaque reasoning payload), function_call items rebuilt
 * from tool_use blocks (call_id pairing), function_call_output items from tool_results. Images
 * inside tool_results are re-homed as input_image user items (function outputs are string-only).
 *
 * The terminal `response.completed` / `response.incomplete` payload is authoritative for blocks
 * and usage; streamed deltas only drive live text rendering. `incomplete` maps honestly
 * (max_output_tokens → 'max_tokens', content_filter → 'refusal') and `response.failed` throws —
 * an unfinished generation must never look like a clean turn.
 */

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (typeof v === 'object' && v !== null ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Index of the last user message carrying anything other than tool_results (the loop boundary). */
function lastRealUserIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m.content.some((b) => b.type !== 'tool_result')) return i;
  }
  return -1;
}

function splitToolResult(content: string | ToolResultPart[]): { text: string; images: Extract<ToolResultPart, { type: 'image' }>[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  const images: Extract<ToolResultPart, { type: 'image' }>[] = [];
  const texts: string[] = [];
  for (const p of content) {
    if (p.type === 'text') texts.push(p.text);
    else images.push(p);
  }
  return { text: texts.join('\n'), images };
}

/**
 * Pure request builder — exported for golden tests. `visionInput` comes from the CATALOG so the
 * same single rule governs pixels everywhere (S15 review finding: this path re-homed images
 * unconditionally, which could send pixels to a model the harness itself classified as text-only —
 * reachable via `/model <uncataloged-id>` while image parts are still inside the elision window).
 */
export function buildResponsesRequest(req: ProviderRequest, visionInput = true): Rec {
  const input: Rec[] = [];
  const loopStart = lastRealUserIndex(req.messages);

  req.messages.forEach((m, idx) => {
    if (m.role === 'assistant') {
      let texts = '';
      for (const b of m.content) {
        if (b.type === 'reasoning') {
          // Replay OUR reasoning items verbatim, current loop only (older items are dead weight;
          // foreign providers' payloads are not Responses items at all).
          if (b.providerName === 'openai' && b.model === req.model && idx > loopStart && rec(b.payload) !== undefined) {
            input.push(rec(b.payload)!);
          }
        } else if (b.type === 'text') {
          texts += b.text;
        } else if (b.type === 'tool_use') {
          input.push({
            type: 'function_call',
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          });
        }
      }
      if (texts.length > 0) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: texts }] });
      }
      return;
    }
    // role user: function_call_output items first (pairing), re-homed images after, text last.
    const texts: string[] = [];
    const pendingImages: { label: string; images: Extract<ToolResultPart, { type: 'image' }>[] }[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const { text, images } = splitToolResult(b.content);
        let output = text;
        if (images.length > 0) {
          if (visionInput) {
            output = `${text}${text.length > 0 ? '\n' : ''}[${images.length} screenshot(s) attached in the next message]`;
            pendingImages.push({ label: b.toolUseId, images });
          } else {
            const pointers = images
              .map(
                (img) =>
                  `[screenshot${img.label !== undefined ? ` ${img.label}` : ''}: stored as evidence${img.sha256 !== undefined ? ` at objects/${img.sha256}` : ''}; this model has no image input]`,
              )
              .join('\n');
            output = `${text}${text.length > 0 ? '\n' : ''}${pointers}`;
          }
        }
        input.push({ type: 'function_call_output', call_id: b.toolUseId, output });
      } else if (b.type === 'text') {
        texts.push(b.text);
      }
    }
    for (const p of pendingImages) {
      input.push({
        role: 'user',
        content: [
          { type: 'input_text', text: `screenshots from tool call ${p.label}:` },
          ...p.images.map((img) => ({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.dataBase64}` })),
        ],
      });
    }
    if (texts.length > 0) {
      input.push({ role: 'user', content: [{ type: 'input_text', text: texts.join('\n') }] });
    }
  });

  const body: Rec = {
    model: req.model,
    input,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: req.maxTokens,
  };
  if (req.system.length > 0) body['instructions'] = req.system;
  if (req.tools.length > 0) {
    // Flat Responses tool schema. strict:false — zod-derived draft-7 schemas are not
    // strict-transformable (strict demands additionalProperties:false + all-required).
    body['tools'] = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
      strict: false,
    }));
  }
  return body;
}

/** Map a terminal Responses payload (completed/incomplete) into a ProviderTurn. */
export function mapResponsesResult(response: Rec, model: string): ProviderTurn {
  const blocks: ContentBlock[] = [];
  const output = Array.isArray(response['output']) ? (response['output'] as Rec[]) : [];
  let sawFunctionCall = false;
  for (const item of output) {
    const type = str(item['type']);
    if (type === 'reasoning') {
      const summary = Array.isArray(item['summary'])
        ? (item['summary'] as Rec[]).map((s) => str(s['text']) ?? '').join('\n').trim()
        : '';
      blocks.push({
        type: 'reasoning',
        providerName: 'openai',
        model,
        payload: item,
        ...(summary.length > 0 ? { text: summary } : {}),
      });
    } else if (type === 'message') {
      const content = Array.isArray(item['content']) ? (item['content'] as Rec[]) : [];
      const text = content.map((c) => (str(c['type']) === 'output_text' ? (str(c['text']) ?? '') : '')).join('');
      if (text.length > 0) blocks.push({ type: 'text', text });
    } else if (type === 'function_call') {
      sawFunctionCall = true;
      const args = str(item['arguments']) ?? '';
      let inputParsed: unknown;
      try {
        inputParsed = args.length > 0 ? JSON.parse(args) : {};
      } catch {
        inputParsed = { _unparsed: args };
      }
      blocks.push({
        type: 'tool_use',
        id: str(item['call_id']) ?? str(item['id']) ?? 'call_unknown',
        name: str(item['name']) ?? 'unknown_tool',
        input: inputParsed,
      });
    }
    // web_search/file_search/etc. hosted-tool items are not requested and are ignored if present.
  }

  const status = str(response['status']);
  let stopReason: StopReason;
  if (status === 'incomplete') {
    const reason = str(rec(response['incomplete_details'])?.['reason']);
    stopReason = reason === 'content_filter' ? 'refusal' : 'max_tokens';
  } else {
    stopReason = sawFunctionCall ? 'tool_use' : 'end_turn';
  }

  const usage = rec(response['usage']);
  const cached = num(rec(usage?.['input_tokens_details'])?.['cached_tokens']);
  const cacheWrite = num(rec(usage?.['input_tokens_details'])?.['cache_write_tokens'] ?? usage?.['cache_write_tokens']);
  const reasoningTokens = num(rec(usage?.['output_tokens_details'])?.['reasoning_tokens']);
  return {
    blocks,
    stopReason,
    usage: {
      inputTokens: Math.max(0, num(usage?.['input_tokens']) - cached),
      outputTokens: num(usage?.['output_tokens']),
      cacheReadInputTokens: cached,
      cacheCreationInputTokens: cacheWrite,
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    },
  };
}

export interface ResponsesProviderOptions {
  baseUrl?: string;
  /** The credential VALUE — read from env by the registry; never logged or persisted. */
  apiKey: string;
  transport?: Transport;
  /** Injectable fetch for hermetic tests (overrides transport/global fetch). */
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export class OpenAiResponsesProvider implements Provider {
  readonly name = 'openai';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly transport: Transport;
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;

  constructor(opts: ResponsesProviderOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.transport = opts.transport ?? createTransport({ describeUrl: this.baseUrl });
    this.fetchImpl =
      opts.fetchImpl ??
      ((input, init) => (this.transport.fetch ?? (globalThis.fetch as typeof fetch))(input as never, init as never));
  }

  describeTransport(): string {
    return this.transport.describe();
  }

  async complete(req: ProviderRequest, onText?: (delta: string) => void, signal?: AbortSignal): Promise<ProviderTurn> {
    const body = JSON.stringify(buildResponsesRequest(req, capsFor('openai', req.model).visionInput));
    const url = `${this.baseUrl}/responses`;

    const res = await withRetry(
      async () => {
        let r: Response;
        try {
          r = await this.fetchImpl(url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              'content-type': 'application/json',
              accept: 'text/event-stream',
            },
            body,
            ...(signal !== undefined ? { signal } : {}),
          });
        } catch (err) {
          if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
          throw new ProviderError({ kind: 'network', provider: 'openai', message: `request failed: ${(err as Error).message}` });
        }
        if (!r.ok) {
          let parsed: unknown;
          try {
            parsed = await r.json();
          } catch {
            parsed = undefined;
          }
          throw this.classify(r.status, parsed, r.headers.get('retry-after'));
        }
        return r;
      },
      { ...(signal !== undefined ? { signal } : {}) },
    );

    if (res.body === null) throw new ProviderError({ kind: 'server', provider: 'openai', message: 'response had no body' });

    let terminal: Rec | undefined;
    let incomplete = false;
    for await (const ev of sseEvents(res.body as unknown as AsyncIterable<Uint8Array>, signal)) {
      if (ev.data === SSE_DONE) break;
      let data: Rec;
      try {
        data = JSON.parse(ev.data) as Rec;
      } catch {
        continue;
      }
      const type = str(data['type']) ?? ev.event;
      if (type === 'response.output_text.delta') {
        const delta = str(data['delta']);
        if (delta !== undefined && delta.length > 0) onText?.(delta);
      } else if (type === 'response.completed') {
        terminal = rec(data['response']);
      } else if (type === 'response.incomplete') {
        terminal = rec(data['response']);
        incomplete = true;
      } else if (type === 'response.failed') {
        const errInfo = rec(rec(data['response'])?.['error']);
        throw new ProviderError({
          kind: 'server',
          provider: 'openai',
          ...(str(errInfo?.['code']) !== undefined ? { providerCode: str(errInfo?.['code'])! } : {}),
          message: str(errInfo?.['message']) ?? 'response failed',
        });
      } else if (type === 'error') {
        throw new ProviderError({ kind: 'server', provider: 'openai', message: str(data['message']) ?? 'stream error' });
      }
      // output_item.added / function_call_arguments.* deltas only pre-announce what the
      // terminal payload carries authoritatively; they are deliberately not accumulated.
    }

    if (terminal === undefined) {
      throw new ProviderError({ kind: 'server', provider: 'openai', message: 'stream ended without a terminal response event' });
    }
    if (incomplete && terminal['incomplete_details'] === undefined) {
      terminal['incomplete_details'] = { reason: 'max_output_tokens' };
    }
    if (incomplete) terminal['status'] = 'incomplete';
    return mapResponsesResult(terminal, req.model);
  }

  private classify(status: number, body: unknown, retryAfter: string | null): ProviderError {
    const e = rec(rec(body)?.['error']);
    const code = str(e?.['code']) ?? str(e?.['type']);
    let kind = classifyHttpStatus(status);
    if (status === 429 && (code === 'insufficient_quota' || str(e?.['type']) === 'insufficient_quota')) kind = 'balance';
    if (status === 400 && code === 'context_length_exceeded') kind = 'context-window';
    const err = new ProviderError({
      kind,
      provider: 'openai',
      status,
      ...(code !== undefined ? { providerCode: code } : {}),
      message: str(e?.['message']) ?? `HTTP ${status}`,
    });
    const ra = retryAfterMs(retryAfter);
    if (ra !== undefined) (err as ProviderError & { retryAfterHint?: number }).retryAfterHint = ra;
    return err;
  }
}
