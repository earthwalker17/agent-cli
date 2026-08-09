import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sha256 } from '../shared/hash.js';
import { ConfigError } from '../shared/errors.js';
import { PROVIDER_NAMES } from '../provider/catalog.js';
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
  /**
   * Domains web research may never reach (Session 19). Narrowing, like everything else here —
   * and note what is deliberately ABSENT: there is no allowed-domains counterpart. A permit list
   * would be a widening knob, and the whole point of this schema is that it structurally cannot
   * express one. Available in BOTH layers: a repository has a legitimate interest in saying
   * "never send anything about this project to that host".
   */
  researchBlockedDomains: z.array(z.string().min(1).max(253)).max(256).optional(),
  /**
   * Hosts remote Git/GitHub delivery may never reach (Session 20). Same narrowing-only shape as
   * `researchBlockedDomains`, and available in BOTH layers for the same reason: a repository has a
   * legitimate interest in saying "nothing from this workspace is ever published to that host".
   * An entry refuses reads as well as mutations — forbidding a host means not looking at it either.
   */
  remoteBlockedHosts: z.array(z.string().min(1).max(253)).max(256).optional(),
};

const UserConfigSchema = z
  .object({
    /** Provider preference (Session 15). USER layer only — the workspace schema structurally
     *  cannot express it: a cloned repo must never choose which vendor receives the session. */
    provider: z.enum(PROVIDER_NAMES).optional(),
    model: z.string().min(1).optional(),
    maxSteps: z.number().int().positive().max(400).optional(),
    /** End-of-session project-memory updates (default on). USER layer only — a workspace file
     *  must not toggle harness memory writes (workspace config stays narrowing-only). */
    memoryUpdates: z.boolean().optional(),
    ...narrowing,
  })
  .strict();

const WorkspaceConfigSchema = z.object({ ...narrowing }).strict();

export interface ResolvedConfig {
  /** User-level preferences; CLI flags still win (applied by the caller). */
  provider?: string;
  model?: string;
  maxSteps?: number;
  /** End-of-session project-memory updates (absent = on). User layer only. */
  memoryUpdates?: boolean;
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
    researchBlockedDomains: [...(user?.data.researchBlockedDomains ?? []), ...(ws?.data.researchBlockedDomains ?? [])].map((s) =>
      s.trim().toLowerCase(),
    ),
    remoteBlockedHosts: [...(user?.data.remoteBlockedHosts ?? []), ...(ws?.data.remoteBlockedHosts ?? [])].map((s) =>
      s.trim().toLowerCase(),
    ),
  };

  const sources: ResolvedConfig['sources'] = [];
  if (user) sources.push({ path: userConfigPath(stateRoot), sha256: user.sha256 });
  if (ws) sources.push({ path: workspaceConfigPath(workspaceRoot), sha256: ws.sha256 });

  return {
    ...(user?.data.provider !== undefined ? { provider: user.data.provider } : {}),
    ...(user?.data.model !== undefined ? { model: user.data.model } : {}),
    ...(user?.data.maxSteps !== undefined ? { maxSteps: user.data.maxSteps } : {}),
    ...(user?.data.memoryUpdates !== undefined ? { memoryUpdates: user.data.memoryUpdates } : {}),
    rules,
    sources,
  };
}
