import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult, ToolSchema } from '../types.js';
import { validatePath } from '../policy/paths.js';
import { isSecretName } from '../policy/engine.js';
import { truncateForModel, sha256 } from '../shared/hash.js';
import { runCommandTool } from './run-command.js';

/** Resolve a model-supplied path through the one validator both policy and tools share. */
export function resolveForTool(ctx: ToolContext, p: string): string {
  return validatePath(ctx.workspaceRoot, p, ctx.stateDir ? { stateDir: ctx.stateDir } : {}).resolved;
}

function ok(output: string, extra: Partial<ToolResult> = {}): ToolResult {
  const t = truncateForModel(output);
  return {
    ok: true,
    output: t.text,
    truncated: t.truncated,
    durationMs: 0,
    ...(t.fullSha256 ? { fullOutputSha256: t.fullSha256 } : {}),
    ...extra,
  };
}
function fail(error: string): ToolResult {
  return { ok: false, output: '', error, truncated: false, durationMs: 0 };
}

/** Directory names never descended into by list/search (the gitignore-aware map lands in Phase 9). */
const WALK_EXCLUDES = new Set(['node_modules', '.git', '.agent-cli', 'dist', 'coverage']);

const MAX_READ_BYTES = 20 * 1024 * 1024;

// ── read_file ────────────────────────────────────────────────────────────────────────────────
const ReadInput = z.object({ path: z.string().describe('File path, relative to the workspace root') }).strict();
export const readFileTool: Tool<z.infer<typeof ReadInput>> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from the workspace. Returns file contents (truncated if very large).',
  schema: ReadInput,
  mutates: () => null,
  readsPaths: (i) => [i.path],
  async execute(input, ctx) {
    const abs = resolveForTool(ctx, input.path);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return fail(`file not found: ${input.path}`);
    }
    if (stat.isDirectory()) return fail(`${input.path} is a directory; use list_files`);
    if (stat.size > MAX_READ_BYTES) return fail(`file too large to read (${stat.size} bytes)`);
    return ok(fs.readFileSync(abs, 'utf8'));
  },
};

// ── list_files ───────────────────────────────────────────────────────────────────────────────
const ListInput = z
  .object({ path: z.string().optional().describe('Directory to list (default: workspace root)') })
  .strict();
export const listFilesTool: Tool<z.infer<typeof ListInput>> = {
  name: 'list_files',
  description: 'List the immediate entries of a workspace directory. Directories end with "/".',
  schema: ListInput,
  mutates: () => null,
  readsPaths: (i) => [i.path ?? '.'],
  async execute(input, ctx) {
    const abs = resolveForTool(ctx, input.path ?? '.');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return fail(`directory not found: ${input.path ?? '.'}`);
    }
    const lines = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .slice(0, 500);
    const note = entries.length > 500 ? `\n… (${entries.length - 500} more entries omitted)` : '';
    return ok(lines.join('\n') + note);
  },
};

// ── search ───────────────────────────────────────────────────────────────────────────────────
const SearchInput = z
  .object({
    pattern: z.string().describe('JavaScript regular expression to search for, line by line'),
    path: z.string().optional().describe('Directory to search under (default: workspace root)'),
    maxResults: z.number().int().positive().max(1000).optional(),
  })
  .strict();

const SEARCH_TIME_BUDGET_MS = 2000;
const SEARCH_MAX_FILES = 5000;
const SEARCH_MAX_LINE = 2000;

