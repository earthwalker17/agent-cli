import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { openZipBounded, zipDeterministic } from '../src/artifacts/zip.js';
import { parseXmlBounded, MAX_XML_DEPTH } from '../src/artifacts/xml.js';
import { identifyDocument } from '../src/artifacts/inspect.js';
import { parseDocSpec, type DocSpec } from '../src/artifacts/model.js';
import { renderHtml } from '../src/artifacts/html-render.js';
import { renderDocx } from '../src/artifacts/docx-render.js';
import { validateDocxAgainstSpec } from '../src/artifacts/validate.js';
import { imageInfo } from '../src/artifacts/img-dim.js';
import { openZipBounded as openZip } from '../src/artifacts/zip.js';
import { createRenderDocumentTool, renderCapsFromEvents } from '../src/tools/artifact-render.js';
import { createInspectPagesTool, inspectBudgetFromEvents } from '../src/tools/artifact-inspect.js';
import { computeAcceptance } from '../src/runtime/acceptance.js';
import { decide, Grants } from '../src/policy/engine.js';
import { sha256 } from '../src/shared/hash.js';
import { ArtifactError } from '../src/artifacts/errors.js';
import type { ArtifactEvidence, SessionEvent, ToolContext } from '../src/types.js';
import type { PlanState } from '../src/plan/canonical.js';
import { fixturePdf } from './artifacts.fixtures.js';

/**
 * Regression pins for the Session 17 adversarial review. Each test names the defect it closes;
 * every one of these FAILED against the pre-fix code (verified by hand before fixing).
 */

const run = (text: string, extra: Record<string, unknown> = {}) => ({ text, ...extra });
function spec(blocks: unknown[], extra: Record<string, unknown> = {}): DocSpec {
  const parsed = parseDocSpec(JSON.stringify({ version: 1, meta: { title: 'T' }, ...extra, blocks }));
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.errors.join('; ')}`);
  return parsed.spec;
}

describe('review fix: zip caps gate the size that is actually materialized', () => {
  it('refuses a STORED entry whose compressed size exceeds the cap even when it lies about originalSize', () => {
    const zip = zipSync({ 'a.bin': [new Uint8Array(300_000), { level: 0 }] });
    // Forge the central directory's uncompressed-size field to claim 4 bytes.
    const patched = Uint8Array.from(zip);
    let cd = -1;
    for (let i = patched.length - 22; i >= 0; i--) {
      if (patched[i] === 0x50 && patched[i + 1] === 0x4b && patched[i + 2] === 0x01 && patched[i + 3] === 0x02) {
        cd = i;
        break;
      }
    }
    expect(cd).toBeGreaterThan(0);
    new DataView(patched.buffer, patched.byteOffset).setUint32(cd + 24, 4, true);
    try {
      openZipBounded(patched, { maxEntryBytes: 1_000, maxTotalBytes: 1_000 });
      expect.unreachable('the forged entry must be refused BEFORE inflation');
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactError);
      expect((err as ArtifactError).reason).toBe('zip-bounds');
      // The message must quote the real (compressed) size, not the lie.
      expect((err as Error).message).toContain('300000');
    }
  });
});

describe('review fix: XML nesting is bounded and identification never throws', () => {
  it('refuses a document nested past the depth bound with a typed error', () => {
    const deep = `<r>${'<a>'.repeat(MAX_XML_DEPTH + 5)}${'</a>'.repeat(MAX_XML_DEPTH + 5)}</r>`;
    try {
      parseXmlBounded(deep, 'deep part');
      expect.unreachable();
    } catch (err) {
      expect((err as ArtifactError).reason).toBe('xml-bounds');
    }
  });

  it('identifyDocument returns unsupported (never throws) for a stack-bombing content-types part', () => {
    const inner = '<a>'.repeat(5_000) + '</a>'.repeat(5_000);
    const zip = zipDeterministic({
      '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${inner}</Types>`,
    });
    const id = identifyDocument(zip);
    expect(id.format).toBe('unsupported');
    expect((id as { reason: string }).reason).toContain('[Content_Types].xml');
  });
});

