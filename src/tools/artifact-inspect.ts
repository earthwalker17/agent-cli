/**
 * inspect_pages — SEE a PDF's pages (Session 17): rasterize up to four pages in the probed
 * system browser, store the PNGs as content-addressed evidence blobs, and return the pixels
 * over the wire-image channel.
 *
 * Policy (the `artifact` fact, kind 'inspect'): a document THIS SESSION rendered inherits the
 * render's consent and auto-allows — the fact answers by PATH over the in-memory events, and
 * execute re-verifies by CONTENT sha (the preview-drift pattern: a file swapped since the
 * render refuses rather than riding the path claim). Any other workspace PDF asks (grantable);
 * outside the workspace and secret-named paths deny at the engine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SessionEvent, Tool, ToolResult } from '../types.js';
import { resolveForTool } from './index.js';
import { sha256 } from '../shared/hash.js';
import { caseFold } from '../shared/pathutil.js';
import { identifyDocument } from '../artifacts/inspect.js';
import { rasterizePdfPages, type Rasterize } from '../artifacts/pdf-pages.js';
import type { BrowserAvailability } from '../browser/probe.js';

export const INSPECTED_PAGES_PER_SESSION = 40;
export const INSPECT_BYTES_PER_SESSION = 32 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

export interface InspectBudget {
  usedBytes: number;
  /** Unique page-image shas already charged — re-inspecting an identical page is free. */
  pageShas: Set<string>;
}

/** Events-rebuilt budget (unique image shas; identical re-inspections must not double-count). */
export function inspectBudgetFromEvents(events: readonly SessionEvent[]): InspectBudget {
  const pageShas = new Set<string>();
  let usedBytes = 0;
  for (const e of events) {
    if (e.type !== 'artifact.inspected') continue;
    for (const pg of e.pages) {
      if (!pageShas.has(pg.imageSha256)) {
        pageShas.add(pg.imageSha256);
        usedBytes += pg.bytes;
      }
    }
  }
  return { usedBytes, pageShas };
}

