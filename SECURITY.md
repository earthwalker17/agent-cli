# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub's
[private vulnerability reporting](https://github.com/earthwalker17/agent-cli/security/advisories/new)
rather than opening a public issue.

Include what you did, what happened, and what you expected. A minimal reproduction is worth more
than a long description. You should get a first response within a week; this is a personal
open-source project, not a staffed product, so please calibrate expectations accordingly.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.10.x | ✅ (current: 1.10.2) |
| 1.9.x | ⚠️ security fixes only |
| 1.8.x | ❌ |
| 1.7.x | ❌ |
| 1.6.x | ❌ |
| 1.5.x | ❌ |
| 1.4.x | ❌ |
| 1.3.x | ❌ |
| 1.2.x | ❌ |
| 1.1.x | ❌ |
| 1.0.x | ❌ |
| < 1.0 | ❌ (pre-release development versions) |

## What Agent CLI does and does not defend against

Agent CLI runs an LLM-driven agent against your real filesystem and shell. Its security model is
documented in full in [`docs/SAFETY.md`](docs/SAFETY.md), with the implementing contracts in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and summarized in the README. The short version,
stated honestly:

**Enforced (Windows only):** a probed Low-integrity + Job Object boundary confines *writes* and
process lifetime for commands the harness auto-runs. Every path to `enforced: true` requires a
positive self-test at session start; on failure, or on any non-Windows platform, auto-run is
disabled and every command asks (fail closed).

**Not enforced, by design and stated everywhere it matters:**

- **Reads and network are not confined.** A sandboxed command can still read your files and reach
  the network.
- **Approved commands run unsandboxed** at full user privilege. Approval is the user accepting
  that risk; the harness records the boundary it actually used.
- **Workspace trust is recorded consent, not isolation.** It changes what the agent is *allowed*
  to do, not what a process *can* do.
- **Command output is not scrubbed for secrets.** If a command prints a credential, it lands in
  the evidence log and the model's context. The narrow exception is remote delivery: gh/git output
  passes through a credential scrubber at the pack boundary and again at the event emit site,
  because `gh auth status` below gh 2.97.0 printed part of the token (GHSA-cg6r-mpgc-h9mm), remote
  URLs embed credentials in the standard CI form, and git echoes those URLs inside auth failures.
  That scrubber matches GitHub's documented token shapes and URL userinfo — it is not a general
  secret detector.
- **`--dangerously-allow-all` covers remote mutations too.** The policy engine returns `ask` for
  every publish and never consults a session grant, but that flag replaces the human at the prompt,
  so a publish is auto-allowed and recorded with `source: "dangerous-mode"`. "Asks every time" is a
  statement about the policy decision, not about that flag. Do not use it in a workspace with a
  remote you care about.
- **Remote delivery never holds a credential, and cannot verify one.** Publishing uses gh's own
  stored credential and git's credential helper; the harness never reads a token, and deliberately
  does not forward `GH_TOKEN`/`GITHUB_TOKEN` to child processes. What it *can* prove is what the
  remote actually holds before and after: every mutation is re-checked against the remote and
  recorded as verified or not.
- **Path validation is TOCTOU-racy** in principle, as all path checks are.
- **Screenshots capture whatever the app renders**, secrets included.
- No macOS/Linux enforcement backend exists yet — those platforms run with approval only.

Issues that amount to "the agent did something the user approved" or "a documented non-boundary
is not a boundary" are working as designed. Issues where the harness **claims** a protection it
does not deliver — a decision record that overstates confinement, a check that reads as passing
when it did not, consent that covers more than the prompt said — are exactly what this project
considers security bugs, and are the most valuable thing you can report.

## Scope

In scope: the harness itself (policy engine, path validation, consent and approval flows,
sandbox wrapper, evidence integrity, subagent boundaries).

Out of scope: vulnerabilities in Node.js, the Anthropic API, `playwright-core`, or other
dependencies (report those upstream); anything requiring an attacker to already control the
machine the harness runs on.
