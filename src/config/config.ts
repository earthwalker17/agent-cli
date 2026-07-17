import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sha256 } from '../shared/hash.js';
import { ConfigError } from '../shared/errors.js';
import type { PolicyRules } from '../types.js';

/**
 * Layered, NARROWING-ONLY configuration.
 *
 * Two layers, one rule: configuration may restrict what the agent does, never expand it. The
 * schemas structurally cannot express widening — there is no allowlist field, no auto-approve
 * field, no way to relax the command gate. Precedence for preferences: CLI flags > user config >
 * built-in defaults. Safety knobs (protectedPaths, secretPatterns) merge as a UNION of
 * restrictions across layers.
 *
 * - User config `<stateRoot>/config.json`: preferences (model, maxSteps) + narrowing knobs.
 * - Workspace config `<workspace>/.agent-cli/config.json`: narrowing knobs ONLY. A workspace is
 *   attacker-influencable ground, so it may not choose the model/provider/steps — and it is read
 *   only AFTER the trust gate passes. The `.agent-cli` directory itself is already write-protected
 *   from the agent's file tools by the path validator.
 *
 * Any parse failure or unknown key is a hard ConfigError: a config that cannot be fully
 * understood must not silently degrade into "no config".
 */

const narrowing = {
  /** Extra write-deny roots, resolved against the workspace root (absolute allowed). */
  protectedPaths: z.array(z.string().min(1).max(260)).max(64).optional(),
  /** LITERAL lowercase basename substrings (never regex) marking files as secret-like. */
  secretPatterns: z.array(z.string().min(1).max(100)).max(64).optional(),
  /** LITERAL name substrings dropped from child-process environments (narrowing; the core floor stays). */
  envExcludePatterns: z.array(z.string().min(1).max(100)).max(64).optional(),
};

const UserConfigSchema = z
  .object({
    model: z.string().min(1).optional(),
    maxSteps: z.number().int().positive().max(200).optional(),
    ...narrowing,
  })
  .strict();

const WorkspaceConfigSchema = z.object({ ...narrowing }).strict();

export interface ResolvedConfig {
  /** User-level preferences; CLI flags still win (applied by the caller). */
  model?: string;
  maxSteps?: number;
  /** Union of all layers' narrowing knobs. */
  rules: PolicyRules;
  /** Provenance for the config.loaded event. */
  sources: { path: string; sha256: string }[];
}

export function userConfigPath(stateRoot: string): string {
  return path.join(stateRoot, 'config.json');
}
export function workspaceConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.agent-cli', 'config.json');
}

function loadFile<T>(file: string, schema: z.ZodType<T>, label: string): { data: T; sha256: string } | undefined {
  if (!fs.existsSync(file)) return undefined;
  const raw = fs.readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`${label} config is not valid JSON (${file}): ${(e as Error).message}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ConfigError(
      `${label} config rejected (${file}): ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}`,
    );
  }
  return { data: result.data, sha256: sha256(raw) };
}

/**
 * Load and merge both layers. MUST be called only after the trust gate has passed — the
 * workspace file is untrusted folder content until then.
 */
export function loadConfig(stateRoot: string, workspaceRoot: string): ResolvedConfig {
  const user = loadFile(userConfigPath(stateRoot), UserConfigSchema, 'user');
  const ws = loadFile(workspaceConfigPath(workspaceRoot), WorkspaceConfigSchema, 'workspace');

  const rules: PolicyRules = {
    protectedPaths: [...(user?.data.protectedPaths ?? []), ...(ws?.data.protectedPaths ?? [])],
    secretPatterns: [...(user?.data.secretPatterns ?? []), ...(ws?.data.secretPatterns ?? [])].map((s) =>
      s.toLowerCase(),
    ),
    envExcludePatterns: [...(user?.data.envExcludePatterns ?? []), ...(ws?.data.envExcludePatterns ?? [])].map((s) =>
      s.toLowerCase(),
    ),
  };

  const sources: ResolvedConfig['sources'] = [];
  if (user) sources.push({ path: userConfigPath(stateRoot), sha256: user.sha256 });
  if (ws) sources.push({ path: workspaceConfigPath(workspaceRoot), sha256: ws.sha256 });

  return {
    ...(user?.data.model !== undefined ? { model: user.data.model } : {}),
    ...(user?.data.maxSteps !== undefined ? { maxSteps: user.data.maxSteps } : {}),
    rules,
    sources,
  };
}
