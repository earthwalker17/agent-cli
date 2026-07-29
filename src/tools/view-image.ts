import { z } from 'zod';
import type { SessionEvent, Tool, ToolResult } from '../types.js';

/**
 * view_image — re-read a screenshot THIS SESSION's browser flows recorded (Session 13).
 *
 * The sha bound is a security boundary, not tidiness: the shared objects/ store also holds
 * blobs deliberately withheld from the model (spilled full command output, snapshot pre-images
 * of arbitrary files — including files whose redacted reads are non-replayable by design). This
 * tool therefore refuses ANY sha that is not a screenshot artifact recorded in this session's
 * `browser.flow` events — structurally: there is no path input, and the admission list is the
 * session's own evidence log. Prior-life artifacts of a RESUMED session qualify (same log).
 *
 * Policy: the `evidenceRead` fact routes this to the honest `observe.session-evidence` rule
 * (the plain observe fall-through's "read-only workspace access" reason would be false here).
 *
 * The returned image rides the Session-13 wire-image channel: the model sees the pixels live,
 * the log records metadata + pointer, elision ages the pixels into a marker after
 * IMAGE_KEEP_LAST_STEPS, and resume degrades to the pointer.
 */

const ViewImageInput = z
  .object({
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'a lowercase hex sha256 from a browser_flow screenshot artifact')
      .describe('The screenshot artifact to view (from a browser_flow result: objects/<sha256>).'),
  })
  .strict();
export type ViewImageInputT = z.infer<typeof ViewImageInput>;

export interface ViewImageDeps {
  getBlob: (sha256: string) => Buffer;
  events: () => readonly SessionEvent[];
  /** Live model capability (Session 15): read at CALL time so /provider switches are honored.
   *  Absent (older wiring/tests) = vision assumed available. */
  modelInfo?: () => { model: string; visionInput: boolean };
}

export function createViewImageTool(deps: ViewImageDeps): Tool<ViewImageInputT> {
  return {
    name: 'view_image',
    description:
      'Look at a screenshot a browser_flow of THIS session recorded (pass the objects/<sha256> value from the flow ' +
      'result). Use it for supplementary VISUAL judgment — clipping, overlap, broken layout, unreadable contrast, ' +
      'missing states, obviously wrong rendering. Visual judgment is judgment: it can add findings, but it can ' +
      'never override a failed deterministic assertion, and a nice-looking screenshot is not evidence that ' +
      'anything works. Only screenshots from this session are viewable; traces are files for humans.',
    schema: ViewImageInput,
    mutates: () => ({ paths: [] }),
    // `admitted` is computed from the same event scan execute() uses (pure over the session's
    // in-memory events), so the DECISION RECORD never claims an allowed re-read of bytes the
    // tool would refuse — the engine denies un-admitted shas outright.
    evidenceRead: (input) => {
      let admitted = false;
      try {
        for (const e of deps.events()) {
          if (e.type === 'browser.flow' && e.artifacts.some((a) => a.kind === 'screenshot' && a.sha256 === input.sha256)) {
            admitted = true;
            break;
          }
        }
      } catch {
        admitted = false;
      }
      return { sha256: input.sha256, admitted };
    },

    execute(input, _ctx): Promise<ToolResult> {
      const startedAt = Date.now();
      const refuse = (output: string, error: string): ToolResult => ({
        ok: false,
        output: `refused: ${output}`,
        error,
        durationMs: Date.now() - startedAt,
        truncated: false,
      });

      // Session 15 vision gate: a text-only model cannot LOOK at pixels. Only this visual-
      // judgment step degrades — the screenshot stays in the evidence store, and deterministic
      // browser assertions / DOM checks are untouched. Recorded honestly via the tool result.
      const info = deps.modelInfo?.();
      if (info !== undefined && !info.visionInput) {
        return Promise.resolve(
          refuse(
            `model '${info.model}' has no image input — the screenshot remains at objects/${input.sha256} and ` +
              'deterministic browser assertions are unaffected. Switch to a vision-capable model (/model) to view it.',
            'unsupported: model has no image input',
          ),
        );
      }

      let found: { label: string; mediaType: string; flowName: string; kind: 'screenshot' | 'trace' } | null = null;
      const available: string[] = [];
      for (const e of deps.events()) {
        if (e.type !== 'browser.flow') continue;
        for (const a of e.artifacts) {
          if (a.kind === 'screenshot') available.push(a.sha256);
          if (a.sha256 === input.sha256) found = { label: a.label, mediaType: a.mediaType, flowName: e.flowName, kind: a.kind };
        }
      }
      if (found === null) {
        return Promise.resolve(
          refuse(
            `no browser-flow artifact of this session has sha ${input.sha256.slice(0, 12)}… — this tool reads ONLY ` +
              `screenshots this session's flows recorded (${String(available.length)} available). Other blobs in the ` +
              'evidence store are deliberately not model-readable.',
            'not a session browser artifact',
          ),
        );
      }
      if (found.kind !== 'screenshot') {
        return Promise.resolve(
          refuse('that artifact is a trace zip — a file for humans (npx playwright show-trace), not a viewable image', 'not an image artifact'),
        );
      }
      let bytes: Buffer;
      try {
        bytes = deps.getBlob(input.sha256);
      } catch (e) {
        return Promise.resolve(refuse(`the artifact blob could not be read: ${(e as Error).message}`, 'blob read failed'));
      }
      return Promise.resolve({
        ok: true,
        output:
          `screenshot '${found.label}' from flow '${found.flowName}' (objects/${input.sha256}, ` +
          `${String(Math.round(bytes.length / 1024))} KiB) — attached. Judge layout/readability/states; ` +
          'deterministic assertions remain the functional evidence.',
        durationMs: Date.now() - startedAt,
        truncated: false,
        images: [{ mediaType: found.mediaType, dataBase64: bytes.toString('base64'), sha256: input.sha256, label: found.label }],
      });
    },
  };
}