describe('review fix: font names cannot break out of the CSS block', () => {
  it('refuses markup-bearing font names at the schema', () => {
    const parsed = parseDocSpec(
      JSON.stringify({
        version: 1,
        meta: { title: 't' },
        styles: { bodyFont: "</style><script>fetch('//x')</script>" },
        blocks: [{ kind: 'paragraph', runs: [run('x')] }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(' ')).toContain('font names');
  });

  it('the rendered page still contains no script tag for any accepted font', () => {
    const s = spec([{ kind: 'paragraph', runs: [run('x')] }], { styles: { bodyFont: 'Calibri Light' } });
    expect(renderHtml(s, new Map()).html).not.toContain('<script');
  });
});

describe('review fix: validation does not manufacture failures', () => {
  it('passes a 25-table document (the reader display cap no longer bounds validation)', () => {
    const mkTable = () => ({ kind: 'table', rows: [[[run('h')]], [[run('v')]]] });
    const s = spec(Array.from({ length: 25 }, mkTable));
    const report = validateDocxAgainstSpec(renderDocx(s, new Map()), s);
    expect(report.failures).toEqual([]);
  });

  it('passes a heading containing \\r (the renderer normalizes it; so does the comparison)', () => {
    const s = spec([{ kind: 'heading', level: 1, runs: [run('Q1\rReport')] }]);
    const report = validateDocxAgainstSpec(renderDocx(s, new Map()), s);
    expect(report.failures).toEqual([]);
  });

  it('ignores a heading whose runs carry no visible text (it renders no outline entry)', () => {
    const s = spec([{ kind: 'heading', level: 1, runs: [run('   ')] }, { kind: 'heading', level: 2, runs: [run('Real')] }]);
    const report = validateDocxAgainstSpec(renderDocx(s, new Map()), s);
    expect(report.failures).toEqual([]);
  });
});

describe('review fix: OOXML details', () => {
  it('emits rPr children in schema sequence and transitional alignment values', () => {
    const s = spec([
      { kind: 'paragraph', align: 'right', runs: [run('x', { bold: true, underline: true, color: '#112233', code: true })] },
    ]);
    const doc = openZip(renderDocx(s, new Map())).text('word/document.xml')!;
    const rPr = /<w:rPr>(.*?)<\/w:rPr>/.exec(doc)![1]!;
    const order = ['w:rFonts', 'w:b', 'w:color', 'w:u', 'w:shd'].map((n) => rPr.indexOf(`<${n}`));
    expect(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]!))).toBe(true);
    expect(doc).toContain('<w:jc w:val="right"/>');
    expect(doc).not.toContain('w:val="end"');
  });

  it('converts tabs inside code blocks to w:tab like every other text path', () => {
    const s = spec([{ kind: 'code', text: 'if (x) {\n\tdoThing();\n}' }]);
    const doc = openZip(renderDocx(s, new Map())).text('word/document.xml')!;
    expect(doc).toContain('<w:tab/>');
    expect(doc).not.toMatch(/<w:t[^>]*>[^<]*\t/);
  });

  it('accepts a JPEG carrying legal 0xFF fill bytes before a marker', () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
      0xff, 0xff, // fill bytes
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x78, 0x00, 0xf0, 0x01, 0x01, 0x11, 0x00,
    ]);
    expect(imageInfo(jpeg)).toMatchObject({ format: 'jpeg', width: 240, height: 120 });
  });
});

