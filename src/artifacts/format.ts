/**
 * ArtifactSummary → the text a model reads. Coverage is the FIRST line after the header —
 * "what depth of read this was" is the fact every later claim rests on. Pure formatting;
 * bounds already applied by the readers.
 */

import type { ArtifactSummary, ArtifactMetadata } from './types.js';

export type ReadDetail = 'summary' | 'structure' | 'text';

const SUMMARY_TEXT_CAP = 2_500;

function metaLines(m: ArtifactMetadata): string[] {
  const out: string[] = [];
  if (m.title !== undefined) out.push(`title: ${m.title}`);
  if (m.author !== undefined) out.push(`author: ${m.author}`);
  if (m.subject !== undefined) out.push(`subject: ${m.subject}`);
  if (m.keywords !== undefined) out.push(`keywords: ${m.keywords}`);
  if (m.created !== undefined) out.push(`created: ${m.created}`);
  if (m.modified !== undefined) out.push(`modified: ${m.modified}`);
  if (m.application !== undefined) out.push(`application: ${m.application}`);
  return out;
}

export function formatSummary(s: ArtifactSummary, detail: ReadDetail): string {
  const lines: string[] = [];
  lines.push(`format: ${s.kind}`);
  lines.push(`coverage: ${s.coverage}${s.coverageReasons.length > 0 ? ` — ${s.coverageReasons.join('; ')}` : ''}`);
  const meta = metaLines(s.metadata);
  if (meta.length > 0) {
    lines.push('', '## Metadata', ...meta);
  }

  if (s.kind === 'docx') {
    lines.push('', '## Structure');
    lines.push(`paragraphs: ${s.paragraphCount}; tables: ${s.tables.length}; headers: ${s.headerCount}; footers: ${s.footerCount}; media: ${s.media.length}`);
    if (s.outline.length > 0) {
      lines.push('', '## Outline');
      for (const h of s.outline) lines.push(`${'  '.repeat(Math.max(0, h.level - 1))}H${h.level} ${h.text}`);
    }
    if (s.tables.length > 0) {
      lines.push('', '## Tables');
      for (const [i, t] of s.tables.entries()) {
        lines.push(`table ${i + 1}: ${t.rows}×${t.cols}${t.headerCells.length > 0 ? ` | header: ${t.headerCells.join(' · ')}` : ''}`);
        if (detail !== 'structure') for (const row of t.sampleRows) lines.push(`  ${row.join(' · ')}`);
      }
    }
    if (detail !== 'structure' && s.text.length > 0) {
      lines.push('', '## Text');
      lines.push(detail === 'text' ? s.text : s.text.slice(0, SUMMARY_TEXT_CAP) + (s.text.length > SUMMARY_TEXT_CAP ? '\n… (use detail: "text" for the rest)' : ''));
    }
  } else if (s.kind === 'pptx') {
    lines.push('', `## Slides (${s.slideCount})`);
    for (const slide of s.slides) {
      lines.push(`slide ${slide.index}: ${slide.title ?? '(no title)'}${slide.notes !== undefined ? ' [has notes]' : ''}`);
      if (detail === 'text') {
        if (slide.text.length > 0) lines.push(...slide.text.split('\n').map((l) => `  ${l}`));
        if (slide.notes !== undefined) lines.push(`  notes: ${slide.notes}`);
      }
    }
    if (s.media.length > 0) lines.push('', `media: ${s.media.length} file(s)`);
  } else if (s.kind === 'pdf') {
    lines.push('', `## Pages (${s.pageCount})`);
    if (detail === 'structure') {
      for (const p of s.pages) lines.push(`page ${p.page}: ${p.text.length} chars`);
    } else if (detail === 'text') {
      for (const p of s.pages) {
        lines.push('', `### Page ${p.page}`, p.text);
      }
    } else {
      const first = s.pages[0];
      if (first !== undefined) {
        lines.push('', '### Page 1 (excerpt)');
        lines.push(first.text.slice(0, SUMMARY_TEXT_CAP) + (first.text.length > SUMMARY_TEXT_CAP ? '…' : ''));
        if (s.pages.length > 1) lines.push('', `(${s.pages.length - 1} more extracted page(s) — use detail: "text")`);
      }
    }
  } else {
    lines.push('', `## Sheets (${s.sheetNames.length})`);
    for (const name of s.sheetNames) lines.push(`- ${name}`);
  }

  if (s.media.length > 0 && s.kind !== 'pptx') {
    lines.push('', '## Media', ...s.media.map((m) => `${m.name} (${m.bytes} bytes)`));
  }
  if (s.warnings.length > 0) {
    lines.push('', '## Warnings', ...s.warnings.map((w) => `- ${w}`));
  }
  return lines.join('\n');
}
