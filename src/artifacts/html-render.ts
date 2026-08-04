/**
 * DocSpec → ONE self-contained HTML string for Chromium PDF printing. Self-contained is a
 * CONTRACT, not a habit: no <script>, no <link>, no external src — images are data: URIs —
 * so the offline+route-abort browser context has nothing to fetch (test-asserted). Header and
 * footer come back as Playwright displayHeaderFooter TEMPLATES (the path the step-0 probe
 * proved end to end, page numbers extracted from the printed PDF), not @page margin boxes.
 *
 * Every interpolated value routes through the HTML escapers; header/footer strings are
 * model-authored text and the templates are separate documents, so they get the same
 * discipline.
 */

import type { DocBlock, DocRun, DocSpec } from './model.js';
import { headingSizePt, resolvePage, resolveTheme, type ResolvedTheme } from './model.js';
import { imageInfo } from './img-dim.js';
import { ArtifactError } from './errors.js';

const eh = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** CSS string literal (single-quoted) for font names etc. */
const cssStr = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\n\r]/g, ' ')}'`;

export interface RenderedHtml {
  html: string;
  /** Playwright pdf() header/footer templates; undefined when the spec declares none. */
  headerTemplate?: string;
  footerTemplate?: string;
}

function renderRun(run: DocRun): string {
  let inner = eh(run.text).replace(/\n/g, '<br>').replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
  if (run.code === true) inner = `<code>${inner}</code>`;
  if (run.bold === true) inner = `<strong>${inner}</strong>`;
  if (run.italic === true) inner = `<em>${inner}</em>`;
  if (run.underline === true) inner = `<u>${inner}</u>`;
  const style = run.color !== undefined ? ` style="color:${eh(run.color)}"` : '';
  if (run.link !== undefined) return `<a href="${eh(run.link)}"${style}>${inner}</a>`;
  return style !== '' ? `<span${style}>${inner}</span>` : inner;
}

const runs = (rs: readonly DocRun[]): string => rs.map(renderRun).join('');

/** Flat list items with levels → properly nested markup. */
function renderList(block: Extract<DocBlock, { kind: 'list' }>): string {
  const tag = block.ordered === true ? 'ol' : 'ul';
  let html = `<${tag}>`;
  let depth = 0;
  for (const item of block.items) {
    const level = item.level ?? 0;
    while (depth < level) {
      html += `<${tag}>`;
      depth += 1;
    }
    while (depth > level) {
      html += `</${tag}>`;
      depth -= 1;
    }
    html += `<li>${runs(item.runs)}</li>`;
  }
  while (depth > 0) {
    html += `</${tag}>`;
    depth -= 1;
  }
  return `${html}</${tag}>`;
}

