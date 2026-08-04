/**
 * Shared OPC (Open Packaging Conventions) readers used by the docx/pptx/xlsx summaries:
 * docProps metadata, media inventories, and relationship maps. All tolerant — a missing or
 * unparseable part degrades to a warning, never a throw (the summary's coverage says so).
 */

import type { ArtifactMetadata, MediaEntry } from './types.js';
import type { OpenedZip } from './zip.js';
import { attr, childElements, directText, firstChild, parseXmlBounded, walkElements, type XmlElement } from './xml.js';

const CAP = 300;

const clip = (s: string): string => (s.length > CAP ? `${s.slice(0, CAP)}…` : s);

/** docProps/core.xml + docProps/app.xml → metadata; failures become warnings. */
export function readOoxmlMetadata(zip: OpenedZip, warnings: string[]): ArtifactMetadata {
  const meta: ArtifactMetadata = {};
  const core = zip.text('docProps/core.xml');
  if (core !== null) {
    try {
      const doc = parseXmlBounded(core, 'docProps/core.xml');
      const root = childElements(doc)[0];
      if (root !== undefined) {
        for (const el of walkElements(root)) {
          const text = clip(directText(el).trim());
          if (text.length === 0) continue;
          if (el.name === 'dc:title') meta.title = text;
          else if (el.name === 'dc:creator') meta.author = text;
          else if (el.name === 'dc:subject') meta.subject = text;
          else if (el.name === 'cp:keywords') meta.keywords = text;
          else if (el.name === 'dcterms:created') meta.created = text;
          else if (el.name === 'dcterms:modified') meta.modified = text;
        }
      }
    } catch {
      warnings.push('docProps/core.xml unreadable; document metadata omitted');
    }
  }
  const app = zip.text('docProps/app.xml');
  if (app !== null) {
    try {
      const doc = parseXmlBounded(app, 'docProps/app.xml');
      const root = childElements(doc)[0];
      const application = root === undefined ? null : firstChild(root, 'Application');
      if (application !== null) {
        const text = clip(directText(application).trim());
        if (text.length > 0) meta.application = text;
      }
    } catch {
      warnings.push('docProps/app.xml unreadable; producing application omitted');
    }
  }
  return meta;
}

/** Entries under a media directory (`word/media/`, `ppt/media/`), name + size only. */
export function mediaInventory(zip: OpenedZip, dirPrefix: string): MediaEntry[] {
  const out: MediaEntry[] = [];
  for (const name of zip.names) {
    if (!name.startsWith(dirPrefix)) continue;
    out.push({ name, bytes: zip.bytes(name)?.length ?? 0 });
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * A part's relationship map (`Id → Target`), resolved against the part's own directory.
 * Targets are normalized to zip-entry form; anything escaping the package is dropped.
 */
export function readRelationships(zip: OpenedZip, relsPath: string, baseDir: string, warnings: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const xml = zip.text(relsPath);
  if (xml === null) return map;
  let doc;
  try {
    doc = parseXmlBounded(xml, relsPath);
  } catch {
    warnings.push(`${relsPath} unreadable; relationship-ordered content may be incomplete`);
    return map;
  }
  const root = firstChild(doc, 'Relationships');
  if (root === null) return map;
  for (const rel of childElements(root, 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id === null || target === null) continue;
    if (attr(rel, 'TargetMode') === 'External') continue;
    const resolved = resolveTarget(baseDir, target);
    if (resolved !== null) map.set(id, resolved);
  }
  return map;
}

/** Resolve an OPC relationship target against a base dir, refusing package escapes. */
function resolveTarget(baseDir: string, target: string): string | null {
  const raw = target.startsWith('/') ? target.slice(1) : `${baseDir}${baseDir.length > 0 ? '/' : ''}${target}`;
  const parts: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.length === 0 ? null : parts.join('/');
}

/** Concatenated bounded text of the named descendant elements, in document order. */
export function collectDescendantText(root: XmlElement, names: readonly string[], cap = CAP): string {
  let out = '';
  for (const el of walkElements(root)) {
    if (!names.includes(el.name)) continue;
    out += directText(el);
    if (out.length >= cap) return `${out.slice(0, cap)}…`;
  }
  return out;
}
