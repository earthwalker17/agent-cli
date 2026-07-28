# Contributing to Agent CLI

Thanks for looking. This is an open, build-in-public engineering project: the goal is to
understand how agent harnesses actually work by building one from first principles, with honest
evidence at every step. Contributions are welcome, and so is criticism — the useful parts of
harsh review have historically been the most valuable input this project gets.

Please read [`PROJECT.md`](PROJECT.md) (the thesis) and [`CLAUDE.md`](CLAUDE.md) (the operating
constitution) before proposing anything structural. They are the project's working documents, and
they explain *why* several things that look over-engineered are the way they are.

## Getting set up

```sh
git clone https://github.com/earthwalker17/agent-cli.git
cd agent-cli
npm install          # runs the build automatically (see the `prepare` script)
npm test             # 1072 tests, hermetic — no network, no API key, no billing
```

Requires **Node 22+**. Developed and tested Windows-first; the logic is cross-platform, but only
the Windows path rules and the Windows sandbox backend are exercised in full.

To use the CLI itself you need `ANTHROPIC_API_KEY` in your environment. Running the agent costs
money — the test suite does not.

## What makes a good contribution here

The bar this project holds itself to, in rough priority order:

1. **Evidence over narration.** A change is not done because it looks right. Tool output, diffs,
   tests, and observable state outrank explanations. Never claim a check ran that did not run.
2. **Honest failure.** Do not convert a failed or unverified outcome into success through prose.
   If something cannot be verified on your platform, say so in the PR.
3. **Small, reviewable commits.** One logical change per commit, with a message that explains
   intent — not just what changed. Look at `git log` for the house style: a subject line naming
   the area, then prose explaining *why*, including what the wrong version would have done.
4. **Regression tests for real defects**, especially anything touching safety, persistence,
   recovery, or a boundary. If you fixed a bug, the test should fail without your fix.
5. **Honest limits stay honest.** If a change narrows what the system can truthfully claim,
   update the claim. `ARCHITECTURE.md` documents the implemented system; `ROADMAP.md` records
   what is deferred and why.

## Things that will get pushback

- Widening authority. The policy engine is a single fail-closed choke point; new capabilities go
  *through* it, never around it. A tool that reaches the wrong `decide()` branch is a security bug.
- Adding a second runtime loop, a second source of truth for session state, or workflow-specific
  logic inside `runTurn`, the policy engine, or the REPL.
- Claims in documentation that the code does not support.
- Large mixed commits, unrelated reformatting, or generated churn.

## Before you open a pull request

```sh
npm run typecheck    # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run build
npm test
```

All three must pass. If a test is platform-gated and skips on your machine (the Windows sandbox
suite, the browser flows, the git-backed suites), say which ones skipped in the PR description —
that is useful information, not an admission.

The PR template asks what you verified and how. Please fill it in; "should work" is not a
verification result.

## Reporting bugs

Open an issue with the bug template. The single most useful thing you can include is the
**evidence log** for the session: `agent report <session-id>` prints a deterministic report
derived purely from events. Redact anything sensitive first — command output is not scrubbed
for secrets, so reports can contain whatever your commands printed.

## Security

Do not open public issues for security problems. See [`SECURITY.md`](SECURITY.md).

## Licence

By contributing, you agree that your contributions are licensed under the MIT License that
covers this project.
