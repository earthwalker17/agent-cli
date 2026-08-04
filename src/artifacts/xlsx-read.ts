/**
 * XLSX: identification, metadata, and sheet inventory ONLY — spreadsheet content is out of the
 * documents pack's scope, and the coverage verdict says so structurally rather than implying a
 * shallow read was a full one.
 */

import type { XlsxSummary } from './types.js';
import type { OpenedZip } from './zip.js';
import { attr, childElements, firstChild, parseXmlBounded } from './xml.js';
import { mediaInventory, readOoxmlMetadata } from './opc.js';

export function readXlsx(zip: OpenedZip): XlsxSummary {
  const warnings: string[] = [];
  const metadata = readOoxmlMetadata(zip, warnings);
  const sheetNames: string[] = [];
  const wb = zip.text('xl/workbook.xml');
  if (wb !== null) {
    try {
      const doc = parseXmlBounded(wb, 'xl/workbook.xml');
      const root = firstChild(doc, 'workbook');
      const sheets = root === null ? null : firstChild(root, 'sheets');
      if (sheets !== null) {
        for (const sheet of childElements(sheets, 'sheet')) {
          const name = attr(sheet, 'name');
          if (name !== null) sheetNames.push(name.slice(0, 100));
          if (sheetNames.length >= 50) break;
        }
      }
    } catch {
      warnings.push('xl/workbook.xml unreadable; sheet names omitted');
    }
  }
  return {
    kind: 'xlsx',
    metadata,
    sheetNames,
    media: mediaInventory(zip, 'xl/media/'),
    warnings,
    coverage: 'structural',
    coverageReasons: ['spreadsheet content reading is outside the documents pack scope; names and metadata only'],
  };
}
