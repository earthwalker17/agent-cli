/**
 * Per-language symbol + import extraction (Session 10; Session 18 adds Rust, Go, and C/C++).
 * Deterministic, line-anchored regex heuristics — declared as heuristics, never parsed truth.
 * Supported: the TS/JS family, Python, Rust, Go, and C/C++ (one `c-cpp` id — a `.h` is not
 * attributable to either language). Every other language ranks via path/lexical/git signals
 * only, and every rendered surface states that coverage honestly.
 *
 * Injection defense is STRUCTURAL: symbol capture groups are strict identifier classes
 * (bounded length), and import specifiers pass a conservative charset filter — repository
 * content cannot smuggle prose, delimiters, or control characters into the system prompt
 * through this path. (Rendered paths are additionally sanitized at render time.)
 *
 * Column-0 anchoring is a shared recall property: module-level items only. Nested defs (Python),
 * `impl` methods (Rust), and class members stay invisible by design — the map names what a file
 * IS, and live reads answer what is inside it.
 */

export type LangId = 'ts' | 'py' | 'rust' | 'go' | 'c-cpp';

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'struct' | 'trait' | 'mod' | 'macro';

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
const C_EXTS = new Set(['.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cxx', '.hxx']);
const C_HEADER_EXTS = new Set(['.h', '.hpp', '.hh', '.hxx']);

/** Extension → supported language; null = rank-by-other-signals only. */
export function langForPath(relPath: string): LangId | null {
  const dot = relPath.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = relPath.slice(dot).toLowerCase();
  if (TS_EXTS.has(ext)) return 'ts';
  if (ext === '.py') return 'py';
  if (ext === '.rs') return 'rust';
  if (ext === '.go') return 'go';
  if (C_EXTS.has(ext)) return 'c-cpp';
  return null;
}

// Strict identifier classes, bounded — the structural injection defense.
const ID = String.raw`([A-Za-z_$][A-Za-z0-9_$]{0,127})`;
const WORD_ID = String.raw`([A-Za-z_][A-Za-z0-9_]{0,127})`;

