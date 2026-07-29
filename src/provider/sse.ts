/**
 * One shared incremental SSE parser (Session 15) for the fetch-based adapters.
 *
 * Yields one record per SSE event: the joined `data:` payload plus the optional `event:` name
 * (the OpenAI Responses API names its events; Chat-Completions-family streams do not). Handles
 * the hostile realities the fixtures pin: chunk boundaries anywhere (including mid-UTF-8),
 * CRLF and LF line endings, comment keep-alive lines (`: ...` — DeepSeek sends these), multi-line
 * data fields, and the literal `[DONE]` sentinel, which is YIELDED (callers decide to stop —
 * Kimi documents [DONE], not finish_reason, as the terminator).
 */

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* sseEvents(
  body: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, undefined> {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;

  const flush = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const ev: SseEvent = { data: dataLines.join('\n'), ...(eventName !== undefined ? { event: eventName } : {}) };
    dataLines = [];
    eventName = undefined;
    return ev;
  };

  const consumeLine = (line: string): SseEvent | undefined => {
    if (line === '') return flush(); // blank line = event boundary
    if (line.startsWith(':')) return undefined; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
    // id / retry / unknown fields are ignored.
    return undefined;
  };

  for await (const chunk of body) {
    if (signal?.aborted) return;
    buf += decoder.decode(chunk, { stream: true });
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl === -1) break;
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const ev = consumeLine(line);
      if (ev !== undefined) yield ev;
    }
  }
  // Trailing buffer (a stream that ended without a final newline) and any unflushed event.
  buf += decoder.decode();
  if (buf !== '') {
    const ev = consumeLine(buf.endsWith('\r') ? buf.slice(0, -1) : buf);
    if (ev !== undefined) yield ev;
  }
  const tail = flush();
  if (tail !== undefined) yield tail;
}

export const SSE_DONE = '[DONE]';
