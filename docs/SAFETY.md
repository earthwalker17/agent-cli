# Safety model and honest limitations

Read this before trusting the harness with anything sensitive.

This document is about what Agent CLI *does and does not* protect you from. For how to report a
vulnerability, see [`../SECURITY.md`](../SECURITY.md). For the implementing contracts, see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

The organizing idea: **the same claim appears in the banner, the approval prompt, the evidence
report, the system prompt and here, in the same words.** A protection this project cannot deliver
is documented as one it does not deliver. A decision record that overstates confinement is treated
as a security bug, not a documentation nit.

---

## Three different controls

Trust, approval and sandbox are separate axes, and conflating them is how agent harnesses end up
claiming more than they enforce.

| Control | What it is | What it is not |
| --- | --- | --- |
| **Trust** | Recorded consent that you allowed the agent to operate in a folder. Lives outside every workspace, in an append-only audited store. | Isolation. It changes what the agent is *allowed* to do, not what a process *can* do. |
| **Approval** | A per-action decision, asked at the moment of consequence, with the exact command, target and effect on screen. | A guarantee about what the approved action then does. Approving is accepting the risk. |
| **Sandbox** | The OS technically confining a process. Windows-only, probed per session, narrow. | Present anywhere else. On other platforms there is no enforcement, and auto-run is disabled. |

---

## The Windows sandbox: what it enforces, and what it does not

When Agent CLI runs on Windows and its startup probe passes, an **auto-run** command executes at
**Low integrity** inside a **Job Object**.

**What it does enforce**, verified by tests against the live OS:

- The command **cannot write** to the workspace, your profile, system directories, or the harness
  state directory — Mandatory Integrity Control denies the write at the kernel.
- Its whole process tree — including a detached grandchild that `taskkill /T` would miss — is
  **reaped on kill**, via the Job Object's kill-on-close.

**What it does NOT enforce**, stated verbatim in the harness's own `doesNotConfine` facts:

- It does **not stop reads**. A sandboxed command can still read files, including secrets — so read
  approval and log redaction still matter.
- It does **not gate the network**. Low integrity does not restrict sockets or DNS.
- It lets the child write **Low-labeled** locations: its scratch `TEMP`, and
  `%USERPROFILE%\AppData\LocalLow`.
- **Service-reparented** work (`schtasks`, `sc`, `wmic`, BITS) can leave the Job.

It needs **no admin** and no special privilege.

**Fail closed, never fake.** The mode is established by a runtime probe and reported truthfully in
the banner, the report, and the system prompt. On any non-Windows platform, or if the probe fails,
the mode is `none` (no enforcement) and **auto-run is disabled — every command asks**. Agent CLI
never auto-runs a command with nothing enforcing the boundary, and never claims cross-platform
parity it does not have.

**Approved commands run UNSANDBOXED.** When you approve a command, you accepted the risk: it runs
with **your full privileges** and its effects are **not snapshotted and not undoable**. The sandbox
backs the *auto-run* decision — defence in depth for a misjudged read-only command. It is not
applied to commands you explicitly allow.

---

## The command gate, and why it is not a boundary

**The automatic reviewer is a prompt-skip gate, not a security boundary.** It is a *positive* proof
of safety over the command string, so obfuscation — encoding, `%VAR:~%` reconstruction, glob
invocation, alternate interpreters — lands in "ask", not "auto-run". But a string reviewer can
never be a security boundary. The sandbox is what actually contains an auto-run command; the
reviewer only decides whether to skip a prompt.

---

## Network and external egress

- **Web research SENDS text off this machine, and that is the consequence to weigh.** Nothing
  executes and nothing here changes; a query and (for a page read) a URL go out to one destination,
  and untrusted text comes back. The prompt shows the query verbatim before it is sent, names the
  destination, and states the per-call and session bounds. `[s]` is bounded by the session research
  budget rather than by the session itself.
