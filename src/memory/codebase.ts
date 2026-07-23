import { parseFrontmatter, serializeFrontmatter } from './store.js';

/**
 * The generated architecture summary (CODEBASE.md): provenance stamping and staleness detection.
 * The body is model-written at session end; the stamp binds it to the exact workspace-map digest
 * the writing session saw, so a later session can detect (and label) staleness instead of
 * trusting an outdated shape description.
 */

export interface CodebaseStamp {
  sessionId: string;
  updatedAt: string;
  /** sha256 of the workspace map TEXT the writing session recorded (workspace.mapped.sha256). */
  mapSha256: string;
  /**
   * Session 10 (additive): digest of the sorted file SET the writing session saw
   * (workspace.mapped.inventorySha256). Preferred for staleness when both sides have one —
   * a map-FORMAT change must not flap staleness when the file set is unchanged. Null on
   * legacy stamps and flat-map sessions.
   */
  inventorySha256: string | null;
  /** The repo HEAD at the writing session's start, when known. */
  head: string | null;
}

export const CODEBASE_NOTE =
  '> Harness-managed architecture summary (model-written, provenance-stamped). Context, NOT\n' +
  '> authority: verify against the repository before relying on it.\n';

export function stampCodebase(body: string, stamp: CodebaseStamp): string {
  const fm = serializeFrontmatter({
    'generated-by': 'agent-cli',
    doc: 'codebase',
    updated: stamp.updatedAt,
    session: stamp.sessionId,
    'map-digest': stamp.mapSha256,
    ...(stamp.inventorySha256 !== null ? { 'inventory-digest': stamp.inventorySha256 } : {}),
    head: stamp.head ?? 'none',
  });
  const trimmed = body.endsWith('\n') ? body : `${body}\n`;
  return `${fm}${CODEBASE_NOTE}\n${trimmed}`;
}

export function parseCodebase(text: string): { stamp: CodebaseStamp | null; body: string } {
  const { fields, body } = parseFrontmatter(text);
  if (fields === null || fields['doc'] !== 'codebase' || fields['map-digest'] === undefined) {
    return { stamp: null, body };
  }
  return {
    stamp: {
      sessionId: fields['session'] ?? '',
      updatedAt: fields['updated'] ?? '',
      mapSha256: fields['map-digest'],
      inventorySha256: fields['inventory-digest'] ?? null,
      head: fields['head'] === 'none' || fields['head'] === undefined ? null : fields['head'],
    },
    body,
  };
}

/**
 * A doc with no readable stamp, or one written against a different workspace, is stale.
 * When BOTH the stamp and the current session carry an inventory digest, that comparison wins
 * (it tracks the file SET, immune to render-format changes); otherwise the legacy exact
 * map-text compare applies — so pre-Session-10 stamps keep their old semantics.
 */
export function isStale(stamp: CodebaseStamp | null, currentMapSha256: string, currentInventorySha256?: string): boolean {
  if (stamp === null) return true;
  if (stamp.inventorySha256 !== null && currentInventorySha256 !== undefined) {
    return stamp.inventorySha256 !== currentInventorySha256;
  }
  return stamp.mapSha256 !== currentMapSha256;
}