interface SymbolPattern {
  re: RegExp;
  kind: SymbolKind;
  /** A boolean, or derived from the captured name (Python underscore, Go case). */
  exported: boolean | ((name: string) => boolean);
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

const pyExported = (name: string): boolean => !name.startsWith('_');
const PY_SYMBOLS: SymbolPattern[] = [
  { re: new RegExp(String.raw`^(?:async\s+)?def\s+${WORD_ID}`), kind: 'function', exported: pyExported },
  { re: new RegExp(String.raw`^class\s+${WORD_ID}`), kind: 'class', exported: pyExported },
];

/**
 * Rust (Session 18): `pub`-prefixed items are the exported surface (any `pub(...)` restriction
 * still reads as visible beyond the file). Methods live inside `impl` blocks at indentation ≥1
 * and are excluded by the column-0 anchor, matching the shared recall property.
 */
const RUST_PUB = String.raw`^pub(?:\([^)]{0,64}\))?\s+`;
const RUST_FN = String.raw`(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]{0,32}"\s+)?fn\s+`;
const RUST_SYMBOLS: SymbolPattern[] = [
  { re: new RegExp(RUST_PUB + RUST_FN + WORD_ID), kind: 'function', exported: true },
  { re: new RegExp(RUST_PUB + String.raw`struct\s+` + WORD_ID), kind: 'struct', exported: true },
  { re: new RegExp(RUST_PUB + String.raw`enum\s+` + WORD_ID), kind: 'enum', exported: true },
  { re: new RegExp(RUST_PUB + String.raw`(?:unsafe\s+)?trait\s+` + WORD_ID), kind: 'trait', exported: true },
  { re: new RegExp(RUST_PUB + String.raw`type\s+` + WORD_ID), kind: 'type', exported: true },
  { re: new RegExp(RUST_PUB + String.raw`(?:const|static)\s+` + WORD_ID), kind: 'const', exported: true },
  { re: new RegExp(RUST_PUB + String.raw`mod\s+` + WORD_ID), kind: 'mod', exported: true },
  { re: new RegExp(String.raw`^` + RUST_FN + WORD_ID), kind: 'function', exported: false },
  { re: new RegExp(String.raw`^struct\s+` + WORD_ID), kind: 'struct', exported: false },
  { re: new RegExp(String.raw`^enum\s+` + WORD_ID), kind: 'enum', exported: false },
  { re: new RegExp(String.raw`^(?:unsafe\s+)?trait\s+` + WORD_ID), kind: 'trait', exported: false },
  { re: new RegExp(String.raw`^mod\s+` + WORD_ID), kind: 'mod', exported: false },
  { re: new RegExp(String.raw`^macro_rules!\s+` + WORD_ID), kind: 'macro', exported: false },
];

/** Go (Session 18): exported IS the name's case — the language's own rule. */
const goExported = (name: string): boolean => /^[A-Z]/.test(name);
const GO_SYMBOLS: SymbolPattern[] = [
  { re: new RegExp(String.raw`^func\s+(?:\([^)]{1,80}\)\s+)?${WORD_ID}`), kind: 'function', exported: goExported },
  { re: new RegExp(String.raw`^type\s+${WORD_ID}\s+struct\b`), kind: 'struct', exported: goExported },
  { re: new RegExp(String.raw`^type\s+${WORD_ID}\s+interface\b`), kind: 'interface', exported: goExported },
  { re: new RegExp(String.raw`^type\s+${WORD_ID}`), kind: 'type', exported: goExported },
  { re: new RegExp(String.raw`^(?:const|var)\s+${WORD_ID}`), kind: 'const', exported: goExported },
];

/**
 * C/C++ (Session 18): deliberately MINIMAL and declared as such. Aggregate/type names, macros,
 * and one conservative column-0 function pattern that requires at least one preceding type token
 * (which is what keeps `if (`, bare macro invocations, and call statements out). `exported` is
 * resolved per file: a header's declarations are its public surface.
 */
const C_SYMBOLS: SymbolPattern[] = [
  { re: new RegExp(String.raw`^(?:typedef\s+)?(?:struct|union)\s+${WORD_ID}`), kind: 'struct', exported: false },
  { re: new RegExp(String.raw`^(?:typedef\s+)?enum\s+${WORD_ID}`), kind: 'enum', exported: false },
  { re: new RegExp(String.raw`^(?:template\s*<[^>]{0,80}>\s*)?class\s+${WORD_ID}`), kind: 'class', exported: false },
  { re: new RegExp(String.raw`^#\s*define\s+${WORD_ID}`), kind: 'macro', exported: false },
  { re: new RegExp(String.raw`^(?!#)(?:[A-Za-z_][A-Za-z0-9_]*[\s*]+){1,4}${WORD_ID}\s*\(`), kind: 'function', exported: false },
];

const LANG_SYMBOLS: Record<LangId, SymbolPattern[]> = {
  ts: TS_SYMBOLS,
  py: PY_SYMBOLS,
  rust: RUST_SYMBOLS,
  go: GO_SYMBOLS,
  'c-cpp': C_SYMBOLS,
};

interface ImportPattern {
  re: RegExp;
  /** Optional shaping of the captured specifier (e.g. rust `mod x;` → `mod::x`). */
  map?: (s: string) => string;
}

// Import specifiers: first string literal of line-anchored import/export-from forms, plus
// require()/import() anywhere in a line. The charset filter below is the gate.
const TS_IMPORTS: ImportPattern[] = [
  { re: new RegExp(String.raw`^import\s+(?:type\s+)?(?:[^'"]*\sfrom\s+)?['"]([^'"]{1,256})['"]`) },
  { re: new RegExp(String.raw`^export\s+(?:type\s+)?[^'"]*\sfrom\s+['"]([^'"]{1,256})['"]`) },
  { re: new RegExp(String.raw`\brequire\(\s*['"]([^'"]{1,256})['"]\s*\)`) },
  { re: new RegExp(String.raw`\bimport\(\s*['"]([^'"]{1,256})['"]\s*\)`) },
];
const PY_IMPORTS: ImportPattern[] = [
  { re: new RegExp(String.raw`^from\s+([.A-Za-z0-9_]{1,256})\s+import\b`) },
  { re: new RegExp(String.raw`^import\s+([.A-Za-z0-9_]{1,256})\b`) },
];
// Rust: `use` paths (the capture stops before `::{group}` braces) and `mod x;` declarations,
// which are the crate's file-tree edges — shaped as a `mod::` pseudo-specifier for the resolver.
const RUST_IMPORTS: ImportPattern[] = [
  { re: new RegExp(String.raw`^(?:pub(?:\([^)]{0,64}\))?\s+)?use\s+([A-Za-z0-9_]+(?:::[A-Za-z0-9_]+)*)`) },
  { re: new RegExp(String.raw`^(?:pub(?:\([^)]{0,64}\))?\s+)?mod\s+${WORD_ID}\s*;`), map: (s) => `mod::${s}` },
];
// Go single-line form; the `import ( … )` block form needs one line of in-file state (below).
const GO_IMPORT_SINGLE = new RegExp(String.raw`^import\s+(?:[A-Za-z0-9_.]{1,64}\s+)?"([^"]{1,256})"`);
const GO_IMPORT_BLOCK_OPEN = /^import\s*\(\s*$/;
const GO_IMPORT_BLOCK_LINE = new RegExp(String.raw`^\s*(?:[A-Za-z0-9_.]{1,64}\s+)?"([^"]{1,256})"`);
const C_IMPORTS: ImportPattern[] = [{ re: new RegExp(String.raw`^\s*#\s*include\s+["<]([^">]{1,256})[">]`) }];

const LANG_IMPORTS: Record<LangId, ImportPattern[]> = {
  ts: TS_IMPORTS,
  py: PY_IMPORTS,
  rust: RUST_IMPORTS,
  go: [{ re: GO_IMPORT_SINGLE }],
  'c-cpp': C_IMPORTS,
};

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
  const patterns = LANG_SYMBOLS[lang];
  const importPatterns = LANG_IMPORTS[lang];
  // A header's declarations are its public surface; a .c/.cpp file's are internal by default.
  const cHeader = lang === 'c-cpp' && C_HEADER_EXTS.has(relPath.slice(relPath.lastIndexOf('.')).toLowerCase());
  let inGoImportBlock = false;

  const lines = content.split('\n', MAX_LINES);
  for (const raw of lines) {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE && imports.length >= MAX_IMPORTS_PER_FILE) break;
    const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;

    if (symbols.length < MAX_SYMBOLS_PER_FILE) {
      for (const p of patterns) {
        const m = p.re.exec(line);
        if (m?.[1] !== undefined) {
          const key = `${p.kind}:${m[1]}`;
          if (!seenSymbols.has(key)) {
            seenSymbols.add(key);
            const exported = cHeader ? true : typeof p.exported === 'function' ? p.exported(m[1]) : p.exported;
            symbols.push({ name: m[1], kind: p.kind, exported });
          }
          break; // first pattern wins per line
        }
      }
    }

    if (imports.length < MAX_IMPORTS_PER_FILE) {
      const push = (spec: string): void => {
        if (SPECIFIER_OK.test(spec) && !seenImports.has(spec)) {
          seenImports.add(spec);
          imports.push(spec);
        }
      };
      // Go's block form is the one construct here that spans lines; the flag is reset by the
      // closing paren and the file end, and a hostile file can at worst waste its own budget.
      if (lang === 'go') {
        if (inGoImportBlock) {
          if (/^\)/.test(line)) inGoImportBlock = false;
          else {
            const m = GO_IMPORT_BLOCK_LINE.exec(line);
            if (m?.[1] !== undefined) push(m[1]);
          }
          continue;
        }
        if (GO_IMPORT_BLOCK_OPEN.test(line)) {
          inGoImportBlock = true;
          continue;
        }
      }
      for (const p of importPatterns) {
        const m = p.re.exec(line);
        if (m?.[1] !== undefined) {
          push(p.map !== undefined ? p.map(m[1]) : m[1]);
          break;
        }
      }
    }
  }

  return { lang, symbols, imports };
}