- **A configured proxy still carries the connection** — the claim is about the destination, not the
  wire — and page retrieval happens on the provider's infrastructure. So the *research tools'*
  egress is one host, which is **not** the same as the harness's: `npm view` is on the auto-run
  allowlist, and the sandbox does not gate the network at all.
- **Remote delivery never holds a credential, and cannot verify one.** Publishing uses gh's own
  stored credential and git's credential helper; the harness never reads a token, and deliberately
  does not forward `GH_TOKEN`/`GITHUB_TOKEN` to child processes. What it *can* prove is what the
  remote actually holds before and after: every mutation is re-checked against the remote and
  recorded as verified or not.

---

## Untrusted content

- **Retrieved web content is untrusted, and the fence is a mitigation, not a boundary.** Every
  retrieved string is neutralized at ingestion (control, bidi and zero-width characters escaped;
  harness-fence mimicry broken) and rendered inside an explicit UNTRUSTED region that tells the
  model it is data, never instructions. A sufficiently persuasive page can still influence a model
  — no prompt can promise otherwise. What it **cannot** do is act: a researcher subagent holds no
  tool that writes, runs, or delegates, so the worst case is a bad claim. That is why claims carry
  their sources and why research can never mark anything verified.
- **Repository text is untrusted too.** Commit subjects, author names, branch and tag names and
  paths pass through the same scrubbing and fencing, because a cloned repository can carry "ignore
  previous instructions" in a commit message exactly as a stranger's pull request can.
- **Research never counts as verification.** No research event marks a file CHECKED or satisfies a
  plan gate. A session accepted as complete after consulting the web says so in its caveats, and
  names any finding that rested on a single source or on sources that disagreed.

---

## Secrets

- **Command output is not scrubbed.** Secret-looking *file reads* (`.env`, `*.pem`, …) are redacted
  in the event log, but `run_command` stdout is captured verbatim — a command that echoes a
  credential will record it in the log, and `agent report --json` may surface it.
- **The narrow exception is remote delivery**: gh and git output passes through a credential
  scrubber at the pack boundary and again at the event emit site, because `gh auth status` below
  gh 2.97.0 printed part of the token (GHSA-cg6r-mpgc-h9mm), remote URLs embed credentials in the
  standard CI form, and git echoes those URLs inside auth failures. That scrubber matches GitHub's
  documented token shapes and URL userinfo — it is **not** a general secret detector.
- **Credentials are env-only** — never a flag, never a config file, never a slash-command argument
  — so they cannot reach argv, a user message, or any event. Events record the env var *name*, the
  API *host*, and how the key was checked.
- **Screenshots capture whatever the app renders**, secrets included.
- **A git checkpoint refuses to capture secret-named files** your `.gitignore` does not already
  exclude, because `git add -A` excludes exactly what gitignore excludes and nothing else, and a
  git blob cannot be redacted.

---

## Reversibility

- **Undo is file-only.** It reverts `write_file` and `edit_file` changes via content-addressed
  snapshots, and refuses to overwrite a file that drifted (external edit) rather than clobber it. It
  does **not** cover `run_command` side effects, out-of-workspace edits, or external changes.
- **An install executes third-party code, and a migration cannot be undone.** `project_setup` never
  runs without an explicit approval showing the exact command and directory, and installs
  deliberately DO run package lifecycle scripts (`--ignore-scripts` would break esbuild, playwright
  and every prebuild download, so the prompt states the risk instead of pretending it away). A
  session-scope answer covers re-runs only while the lockfile, `package.json` and every
  install-affecting config file are unchanged; migrations and seeds ask every single time.
- **A publish is not undoable from here**, which the prompt says in those words.

---

## Correctness of the boundary checks themselves

- **Path checks (file tools) are TOCTOU-racy.** The workspace-boundary check validates a path at
  decision time; a junction created between check and use is not caught. It is logical policy, not
  enforcement — and it guards the typed file tools, not arbitrary shell text (which the sandbox, not
  a path model, is what confines for an auto-run command).
