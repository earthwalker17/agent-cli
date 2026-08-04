/**
 * DocSpec → DOCX bytes, deterministically: fixed rId assignment, no `w:rsid` anywhere, FIXED
 * docProps timestamps (a generated artifact's identity is its content, not its render time),
 * `{date}` as a real DATE field (Word shows today; the BYTES stay stable), and the zip layer's
 * sorted-entry fixed-mtime write. Same spec + same image bytes ⇒ same sha256, per machine.
 *
 * Real named styles (Heading1–4 carry `outlineLvl`, so Word's navigation pane and this pack's
 * own parse-back outline both work), one CONCRETE numbering instance per list block (numbering
 * restart semantics — the classic shared-numId Word gotcha), field runs built from the full
 * fldChar begin/separate/end grammar.
 */

import type { DocRun, DocSpec } from './model.js';
import { headingSizePt, resolvePage, resolveTheme, type ResolvedTheme } from './model.js';
import { imageInfo } from './img-dim.js';
import { xmlEscapeAttr as ea, xmlEscapeText as et } from './xml.js';
import { zipDeterministic } from './zip.js';
import { ArtifactError } from './errors.js';

const mmToTwip = (mm: number): number => Math.round((mm * 1440) / 25.4);
const mmToEmu = (mm: number): number => Math.round(mm * 36_000);
const halfPt = (pt: number): number => Math.round(pt * 2);
const hex = (color: string): string => color.slice(1).toUpperCase();

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

interface ImagePart {
  specPath: string;
  entryName: string;
  rId: string;
  bytes: Uint8Array;
  widthMm: number;
  heightMm: number;
  contentType: string;
}

interface RenderPlan {
  images: ImagePart[];
  /** url → rId, first occurrence wins. */
  links: Map<string, string>;
  /** One concrete numbering instance per list block, in block order. */
  listNumIds: { numId: number; ordered: boolean }[];
}

/** Pre-size images and assign every deterministic id up front. */
function planRender(spec: DocSpec, imageBytes: ReadonlyMap<string, Uint8Array>, contentWidthMm: number): RenderPlan {
  const images: ImagePart[] = [];
  const links = new Map<string, string>();
  const listNumIds: { numId: number; ordered: boolean }[] = [];
  for (const block of spec.blocks) {
    if (block.kind === 'image') {
      const bytes = imageBytes.get(block.path);
      if (bytes === undefined) throw new ArtifactError(`image bytes missing for "${block.path}"`, 'render-input');
      const info = imageInfo(bytes);
      if (info === null) throw new ArtifactError(`"${block.path}" is not a readable PNG or JPEG`, 'render-input');
      const n = images.length + 1;
      const naturalWidthMm = (info.width / 96) * 25.4;
      const widthMm = Math.min(block.widthMm ?? naturalWidthMm, contentWidthMm);
      images.push({
        specPath: block.path,
        entryName: `word/media/image${n}.${info.extension}`,
        rId: `rIdImg${n}`,
        bytes,
        widthMm,
        heightMm: widthMm * (info.height / info.width),
        contentType: info.contentType,
      });
    } else if (block.kind === 'list') {
      listNumIds.push({ numId: listNumIds.length + 1, ordered: block.ordered === true });
    }
    const runs = block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'quote' ? block.runs : [];
    const nested = block.kind === 'list' ? block.items.flatMap((i) => i.runs) : block.kind === 'table' ? block.rows.flat(2) : [];
    for (const run of [...runs, ...nested]) {
      if (run.link !== undefined && !links.has(run.link)) links.set(run.link, `rIdLink${links.size + 1}`);
    }
  }
  return { images, links, listNumIds };
}

/**
 * Run properties in CT_RPr's SCHEMA SEQUENCE (rStyle, rFonts, b, i, color, u, shd). Word is
 * lenient about the order; strict validators are not, and this file claims to emit valid OOXML.
 */
