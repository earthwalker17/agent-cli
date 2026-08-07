import { z } from 'zod';
import { validateSourceUrl } from '../research/sanitize.js';
import { sanitizeLine } from '../shared/text.js';
import type { ResearchNote, Tool, ToolResult } from '../types.js';

/**
 * record_source (Session 19) — the researcher child's ONLY structured findings channel, and an
 * exact analogue of `report_finding`: validated at the source, accumulated in a per-task closure
 * the delegate builds for each child, captured as one `research.findings` event at task end.
 *
 * What makes this the difference between research and a pile of search results is the SHAPE it
 * insists on. A finding must be one falsifiable claim, must name the URLs it rests on, and must
 * state whether independent sources agree. That last field is not decoration: "corroborated" with
 * a single source is refused here, so the schema itself prevents the most common way a confident
 * research summary becomes wrong — one page, restated as consensus.
 *
 * `retrievedAt` is stamped by the HARNESS, never taken from the model. Research is perishable, and
 * a date the model can author is a date it can be wrong about.
 *
 * Policy shape: no facts, empty mutation plan → observe/auto-allow (the `report_finding` and
 * `recover` precedent: recording evidence confers no authority and reaches nothing). Pinned by test.
 */

export const MAX_NOTES_PER_RESEARCHER = 10;

const NoteInput = z
  .object({
    claim: z
      .string()
      .min(10)
      .max(400)
      .describe('ONE falsifiable statement of what you learned — "X is now Y", not "I looked into X". No summaries of the web.'),
    sources: z
      .array(z.string().min(1).max(2048))
      .min(1)
      .max(6)
      .describe('The URLs this claim rests on, as returned by search or extract. A claim with no source is not a finding.'),
    corroboration: z
      .enum(['corroborated', 'single-source', 'sources-disagree'])
      .describe(
        'corroborated = two or more INDEPENDENT sources agree (two pages copying one upstream are ONE source). ' +
          'single-source = only one source says this — a disclosure, not a failure. ' +
          'sources-disagree = they conflict, and the claim records what each said.',
      ),
    confidence: z.enum(['high', 'medium', 'low']),
    relevance: z
      .string()
      .min(10)
      .max(300)
      .describe('Why this matters to the delegated task — what the main agent should do differently. This is the filter that keeps notes useful.'),
  })
  .strict();

type NoteInputT = z.infer<typeof NoteInput>;

/** The per-task accumulator: the delegate holds one per researcher child and captures at task end. */
export interface NoteAccumulator {
  items: Omit<ResearchNote, 'noteId'>[];
}

export function createNoteAccumulator(): NoteAccumulator {
  return { items: [] };
}

export interface RecordSourceDeps {
  acc: NoteAccumulator;
  /** Harness clock for the retrieval date. Injected so tests are deterministic. */
  today?: () => string;
}

export function createRecordSourceTool(deps: RecordSourceDeps): Tool<NoteInputT> {
  const today = deps.today ?? ((): string => new Date().toISOString().slice(0, 10));
  return {
    name: 'record_source',
    description:
      'Record ONE source-backed finding. Recorded findings are what reaches the main agent as structured evidence — a claim that ' +
      'exists only in your prose report is narration. Record findings, not summaries: one falsifiable claim, the URLs behind it, ' +
      'and an honest corroboration verdict. An honest "single-source" beats a confident "corroborated" you cannot support. ' +
      `Budget: ${String(MAX_NOTES_PER_RESEARCHER)} findings per research task.`,
    schema: NoteInput,
    mutates: () => ({ paths: [] }),
    async execute(input): Promise<ToolResult> {
      const done = (ok: boolean, output: string, error?: string): ToolResult => ({
        ok,
        output,
        durationMs: 0,
        truncated: false,
        ...(error !== undefined ? { error } : {}),
      });
      if (deps.acc.items.length >= MAX_NOTES_PER_RESEARCHER) {
        return done(
          false,
          '',
          `finding budget exhausted (${String(MAX_NOTES_PER_RESEARCHER)} recorded): consolidate related claims instead — ` +
            'raise anything remaining as prose in your final report',
        );
      }

      // A source URL is an IDENTIFIER, so the report_finding rule applies: a value sanitization
      // would ALTER is refused outright rather than escaped. A citation that points nowhere while
      // still looking like a citation is worse than a missing one.
      const sources: string[] = [];
      for (const raw of input.sources) {
        const v = validateSourceUrl(raw);
        if (!v.ok) {
          return done(false, '', `source '${sanitizeLine(raw).slice(0, 200)}' is not a citable source (${v.reason}) — cite a URL you actually retrieved`);
        }
        if (!sources.includes(v.url)) sources.push(v.url);
      }
      // The schema cannot express this, and it is the single most valuable check here: claiming
      // corroboration from one URL is exactly how one page becomes "consensus".
      if (input.corroboration === 'corroborated' && sources.length < 2) {
        return done(
          false,
          '',
          "corroboration 'corroborated' needs at least two DISTINCT sources; you cited one. " +
            "Record it as 'single-source' (which is an honest and useful answer), or find a second independent source.",
        );
      }

      // Neutralize at ingestion, one choke point (the report_finding discipline): these strings
      // are model-authored, derived from untrusted web pages, and are later rendered into
      // harness-attributed lines in the chrome, the report, and RESEARCH.md.
      deps.acc.items.push({
        claim: sanitizeLine(input.claim),
        sources,
        corroboration: input.corroboration,
        confidence: input.confidence,
        relevance: sanitizeLine(input.relevance),
        retrievedAt: today(),
      });
      return done(
        true,
        `finding ${String(deps.acc.items.length)} recorded (${input.corroboration}, ${input.confidence} confidence, ` +
          `${String(sources.length)} source(s)) — ${String(MAX_NOTES_PER_RESEARCHER - deps.acc.items.length)} slot(s) remain`,
      );
    },
  };
}
