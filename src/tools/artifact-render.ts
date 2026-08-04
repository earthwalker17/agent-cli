/**
 * render_document — DocSpec file → DOCX and/or PDF artifacts next to the spec (Session 17).
 *
 * Policy: the `artifact` fact, kind 'render' — reversible auto-allow in-workspace with a
 * snapshot (artifacts are undoable), and the ENGINE's recorded reason states what this file
 * enforces: the engine never evaluates reads on a mutating tool, so every spec-referenced
 * image path is validated HERE, at execute, with the same validator + secret-name rules the
 * engine uses — out-of-workspace and secret-named paths refuse into the error list and
 * nothing renders.
 *
 * An invalid spec returns the COMPLETE error list with nothing written (the update_plan
 * revision-loop pattern). A missing browser skips the PDF with a recorded honest reason —
 * no artifact, no event, no phantom mutation — while the DOCX still renders.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { SessionEvent, Tool, ToolContext, ToolResult } from '../types.js';
import { resolveForTool } from './index.js';
import { validatePath } from '../policy/paths.js';
import { isSecretName } from '../policy/engine.js';
import { sha256 } from '../shared/hash.js';
import { parseDocSpec, type DocSpec } from '../artifacts/model.js';
import { renderDocx } from '../artifacts/docx-render.js';
import { renderHtml } from '../artifacts/html-render.js';
import { renderPdf } from '../artifacts/pdf-render.js';
import { validateDocxAgainstSpec, validatePdfAgainstSpec } from '../artifacts/validate.js';
import { imageInfo } from '../artifacts/img-dim.js';
import { ArtifactError } from '../artifacts/errors.js';
import type { BrowserAvailability } from '../browser/probe.js';

export const RENDERS_PER_SESSION = 20;
const MAX_SPEC_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Session render budget, rebuilt from events at assembly (distinct rendered callIds — one
 *  call may emit two formats). A call that crashed before any event counts free on resume:
 *  no artifact exists, so the honest ledger has nothing to charge. */
export function renderCapsFromEvents(events: readonly SessionEvent[]): { renders: number } {
  const callIds = new Set<string>();
  for (const e of events) {
    if (e.type === 'artifact.rendered') callIds.add(e.callId);
  }
  return { renders: callIds.size };
}

const BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,78}[A-Za-z0-9]$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const RenderInput = z
  .object({
    spec_path: z.string().describe('The *.docspec.json file to render, relative to the workspace root'),
    formats: z
      .array(z.enum(['docx', 'pdf']))
      .min(1)
      .max(2)
      .optional()
      .describe('Which artifacts to produce (default: both). PDF needs a system browser; DOCX never does.'),
    out_basename: z
      .string()
      .optional()
      .describe('Artifact base name (default: the spec file name without .docspec.json); no separators or extensions')
      .refine((s) => s === undefined || (BASENAME_RE.test(s) && !RESERVED.test(s)), {
        message: 'out_basename must be a plain file name: letters/digits/space/._- only, no separators, not a reserved device name',
      }),
  })
  .strict();
type RenderInputT = z.infer<typeof RenderInput>;

function outputsFor(input: RenderInputT, ctx: ToolContext): { docx: string; pdf: string; dir: string; base: string } {
  const specAbs = resolveForTool(ctx, input.spec_path);
  const dir = path.dirname(specAbs);
  const base = input.out_basename ?? path.basename(specAbs).replace(/\.docspec\.json$/i, '').replace(/\.json$/i, '');
  return { dir, base, docx: path.join(dir, `${base}.docx`), pdf: path.join(dir, `${base}.pdf`) };
}

function formatsOf(input: RenderInputT): ('docx' | 'pdf')[] {
  return input.formats ?? ['docx', 'pdf'];
}

