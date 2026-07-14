import { createHash, createHmac, randomBytes } from 'node:crypto';

/** Hex sha256 of a string or buffer. Used for content-addressed snapshots and evidence. */
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface Truncated {
  /** The exact string the model sees AND the exact string persisted to the log. */
  text: string;
  truncated: boolean;
  /** sha256 of the FULL untruncated output — so truncation never hides fidelity. */
  fullSha256?: string;
}

/**
 * The single truncation contract. The returned `text` is what the model receives and what
 * `tool.completed.outputPreview` records, so a resumed conversation is byte-identical to the
 * original (fixes the "resume history divergence" defect). Head+tail with an explicit marker.
 */
export function truncateForModel(output: string, maxChars = 16_000): Truncated {
  if (output.length <= maxChars) return { text: output, truncated: false };
  const fullSha256 = sha256(output);
  const omitted = output.length - maxChars;
  const marker = `\n\n… [truncated ${omitted} of ${output.length} chars; full sha256=${fullSha256}] …\n\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(budget * 0.7);
  const tail = budget - head;
  const text = output.slice(0, head) + marker + (tail > 0 ? output.slice(output.length - tail) : '');
  return { text, truncated: true, fullSha256 };
}

/** A per-session random salt (hex) used to key secret redaction. Kept out of the event log. */
export function randomSaltHex(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Replace secret content with a non-reversible marker for persistence. Uses HMAC keyed by a
 * per-session salt (not stored in the log), so equal secrets read within one session compare
 * equal in the log, but the log alone cannot be dictionary-brute-forced (fixes the
 * "unsalted-sha256 brute force" defect). The model still sees the real bytes in memory.
 */
export function redactSecret(content: string, saltHex: string): string {
  const mac = createHmac('sha256', Buffer.from(saltHex, 'hex')).update(content).digest('hex');
  return `[REDACTED secret: ${Buffer.byteLength(content, 'utf8')} bytes, hmac=${mac.slice(0, 16)}]`;
}