- **`--dangerously-allow-all` covers remote mutations too.** The policy engine returns `ask` for
  every publish and never consults a session grant, but that flag replaces the human at the prompt,
  so a publish is auto-allowed and recorded with `source: "dangerous-mode"`. "Asks every time" is a
  statement about the policy decision, not about that flag. Do not use it in a workspace with a
  remote you care about.

---

## Scope limits that are decisions, not gaps

- **The multi-project workflow is live-proven end to end, in one session**, against a real
  two-package project with real lockfiles and no `node_modules`: one natural-language request drove
  detection, installs for both projects, migrate, seed, per-project typed checks, a parallel
  executor wave in isolated worktrees, integration, two managed dev servers at once, three passing
  project-attributed browser flows, a three-lens adversarial review that recorded a seeded XSS, a
  deliberate mid-session kill and resume, and `/accept` COMPLETE with no override.
- **yarn is implemented from documentation, not live-proven.** npm is exercised; pnpm is implemented
  and unit-tested; yarn is not installed on the development machine.
- **Polyglot support is a defined, bounded surface.** Rust and Go recipes are live-proven with the
  toolchains the development machine has (rustup **gnu** host, stable; Go from go.dev); MSVC-hosted
  Rust, cgo, build tags, cargo features, and `rust-toolchain` version pinning are facts the harness
  records but never manipulates. Symbol and import extraction is declared heuristic (column-0 regex,
  no tree-sitter): Rust `impl` methods, C++ templates and Go generated code are invisible to the map
  (live reads always see them). The Go import graph is resolved by directory-suffix matching, wrong
  only toward missing edges. C/C++ is detection and indexing only — no configure or build recipes.
  Embedded validation splits at the host boundary: cross builds are verifiable, anything needing a
  board, emulator or runner refuses with the reason — the harness manages no hardware.
- **External database servers, Docker and containers are out of scope.** What is supported is
  file-backed local databases and the project's own declared migrate and seed scripts.
- **DOCX visual fidelity belongs to Word.** DOCX claims are structural and parse-back verified;
  visual judgment happens on the PDF twin rendered from the same spec. PDF bytes are not claimed
  deterministic. Editing pre-existing DOCX files, PPTX generation, footnotes, TOC fields, tracked
  changes, cell merges and RTL fidelity are out of scope rather than partially supported.

---

## Platform notes

- **Windows is the first-class platform.** It is developed and tested there, and the OS-enforced
  sandbox backend exists **only** for Windows. CI gates on both Windows and Linux; the Windows leg
  is the one that can falsify the sandbox claims, because the sandbox suites and the win32 path
  rules only execute there. On non-Windows the sandbox suites skip and the agent runs with approval
  only — auto-run is disabled, fail closed. macOS is not exercised by CI.
- **Legacy console note:** on Windows PowerShell 5.1, piping or redirecting the CLI's output (or a
  command's own output) can re-encode it through the OEM code page and mangle non-ASCII text;
  PowerShell 7+ and Windows Terminal handle UTF-8 correctly. Piped and non-TTY output uses ASCII
  status glyphs for this reason.

---

## Where the state lives

Event logs, snapshots and trust live **outside** the workspace at `%USERPROFILE%\.agent-cli\`
(override with `AGENT_CLI_STATE_DIR`). The startup check refuses to run if the state directory
resolves inside the workspace. An *approved* (unsandboxed) shell command can still reach that state
directory — but an *auto-run* (sandboxed) command **cannot** write it, because the state directory
is Medium integrity and the Low-integrity child is OS-denied.

---

## What is not built

**Stronger isolation is future work**, and named as such: network-egress control, a
read/confidentiality boundary, containers or a VM, and macOS/Linux enforcement backends. See the
deferred pool in [`ROADMAP.md`](ROADMAP.md); the first two are called out there as the two enforced
gaps that most matter.
