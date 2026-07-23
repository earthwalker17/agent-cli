/**
 * Per-language symbol + import extraction (Session 10). Deterministic, line-anchored regex
 * heuristics — declared as heuristics, never parsed truth. V1 supports the TS/JS family and
 * Python; every other language ranks via path/lexical/git signals only, and every rendered
 * surface states that coverage honestly.
 *
 * Injection defense is STRUCTURAL: symbol capture groups are strict identifier classes
 * (bounded length), and import specifiers pass a conservative charset filter — repository
 * content cannot smuggle prose, delimiters, or control characters into the system prompt
 * through this path. (Rendered paths are additionally sanitized at render time.)
 */

export type LangId = 'ts' | 'py';

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  exported: boolean;
}

export interface FileFacts {
  /** null = read but not extractable (binary or unsupported — kept so the store need not re-read). */
  lang: LangId | null;
  symbols: SymbolInfo[];
  /** Raw import specifiers (charset-filtered); resolution to files happens in graph.ts. */
  imports: string[];
}

export const MAX_SYMBOLS_PER_FILE = 64;
export const MAX_IMPORTS_PER_FILE = 64;
export const MAX_EXTRACT_BYTES = 256 * 1024;
const MAX_LINES = 20_000;
const MAX_LINE_CHARS = 500;

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** Extension → supported language; null = rank-by-other-signals only. */
export function langForPath(relPath: string): LangId | null {
  const dot = relPath.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = relPath.slice(dot).toLowerCase();
  if (TS_EXTS.has(ext)) return 'ts';
  if (ext === '.py') return 'py';
  return null;
}

// Strict identifier class, bounded — the structural injection defense.
const ID = String.raw`([A-Za-z_$][A-Za-z0-9_$]{0,127})`;

interface SymbolPattern {
  re: RegExp;
  kind: SymbolKind;
  exported: boolean;
}

const TS_SYMBOLS: SymbolPattern[] = [
  { re: new RegExp(String.raw`^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*${ID}`), kind: 'function', exported: true },
  { re: new RegExp(String.raw`^export\s+(?:default\s+)?(?:abstract\s+)?class\s+${ID}`), kind: 'class', exported: true },
  { re: new RegExp(String.raw`^export\s+interface\s+${ID}`), kind: 'interface', exported: true },
  { re: new RegExp(String.raw`^export\s+type\s+${ID}`), kind: 'type', exported: true },
  { re: new RegExp(String.raw`^export\s+(?:declare\s+)?(?:const\s+)?enum\s+${ID}`), kind: 'enum', exported: true },
  { re: new RegExp(String.raw`^export\s+(?:const|let|var)\s+${ID}`), kind: 'const', exported: true },
  { re: new RegExp(String.raw`^(?:async\s+)?function\s*\*?\s*${ID}`), kind: 'function', exported: false },
  { re: new RegExp(String.raw`^(?:abstract\s+)?class\s+${ID}`), kind: 'class', exported: false },
  { re: new RegExp(String.raw`^interface\s+${ID}`), kind: 'interface', exported: false },
  { re: new RegExp(String.raw`^type\s+${ID}\s*=`), kind: 'type', exported: false },
  { re: new RegExp(String.raw`^(?:const|let|var)\s+${ID}\s*=`), kind: 'const', exported: false },
];

const PY_ID = String.raw`([A-Za-z_][A-Za-z0-9_]{0,127})`;
const PY_SYMBOLS: Array<{ re: RegExp; kind: SymbolKind }> = [
  { re: new RegExp(String.raw`^(?:async\s+)?def\s+${PY_ID}`), kind: 'function' },
  { re: new RegExp(String.raw`^class\s+${PY_ID}`), kind: 'class' },
];

// Import specifiers: first string literal of line-anchored import/export-from forms, plus
// require()/import() anywhere in a line. The charset filter below is the gate.
const TS_IMPORTS: RegExp[] = [
  new RegExp(String.raw`^import\s+(?:type\s+)?(?:[^'"]*\sfrom\s+)?['"]([^'"]{1,256})['"]`),
  new RegExp(String.raw`^export\s+(?:type\s+)?[^'"]*\sfrom\s+['"]([^'"]{1,256})['"]`),
  new RegExp(String.raw`\brequire\(\s*['"]([^'"]{1,256})['"]\s*\)`),
  new RegExp(String.raw`\bimport\(\s*['"]([^'"]{1,256})['"]\s*\)`),
];
const PY_IMPORTS: RegExp[] = [
  new RegExp(String.raw`^from\s+([.A-Za-z0-9_]{1,256})\s+import\b`),
  new RegExp(String.raw`^import\s+([.A-Za-z0-9_]{1,256})\b`),
];

const SPECIFIER_OK = /^[A-Za-z0-9_@.\/~:-]+$/;

/**
 * Extract symbols + imports from one file's content. `content` must already be sliced to
 * MAX_EXTRACT_BYTES by the caller (the store enforces size eligibility before reading).
 */
export function extractFileFacts(relPath: string, content: string): FileFacts {
  const lang = langForPath(relPath);
  if (lang === null) return { lang: null, symbols: [], imports: [] };

  const symbols: SymbolInfo[] = [];
  const seenSymbols = new Set<string>();
  const imports: string[] = [];
  const seenImports = new Set<string>();

  const lines = content.split('\n', MAX_LINES);
  for (const raw of lines) {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE && imports.length >= MAX_IMPORTS_PER_FILE) break;
    const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;

    if (symbols.length < MAX_SYMBOLS_PER_FILE) {
      if (lang === 'ts') {
        for (const p of TS_SYMBOLS) {
          const m = p.re.exec(line);
          if (m?.[1] !== undefined) {
            const key = `${p.kind}:${m[1]}`;
            if (!seenSymbols.has(key)) {
              seenSymbols.add(key);
              symbols.push({ name: m[1], kind: p.kind, exported: p.exported });
            }
            break; // first pattern wins per line
          }
        }
      } else {
        for (const p of PY_SYMBOLS) {
          const m = p.re.exec(line);
          if (m?.[1] !== undefined) {
            const key = `${p.kind}:${m[1]}`;
            if (!seenSymbols.has(key)) {
              seenSymbols.add(key);
              // Python convention: a leading underscore marks a module-private name.
              symbols.push({ name: m[1], kind: p.kind, exported: !m[1].startsWith('_') });
            }
            break;
          }
        }
      }
    }

    if (imports.length < MAX_IMPORTS_PER_FILE) {
      for (const re of lang === 'ts' ? TS_IMPORTS : PY_IMPORTS) {
        const m = re.exec(line);
        if (m?.[1] !== undefined && SPECIFIER_OK.test(m[1]) && !seenImports.has(m[1])) {
          seenImports.add(m[1]);
          imports.push(m[1]);
          break;
        }
      }
    }
  }

  return { lang, symbols, imports };
}