function runProps(run: DocRun, theme: ResolvedTheme, extra?: { styleId?: string }): string {
  const parts: string[] = [];
  if (extra?.styleId !== undefined) parts.push(`<w:rStyle w:val="${extra.styleId}"/>`);
  if (run.code === true) parts.push(`<w:rFonts w:ascii="${ea(theme.monoFont)}" w:hAnsi="${ea(theme.monoFont)}"/>`);
  if (run.bold === true) parts.push('<w:b/>');
  if (run.italic === true) parts.push('<w:i/>');
  if (run.color !== undefined) parts.push(`<w:color w:val="${hex(run.color)}"/>`);
  if (run.underline === true) parts.push('<w:u w:val="single"/>');
  if (run.code === true) parts.push('<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>');
  return parts.length > 0 ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}

/** Text → the INNER children of a w:r: w:t segments with real w:br / w:tab between them. */
function runInner(text: string): string {
  const pieces: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) {
      const preserve = current !== current.trim() ? ' xml:space="preserve"' : '';
      pieces.push(`<w:t${preserve}>${et(current)}</w:t>`);
      current = '';
    }
  };
  for (const ch of text) {
    if (ch === '\n') {
      flush();
      pieces.push('<w:br/>');
    } else if (ch === '\t') {
      flush();
      pieces.push('<w:tab/>');
    } else if (ch !== '\r') {
      current += ch;
    }
  }
  flush();
  return pieces.join('');
}

/** One logical run → a w:r element; embedded \n and \t become real breaks and tabs. */
function renderRunText(text: string, rPr: string): string {
  const inner = runInner(text);
  return inner.length > 0 ? `<w:r>${rPr}${inner}</w:r>` : '';
}

function renderRuns(runs: readonly DocRun[], theme: ResolvedTheme, plan: RenderPlan): string {
  return runs
    .map((run) => {
      if (run.link !== undefined) {
        const rId = plan.links.get(run.link)!;
        const inner = renderRunText(run.text, runProps(run, theme, { styleId: 'Hyperlink' }));
        return inner.length > 0 ? `<w:hyperlink r:id="${rId}">${inner}</w:hyperlink>` : '';
      }
      return renderRunText(run.text, runProps(run, theme));
    })
    .join('');
}

// TRANSITIONAL ST_Jc values (this file declares the 2006 transitional namespace): `start`/`end`
// are the ISO-strict spellings, which older readers ignore — silently left-aligning a right-
// aligned paragraph.
const JC: Record<string, string> = { left: 'left', center: 'center', right: 'right', justify: 'both' };

