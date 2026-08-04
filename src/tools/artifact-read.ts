/**
 * read_document — the documents pack's read surface (Session 17): identify a DOCX/PPTX/PDF
 * (XLSX identified, deliberately not content-read) by MAGIC BYTES, extract bounded structure,
 * text, and metadata, and answer with an explicit coverage verdict.
 *
 * Policy: a pure declared read (`readsPaths`) — observe in-workspace, ask outside, and the
 * secret-name classification (with log redaction) rides the existing engine branch untouched.
 * Refusals for unrecognized bytes never echo file content: a renamed `.env` fails the sniff
 * with a sentence about formats, not about what was in the file.
 */

import fs from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolResult } from '../types.js';
import { resolveForTool } from './index.js';
import { truncateForModel } from '../shared/hash.js';
import { identifyDocument } from '../artifacts/inspect.js';
import { readDocx } from '../artifacts/docx-read.js';
import { readPptx } from '../artifacts/pptx-read.js';
import { readPdf } from '../artifacts/pdf-read.js';
import { readXlsx } from '../artifacts/xlsx-read.js';
import { formatSummary } from '../artifacts/format.js';
import { ArtifactError } from '../artifacts/errors.js';
import type { ArtifactSummary } from '../artifacts/types.js';

/** Raw-bytes bound; the zip layer separately bounds DECOMPRESSED size. */
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

const ReadDocumentInput = z
  .object({
    path: z.string().describe('Document path, relative to the workspace root (.docx/.pptx/.pdf; format is detected from bytes, not the extension)'),
    detail: z
      .enum(['summary', 'structure', 'text'])
      .optional()
      .describe('summary (default): metadata + outline + text excerpt; structure: no body text; text: all extracted text'),
  })
  .strict();

export const readDocumentTool: Tool<z.infer<typeof ReadDocumentInput>> = {
  name: 'read_document',
  description:
    'Read a binary document (DOCX, PPTX, PDF; XLSX is identified with sheet names only). Returns metadata, ' +
    'outline/slides/pages, table shapes, media inventory, and bounded text, with an explicit coverage verdict ' +
    '(full / partial / structural). Format is detected from file bytes. For plain text files use read_file.',
  schema: ReadDocumentInput,
  mutates: () => null,
  readsPaths: (i) => [i.path],
  async execute(input, ctx) {
    const started = Date.now();
    const fail = (error: string): ToolResult => ({ ok: false, output: '', error, truncated: false, durationMs: Date.now() - started });
    const abs = resolveForTool(ctx, input.path);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return fail(`file not found: ${input.path}`);
    }
    if (stat.isDirectory()) return fail(`${input.path} is a directory`);
    if (stat.size > MAX_DOCUMENT_BYTES) return fail(`document too large to read (${stat.size} bytes; bound ${MAX_DOCUMENT_BYTES})`);
    const bytes = new Uint8Array(fs.readFileSync(abs));

    const id = identifyDocument(bytes);
    if (id.format === 'unsupported') return fail(`unsupported document: ${id.reason}`);

    let summary: ArtifactSummary;
    try {
      if (id.format === 'pdf') summary = await readPdf(bytes);
      else if (id.format === 'docx') summary = readDocx(id.zip!);
      else if (id.format === 'pptx') summary = readPptx(id.zip!);
      else summary = readXlsx(id.zip!);
    } catch (err) {
      // Readers degrade internally; an escape here is a bounds violation mid-part — still typed.
      if (err instanceof ArtifactError) return fail(`document refused: ${err.message}`);
      throw err;
    }

    const assembled = formatSummary(summary, input.detail ?? 'summary');
    const t = truncateForModel(assembled);
    return {
      ok: true,
      output: t.text,
      truncated: t.truncated,
      durationMs: Date.now() - started,
      // The spill contract: fullOutput must be the exact string truncateForModel saw.
      ...(t.truncated ? { fullOutput: assembled, fullOutputSha256: t.fullSha256 } : {}),
    };
  },
};
