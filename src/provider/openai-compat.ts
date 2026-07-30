import type { ChatMessage, ContentBlock, Provider, ProviderRequest, ProviderTurn, StopReason, ToolResultPart } from '../types.js';
import { createTransport, type Transport } from '../net/transport.js';
import { capsFor, type ModelCaps, type ProviderName } from './catalog.js';
import { ProviderError, classifyHttpStatus, retryAfterMs, withRetry } from './errors.js';
import { sseEvents, SSE_DONE } from './sse.js';
import type { CompatProfile } from './profiles.js';

/**
 * ONE Chat-Completions-compatible adapter (Session 15), parameterized by a CompatProfile —
 * serving DeepSeek, Kimi (Moonshot), and GLM (Z.AI/Zhipu). Everything provider-specific is
 * profile/catalog DATA; this file has no provider name-checks.
 *
 * Wire mapping rules the tests pin:
 * - Each harness tool_result becomes its OWN `role:"tool"` message (kimi errors on any
 *   tool_call/tool-message mismatch), emitted BEFORE any user text from the same harness
 *   message so pairing adjacency with the preceding assistant tool_calls message holds.
 * - Image parts: on vision models ('rehomed') the pixels are re-emitted as a follow-up user
 *   message with data-URI image_url parts (kimi-k3 rejects https URLs; string-only tool
 *   outputs everywhere in this family); on text-only models ('none') an honest text pointer
 *   replaces them — the recorded waiver happens upstream at the runtime choke.
 * - Reasoning replay follows the catalog: 'all' (kimi — the complete assistant message,
 *   reasoning included, goes back verbatim), 'current-loop' (deepseek — required on
 *   tool-calling assistant messages), 'none' (glm — the server strips prior thinking).
 * - No sampling params, no tool_choice, no thinking param — provider defaults are what the
 *   harness wants, and kimi locks sampling outright.
 * - The stream terminates on the literal [DONE] sentinel (kimi's documented rule), usage is
 *   accepted from every documented location, and error-shaped finish_reasons THROW typed
 *   errors instead of fabricating a model turn.
 */

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface CompatRequestBody {
  model: string;
  messages: WireMessage[];
  tools?: { type: 'function'; function: Record<string, unknown> }[];
  stream: true;
  stream_options?: { include_usage: true };
  [key: string]: unknown;
}

function textOfParts(content: string | ToolResultPart[]): { text: string; images: Extract<ToolResultPart, { type: 'image' }>[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  const images: Extract<ToolResultPart, { type: 'image' }>[] = [];
  const texts: string[] = [];
  for (const p of content) {
    if (p.type === 'text') texts.push(p.text);
    else images.push(p);
  }
  return { text: texts.join('\n'), images };
}

function imagePointer(img: Extract<ToolResultPart, { type: 'image' }>): string {
  const where = img.sha256 !== undefined ? `objects/${img.sha256}` : 'the session evidence store';
  return `[screenshot${img.label !== undefined ? ` ${img.label}` : ''}: captured as evidence at ${where}; this model has no image input]`;
}

/** Index of the last user message carrying anything other than tool_results (the loop boundary). */
function lastRealUserIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m.content.some((b) => b.type !== 'tool_result')) return i;
  }
  return -1;
}