function writeAtomic(target: string, bytes: Uint8Array): void {
  const tmp = path.join(path.dirname(target), `.tmp-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, bytes);
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export interface RenderDocumentDeps {
  probe: () => Promise<BrowserAvailability>;
  caps: { renders: number };
}

export function createRenderDocumentTool(deps: RenderDocumentDeps): Tool<RenderInputT> {
  return {
    name: 'render_document',
    description:
      'Render a *.docspec.json document spec into polished artifacts next to it: a DOCX (deterministic bytes) ' +
      'and/or a PDF (printed via the system browser). Runs deterministic parse-back validation on every artifact ' +
      'and reports the verdict. Revise by editing the SPEC and re-rendering — never regenerate artifacts by hand. ' +
      'Then inspect the PDF visually with inspect_pages.',
    schema: RenderInput,
    // The fact has no ctx, so it declares WORKSPACE-RELATIVE outputs; the engine resolves both
    // sides through the shared validator before its consistency cross-check.
    artifact: (i) => {
      const dir = path.dirname(i.spec_path);
      const base = i.out_basename ?? path.basename(i.spec_path).replace(/\.docspec\.json$/i, '').replace(/\.json$/i, '');
      return {
        kind: 'render',
        outputs: formatsOf(i).map((f) => path.join(dir, `${base}.${f}`)),
        usesBrowser: formatsOf(i).includes('pdf'),
      };
    },
    mutates: (i, c) => ({ paths: formatsOf(i).map((f) => (f === 'docx' ? outputsFor(i, c).docx : outputsFor(i, c).pdf)) }),
    async execute(input, ctx) {
      const started = Date.now();
      const fail = (error: string): ToolResult => ({ ok: false, output: '', error, truncated: false, durationMs: Date.now() - started });

      if (deps.caps.renders >= RENDERS_PER_SESSION) {
        return fail(`the session render budget (${RENDERS_PER_SESSION}) is spent; revise within existing artifacts or start a new session`);
      }

      const specAbs = resolveForTool(ctx, input.spec_path);
      let specText: string;
      try {
        const stat = fs.statSync(specAbs);
        if (stat.size > MAX_SPEC_BYTES) return fail(`spec too large (${stat.size} bytes; bound ${MAX_SPEC_BYTES})`);
        specText = fs.readFileSync(specAbs, 'utf8');
      } catch {
        return fail(`spec not found: ${input.spec_path}`);
      }
      const parsed = parseDocSpec(specText);
      if (!parsed.ok) {
        return fail(`the spec is invalid — nothing was rendered. Fix ALL of these, then re-render:\n${parsed.errors.map((e) => `- ${e}`).join('\n')}`);
      }
      const spec: DocSpec = parsed.spec;
      const specSha256 = sha256(specText);

      // Execute-time enforcement of spec-referenced reads (the engine's recorded reason points
      // here): containment + secret-name + decodability, complete error list, nothing written.
      const imageErrors: string[] = [];
      const imageBytes = new Map<string, Uint8Array>();
      const stateOpt = {
        ...(ctx.stateDir ? { stateDir: ctx.stateDir } : {}),
        ...(ctx.rules && ctx.rules.protectedPaths.length > 0 ? { extraProtected: ctx.rules.protectedPaths } : {}),
      };
      const specDir = path.dirname(specAbs);
      for (const block of spec.blocks) {
        if (block.kind !== 'image' || imageBytes.has(block.path)) continue;
        let resolved: { resolved: string; inWorkspace: boolean };
        try {
          resolved = validatePath(ctx.workspaceRoot, path.join(specDir, block.path), stateOpt);
        } catch (err) {
          imageErrors.push(`image "${block.path}": ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (!resolved.inWorkspace) {
          imageErrors.push(`image "${block.path}": resolves outside the workspace; images must live in the workspace`);
          continue;
        }
        if (isSecretName(block.path, ctx.rules?.secretPatterns) || isSecretName(resolved.resolved, ctx.rules?.secretPatterns)) {
          imageErrors.push(`image "${block.path}": secret-named files are never embedded into artifacts`);
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(resolved.resolved);
        } catch {
          imageErrors.push(`image "${block.path}": file not found (relative to the spec file)`);
          continue;
        }
        if (bytes.length > MAX_IMAGE_BYTES) {
          imageErrors.push(`image "${block.path}": ${bytes.length} bytes exceeds the ${MAX_IMAGE_BYTES} bound`);
          continue;
        }
        if (imageInfo(new Uint8Array(bytes)) === null) {
          imageErrors.push(`image "${block.path}": not a readable PNG or JPEG`);
          continue;
        }
        imageBytes.set(block.path, new Uint8Array(bytes));
      }
      if (imageErrors.length > 0) {
        return fail(`image references are invalid — nothing was rendered:\n${imageErrors.map((e) => `- ${e}`).join('\n')}`);
      }

      deps.caps.renders += 1;
      const out = outputsFor(input, ctx);
      const rel = (abs: string): string => path.relative(ctx.workspaceRoot, abs).split(path.sep).join('/');
      const sections: string[] = [];
      const formats = formatsOf(input);

      if (formats.includes('docx')) {
        const t0 = Date.now();
        let bytes: Uint8Array;
        try {
          bytes = renderDocx(spec, imageBytes);
        } catch (err) {
          if (err instanceof ArtifactError) return fail(`DOCX render failed: ${err.message}`);
          throw err;
        }
        writeAtomic(out.docx, bytes);
        const validation = validateDocxAgainstSpec(bytes, spec);
        ctx.reportArtifact?.({
          kind: 'rendered',
          format: 'docx',
          path: rel(out.docx),
          sha256: sha256(Buffer.from(bytes)),
          bytes: bytes.length,
          specPath: rel(specAbs),
          specSha256,
          validation: {
            status: validation.status,
            findings: [...validation.failures, ...validation.notes.map((n) => `note: ${n}`)],
            summary:
              validation.status === 'pass'
                ? `parse-back validation passed (${validation.notes.length} note(s))`
                : `parse-back validation FAILED: ${validation.failures.length} finding(s)`,
          },
          durationMs: Date.now() - t0,
        });
        sections.push(
          `DOCX: ${rel(out.docx)} (${bytes.length} bytes, sha256 ${sha256(Buffer.from(bytes)).slice(0, 12)}…)\n` +
            `  validation: ${validation.status.toUpperCase()}` +
            (validation.failures.length > 0 ? `\n${validation.failures.map((f) => `  - ${f}`).join('\n')}` : '') +
            (validation.notes.length > 0 ? `\n${validation.notes.map((n) => `  ~ ${n}`).join('\n')}` : ''),
        );
      }

      if (formats.includes('pdf')) {
        const t0 = Date.now();
        const rendered = renderHtml(spec, imageBytes);
        const printed = await renderPdf(spec, rendered, deps.probe);
        if (!printed.ok) {
          sections.push(
            `PDF: SKIPPED — ${printed.reason}` +
              (printed.kind === 'no-browser' ? '\n  (the DOCX artifact, when requested, is unaffected)' : ''),
          );
        } else {
          writeAtomic(out.pdf, printed.bytes);
          const { report, extras } = await validatePdfAgainstSpec(new Uint8Array(printed.bytes), spec);
          ctx.reportArtifact?.({
            kind: 'rendered',
            format: 'pdf',
            path: rel(out.pdf),
            sha256: sha256(printed.bytes),
            bytes: printed.bytes.length,
            pages: extras.pageCount,
            specPath: rel(specAbs),
            specSha256,
            validation: {
              status: report.status,
              findings: [...report.failures, ...report.notes.map((n) => `note: ${n}`)],
              summary:
                report.status === 'pass'
                  ? `printed-text validation passed over ${extras.pageCount} page(s) (${report.notes.length} note(s))`
                  : `printed-text validation FAILED: ${report.failures.length} finding(s)`,
            },
            durationMs: Date.now() - t0,
          });
          sections.push(
            `PDF: ${rel(out.pdf)} (${printed.bytes.length} bytes, ${extras.pageCount} page(s), sha256 ${sha256(printed.bytes).slice(0, 12)}…)\n` +
              `  validation: ${report.status.toUpperCase()}` +
              (report.failures.length > 0 ? `\n${report.failures.map((f) => `  - ${f}`).join('\n')}` : '') +
              (report.notes.length > 0 ? `\n${report.notes.map((n) => `  ~ ${n}`).join('\n')}` : ''),
          );
        }
      }

      const guidance =
        formats.includes('pdf') && sections.some((s) => s.startsWith('PDF: ') && !s.includes('SKIPPED'))
          ? `\n\nNext: inspect_pages on ${rel(out.pdf)} to SEE the pages before claiming visual quality; revise by editing ${rel(specAbs)} and re-rendering.`
          : `\n\nRevise by editing ${rel(specAbs)} and re-rendering.`;
      return {
        ok: true,
        output: `rendered from ${rel(specAbs)} (spec sha256 ${specSha256.slice(0, 12)}…)\n\n${sections.join('\n\n')}${guidance}`,
        truncated: false,
        durationMs: Date.now() - started,
      };
    },
  };
}
