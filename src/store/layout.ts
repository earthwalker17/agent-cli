import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../shared/hash.js';
import { caseFold, isInside } from '../shared/pathutil.js';
import { ConfigError } from '../shared/errors.js';

/**
 * Per-project on-disk layout for the harness's own state. State lives OUTSIDE the workspace so
 * the file tools cannot reach the audit/recovery substrate and the user's repo stays clean.
 */
export interface ProjectLayout {
  /** Root of all Agent CLI state (default ~/.agent-cli, override AGENT_CLI_STATE_DIR). */
  stateRoot: string;
  /** This project's directory, `<stateRoot>/projects/<slug>`. */
  projectDir: string;
  sessionsDir: string;
  objectsDir: string;
  sessionFile(sessionId: string): string;
  lockFile(sessionId: string): string;
}

function realIfExists(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

function projectSlug(workspaceReal: string): string {
  const sani = workspaceReal
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // Hash the case-folded real path so it disambiguates and is stable across case variants.
  return `${sani || 'ws'}-${sha256(caseFold(workspaceReal)).slice(0, 8)}`;
}

/** The root of all Agent CLI state (no directory creation, no workspace knowledge). */
export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env['AGENT_CLI_STATE_DIR'] ?? path.join(os.homedir(), '.agent-cli'));
}

/**
 * Resolve (and, if `ensure`, create) the state layout for a workspace. Refuses if the state
 * root resolves to be equal-to or inside the workspace — otherwise the file tools' protected-path
 * rule could be bypassed and the agent could rewrite its own audit log.
 */
export function resolveLayout(
  workspaceRoot: string,
  opts: { env?: NodeJS.ProcessEnv; ensure?: boolean } = {},
): ProjectLayout {
  const env = opts.env ?? process.env;
  const workspaceReal = realIfExists(workspaceRoot);
  const stateRoot = resolveStateRoot(env);

  if (isInside(workspaceReal, stateRoot)) {
    throw new ConfigError(
      `state dir (${stateRoot}) resolves inside the workspace (${workspaceReal}); ` +
        `the audit/recovery substrate must live outside the workspace. ` +
        `Set AGENT_CLI_STATE_DIR to a path outside it.`,
    );
  }

  const projectDir = path.join(stateRoot, 'projects', projectSlug(workspaceReal));
  const sessionsDir = path.join(projectDir, 'sessions');
  const objectsDir = path.join(projectDir, 'objects');

  if (opts.ensure) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(objectsDir, { recursive: true });
  }

  return {
    stateRoot,
    projectDir,
    sessionsDir,
    objectsDir,
    sessionFile: (id) => path.join(sessionsDir, `${id}.jsonl`),
    lockFile: (id) => path.join(sessionsDir, `${id}.lock`),
  };
}
