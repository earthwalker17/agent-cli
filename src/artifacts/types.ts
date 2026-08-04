/**
 * Shared contracts of the documents workflow pack (Session 17). Readers produce ONE summary
 * shape per format; every summary carries an explicit COVERAGE verdict so "we read it" can
 * never quietly mean three different depths of "read".
 */

export type ArtifactCoverage =
  /** Content, structure, and metadata were all extracted within bounds. */
  | 'full'
  /** Real content was extracted but a bound cut it short (the reasons say which). */
  | 'partial'
  /** Only structure/metadata — content extraction was not possible or not attempted. */
  | 'structural';

export interface ArtifactMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  /** ISO-ish strings as found in the file; never reinterpreted. */
  created?: string;
  modified?: string;
  /** PDF producer / OOXML application, when present. */
  application?: string;
}

export interface OutlineEntry {
  /** Heading level for docx (1-9); slide index for pptx. */
  level: number;
  text: string;
}

export interface TableSummary {
  rows: number;
  cols: number;
  /** First-row cell texts, bounded — the most identifying part of a table. */
  headerCells: string[];
  /** Up to a few data rows, each bounded, for orientation — never the full table. */
  sampleRows: string[][];
}

export interface MediaEntry {
  name: string;
  bytes: number;
}

export interface SlideSummary {
  /** 1-based position in the presentation's declared slide order. */
  index: number;
  title?: string;
  /** Slide body text, bounded. */
  text: string;
  /** Speaker notes, bounded, when present. */
  notes?: string;
}

export interface PageText {
  /** 1-based. */
  page: number;
  text: string;
}

interface SummaryCommon {
  metadata: ArtifactMetadata;
  media: MediaEntry[];
  warnings: string[];
  coverage: ArtifactCoverage;
  coverageReasons: string[];
}

export interface DocxSummary extends SummaryCommon {
  kind: 'docx';
  outline: OutlineEntry[];
  paragraphCount: number;
  /** Flowed body text, bounded. */
  text: string;
  tables: TableSummary[];
  headerCount: number;
  footerCount: number;
}

export interface PptxSummary extends SummaryCommon {
  kind: 'pptx';
  slideCount: number;
  slides: SlideSummary[];
}

export interface PdfSummary extends SummaryCommon {
  kind: 'pdf';
  pageCount: number;
  pages: PageText[];
}

/** xlsx is IDENTIFIED and metadata-read, deliberately not content-read (out of scope). */
export interface XlsxSummary extends SummaryCommon {
  kind: 'xlsx';
  sheetNames: string[];
}

export type ArtifactSummary = DocxSummary | PptxSummary | PdfSummary | XlsxSummary;

/** Bounds shared by the readers. Parameters so tests exercise the honesty paths cheaply. */
export interface ReadBounds {
  /** Total body/page/slide text collected before coverage degrades to 'partial'. */
  maxTextChars?: number;
  /** Tables summarized before the rest are counted only. */
  maxTables?: number;
  /** PDF pages / slides text-extracted before the rest are counted only. */
  maxUnits?: number;
}

export const DEFAULT_READ_BOUNDS: Required<ReadBounds> = {
  maxTextChars: 200_000,
  maxTables: 24,
  maxUnits: 100,
};
