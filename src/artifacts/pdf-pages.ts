/**
 * PDF pages → PNG buffers, by injecting unpdf's bundled pdf.js build into a blank page of the
 * probed SYSTEM browser (step-0 proven; native-free by construction — the same library that
 * reads PDFs in Node renders them where a real DOM exists). The context is offline with
 * http(s) route-abort; the library code and the PDF bytes travel in via evaluate, nothing is
 * fetched. `isEvalSupported: false` keeps the PostScript eval path off for untrusted bytes.
 *
 * Every image respects a PER-IMAGE byte ceiling: an oversize page re-renders at a reduced
 * scale until it fits (wire-image budgets are real — a 4 MB page PNG would ride every request
 * for two assistant steps).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { BrowserAvailability } from '../browser/probe.js';

// The evaluate() callback below executes INSIDE the browser page; this project compiles
// against Node libs only, so declare the one DOM global the callback touches.
declare const document: {
  createElement(tag: 'canvas'): {
    width: number;
    height: number;
    getContext(kind: '2d'): unknown;
    toDataURL(type: string): string;
  };
};

const LAUNCH_TIMEOUT_MS = 30_000;
const RASTER_WALL_MS = 60_000;
export const DEFAULT_RASTER_SCALE = 2;
export const MAX_IMAGE_BYTES = 1_000_000;

let cachedPdfjsCode: string | null = null;

/** unpdf's bundled build, read once from node_modules (never executed in Node here). */
function pdfjsCode(): string {
  if (cachedPdfjsCode === null) {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('unpdf');
    cachedPdfjsCode = fs.readFileSync(path.join(path.dirname(entry), 'pdfjs.mjs'), 'utf8');
  }
  return cachedPdfjsCode;
}

export interface RasterizedPage {
  page: number;
  png: Buffer;
  /** The scale this page actually rendered at (reduced when the ceiling forced it). */
  scale: number;
}

export type RasterizeResult =
  | { ok: true; pages: RasterizedPage[]; pageCount: number; warnings: string[] }
  | { ok: false; reason: string };

export type Rasterize = (bytes: Uint8Array, pages: readonly number[], probe: () => Promise<BrowserAvailability>) => Promise<RasterizeResult>;

export const rasterizePdfPages: Rasterize = async (bytes, pages, probe) => {
  const availability = await probe();
  if (!availability.available) {
    return { ok: false, reason: `no system browser is available for page rendering (${availability.reason ?? 'probe failed'})` };
  }
  const { chromium } = await import('playwright-core');
  let browser;
  try {
    browser = await chromium.launch({
      ...(availability.channel !== undefined && availability.channel !== 'chromium-cache' ? { channel: availability.channel } : {}),
      headless: true,
      timeout: LAUNCH_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, reason: `browser launch failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  }
  try {
    const context = await browser.newContext({ offline: true, viewport: { width: 100, height: 100 } });
    const page = await context.newPage();
    await page.route(/^https?:/, (route) => route.abort());
    await page.setContent('<!doctype html><html><body></body></html>');
    page.setDefaultTimeout(RASTER_WALL_MS);

    const result = (await page.evaluate(
      async (args: { code: string; pdfBase64: string; pages: number[]; scale: number; maxBytes: number }) => {
        const out: { pages: { page: number; dataUrl: string; scale: number }[]; pageCount: number; warnings: string[]; error?: string } = {
          pages: [],
          pageCount: 0,
          warnings: [],
        };
        try {
          const blobUrl = URL.createObjectURL(new Blob([args.code], { type: 'text/javascript' }));
          // Indirected dynamic import: this callback's SOURCE is serialized into the page, and
          // bundler transforms (vitest's vite SSR pass) rewrite a literal `import()` into a
          // helper that does not exist there. A Function-constructed import is left alone.
          const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<unknown>;
          const pdfjs = (await dynImport(blobUrl)) as {
            getDocument: (o: object) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<unknown> }>; destroy: () => Promise<void> };
          };
          const bin = Uint8Array.from(atob(args.pdfBase64), (c) => c.charCodeAt(0));
          const task = pdfjs.getDocument({ data: bin, isEvalSupported: false, useWorkerFetch: false });
          const doc = await task.promise;
          out.pageCount = doc.numPages;
          for (const pageNo of args.pages) {
            if (pageNo < 1 || pageNo > doc.numPages) {
              out.warnings.push(`page ${pageNo} does not exist (document has ${doc.numPages})`);
              continue;
            }
            const p = (await doc.getPage(pageNo)) as {
              getViewport: (o: { scale: number }) => { width: number; height: number };
              render: (o: { canvasContext: unknown; viewport: unknown }) => { promise: Promise<void> };
            };
            let scale = args.scale;
            let dataUrl = '';
            let bytesApprox = 0;
            let renderedScale = scale;
            for (let attempt = 0; attempt < 3; attempt++) {
              const viewport = p.getViewport({ scale });
              const canvas = document.createElement('canvas');
              canvas.width = Math.ceil(viewport.width);
              canvas.height = Math.ceil(viewport.height);
              await p.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
              dataUrl = canvas.toDataURL('image/png');
              renderedScale = scale;
              bytesApprox = Math.floor((dataUrl.length - 22) * 0.75);
              if (bytesApprox <= args.maxBytes || scale <= 0.75) break;
              // Compute the NEXT scale, then say what happened only once it has been rendered —
              // recording a scale that was never rendered (and a re-render that never occurred)
              // put a false number into the inspection evidence.
              scale = Math.max(0.75, scale * Math.sqrt((args.maxBytes / bytesApprox) * 0.9));
              out.warnings.push(`page ${pageNo} re-rendering at scale ${scale.toFixed(2)} to fit the per-image byte ceiling`);
            }
            if (bytesApprox > args.maxBytes) {
              // The ceiling is ENFORCED, not advisory: a page that will not fit even at the
              // scale floor is dropped with its size, rather than riding every request.
              out.warnings.push(
                `page ${pageNo} omitted: ${bytesApprox} bytes still exceeds the ${args.maxBytes}-byte per-image ceiling at the minimum scale`,
              );
              continue;
            }
            out.pages.push({ page: pageNo, dataUrl, scale: renderedScale });
          }
          await task.destroy().catch(() => undefined);
        } catch (err) {
          const e = err as Error;
          out.error = `${e?.constructor?.name ?? 'Error'}: ${String(e?.message ?? err).slice(0, 300)}`;
        }
        return out;
      },
      { code: pdfjsCode(), pdfBase64: Buffer.from(bytes).toString('base64'), pages: [...pages], scale: DEFAULT_RASTER_SCALE, maxBytes: MAX_IMAGE_BYTES },
    )) as { pages: { page: number; dataUrl: string; scale: number }[]; pageCount: number; warnings: string[]; error?: string };

    if (result.error !== undefined) {
      return { ok: false, reason: `page rendering failed in the browser: ${result.error}` };
    }
    return {
      ok: true,
      pageCount: result.pageCount,
      warnings: result.warnings,
      pages: result.pages.map((p) => ({ page: p.page, scale: p.scale, png: Buffer.from(p.dataUrl.split(',')[1] ?? '', 'base64') })),
    };
  } catch (err) {
    return { ok: false, reason: `page rendering failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  } finally {
    await browser.close().catch(() => undefined);
  }
};