function renderImageParagraph(img: ImagePart, n: number, align: string | undefined, theme: ResolvedTheme, caption?: string): string {
  const cx = mmToEmu(img.widthMm);
  const cy = mmToEmu(img.heightMm);
  const jc = `<w:pPr><w:jc w:val="${JC[align ?? 'center']}"/></w:pPr>`;
  const drawing =
    `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${n}" name="Image ${n}"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="Image ${n}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${img.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  const captionP =
    caption !== undefined ? `<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr>${renderRunText(caption, '')}</w:p>` : '';
  return `<w:p>${jc}<w:r>${drawing}</w:r></w:p>${captionP}`;
}

function renderTable(block: Extract<DocSpec['blocks'][number], { kind: 'table' }>, theme: ResolvedTheme, plan: RenderPlan, contentWidthTwip: number, accent: string): string {
  const cols = block.rows[0]!.length;
  const pcts = block.columnsPct ?? Array.from({ length: cols }, () => 100 / cols);
  const border = (name: string): string => `<w:${name} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
  const grid = pcts.map((p) => `<w:gridCol w:w="${Math.round((contentWidthTwip * p) / 100)}"/>`).join('');
  const headerRow = block.headerRow !== false;
  const rows = block.rows
    .map((row, ri) => {
      const isHeader = headerRow && ri === 0;
      const cells = row
        .map((cellRuns, ci) => {
          const shd = isHeader ? `<w:shd w:val="clear" w:color="auto" w:fill="${accent}"/>` : '';
          const runs = isHeader ? cellRuns.map((r) => ({ ...r, bold: true, color: r.color ?? '#FFFFFF' })) : [...cellRuns];
          return (
            `<w:tc><w:tcPr><w:tcW w:w="${Math.round((pcts[ci] ?? 100 / cols) * 50)}" w:type="pct"/>${shd}</w:tcPr>` +
            `<w:p>${renderRuns(runs, theme, plan)}</w:p></w:tc>`
          );
        })
        .join('');
      return `<w:tr>${isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
    })
    .join('');
  return (
    '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>' +
    `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>` +
    '<w:tblLayout w:type="fixed"/></w:tblPr>' +
    `<w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>` +
    // A bare paragraph after every table: two adjacent tables otherwise MERGE in Word.
    '<w:p/>'
  );
}

/** Header/footer text with `{...}` tokens → literal runs + real field runs. */
function renderFieldText(text: string, title: string): string {
  const fld = (instr: string): string =>
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  let out = '';
  const re = /\{(pageNumber|totalPages|date|title)\}/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out += renderRunText(text.slice(last, m.index), '');
    if (m[1] === 'pageNumber') out += fld('PAGE');
    else if (m[1] === 'totalPages') out += fld('NUMPAGES');
    else if (m[1] === 'date') out += fld('DATE \\@ "yyyy-MM-dd"');
    else out += renderRunText(title, '');
    last = m.index + m[0]!.length;
  }
  if (last < text.length) out += renderRunText(text.slice(last), '');
  return out;
}

function headerFooterPart(
  root: 'w:hdr' | 'w:ftr',
  hf: { left?: string | undefined; center?: string | undefined; right?: string | undefined },
  title: string,
  contentWidthTwip: number,
  theme: ResolvedTheme,
): string {
  const tabs =
    `<w:tabs><w:tab w:val="center" w:pos="${Math.round(contentWidthTwip / 2)}"/>` +
    `<w:tab w:val="right" w:pos="${contentWidthTwip}"/></w:tabs>`;
  const size = `<w:rPr><w:sz w:val="${halfPt(theme.baseSizePt - 2)}"/><w:color w:val="595959"/></w:rPr>`;
  const seg = (s: string | undefined): string => (s === undefined ? '' : renderFieldText(s, title));
  const body =
    `<w:p><w:pPr>${tabs}<w:rPr/></w:pPr>` +
    seg(hf.left) +
    `<w:r>${size}<w:tab/></w:r>` +
    seg(hf.center) +
    `<w:r>${size}<w:tab/></w:r>` +
    seg(hf.right) +
    '</w:p>';
  return `${DECL}<${root} ${W_NS}>${body}</${root}>`;
}

function stylesXml(spec: DocSpec, theme: ResolvedTheme): string {
  const lang = spec.meta.language ?? 'en';
  const heading = (level: number): string =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
    `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
    '<w:pPr><w:keepNext/><w:keepLines/>' +
    `<w:spacing w:before="${level === 1 ? 360 : 240}" w:after="${level === 1 ? 160 : 120}"/>` +
    `<w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="${ea(theme.headingFont)}" w:hAnsi="${ea(theme.headingFont)}"/>` +
    `${level >= 3 ? '<w:b/>' : ''}<w:color w:val="${hex(theme.accentColor)}"/>` +
    `<w:sz w:val="${halfPt(headingSizePt(theme, level))}"/></w:rPr></w:style>`;
  return (
    `${DECL}<w:styles ${W_NS}>` +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    `<w:rFonts w:ascii="${ea(theme.bodyFont)}" w:hAnsi="${ea(theme.bodyFont)}"/>` +
    `<w:sz w:val="${halfPt(theme.baseSizePt)}"/><w:lang w:val="${ea(lang)}"/>` +
    '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>' +
    `<w:spacing w:after="${Math.round(theme.paragraphSpacingPt * 20)}" w:line="${Math.round(240 * theme.lineSpacing)}" w:lineRule="auto"/>` +
    '</w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    heading(1) +
    heading(2) +
    heading(3) +
    heading(4) +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
    '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:spacing w:after="120" w:line="240" w:lineRule="auto"/></w:pPr>' +
    `<w:rPr><w:rFonts w:ascii="${ea(theme.monoFont)}" w:hAnsi="${ea(theme.monoFont)}"/><w:sz w:val="${halfPt(theme.baseSizePt - 1)}"/></w:rPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/>' +
    `<w:pPr><w:jc w:val="center"/><w:spacing w:after="200"/></w:pPr><w:rPr><w:i/><w:sz w:val="${halfPt(theme.baseSizePt - 2)}"/><w:color w:val="595959"/></w:rPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:contextualSpacing/></w:pPr></w:style>' +
    '</w:styles>'
  );
}

function numberingXml(listNumIds: readonly { numId: number; ordered: boolean }[]): string {
  const bulletLvls = ['•', 'o', '▪']
    .map(
      (ch, lvl) =>
        `<w:lvl w:ilvl="${lvl}"><w:numFmt w:val="bullet"/><w:lvlText w:val="${et(ch)}"/>` +
        `<w:pPr><w:ind w:left="${720 * (lvl + 1)}" w:hanging="360"/></w:pPr></w:lvl>`,
    )
    .join('');
  const decimalLvls = [0, 1, 2]
    .map(
      (lvl) =>
        `<w:lvl w:ilvl="${lvl}"><w:start w:val="1"/><w:numFmt w:val="decimal"/>` +
        `<w:lvlText w:val="%${lvl + 1}."/>` +
        `<w:pPr><w:ind w:left="${720 * (lvl + 1)}" w:hanging="360"/></w:pPr></w:lvl>`,
    )
    .join('');
  const nums = listNumIds
    .map((l) => `<w:num w:numId="${l.numId}"><w:abstractNumId w:val="${l.ordered ? 1 : 0}"/></w:num>`)
    .join('');
  return (
    `${DECL}<w:numbering ${W_NS}>` +
    `<w:abstractNum w:abstractNumId="0">${bulletLvls}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1">${decimalLvls}</w:abstractNum>` +
    nums +
    '</w:numbering>'
  );
}

/** Render a validated DocSpec plus its (already policy-validated) image bytes to DOCX. */
export function renderDocx(spec: DocSpec, imageBytes: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const theme = resolveTheme(spec);
  const page = resolvePage(spec);
  const contentWidthMm = page.widthMm - page.margins.leftMm - page.margins.rightMm;
  const contentWidthTwip = mmToTwip(contentWidthMm);
  const plan = planRender(spec, imageBytes, contentWidthMm);

  const accent = hex(theme.accentColor);
  const bodyParts: string[] = [];
  let imageIdx = 0;
  let listIdx = 0;
  for (const block of spec.blocks) {
    if (block.kind === 'heading') {
      bodyParts.push(`<w:p><w:pPr><w:pStyle w:val="Heading${block.level}"/></w:pPr>${renderRuns(block.runs, theme, plan)}</w:p>`);
    } else if (block.kind === 'paragraph') {
      const jc = block.align !== undefined ? `<w:pPr><w:jc w:val="${JC[block.align]}"/></w:pPr>` : '';
      bodyParts.push(`<w:p>${jc}${renderRuns(block.runs, theme, plan)}</w:p>`);
    } else if (block.kind === 'quote') {
      bodyParts.push(`<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr>${renderRuns(block.runs, theme, plan)}</w:p>`);
    } else if (block.kind === 'code') {
      const lines = block.text.replace(/\r\n?/g, '\n').split('\n');
      const runs = lines
        .map((line, i) => {
          // Tabs go through the SAME `<w:tab/>` conversion every other text path uses — a raw
          // #x9 inside w:t renders at the reader's mercy, and code is the most
          // indentation-sensitive block there is (the HTML twin keeps real tabs via <pre>).
          const t = runInner(line);
          return `<w:r>${i < lines.length - 1 ? `${t}<w:br/>` : t}</w:r>`;
        })
        .join('');
      bodyParts.push(`<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>${runs}</w:p>`);
    } else if (block.kind === 'list') {
      const numId = plan.listNumIds[listIdx]!.numId;
      listIdx += 1;
      for (const item of block.items) {
        bodyParts.push(
          `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${item.level ?? 0}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>` +
            `${renderRuns(item.runs, theme, plan)}</w:p>`,
        );
      }
    } else if (block.kind === 'table') {
      bodyParts.push(renderTable(block, theme, plan, contentWidthTwip, accent));
    } else if (block.kind === 'image') {
      const img = plan.images[imageIdx]!;
      imageIdx += 1;
      bodyParts.push(renderImageParagraph(img, imageIdx, block.align, theme, block.caption));
    } else {
      bodyParts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    }
  }

  const landscape = spec.page?.orientation === 'landscape';
  const sectPr =
    '<w:sectPr>' +
    (spec.header !== undefined ? '<w:headerReference w:type="default" r:id="rId3"/>' : '') +
    (spec.footer !== undefined ? '<w:footerReference w:type="default" r:id="rId4"/>' : '') +
    `<w:pgSz w:w="${mmToTwip(page.widthMm)}" w:h="${mmToTwip(page.heightMm)}"${landscape ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${mmToTwip(page.margins.topMm)}" w:right="${mmToTwip(page.margins.rightMm)}" ` +
    `w:bottom="${mmToTwip(page.margins.bottomMm)}" w:left="${mmToTwip(page.margins.leftMm)}" w:header="708" w:footer="708" w:gutter="0"/>` +
    '</w:sectPr>';

  const documentXml = `${DECL}<w:document ${W_NS}><w:body>${bodyParts.join('')}${sectPr}</w:body></w:document>`;

  const documentRels =
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    (spec.header !== undefined
      ? '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'
      : '') +
    (spec.footer !== undefined
      ? '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
      : '') +
    plan.images
      .map(
        (img) =>
          `<Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${ea(img.entryName.replace('word/', ''))}"/>`,
      )
      .join('') +
    [...plan.links.entries()]
      .map(
        ([url, rId]) =>
          `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${ea(url)}" TargetMode="External"/>`,
      )
      .join('') +
    '</Relationships>';

  const contentTypes =
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    (spec.header !== undefined
      ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
      : '') +
    (spec.footer !== undefined
      ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
      : '') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';

  // FIXED timestamps: the artifact's identity is its content, not its render time. The render
  // evidence (artifact.rendered) carries the real wall clock.
  const coreXml =
    `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${et(spec.meta.title)}</dc:title>` +
    (spec.meta.author !== undefined ? `<dc:creator>${et(spec.meta.author)}</dc:creator>` : '') +
    (spec.meta.subject !== undefined ? `<dc:subject>${et(spec.meta.subject)}</dc:subject>` : '') +
    (spec.meta.keywords !== undefined ? `<cp:keywords>${et(spec.meta.keywords)}</cp:keywords>` : '') +
    '<cp:revision>1</cp:revision>' +
    '<dcterms:created xsi:type="dcterms:W3CDTF">2001-01-01T00:00:00Z</dcterms:created>' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">2001-01-01T00:00:00Z</dcterms:modified>' +
    '</cp:coreProperties>';

  const appXml =
    `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
    '<Application>Agent CLI</Application></Properties>';

  const rootRels =
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';

  const entries: Record<string, Uint8Array | string> = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rootRels,
    'word/document.xml': documentXml,
    'word/_rels/document.xml.rels': documentRels,
    'word/styles.xml': stylesXml(spec, theme),
    'word/numbering.xml': numberingXml(plan.listNumIds),
    'docProps/core.xml': coreXml,
    'docProps/app.xml': appXml,
  };
  if (spec.header !== undefined) entries['word/header1.xml'] = headerFooterPart('w:hdr', spec.header, spec.meta.title, contentWidthTwip, theme);
  if (spec.footer !== undefined) entries['word/footer1.xml'] = headerFooterPart('w:ftr', spec.footer, spec.meta.title, contentWidthTwip, theme);
  for (const img of plan.images) entries[img.entryName] = img.bytes;

  return zipDeterministic(entries);
}
