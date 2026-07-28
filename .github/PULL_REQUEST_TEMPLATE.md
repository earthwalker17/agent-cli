<!--
Thanks for contributing. Please read CONTRIBUTING.md if you have not yet — especially the
"Evidence over narration" bar, which is what review here is actually about.
-->

## What this changes

<!-- One paragraph: the behaviour before, the behaviour after, and why the change is worth making. -->

## Why

<!--
What problem does this solve? If it fixes a defect, describe the failure concretely:
inputs/state → wrong outcome. If the wrong version of this fix would be subtly bad, say how.
-->

## How it was verified

<!--
Not "should work". What did you actually run, and what did it output?
-->

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm test`

Platform-gated suites that **skipped** on my machine (this is useful information, not a problem):

<!-- e.g. "sandbox.windows.test.ts (not on Windows), browser.flow.test.ts (no system browser)" -->

## Tests

- [ ] This adds a regression test that fails without the fix
- [ ] This is a documentation-only change
- [ ] No test is possible here, and I explained why below

## Honesty checklist

- [ ] No documentation claim in this PR outruns what the code actually does
- [ ] If this narrows what the system can truthfully claim, I updated the claim
- [ ] This does not widen the agent's authority, or if it does, it goes through the policy engine
- [ ] Commits are small and separately reviewable, with messages explaining intent