const normalizeRel = (p: string): string => caseFold(p.split('\\').join('/').replace(/^\.\//, ''));
const relFromWorkspace = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

const InspectInput = z
  .object({
    path: z.string().describe('PDF path, workspace-relative — usually the artifact render_document produced'),
    pages: z
      .array(z.number().int().min(1).max(2_000))
      .min(1)
      .max(4)
      .optional()
      .describe('1-based page numbers to view (default [1, 2]; at most 4 per call — call again for more)'),
  })
  .strict();
type InspectInputT = z.infer<typeof InspectInput>;

export interface InspectPagesDeps {
  probe: () => Promise<BrowserAvailability>;
  putBlob: (bytes: Buffer) => string;
  events: () => readonly SessionEvent[];
  budget: InspectBudget;
  modelInfo?: () => { model: string; visionInput: boolean };
  /** Injectable for tests; defaults to the real browser rasterizer. */
  rasterize?: Rasterize;
}

export function createInspectPagesTool(deps: InspectPagesDeps): Tool<InspectInputT> {
  /** The newest render this session recorded for a path (identity + provenance), if any. */
  const latestRender = (rel: string): { sha256: string; embeddedWorkspaceImages: boolean } | null => {
    try {
      const want = normalizeRel(rel);
      let found: { sha256: string; embeddedWorkspaceImages: boolean } | null = null;
      for (const e of deps.events()) {
        if (e.type === 'artifact.rendered' && normalizeRel(e.path) === want) {
          found = { sha256: e.sha256, embeddedWorkspaceImages: e.embeddedWorkspaceImages === true };
        }
      }
      return found;
    } catch {
      return null;
    }
  };

  /**
   * Inherited consent needs a recorded render for this path whose spec embedded NO workspace
   * images. The image clause is the anti-laundering rule: a spec may name any in-workspace
   * non-secret PNG/JPEG, the render auto-allows, and rasterizing the result would then show the
   * model pixels of arbitrary workspace bytes — exactly what the inspect ask exists to gate
   * (S17 review). PURE by contract (events only); execute re-verifies content identity.
   */
  const inheritsConsent = (relPath: string): boolean => {
    const render = latestRender(relPath);
    return render !== null && !render.embeddedWorkspaceImages;
  };
  /** True when this session rendered the path but its spec embedded workspace images. */
  const renderedWithEmbeddedImages = (relPath: string): boolean => latestRender(relPath)?.embeddedWorkspaceImages === true;

  return {
    name: 'inspect_pages',
    description:
      'SEE the pages of a PDF: renders up to 4 pages as images and shows them to you, storing each as session ' +
      'evidence (objects/<sha>). Use it after render_document to judge layout — clipping, overflow, broken tables, ' +
      'awkward page breaks, whitespace, balance — then revise the SPEC and re-render. Page images age out of the ' +
      'conversation after a couple of steps; re-inspect (or view_image an objects/<sha>) to look again. Visual ' +
      'judgment never overrides a failed deterministic validation.',
    schema: InspectInput,
    mutates: () => ({ paths: [] }),
    artifact: (i) => ({
      kind: 'inspect',
      path: i.path,
      sessionRendered: inheritsConsent(i.path),
      ...(renderedWithEmbeddedImages(i.path) ? { renderedWithEmbeddedImages: true } : {}),
    }),
    async execute(input, ctx) {
      const started = Date.now();
      const fail = (error: string): ToolResult => ({ ok: false, output: '', error, truncated: false, durationMs: Date.now() - started });

      const info = deps.modelInfo?.();
      if (info !== undefined && !info.visionInput) {
        return fail(
          `model '${info.model}' has no image input, so page inspection would render pixels nobody can see. ` +
            'Deterministic validation (render_document) is unaffected and remains the structural evidence; switch to a ' +
            'vision-capable model (/model) to inspect visually.',
        );
      }

      const abs = resolveForTool(ctx, input.path);
      let bytes: Buffer;
      try {
        const stat = fs.statSync(abs);
        if (stat.size > MAX_DOCUMENT_BYTES) return fail(`document too large to rasterize (${stat.size} bytes)`);
        bytes = fs.readFileSync(abs);
      } catch {
        return fail(`file not found: ${input.path}`);
      }
      const id = identifyDocument(new Uint8Array(bytes));
      if (id.format === 'docx') {
        return fail(
          'inspect_pages rasterizes PDFs. DOCX visual truth belongs to Word; the PDF twin render_document produces ' +
            'from the same spec is the inspectable artifact — render with formats including "pdf" and inspect that.',
        );
      }
      if (id.format !== 'pdf') {
        return fail(`not a PDF (detected: ${id.format === 'unsupported' ? id.reason : id.format})`);
      }

      // Execute-time identity re-check for the auto-allowed admission (the decision inherited
      // the RENDER's consent; a swapped file must not ride the path claim). The named cures are
      // calls the harness actually allows — a refusal that prescribes an unobtainable approval
      // is a dead end (the S16.5 refusable-cure lesson).
      const docSha = sha256(bytes);
      const recorded = latestRender(input.path);
      if (recorded !== null && recorded.sha256 !== docSha) {
        return fail(
          `${input.path} has CHANGED since this session rendered it (sha ${docSha.slice(0, 12)}… ≠ recorded ${recorded.sha256.slice(0, 12)}…). ` +
            'The consent this call inherited belongs to the bytes THIS session produced. Re-render it from its spec (render_document) ' +
            'and inspect again, or copy the current file to a different name and inspect that — a path this session did not render ' +
            'asks for its own approval.',
        );
      }

      const pages = [...new Set(input.pages ?? [1, 2])].sort((a, b) => a - b);
      if (deps.budget.pageShas.size >= INSPECTED_PAGES_PER_SESSION) {
        return fail(`the session page-inspection budget (${INSPECTED_PAGES_PER_SESSION} unique page images) is spent`);
      }

      const rasterize = deps.rasterize ?? rasterizePdfPages;
      const result = await rasterize(new Uint8Array(bytes), pages, deps.probe);
      if (!result.ok) return fail(result.reason);

      const stored: { page: number; sha: string; bytes: number }[] = [];
      const omitted: string[] = [];
      for (const pg of result.pages) {
        const sha = sha256(pg.png);
        const isNew = !deps.budget.pageShas.has(sha);
        if (isNew && (deps.budget.pageShas.size >= INSPECTED_PAGES_PER_SESSION || deps.budget.usedBytes + pg.png.length > INSPECT_BYTES_PER_SESSION)) {
          omitted.push(`page ${pg.page} omitted: session page-image budget exhausted`);
          continue;
        }
        const storedSha = deps.putBlob(pg.png);
        if (isNew) {
          deps.budget.pageShas.add(storedSha);
          deps.budget.usedBytes += pg.png.length;
        }
        stored.push({ page: pg.page, sha: storedSha, bytes: pg.png.length });
      }

      const warnings = [...result.warnings, ...omitted];
      if (stored.length === 0) {
        // No event: an `artifact.inspected` with zero pages claims an inspection that produced
        // nothing, and the report/chrome would render an empty "page(s)" list under it.
        return fail(`no pages could be shown: ${warnings.join('; ') || 'nothing rendered'}`);
      }
      ctx.reportArtifact?.({
        kind: 'inspected',
        // Workspace-relative POSIX, exactly like the render side — an absolute or `./`-prefixed
        // model string would record a different identity for the same artifact and stop
        // correlating with its render event.
        path: relFromWorkspace(ctx.workspaceRoot, abs),
        sha256: docSha,
        source: 'pdf',
        pages: stored.map((s) => ({ page: s.page, imageSha256: s.sha, bytes: s.bytes, mediaType: 'image/png' })),
        warnings,
      });
      const lines = [
        `${input.path} (${result.pageCount} page(s), sha256 ${docSha.slice(0, 12)}…) — showing page(s) ${stored.map((s) => s.page).join(', ')}:`,
        ...stored.map((s) => `  page ${s.page}: objects/${s.sha} (${Math.round(s.bytes / 1024)} KiB)`),
        ...(warnings.length > 0 ? ['', ...warnings.map((w) => `warning: ${w}`)] : []),
        '',
        'Judge layout, breaks, balance, and readability; the deterministic validation verdict remains the structural evidence.',
      ];
      return {
        ok: true,
        output: lines.join('\n'),
        truncated: false,
        durationMs: Date.now() - started,
        images: stored.map((s) => {
          const png = result.pages.find((p) => p.page === s.page)!.png;
          return { mediaType: 'image/png', dataBase64: png.toString('base64'), sha256: s.sha, label: `page ${s.page} of ${input.path}` };
        }),
      };
    },
  };
}
