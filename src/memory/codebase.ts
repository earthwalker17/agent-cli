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
      head: fields['head'] === 'none' || fields['head'] === undefined ? null : fields['head'],
    },
    body,
  };
}

/** A doc with no readable stamp, or one written against a different workspace map, is stale. */
export function isStale(stamp: CodebaseStamp | null, currentMapSha256: string): boolean {
  return stamp === null || stamp.mapSha256 !== currentMapSha256;
}