function renderTable(block: Extract<DocBlock, { kind: 'table' }>): string {
  const cols = block.rows[0]!.length;
  const pcts = block.columnsPct ?? Array.from({ length: cols }, () => 100 / cols);
  const colgroup = `<colgroup>${pcts.map((p) => `<col style="width:${p.toFixed(2)}%">`).join('')}</colgroup>`;
  const headerRow = block.headerRow !== false;
  const head = headerRow ? `<thead><tr>${block.rows[0]!.map((c) => `<th>${runs(c)}</th>`).join('')}</tr></thead>` : '';
  const bodyRows = (headerRow ? block.rows.slice(1) : block.rows)
    .map((row) => `<tr>${row.map((c) => `<td>${runs(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table>${colgroup}${head}<tbody>${bodyRows}</tbody></table>`;
}

function renderImage(block: Extract<DocBlock, { kind: 'image' }>, imageBytes: ReadonlyMap<string, Uint8Array>, contentWidthMm: number): string {
  const bytes = imageBytes.get(block.path);
  if (bytes === undefined) throw new ArtifactError(`image bytes missing for "${block.path}"`, 'render-input');
  const info = imageInfo(bytes);
  if (info === null) throw new ArtifactError(`"${block.path}" is not a readable PNG or JPEG`, 'render-input');
  const widthMm = Math.min(block.widthMm ?? (info.width / 96) * 25.4, contentWidthMm);
  const dataUri = `data:${info.contentType};base64,${Buffer.from(bytes).toString('base64')}`;
  const align = block.align ?? 'center';
  const img = `<img src="${dataUri}" style="width:${widthMm.toFixed(1)}mm" alt="${eh(block.caption ?? block.path)}">`;
  const caption = block.caption !== undefined ? `<figcaption>${eh(block.caption)}</figcaption>` : '';
  return `<figure style="text-align:${align}">${img}${caption}</figure>`;
}

/** Header/footer template: tokens → Chromium's magic classes; everything else escaped text. */
function hfTemplate(hf: { left?: string | undefined; center?: string | undefined; right?: string | undefined }, title: string, theme: ResolvedTheme, page: { marginLeftMm: number; marginRightMm: number }): string {
  const seg = (s: string | undefined): string => {
    if (s === undefined) return '';
    return s.replace(/\{(pageNumber|totalPages|date|title)\}|[^{]+|\{/g, (m) => {
      if (m === '{pageNumber}') return '<span class="pageNumber"></span>';
      if (m === '{totalPages}') return '<span class="totalPages"></span>';
      if (m === '{date}') return '<span class="date"></span>';
      if (m === '{title}') return eh(title);
      return eh(m);
    });
  };
  // Chromium defaults header/footer font-size to 0 — the explicit size is load-bearing.
  return (
    `<div style="width:100%;font-size:${(theme.baseSizePt - 2).toFixed(1)}pt;font-family:${eh(theme.bodyFont)};color:#595959;` +
    `display:flex;justify-content:space-between;margin:0 ${page.marginRightMm}mm 0 ${page.marginLeftMm}mm;">` +
    `<span>${seg(hf.left)}</span><span>${seg(hf.center)}</span><span>${seg(hf.right)}</span></div>`
  );
}

export function renderHtml(spec: DocSpec, imageBytes: ReadonlyMap<string, Uint8Array>): RenderedHtml {
  const theme = resolveTheme(spec);
  const page = resolvePage(spec);
  const contentWidthMm = page.widthMm - page.margins.leftMm - page.margins.rightMm;

  const css = `
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ${cssStr(theme.bodyFont)}, 'Segoe UI', sans-serif; font-size: ${theme.baseSizePt}pt;
           line-height: ${theme.lineSpacing.toFixed(2)}; color: #222222; }
    h1, h2, h3, h4 { font-family: ${cssStr(theme.headingFont)}, ${cssStr(theme.bodyFont)}, sans-serif;
                     color: ${theme.accentColor}; break-after: avoid; break-inside: avoid;
                     margin: 1.1em 0 0.4em 0; }
    h1 { font-size: ${headingSizePt(theme, 1)}pt; } h2 { font-size: ${headingSizePt(theme, 2)}pt; }
    h3 { font-size: ${headingSizePt(theme, 3)}pt; } h4 { font-size: ${headingSizePt(theme, 4)}pt; }
    p { margin: 0 0 ${theme.paragraphSpacingPt}pt 0; }
    table { width: 100%; border-collapse: collapse; margin: 0 0 ${theme.paragraphSpacingPt}pt 0; }
    tr { break-inside: avoid; }
    thead { display: table-header-group; }
    th, td { border: 0.5pt solid #BFBFBF; padding: 3pt 6pt; text-align: left; vertical-align: top; }
    thead th { background: ${theme.accentColor}; color: #FFFFFF; }
    code { font-family: ${cssStr(theme.monoFont)}, monospace; background: #F2F2F2; padding: 0 2pt; }
    pre { font-family: ${cssStr(theme.monoFont)}, monospace; font-size: ${theme.baseSizePt - 1}pt;
          background: #F5F5F5; padding: 6pt 8pt; white-space: pre-wrap; margin: 0 0 ${theme.paragraphSpacingPt}pt 0; }
    pre code { background: none; padding: 0; }
    blockquote { margin: 0 0 ${theme.paragraphSpacingPt}pt 0; padding-left: 10pt; border-left: 2pt solid #BFBFBF;
                 color: #595959; font-style: italic; }
    ul, ol { margin: 0 0 ${theme.paragraphSpacingPt}pt 0; padding-left: 18pt; }
    figure { margin: 0 0 ${theme.paragraphSpacingPt}pt 0; break-inside: avoid; }
    img { max-width: 100%; }
    figcaption { font-style: italic; font-size: ${theme.baseSizePt - 2}pt; color: #595959; text-align: center; margin-top: 2pt; }
    a { color: #0563C1; }
    .pagebreak { break-after: page; height: 0; }
  `;

  const body = spec.blocks
    .map((block) => {
      if (block.kind === 'heading') return `<h${block.level}>${runs(block.runs)}</h${block.level}>`;
      if (block.kind === 'paragraph') {
        const align = block.align !== undefined ? ` style="text-align:${block.align}"` : '';
        return `<p${align}>${runs(block.runs)}</p>`;
      }
      if (block.kind === 'quote') return `<blockquote>${runs(block.runs)}</blockquote>`;
      if (block.kind === 'code') return `<pre><code>${eh(block.text)}</code></pre>`;
      if (block.kind === 'list') return renderList(block);
      if (block.kind === 'table') return renderTable(block);
      if (block.kind === 'image') return renderImage(block, imageBytes, contentWidthMm);
      return '<div class="pagebreak"></div>';
    })
    .join('\n');

  const lang = spec.meta.language ?? 'en';
  const html =
    `<!doctype html><html lang="${eh(lang)}"><head><meta charset="utf-8">` +
    `<title>${eh(spec.meta.title)}</title><style>${css}</style></head><body>${body}</body></html>`;

  const margins = { marginLeftMm: page.margins.leftMm, marginRightMm: page.margins.rightMm };
  return {
    html,
    ...(spec.header !== undefined ? { headerTemplate: hfTemplate(spec.header, spec.meta.title, theme, margins) } : {}),
    ...(spec.footer !== undefined ? { footerTemplate: hfTemplate(spec.footer, spec.meta.title, theme, margins) } : {}),
  };
}
