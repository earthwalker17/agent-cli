import { qualifyRecipeId, toCommand } from '../checks/recipes.js';
import { sha256 } from '../shared/hash.js';
import type { DetectedLockfile, DetectedProject, PackageManager } from '../checks/types.js';
import { SETUP_ACTIONS, type ResolvedCheckFact, type SetupAction } from '../types.js';

/**
 * Project setup (Session 16) — the check inversion applied to the one operation the harness has
 * deliberately refused to perform until now: **the model names an INTENT and a UNIT; the harness
 * names the command.**
 *
 * `src/checks/types.ts` still states the rule this module respects: there is no dependency-install
 * CHECK KIND, because installing runs third-party code with network access and "verify what we
 * just built" is a different promise. Session 16 does not weaken that rule — it gives setup its
 * own tool, its own consent wording, its own event stream, and no path to satisfying a
 * verification gate. A check still means "we verified"; it never means "we fetched".
 *
 * Everything here is DATA. A new ecosystem is a row, exactly as the recipe table intends.
 */

export { SETUP_ACTIONS, type SetupAction };

/** Setup fact kinds, as they appear on `ResolvedCheckFact.kind`. Disjoint from every CheckKind. */
export const SETUP_FACT_KINDS: readonly string[] = SETUP_ACTIONS;

export const INSTALL_TIMEOUT_MS = 900_000;
export const SCRIPT_TIMEOUT_MS = 300_000;

/**
 * Script names a project may declare for the state-changing intents. FIXED and conventional, for
 * the same reason the preview allowlist is fixed: `migrate` must never become a euphemism for
 * "run any script the model names".
 */
const SCRIPT_NAMES: Readonly<Record<Exclude<SetupAction, 'install'>, readonly string[]>> = {
  migrate: ['migrate', 'db:migrate', 'migrate:dev', 'migrate:deploy'],
  seed: ['seed', 'db:seed'],
};

export interface ResolvedSetup {
  action: SetupAction;
  /** `setup.<action>.<how>` (+`@<unit>`) — the `setup.` prefix keeps keys disjoint from checks. */
  recipeId: string;
  command: string;
  /** The workspace-authored script body consent binds, for the script-backed intents. */
  bodySha?: string;
  scriptName?: string;
  /** The lockfile an install is pinned by. Displayed; part of, but not all of, the identity. */
  lockfile?: DetectedLockfile;
  /**
   * The full consent identity of an install: lockfile + package.json + .npmrc, hashed together.
   * null when any component is unhashable, which costs replay consent rather than inventing one.
   */
  installIdentity?: string | null;
  projectId: string;
  cwd: string;
  timeoutMs: number;
  /**
   * Whether a `session`-scope answer may store replay consent. Install: yes, bound to the
   * lockfile sha, so any dependency change re-asks. migrate/seed: NEVER — a migration is not
   * idempotent and its consequence differs per run, so "you approved this once" cannot honestly
   * mean "you approved it again".
   */
  replayable: boolean;
  /** The verbatim consequence sentence the approval prompt shows. */
  consequence: string;
}

export interface SetupResolution {
  resolved: ResolvedSetup | null;
  reason?: string;
  /** true = the CALLER asked wrong; false/absent = a genuine project-capability gap. */
  badRequest?: boolean;
}

const NEEDS_NODE_MODULES =
  'dependencies are not installed (node_modules is absent) — run project_setup install for this project first';

/** Yarn's install flag differs by major; the declaration is the only authoritative signal. */
function yarnInstallArgs(spec: string | null): { args: string[]; note: string; how: string } | null {
  if (spec === null || !spec.startsWith('yarn@')) return null;
  const major = Number.parseInt(spec.slice('yarn@'.length), 10);
  if (!Number.isFinite(major) || major < 1) return null;
  // Branch on the NUMBER. Deriving the label from the note's text read 'yarn 10 (Berry)' as v1.
  return major === 1
    ? { args: ['install', '--frozen-lockfile'], note: 'yarn 1', how: 'yarn.v1' }
    : { args: ['install', '--immutable'], note: `yarn ${String(major)} (Berry)`, how: 'yarn.berry' };
}

/** The lockfile-driven install command. Pinned installs are the point; unpinned ones SAY SO. */
function resolveInstall(p: DetectedProject): SetupResolution {
  if (!p.kinds.includes('node')) {
    return {
      resolved: null,
      reason:
        p.kinds.includes('python')
          ? 'Python dependency installation is not supported: the harness cannot verify which interpreter or virtual environment a command would install into, and guessing would install into the wrong one. Install manually, then re-run the checks.'
          : 'no Node project manifest was detected for this project, and only Node ecosystems have an install recipe',
    };
  }
  const pm: PackageManager = p.packageManager ?? 'npm';
  const lock = p.lockfile;

  let argv: string[];
  let how: string;
  let consequence: string;

  if (lock === null) {
    argv = [pm, 'install'];
    how = `${pm}.install`;
    consequence =
      `NO LOCKFILE is present, so this resolves dependency versions fresh and may write one. ` +
      `Versions are NOT pinned: the result can differ from any other machine or any later run.`;
  } else if (lock.name === 'package-lock.json') {
    argv = ['npm', 'ci'];
    how = 'npm.ci';
    consequence = `Installs exactly what package-lock.json pins, replacing node_modules wholesale.`;
  } else if (lock.name === 'pnpm-lock.yaml') {
    argv = ['pnpm', 'install', '--frozen-lockfile'];
    how = 'pnpm.frozen';
    consequence = `Installs exactly what pnpm-lock.yaml pins and FAILS if the lockfile is out of date.`;
  } else {
    const yarn = yarnInstallArgs(p.packageManagerSpec);
    if (yarn === null) {
      return {
        resolved: null,
        reason:
          "yarn.lock is present but this project does not declare a `packageManager` field, and yarn's pinned-install flag " +
          'differs between v1 (`--frozen-lockfile`) and Berry (`--immutable`). The harness will not guess which one this ' +
          'project means — declare `packageManager` in package.json, or install manually.',
      };
    }
    argv = ['yarn', ...yarn.args];
    how = yarn.how;
    consequence = `Installs exactly what yarn.lock pins (${yarn.note}) and fails if it is out of date.`;
  }

  // Every file that decides what an install fetches or executes, hashed together. A component
  // the harness could not read has no stable identity, so the approval covers THIS call only —
  // better to re-ask than to replay against a file nobody hashed.
  const installIdentity =
    lock !== null && lock.sha256 !== null && p.manifestSha256 !== null
      ? sha256(`${lock.sha256}\n${p.manifestSha256}\n${p.npmrcSha256 ?? ''}`)
      : null;

  return {
    resolved: {
      action: 'install',
      recipeId: qualifyRecipeId(`setup.install.${how}`, p.id),
      command: toCommand(argv),
      ...(lock !== null ? { lockfile: lock } : {}),
      installIdentity,
      projectId: p.id,
      cwd: p.root,
      timeoutMs: INSTALL_TIMEOUT_MS,
      replayable: installIdentity !== null,
      consequence:
        `${consequence} It DOWNLOADS AND EXECUTES third-party package code, including lifecycle ` +
        `scripts, at full user privilege with network access. Not sandboxed, not snapshotted, not undoable.`,
    },
  };
}

