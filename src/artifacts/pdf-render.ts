/**
 * HTML → PDF through the probed SYSTEM browser (the flow.ts launch pattern: dynamic
 * playwright-core import, channel from the shared session-cached probe, headless — which is
 * also Chromium's precondition for pdf()). The page loads ONLY harness-generated content:
 * `setContent` on an OFFLINE context with http(s) route-abort as the second belt. No browser
 * ⇒ an honest typed refusal the caller records; never a silent skip.
 */

import type { BrowserAvailability } from '../browser/probe.js';
import type { DocSpec } from './model.js';
import { resolvePage } from './model.js';
import type { RenderedHtml } from './html-render.js';

const LAUNCH_TIMEOUT_MS = 30_000;
const PRINT_WALL_MS = 45_000;

export type PdfRenderResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: string; kind: 'no-browser' | 'render-failed' };

export async function renderPdf(
  spec: DocSpec,
  rendered: RenderedHtml,
  probe: () => Promise<BrowserAvailability>,
): Promise<PdfRenderResult> {
  const availability = await probe();
  if (!availability.available) {
    return {
      ok: false,
      kind: 'no-browser',
      reason: `no system browser is available for PDF printing (${availability.reason ?? 'probe failed'}); the DOCX path does not need one`,
    };
  }

  const page = resolvePage(spec);
  const { chromium } = await import('playwright-core');
  let browser;
  try {
    browser = await chromium.launch({
      ...(availability.channel !== undefined && availability.channel !== 'chromium-cache' ? { channel: availability.channel } : {}),
      headless: true,
      timeout: LAUNCH_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, kind: 'render-failed', reason: `browser launch failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  }
  try {
    const context = await browser.newContext({ offline: true });
    const p = await context.newPage();
    await p.route(/^https?:/, (route) => route.abort());
    await p.setContent(rendered.html, { waitUntil: 'load', timeout: PRINT_WALL_MS });
    const displayHeaderFooter = rendered.headerTemplate !== undefined || rendered.footerTemplate !== undefined;
    const bytes = await p.pdf({
      printBackground: true,
      format: spec.page?.size ?? 'A4',
      landscape: spec.page?.orientation === 'landscape',
      margin: {
        top: `${page.margins.topMm}mm`,
        right: `${page.margins.rightMm}mm`,
        bottom: `${page.margins.bottomMm}mm`,
        left: `${page.margins.leftMm}mm`,
      },
      displayHeaderFooter,
      // Chromium requires BOTH templates when displayHeaderFooter is on; an absent side is an
      // empty (but styled) div, or it prints its own default date/url chrome.
      ...(displayHeaderFooter
        ? {
            headerTemplate: rendered.headerTemplate ?? '<div style="font-size:1px;"></div>',
            footerTemplate: rendered.footerTemplate ?? '<div style="font-size:1px;"></div>',
          }
        : {}),
    });
    return { ok: true, bytes: Buffer.from(bytes) };
  } catch (err) {
    return { ok: false, kind: 'render-failed', reason: `PDF print failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
