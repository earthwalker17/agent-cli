/**
 * Typed errors for the document-artifact workflow pack. Module-local on purpose: the kernel's
 * `shared/errors.ts` stays reserved for failures the KERNEL can produce; a workflow pack owns
 * its own failure vocabulary (constitution: workflow packs stay outside the kernel).
 */

export type ArtifactErrorReason =
  /** Zip central directory / entry data is not readable as a zip. */
  | 'zip-corrupt'
  /** Zip exceeds a bound (entry count, per-entry bytes, total decompressed bytes). */
  | 'zip-bounds'
  /** A zip entry name is hostile or unrepresentable (traversal, absolute, control chars). */
  | 'zip-entry-name'
  /** XML input exceeds the size bound. */
  | 'xml-bounds'
  /** XML is not well-formed. */
  | 'xml-parse'
  /** A render was handed unusable input (missing/undecodable image bytes). */
  | 'render-input';

/**
 * A bounded-read or render failure with a typed reason. Messages are safe to show a model but
 * are NOT harness-attributed display lines — callers that print them into chrome/report/events
 * still own sanitization at the print site (project discipline).
 */
export class ArtifactError extends Error {
  override readonly name = 'ArtifactError';
  constructor(
    message: string,
    readonly reason: ArtifactErrorReason,
  ) {
    super(message);
  }
}