export const searchTool: Tool<z.infer<typeof SearchInput>> = {
  name: 'search',
  description:
    'Search workspace text files for a regex, line by line. Returns "relpath:line: text" matches. ' +
    'Bounded by time and file count; excludes node_modules/.git/dist and files that look like secrets.',
  schema: SearchInput,
  mutates: () => null,
  readsPaths: (i) => [i.path ?? '.'],
  async execute(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern);
    } catch (e) {
      return fail(`invalid regular expression: ${(e as Error).message}`);
    }
    const root = resolveForTool(ctx, input.path ?? '.');
    const limit = input.maxResults ?? 100;
    const start = Date.now();
    const results: string[] = [];
    let filesScanned = 0;
    let stoppedEarly = false;

    const walk = (dir: string): void => {
      if (stoppedEarly) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (stoppedEarly) return;
        if (e.isDirectory()) {
          if (!WALK_EXCLUDES.has(e.name)) walk(path.join(dir, e.name));
          continue;
        }
        // Skip secret-looking files so search can never spill credentials into results/prompt
        // (the policy gate can't enumerate grep matches ahead of time, so filter here).
        if (isSecretName(e.name)) continue;
        if (filesScanned >= SEARCH_MAX_FILES || Date.now() - start > SEARCH_TIME_BUDGET_MS) {
          stoppedEarly = true;
          return;
        }
        filesScanned++;
        const abs = path.join(dir, e.name);
        let content: string;
        try {
          content = fs.readFileSync(abs, 'utf8');
        } catch {
          continue; // unreadable/binary
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          // Test against a capped slice so catastrophic backtracking stays bounded per line.
          if (re.test(lines[i]!.slice(0, SEARCH_MAX_LINE))) {
            results.push(`${path.relative(ctx.workspaceRoot, abs)}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`);
            if (results.length >= limit) {
              stoppedEarly = true;
              return;
            }
          }
        }
      }
    };
    walk(root);

    const header = results.length === 0 ? 'no matches' : `${results.length} match(es):`;
    const note = stoppedEarly ? '\n… (search stopped early: hit time/file/result limit)' : '';
    return ok([header, ...results].join('\n') + note);
  },
};

// ── write_file ─────────────────────────────────────────────────────────────────────────────
const WriteInput = z
  .object({
    path: z.string().describe('File to create or overwrite, relative to the workspace root'),
    content: z.string().describe('Full UTF-8 contents to write'),
  })
  .strict();
export const writeFileTool: Tool<z.infer<typeof WriteInput>> = {
  name: 'write_file',
  description: 'Create or overwrite a workspace file with the given UTF-8 content. Snapshotted for undo.',
  schema: WriteInput,
  mutates: (i, c) => ({ paths: [resolveForTool(c, i.path)] }),
  async execute(input, ctx) {
    const abs = resolveForTool(ctx, input.path);
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, input.content, 'utf8');
    const bytes = Buffer.byteLength(input.content, 'utf8');
    return ok(`${existed ? 'overwrote' : 'created'} ${input.path} (${bytes} bytes)`);
  },
};

// ── edit_file ──────────────────────────────────────────────────────────────────────────────
const EditInput = z
  .object({
    path: z.string().describe('File to edit, relative to the workspace root'),
    old_string: z.string().describe('Exact text to replace; must occur exactly once'),
    new_string: z.string().describe('Replacement text'),
  })
  .strict();
export const editFileTool: Tool<z.infer<typeof EditInput>> = {
  name: 'edit_file',
  description:
    'Replace exactly one occurrence of old_string with new_string in a workspace file. ' +
    'Fails if old_string is missing or not unique. Snapshotted for undo.',
  schema: EditInput,
  mutates: (i, c) => ({ paths: [resolveForTool(c, i.path)] }),
  async execute(input, ctx) {
    const abs = resolveForTool(ctx, input.path);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      return fail(`file not found: ${input.path}`);
    }
    const idx = content.indexOf(input.old_string);
    if (idx === -1) return fail(`old_string not found in ${input.path}`);
    if (content.indexOf(input.old_string, idx + 1) !== -1) {
      return fail(`old_string is not unique in ${input.path}; include more surrounding context`);
    }
    const updated = content.slice(0, idx) + input.new_string + content.slice(idx + input.old_string.length);
    fs.writeFileSync(abs, updated, 'utf8');
    return ok(`edited ${input.path} (1 replacement)`);
  },
};

/**
 * The kernel tool registry. Order here is the order presented to the model. run_command is last
 * so the model reaches for the typed, snapshotted file tools first.
 */
export const TOOLS: Tool[] = [
  readFileTool,
  listFilesTool,
  searchTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
] as Tool[];

/** Derive the provider-facing JSON Schema for a tool from its single zod source. */
export function toToolSchema(tool: Tool): ToolSchema {
  const json = z.toJSONSchema(tool.schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete json['$schema']; // the Messages API input_schema does not want the meta-schema key
  return { name: tool.name, description: tool.description, input_schema: json };
}

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Stable content hash of a tool's contract — useful for evidence/debugging. */
export function toolFingerprint(tool: Tool): string {
  return sha256(JSON.stringify(toToolSchema(tool)));
}