/** Pure request builder — exported for golden tests. */
export function buildCompatRequest(profile: CompatProfile, req: ProviderRequest, caps: ModelCaps): CompatRequestBody {
  const messages: WireMessage[] = [];
  if (req.system.length > 0) messages.push({ role: 'system', content: req.system });

  const loopStart = lastRealUserIndex(req.messages);

  req.messages.forEach((m, idx) => {
    if (m.role === 'assistant') {
      const texts: string[] = [];
      const toolCalls: WireToolCall[] = [];
      const reasoningParts: string[] = [];
      for (const b of m.content) {
        if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'tool_use') {
          toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
        } else if (b.type === 'reasoning') {
          const inScope =
            profile.echoReasoningContent &&
            b.providerName === profile.provider &&
            b.model === req.model &&
            (caps.reasoning.replay === 'all' || (caps.reasoning.replay === 'current-loop' && idx > loopStart));
          if (inScope && typeof b.payload === 'string') reasoningParts.push(b.payload);
        }
        // tool_result blocks never appear on assistant messages.
      }
      // An assistant turn with neither text nor tool calls (a thinking-only turn — reachable once
      // reasoning is on by default, e.g. a length cut before any text) is DROPPED rather than sent
      // as `{content: null}` with nothing else: this family requires content or tool_calls, and a
      // wire-invalid history would 400 every later request in the session (S15 review finding).
      if (texts.length === 0 && toolCalls.length === 0) return;
      const msg: WireMessage = {
        role: 'assistant',
        content: texts.length > 0 ? texts.join('') : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoningParts.length > 0 ? { reasoning_content: reasoningParts.join('\n') } : {}),
      };
      messages.push(msg);
      return;
    }

    // role user: tool_result blocks become role:"tool" messages FIRST (pairing adjacency with
    // the assistant tool_calls message above them), then any text becomes one user message.
    const texts: string[] = [];
    const pendingImages: { label: string; images: Extract<ToolResultPart, { type: 'image' }>[] }[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const { text, images } = textOfParts(b.content);
        let content = text;
        if (images.length > 0) {
          // Vision is gated by the CATALOG, never by provider name — mirrors the runtime choke.
          if (caps.toolResultImages === 'rehomed' && caps.visionInput) {
            content = `${text}${text.length > 0 ? '\n' : ''}[${images.length} screenshot(s) attached in the next message]`;
            pendingImages.push({ label: b.toolUseId, images });
          } else {
            content = `${text}${text.length > 0 ? '\n' : ''}${images.map(imagePointer).join('\n')}`;
          }
        }
        messages.push({ role: 'tool', tool_call_id: b.toolUseId, content });
      } else if (b.type === 'text') {
        texts.push(b.text);
      }
      // reasoning blocks never appear on user messages.
    }
    for (const p of pendingImages) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `screenshots from tool call ${p.label}:` },
          ...p.images.map(
            (img): ContentPart => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` } }),
          ),
        ],
      });
    }
    if (texts.length > 0) messages.push({ role: 'user', content: texts.join('\n') });
  });

  const body: CompatRequestBody = {
    model: req.model,
    messages,
    stream: true,
    [profile.maxTokensParam]: req.maxTokens,
    ...(profile.sendIncludeUsage ? { stream_options: { include_usage: true } } : {}),
  };
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
        ...(profile.explicitToolStrictFalse ? { strict: false } : {}),
      },
    }));
  }
  return body;
}

// ── Streaming state ────────────────────────────────────────────────────────────────────────

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  args: string;
}

const BASE_FINISH: Record<string, StopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

export interface CompatProviderOptions {
  profile: CompatProfile;
  baseUrl: string;
  /** The credential VALUE — read from env by the registry; never logged or persisted. */
  apiKey: string;
  transport?: Transport;
  /** Injectable fetch for hermetic tests (overrides transport/global fetch). */
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export class OpenAiCompatProvider implements Provider {
  readonly name: ProviderName;
  private readonly profile: CompatProfile;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly transport: Transport;
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;

  constructor(opts: CompatProviderOptions) {
    this.profile = opts.profile;
    this.name = opts.profile.provider;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
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
    const caps = capsFor(this.name, req.model);
    const body = JSON.stringify(buildCompatRequest(this.profile, req, caps));
    const url = `${this.baseUrl}/chat/completions`;

    // Connection phase under bounded retry; once the stream is being consumed we never replay.
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
          throw new ProviderError({
            kind: 'network',
            provider: this.name,
            message: `request failed: ${(err as Error).message}`,
          });
        }
        if (!r.ok) {
          let parsed: unknown;
          try {
            parsed = await r.json();
          } catch {
            parsed = undefined;
          }
          const c = this.profile.classifyError(r.status, parsed);
          const e = new ProviderError({
            kind: c.kind,
            provider: this.name,
            status: r.status,
            ...(c.code !== undefined ? { providerCode: c.code } : {}),
            message: `${c.message ?? `HTTP ${r.status}`}${c.hint !== undefined ? ` — ${c.hint}` : ''}`,
          });
          const ra = retryAfterMs(r.headers.get('retry-after'));
          if (ra !== undefined) (e as ProviderError & { retryAfterHint?: number }).retryAfterHint = ra;
          throw e;
        }
        return r;
      },
      { ...(signal !== undefined ? { signal } : {}) },
    );

    if (res.body === null) {
      throw new ProviderError({ kind: 'server', provider: this.name, message: 'response had no body' });
    }
    return await this.consumeStream(res.body as unknown as AsyncIterable<Uint8Array>, req, onText, signal);
  }

  private async consumeStream(
    bodyStream: AsyncIterable<Uint8Array>,
    req: ProviderRequest,
    onText?: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ProviderTurn> {
    let text = '';
    let reasoning = '';
    let finish: string | undefined;
    let rawUsage: Record<string, unknown> | undefined;
    const toolAcc = new Map<number, ToolCallAccumulator>();

    for await (const ev of sseEvents(bodyStream, signal)) {
      if (ev.data === SSE_DONE) break;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        continue; // tolerate malformed keep-alive-ish payloads; the terminator rules the stream
      }
      // GLM surfaces mid-stream errors as an error envelope chunk.
      const errObj = chunk['error'];
      if (typeof errObj === 'object' && errObj !== null) {
        const c = this.profile.classifyError(200, chunk);
        throw new ProviderError({
          kind: c.kind === 'bad-request' ? 'server' : c.kind,
          provider: this.name,
          ...(c.code !== undefined ? { providerCode: c.code } : {}),
          message: c.message ?? 'provider reported an error mid-stream',
        });
      }
      const choices = chunk['choices'] as { delta?: Record<string, unknown>; finish_reason?: string | null; usage?: unknown }[] | undefined;
      const choice = choices?.[0];
      if (chunk['usage'] !== undefined && chunk['usage'] !== null) rawUsage = chunk['usage'] as Record<string, unknown>;
      if (choice?.usage !== undefined && choice.usage !== null) rawUsage = choice.usage as Record<string, unknown>;
      if (choice === undefined) continue;
      if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
      const delta = choice.delta;
      if (delta === undefined) continue;
      const dText = delta['content'];
      if (typeof dText === 'string' && dText.length > 0) {
        text += dText;
        onText?.(dText);
      }
      const dReasoning = delta['reasoning_content'];
      if (typeof dReasoning === 'string') reasoning += dReasoning; // never rendered — round-trip only
      const dCalls = delta['tool_calls'];
      if (Array.isArray(dCalls)) {
        for (const c of dCalls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
          const idx = c.index ?? 0;
          const acc = toolAcc.get(idx) ?? { args: '' };
          if (typeof c.id === 'string' && c.id.length > 0) acc.id = c.id;
          if (typeof c.function?.name === 'string' && c.function.name.length > 0) acc.name = c.function.name;
          if (typeof c.function?.arguments === 'string') acc.args += c.function.arguments;
          toolAcc.set(idx, acc);
        }
      }
    }

    // Error-shaped finishes throw typed errors — a failed generation must not become a model turn.
    const extra = finish !== undefined ? this.profile.finishExtras[finish] : undefined;
    if (extra !== undefined && 'error' in extra) {
      throw new ProviderError({
        kind: extra.error,
        provider: this.name,
        message: extra.message,
        retryable: extra.retryable ?? false,
      });
    }

    const blocks: ContentBlock[] = [];
    if (reasoning.length > 0) {
      blocks.push({ type: 'reasoning', providerName: this.name, model: req.model, payload: reasoning, text: reasoning });
    }
    if (text.length > 0) blocks.push({ type: 'text', text });
    let synthetic = 0;
    for (const [idx, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      let input: unknown;
      try {
        input = acc.args.length > 0 ? JSON.parse(acc.args) : {};
      } catch {
        // Honest degrade: the raw string fails zod validation downstream and is recorded; the
        // model sees the schema error and retries — never a thrown turn.
        input = { _unparsed: acc.args };
      }
      blocks.push({
        type: 'tool_use',
        id: acc.id ?? `call_${this.name}_${idx}_${++synthetic}`,
        name: acc.name ?? 'unknown_tool',
        input,
      });
    }

    const mapped: StopReason | undefined =
      extra !== undefined && 'stop' in extra ? extra.stop : finish !== undefined ? BASE_FINISH[finish] : undefined;
    const stopReason: StopReason = mapped ?? (toolAcc.size > 0 ? 'tool_use' : finish === undefined ? 'other' : 'other');

    return { blocks, stopReason, usage: this.profile.mapUsage(rawUsage) };
  }
}