/** A state-changing project script (migrate/seed), from the fixed per-intent allowlist. */
function resolveScriptIntent(p: DetectedProject, action: Exclude<SetupAction, 'install'>): SetupResolution {
  const names = SCRIPT_NAMES[action];
  const candidates = names.filter((n) => p.scripts[n] !== undefined);
  if (p.packageManager === null || candidates.length === 0) {
    return {
      resolved: null,
      reason: `this project declares no ${action} script (looked for package.json scripts: ${names.join(', ')})`,
    };
  }
  if (p.hasDependencies && !p.hasNodeModules) return { resolved: null, reason: NEEDS_NODE_MODULES };

  const name = candidates[0]!;
  const body = p.scripts[name]!;
  return {
    resolved: {
      action,
      recipeId: qualifyRecipeId(`setup.${action}.script.${name}`, p.id),
      command: toCommand([p.packageManager, 'run', name]),
      // Consent binds the UNTRUNCATED body (S14.5): `scripts` is display-capped at 200 chars.
      bodySha: p.scriptShas[name] ?? '',
      scriptName: name,
      projectId: p.id,
      cwd: p.root,
      timeoutMs: SCRIPT_TIMEOUT_MS,
      // Deliberately never replayable — see ResolvedSetup.replayable.
      replayable: false,
      consequence:
        action === 'migrate'
          ? 'Runs this project\'s MIGRATION script: it changes local database or application state that the harness ' +
            'does NOT snapshot and CANNOT undo. Migrations are not idempotent, so this asks every time.'
          : 'Runs this project\'s SEED script: it writes local database or application data that the harness does NOT ' +
            'snapshot and CANNOT undo. This asks every time.',
    },
  };
}

export function resolveSetup(p: DetectedProject, action: SetupAction): SetupResolution {
  return action === 'install' ? resolveInstall(p) : resolveScriptIntent(p, action);
}

/**
 * The policy-fact form. `kind` is the ACTION, deliberately not a `CheckKind`: widening CheckKind
 * would let a plan declare `checks: ['install']` and let an install exiting 0 read as verification
 * everywhere the report and the gates look. Setup and verification stay different words.
 */
/** The sha consent binds for this intent, or null when there is nothing stable to bind. */
function bindingSha(r: ResolvedSetup): string | null {
  if (r.action !== 'install') return r.bodySha !== undefined && r.bodySha !== '' ? r.bodySha : null;
  // THREE files, not one. `npm ci` looks like a command whose whole meaning is the lockfile and
  // it is not: package.json's preinstall/install/postinstall/prepare entries are executed by
  // every package manager during an install, and .npmrc chooses the registry and the shell those
  // scripts run in. With only the lockfile bound, the agent could add a `preinstall` through an
  // ordinary auto-allowed in-workspace write and replay the earlier `[s]` with no prompt — the
  // standing shell authority `run_command` is denied by design.
  return r.installIdentity ?? null;
}

export function setupFact(r: ResolvedSetup): ResolvedCheckFact {
  return {
    recipeId: r.recipeId,
    kind: r.action,
    command: r.command,
    // The "body" a setup command's behaviour actually lives in: a script's text for migrate/seed,
    // and the LOCKFILE for an install — `npm ci` is a stable string whose entire meaning is that
    // file, exactly as `npm run test`'s meaning is its package.json entry.
    ...(bindingSha(r) !== null ? { bodySha: bindingSha(r)! } : {}),
    projectId: r.projectId,
    cwd: r.cwd,
    consequence: r.consequence,
    timeoutMs: r.timeoutMs,
    replayable: r.replayable,
    effects: { writesOutputs: true, network: r.action === 'install', workspaceAuthored: r.action !== 'install' },
  };
}

/** Same tuple the replay key hashes — consent and the TOCTOU re-check move together. */
export function sameSetup(a: ResolvedSetup | null, b: ResolvedSetup | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.recipeId === b.recipeId &&
    a.command === b.command &&
    a.bodySha === b.bodySha &&
    a.projectId === b.projectId &&
    a.cwd === b.cwd &&
    (a.lockfile?.sha256 ?? null) === (b.lockfile?.sha256 ?? null) &&
    (a.installIdentity ?? null) === (b.installIdentity ?? null)
  );
}
