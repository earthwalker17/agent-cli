/**
 * The DocSpec — the structured document model the model AUTHORS (as an ordinary workspace
 * JSON file) and the renderers consume deterministically. One schema is the single source of
 * validation; an invalid spec returns the COMPLETE error list verbatim and nothing renders
 * (the update_plan revision-loop pattern).
 *
 * Bounded on purpose: the caps are what make "render whatever the spec says" a consentable
 * sentence. Image paths are SPEC-FILE-RELATIVE and re-validated at execute against workspace
 * containment and secret-name rules — the schema cannot see the filesystem and does not try.
 */

import { z } from 'zod';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const RunSchema = z
  .object({
    text: z.string().max(4_000),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    /** Inline code: monospace + light shading in both renderers. */
    code: z.boolean().optional(),
    color: z.string().regex(HEX_COLOR, 'color must be #RRGGBB').optional(),
    /** External link target; http(s) only. */
    link: z.string().max(2_000).regex(/^https?:\/\//, 'links must be http(s) URLs').optional(),
  })
  .strict();
export type DocRun = z.infer<typeof RunSchema>;

const RUNS = z.array(RunSchema).min(1).max(60);

const HeadingBlock = z.object({ kind: z.literal('heading'), level: z.number().int().min(1).max(4), runs: RUNS }).strict();
const ParagraphBlock = z
  .object({
    kind: z.literal('paragraph'),
    runs: RUNS,
    align: z.enum(['left', 'center', 'right', 'justify']).optional(),
  })
  .strict();
const ListBlock = z
  .object({
    kind: z.literal('list'),
    ordered: z.boolean().optional(),
    items: z.array(z.object({ runs: RUNS, level: z.number().int().min(0).max(2).optional() }).strict()).min(1).max(100),
  })
  .strict();
const TableBlock = z
  .object({
    kind: z.literal('table'),
    /** Relative column widths; omitted = equal. Length must match every row's cell count. */
    columnsPct: z.array(z.number().min(2).max(98)).min(1).max(10).optional(),
    /** First row renders as the header (shaded, bold) unless headerRow is false. */
    headerRow: z.boolean().optional(),
    rows: z.array(z.array(RUNS).min(1).max(10)).min(1).max(200),
  })
  .strict()
  .superRefine((t, ctx) => {
    const width = t.rows[0]!.length;
    if (t.rows.some((r) => r.length !== width)) {
      ctx.addIssue({ code: 'custom', message: 'every table row must have the same number of cells (no spans/merges in v1)' });
    }
    if (t.columnsPct !== undefined && t.columnsPct.length !== width) {
      ctx.addIssue({ code: 'custom', message: `columnsPct has ${t.columnsPct.length} entries but rows have ${width} cells` });
    }
    if (width * t.rows.length > 2_000) {
      ctx.addIssue({ code: 'custom', message: 'table exceeds 2000 cells' });
    }
  });
const ImageBlock = z
  .object({
    kind: z.literal('image'),
    /** Path relative to the SPEC FILE (never absolute, never a URL). PNG or JPEG. */
    path: z
      .string()
      .max(500)
      .refine((p) => !/^([a-zA-Z]:|[\\/])/.test(p) && !/^[a-z]+:\/\//i.test(p), 'image paths are spec-file-relative (no absolute paths or URLs)'),
    widthMm: z.number().min(10).max(170).optional(),
    caption: z.string().max(300).optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
  })
  .strict();
const CodeBlock = z
  .object({ kind: z.literal('code'), text: z.string().max(20_000), language: z.string().max(40).optional() })
  .strict();
const QuoteBlock = z.object({ kind: z.literal('quote'), runs: RUNS }).strict();
const PageBreakBlock = z.object({ kind: z.literal('pageBreak') }).strict();

const BlockSchema = z.discriminatedUnion('kind', [
  HeadingBlock,
  ParagraphBlock,
  ListBlock,
  TableBlock,
  ImageBlock,
  CodeBlock,
  QuoteBlock,
  PageBreakBlock,
]);
export type DocBlock = z.infer<typeof BlockSchema>;

/** Header/footer text; `{pageNumber}` `{totalPages}` `{date}` render as REAL field codes, `{title}` interpolates meta.title. */
const HeaderFooterSchema = z
  .object({
    left: z.string().max(200).optional(),
    center: z.string().max(200).optional(),
    right: z.string().max(200).optional(),
  })
  .strict();

const MarginsSchema = z
  .object({
    topMm: z.number().min(5).max(50),
    rightMm: z.number().min(5).max(50),
    bottomMm: z.number().min(5).max(50),
    leftMm: z.number().min(5).max(50),
  })
  .strict();

export const DocSpecSchema = z
  .object({
    version: z.literal(1),
    meta: z
      .object({
        title: z.string().min(1).max(300),
        author: z.string().max(200).optional(),
        subject: z.string().max(300).optional(),
        keywords: z.string().max(300).optional(),
        /** BCP-47-ish tag stamped into both formats; content is not translated. */
        language: z.string().max(20).optional(),
      })
      .strict(),
    page: z
      .object({
        size: z.enum(['A4', 'Letter']).optional(),
        orientation: z.enum(['portrait', 'landscape']).optional(),
        margins: MarginsSchema.optional(),
      })
      .strict()
      .optional(),
    header: HeaderFooterSchema.optional(),
    footer: HeaderFooterSchema.optional(),
    styles: z
      .object({
        theme: z.enum(['default', 'compact', 'formal']).optional(),
        bodyFont: z.string().max(60).optional(),
        headingFont: z.string().max(60).optional(),
        baseSizePt: z.number().min(8).max(14).optional(),
        accentColor: z.string().regex(HEX_COLOR, 'accentColor must be #RRGGBB').optional(),
        lineSpacing: z.number().min(1).max(2).optional(),
      })
      .strict()
      .optional(),
    blocks: z.array(BlockSchema).min(1).max(500),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const images = spec.blocks.filter((b) => b.kind === 'image').length;
    if (images > 20) ctx.addIssue({ code: 'custom', message: `${images} images exceed the 20-image bound` });
  });

export type DocSpec = z.infer<typeof DocSpecSchema>;

export type ParsedSpec = { ok: true; spec: DocSpec } | { ok: false; errors: string[] };

/** Parse spec JSON text: json errors and the COMPLETE zod issue list come back verbatim. */
export function parseDocSpec(jsonText: string): ParsedSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, errors: [`spec is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const parsed = DocSpecSchema.safeParse(raw);
  if (parsed.success) return { ok: true, spec: parsed.data };
  const errors = parsed.error.issues.map((iss) => `${iss.path.length > 0 ? iss.path.join('.') : '(root)'}: ${iss.message}`);
  return { ok: false, errors };
}

// ── Resolved presentation values shared by BOTH renderers (one source of layout truth) ──────

export interface ResolvedTheme {
  bodyFont: string;
  headingFont: string;
  monoFont: string;
  baseSizePt: number;
  accentColor: string;
  lineSpacing: number;
  /** Paragraph spacing-after in points. */
  paragraphSpacingPt: number;
}

export interface ResolvedPage {
  widthMm: number;
  heightMm: number;
  margins: { topMm: number; rightMm: number; bottomMm: number; leftMm: number };
}

const PAGE_SIZES_MM = { A4: { w: 210, h: 297 }, Letter: { w: 215.9, h: 279.4 } } as const;

export function resolveTheme(spec: DocSpec): ResolvedTheme {
  const s = spec.styles ?? {};
  const theme = s.theme ?? 'default';
  const base: ResolvedTheme = {
    bodyFont: s.bodyFont ?? (theme === 'formal' ? 'Georgia' : 'Calibri'),
    headingFont: s.headingFont ?? (theme === 'formal' ? 'Georgia' : 'Calibri Light'),
    monoFont: 'Consolas',
    baseSizePt: s.baseSizePt ?? (theme === 'compact' ? 10 : 11),
    accentColor: s.accentColor ?? (theme === 'formal' ? '#1F3864' : '#2E5395'),
    lineSpacing: s.lineSpacing ?? (theme === 'compact' ? 1.08 : 1.15),
    paragraphSpacingPt: theme === 'compact' ? 4 : 8,
  };
  return base;
}

export function resolvePage(spec: DocSpec): ResolvedPage {
  const size = PAGE_SIZES_MM[spec.page?.size ?? 'A4'];
  const landscape = spec.page?.orientation === 'landscape';
  const m = spec.page?.margins ?? { topMm: 20, rightMm: 20, bottomMm: 20, leftMm: 20 };
  return {
    widthMm: landscape ? size.h : size.w,
    heightMm: landscape ? size.w : size.h,
    margins: m,
  };
}

/** Heading sizes in points per level, derived from the base size. */
export function headingSizePt(theme: ResolvedTheme, level: number): number {
  const scale = [1.9, 1.45, 1.2, 1.05][level - 1] ?? 1;
  return Math.round(theme.baseSizePt * scale * 2) / 2;
}
