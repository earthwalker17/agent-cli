/**
 * The Node version floor, in a module of its own so that it genuinely runs first.
 *
 * `engines` in package.json is ADVISORY — npm warns and installs anyway — and the failure mode on
 * an old runtime is a cryptic crash mid-session (AbortSignal.any and friends), long after startup.
 * So the CLI checks for itself, prints one actionable line, and exits non-zero.
 *
 * Why it is not simply the first statement of `cli/index.ts`: ESM hoists imports and evaluates
 * every imported module BEFORE the importing module's own body runs. A check sitting below thirty
 * import statements is therefore the thirty-first thing to execute, not the first, and any
 * top-level use of a Node 22 API anywhere in that graph would crash ahead of the friendly message.
 * A dependency-free module imported first has no such gap: ESM evaluates imports in source order,
 * this one imports nothing, so nothing can run before it.
 *
 * Keep this file free of imports — including type-only ones, which `verbatimModuleSyntax` erases
 * but which invite a later non-type import to be added beside them.
 */

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (Number.isFinite(nodeMajor) && nodeMajor < 22) {
  process.stderr.write(`agent-cli requires Node 22 or newer; this is Node ${process.versions.node}. Upgrade Node and re-run.\n`);
  process.exit(1);
}

export {};