describe('review fix: render_document gates its own spec read', () => {
  let ws: string;
  let ctx: ToolContext;
  const probeUnavailable = async () => ({ available: false, reason: 'test' });
  const tool = () => createRenderDocumentTool({ probe: probeUnavailable, caps: { renders: 0 } });

  beforeEach(() => {
    ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'render-fix-')));
    ctx = { workspaceRoot: ws, stateDir: path.join(os.tmpdir(), 'render-fix-state') };
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it('refuses a secret-named spec path without reading or echoing its bytes', async () => {
    fs.writeFileSync(path.join(ws, '.env'), 'AWS_SECRET_ACCESS_KEY=TOPSECRETVALUE\n');
    const res = await tool().execute({ spec_path: '.env' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('secret-named');
    expect(`${res.error}${res.output}`).not.toContain('TOPSECRET');
  });

  it('reports a JSON syntax error by POSITION, never quoting file content', async () => {
    fs.writeFileSync(path.join(ws, 'x.docspec.json'), 'AWS_SECRET_ACCESS_KEY=TOPSECRETVALUE\n');
    const res = await tool().execute({ spec_path: 'x.docspec.json' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not valid JSON');
    expect(res.error).not.toContain('TOPSECRET');
  });

  it('a locked output file is a typed failure, not an escaping throw', async () => {
    fs.writeFileSync(
      path.join(ws, 'r.docspec.json'),
      JSON.stringify({ version: 1, meta: { title: 'T' }, blocks: [{ kind: 'paragraph', runs: [run('x')] }] }),
    );
    // A DIRECTORY where the artifact must go makes the rename fail deterministically.
    fs.mkdirSync(path.join(ws, 'r.docx'));
    const res = await tool().execute({ spec_path: 'r.docspec.json', formats: ['docx'] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('DOCX: FAILED');
  });

  it('a FAILED pdf print is ok:false, while a missing browser is an honest skip', async () => {
    fs.writeFileSync(
      path.join(ws, 'p.docspec.json'),
      JSON.stringify({ version: 1, meta: { title: 'T' }, blocks: [{ kind: 'paragraph', runs: [run('x')] }] }),
    );
    const skipped = await tool().execute({ spec_path: 'p.docspec.json', formats: ['pdf'] }, ctx);
    expect(skipped.ok).toBe(true);
    expect(skipped.output).toContain('PDF: SKIPPED');

    // A probe that CLAIMS an impossible channel makes the launch fail — the render-failed path.
    const failing = createRenderDocumentTool({
      probe: async () => ({ available: true, channel: 'no-such-browser-channel' }),
      caps: { renders: 0 },
    });
    const res = await failing.execute({ spec_path: 'p.docspec.json', formats: ['pdf'] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('PDF: FAILED');
  }, 90_000);
});

describe('review fix: budgets and admission', () => {
  const NO_PLAN: PlanState = {
    kind: 'none',
    status: 'none',
    currentSha: null,
    approvedSha: null,
    diverged: false,
    approvedAndCurrent: false,
    canonical: null,
    legacy: null,
  };
  const ev = (body: Record<string, unknown>, seq: number): SessionEvent => ({ v: 1, seq, ts: 't', ...body }) as SessionEvent;

  it('charges a render whose call produced no artifact event (browserless pdf-only)', () => {
    const events = [
      ev({ type: 'tool.requested', callId: 'c1', tool: 'render_document', input: {} }, 1),
      ev({ type: 'tool.completed', callId: 'c1', ok: true, outputPreview: 'PDF: SKIPPED', durationMs: 1, truncated: false }, 2),
    ];
    expect(renderCapsFromEvents(events).renders).toBe(1);
  });

  it('S20.5: charges an all-formats-HARD-FAILED render on rebuild too — the marker event closes the refund', () => {
    // Charged live after validation, produced nothing, completed ok:false — invisible to the old
    // rebuild, so a resume refunded exactly the failing-render loop the cap exists to bound. A
    // validation REFUSAL (the designed revision loop) stays uncharged and unmarked.
    const events = [
      ev({ type: 'tool.requested', callId: 'c1', tool: 'render_document', input: {} }, 1),
      ev({ type: 'artifact.render-failed', callId: 'c1', specPath: 'p.docspec.json', reasons: ['DOCX: FAILED — locked'], durationMs: 1 }, 2),
      ev({ type: 'tool.completed', callId: 'c1', ok: false, outputPreview: 'DOCX: FAILED', durationMs: 1, truncated: false }, 3),
      // A refusal (never charged live) leaves no marker and must not count on rebuild.
      ev({ type: 'tool.requested', callId: 'c2', tool: 'render_document', input: {} }, 4),
      ev({ type: 'tool.completed', callId: 'c2', ok: false, outputPreview: 'spec did not validate', durationMs: 1, truncated: false }, 5),
    ];
    expect(renderCapsFromEvents(events).renders).toBe(1);
  });

  it('inspect does NOT inherit consent when the render embedded workspace images', () => {
    const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-fix-')));
    try {
      const pdf = fixturePdf();
      fs.writeFileSync(path.join(ws, 'report.pdf'), pdf);
      const base = {
        type: 'artifact.rendered',
        callId: 'c1',
        format: 'pdf',
        path: 'report.pdf',
        sha256: sha256(Buffer.from(pdf)),
        bytes: 1,
        specPath: 's.docspec.json',
        specSha256: 'b'.repeat(64),
        validation: { status: 'pass', findings: [], failureCount: 0, summary: '' },
        durationMs: 1,
      };
      const ctx: ToolContext = { workspaceRoot: ws, stateDir: path.join(os.tmpdir(), 'inspect-fix-state') };
      const mk = (events: SessionEvent[]) =>
        createInspectPagesTool({
          probe: async () => ({ available: true, channel: 'msedge' }),
          putBlob: () => 'a'.repeat(64),
          events: () => events,
          budget: inspectBudgetFromEvents(events),
        });
      const clean = [ev(base, 1)];
      expect(decide(mk(clean), { path: 'report.pdf' }, ctx, new Grants())).toMatchObject({
        rule: 'artifact.inspect-session-artifact',
        decision: 'allow',
      });
      const laundered = [ev({ ...base, embeddedWorkspaceImages: true }, 1)];
      const d = decide(mk(laundered), { path: 'report.pdf' }, ctx, new Grants());
      expect(d).toMatchObject({ rule: 'artifact.inspect-approval-required', decision: 'ask' });
      // The RECORD must state the true reason: this session DID produce the artifact (found
      // live — the first take's prompt claimed the opposite about a file it had just rendered).
      expect(d.reason).toContain('this session rendered');
      expect(d.reason).toContain('EMBEDDED workspace image');
      expect(d.reason).not.toContain('did NOT produce');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('acceptance counts structural failures only, and drops the caveat once the artifact changes', () => {
    // S20.5: retirement matches on the render's additive absPath (production file.mutated paths
    // are ABSOLUTE; the original form of this test passed only because it used rel paths on both
    // sides — a shape production never emits), and the retiring mutation must come from a
    // DIFFERENT call than the render's own.
    const failing = ev(
      {
        type: 'artifact.rendered',
        callId: 'c1',
        format: 'docx',
        path: 'r.docx',
        absPath: 'C:/ws/r.docx',
        sha256: 'c'.repeat(64),
        bytes: 1,
        specPath: 's',
        specSha256: 'd'.repeat(64),
        validation: { status: 'fail', findings: ['real failure', 'note: a heuristic', 'note: another'], failureCount: 1, summary: 'FAILED' },
        durationMs: 1,
      },
      1,
    );
    const one = computeAcceptance(NO_PLAN, null, [failing]);
    expect(one.caveats.join(' ')).toContain('1 structural finding(s)');

    const undone = computeAcceptance(NO_PLAN, null, [
      failing,
      ev({ type: 'file.mutated', callId: 'u1', path: 'C:/ws/r.docx', kind: 'delete', beforeSha256: 'c'.repeat(64), afterSha256: null, createdDirs: [] }, 2),
    ]);
    expect(undone.caveats.join(' ')).not.toContain("artifact 'r.docx'");
  });
});
