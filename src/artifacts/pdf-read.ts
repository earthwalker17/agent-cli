/**
 * PDF summary reader over unpdf (a bundled, dependency-free pdf.js build that works in plain
 * Node — pdfjs-dist itself needs DOMMatrix and auto-loads a NATIVE canvas module even for text,
 * measured in the Session 17 step-0 probe; this pack loads no native code).
 *
 * Untrusted bytes: `isEvalSupported: false` keeps the PostScript-function eval path off, a
 * password-protected file degrades to a structural summary with the reason (never a throw),
 * and per-page text is bounded.
 */

import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import { DEFAULT_READ_BOUNDS, type ArtifactMetadata, type PageText, type PdfSummary, type ReadBounds } from './types.js';

const META_CAP = 300;

function metaString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t.slice(0, META_CAP);
}

export async function readPdf(bytes: Uint8Array, bounds?: ReadBounds): Promise<PdfSummary> {
  const b = { ...DEFAULT_READ_BOUNDS, ...bounds };
  const warnings: string[] = [];
  const coverageReasons: string[] = [];
  const structural = (reason: string): PdfSummary => ({
    kind: 'pdf',
    metadata: {},
    pageCount: 0,
    pages: [],
    media: [],
    warnings,
    coverage: 'structural',
    coverageReasons: [reason],
  });

  let doc;
  try {
    // Copy: pdf.js transfers the buffer to its worker shim and detaches the caller's view.
    // `isEvalSupported: false` is a standard pdf.js DocumentInitParameters option (keeps the
    // PostScript-function eval path off for untrusted bytes); unpdf's bundled type stubs omit
    // it, so the cast widens the TYPE only — the runtime honors it.
    // `verbosity: 0` (ERRORS only) keeps pdf.js's font-substitution and internal-API warnings
    // off the harness's stderr — which is the REPL's CHROME stream, so library noise rendered
    // as harness output (found live, S17).
    doc = await getDocumentProxy(bytes.slice(), { isEvalSupported: false, verbosity: 0 } as Parameters<typeof getDocumentProxy>[1]);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'PasswordException') {
      return structural('password-protected PDF; content is not readable without the password');
    }
    warnings.push(err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : String(err).slice(0, 200));
    return structural('the PDF could not be opened; only its header was identified');
  }

  try {
    let metadata: ArtifactMetadata = {};
    try {
      const { info } = await getMeta(doc);
      const rec = info as Record<string, unknown>;
      const put = (key: keyof ArtifactMetadata, v: string | undefined): void => {
        if (v !== undefined) metadata = { ...metadata, [key]: v };
      };
      put('title', metaString(rec['Title']));
      put('author', metaString(rec['Author']));
      put('subject', metaString(rec['Subject']));
      put('keywords', metaString(rec['Keywords']));
      put('created', metaString(rec['CreationDate']));
      put('modified', metaString(rec['ModDate']));
      put('application', metaString(rec['Producer']) ?? metaString(rec['Creator']));
    } catch {
      warnings.push('PDF metadata unreadable; omitted');
    }

    const pages: PageText[] = [];
    let collected = 0;
    try {
      const { text } = await extractText(doc, { mergePages: false });
      for (const [i, pageText] of text.entries()) {
        if (pages.length >= b.maxUnits || collected >= b.maxTextChars) {
          coverageReasons.push(`${text.length - pages.length} of ${text.length} pages counted but not extracted (bound)`);
          break;
        }
        const clipped = pageText.slice(0, Math.min(b.maxTextChars - collected, 20_000));
        if (clipped.length < pageText.length) coverageReasons.push(`page ${i + 1} text truncated (bound)`);
        pages.push({ page: i + 1, text: clipped });
        collected += clipped.length;
      }
    } catch (err) {
      warnings.push(`text extraction failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`);
      coverageReasons.push('page text could not be extracted; page count and metadata only');
    }

    return {
      kind: 'pdf',
      metadata,
      pageCount: doc.numPages,
      pages,
      media: [],
      warnings,
      coverage: coverageReasons.length > 0 ? (pages.length === 0 ? 'structural' : 'partial') : 'full',
      coverageReasons,
    };
  } finally {
    // unpdf's bundled proxy does not expose pdf.js's destroy(); clean up when it exists.
    const disposable = doc as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
    if (typeof disposable.destroy === 'function') await disposable.destroy().catch(() => undefined);
    else if (typeof disposable.cleanup === 'function') await disposable.cleanup().catch(() => undefined);
  }
}
