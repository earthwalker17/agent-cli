# ROADMAP

Rolling execution record: the latest session in full detail, older sessions compressed to
milestones that keep their objective, lasting decisions (with why), evidence, and still-open
limitations. Newest first. Contracts live in `ARCHITECTURE.md`.

---

## Session 18 (2026-08-07) — Polyglot repository intelligence and verification

### Objective

Extend repository intelligence and typed verification beyond the Node/TS + Python bias —
Rust/Cargo and Go modules as the complete path (units → indexing → symbols/imports → recipes →
signals → classification), C/C++ (CMake) as detection + indexing with honest refusals, and
embedded as a Rust cross-target honesty story — with support meaning **language + build system +
layout + AVAILABLE TOOLCHAIN**, never file-extension recognition. Three audits first (checks/
detection, retrieval, recovery/reporting); the finding that shaped everything: an unrecognized
ecosystem resolved every check to `no-recipe`, and `no-recipe` WAIVES declared gates — a Rust
repo session reached `/accept` COMPLETE having verified nothing, claiming "no supported project
manifest was detected (Node/TS and Python are supported)" about a workspace holding a
Cargo.toml. The S16 silent-inertness bug, one axis over.

### The three-run proof structure (`agent-cli-s18-live/`, all validated post hoc)

- **BEFORE (v1.3.0, 17/17):** the defect on the record — approved build+test gates on a real
  Rust crate, both waived as `no-recipe`, `/accept` COMPLETE with zero checks ever run.
- **Proof A (S18 build, toolchains still absent, 17/17):** the machine's pre-install state used
  as a one-shot fixture. 6 units named across four ecosystems (cargo `[workspace] members`,
  go.work-less go module, CMake, embedded), 8 polyglot files symbol-indexed, and six explicit
  `toolchain-unavailable` states naming exact cures (install via rustup / go.dev) with ZERO
  spawns; the gates waive LOUDLY — "TOOLCHAIN IS NOT INSTALLED on this machine" — never the old
  claim. 2.6 min, 62 events.
- **Proof B (after `winget` Go 1.26.5 + rustup gnu-host stable 1.97.1, 27/27):** the full path.
  `go test` FAILS with the `--- FAIL: TestScale` finding → the CODE fixed, test untouched →
  path-scoped `go test ./calc/...` targeted proof (`scopePaths: gosvc/calc` on the event) →
  `go vet` → `cargo build` FAILS firing `rust-error` with a file:line finding into main.rs →
  fixed → PASS → gates re-proven → embedded: `cargo fmt --check` passes host-side, the cross
  build refuses naming `rustup target add thumbv7em-none-eabihf`, the USER installs the target
  mid-session (driver-executed between turns), the toolchain pseudo-stamp flips the TOCTOU
  fingerprint, re-detection sees it, and the SAME kind cross-compiles and PASSES — while
  `cargo test` still refuses: cross binaries cannot execute on this host, and the harness
  manages no hardware. `/accept` COMPLETE on GREEN gates, no waivers. 9.3 min, 170 events, 15
  real spawns + exactly 2 honest refusals, `[s]` replay consent exercised.

### What landed (commits `5bcb2cf`…`286bcdc` + docs; suite 1480 → 1539)

- **`checks/toolchain.ts`** — machine toolchain availability as a stat-only fact (PATH probe
  PATHEXT-aware; rustup components/targets under toolchain dirs, never the `~/.cargo/bin` proxy
  shims — verified against the real install, which ships exactly the false-positive shims the
  design predicted). Freshness rides the TOCTOU seam as `~toolchain/` pseudo-stamps: absence is
  never cached (S16.5 lesson), and the mid-session install re-detect in proof B is this seam
  working on camera.
- **Detection**: `ProjectKind` += rust/go/cmake with optional per-ecosystem facts (bounded
  hand-extraction, no TOML dependency): cargo workspace root/members, edition, Cargo.lock,
  rust-toolchain files, the `[build].target` cross triple; go module path/directive/go.sum/
  vendor; CMake project name. Units: Cargo.toml/go.mod/CMakeLists.txt join `UNIT_MANIFESTS`;
  cargo members + go.work `use` join the declared sources; target/ + vendor/ join the skip set;
  every new manifest joins the stat-candidate fingerprint.
- **Recipes**: `cargo.` and `go.` rows (build/test/check/clippy `-D warnings`/fmt; go
  build/test/vet with typecheck-as-build and a path→package `test-targeted` mapping only Go can
  honestly express). Holes are decisions with stated reasons (`ECOSYSTEM_KIND_NOTES`): no rust
  test-targeted (name-based selection), no go format (`gofmt -l` exits 0 — the exit code is the
  verdict). **`UnsupportedReason` += `toolchain-unavailable`**: waives gates (the
  browser-unavailable precedent) but tracked apart through the folds so the acceptance caveat
  names the missing toolchain and its recorded cure. The precondition WHY moved into the rows;
  Node/Python answers byte-identical, test-pinned; the recipe-id table pinned as a consent
  surface.
- **Signals/classification**: `rust-error` + `go-error` appended (order pinned); `syntax-error`
  widened for Go's lowercase spelling, `assertion-failed` for Rust ≥1.73's backticked form;
  classify.ts changed ONE line (both ids → compile-type). rustc two-line and Go one-line finding
  extractors carry file:line.
- **Retrieval**: `LangId` += rust/go/c-cpp, `SymbolKind` += struct/trait/mod/macro (no index
  version bump — warm-load convergence is the pinned behavior); pattern tables with pub/case
  exported rules; import edges a polyglot repo entirely lacked (rust `use`/`mod` through the
  crate root; go directory-suffix matching onto a deterministic representative; C `#include`);
  Cargo.toml/go.mod/CMakeLists manifests, lib/mod entry stems, `_test.go` penalty; honesty
  strings now say ts/js/py/rust/go/c-cpp everywhere.
- **Surfaces**: setup refusals say "nothing to install — cargo/go fetch during the build" instead
  of implying a missing feature; the prompt's project block renders per-ecosystem facts
  (toolchain installed/NOT INSTALLED, the cross-target line) instead of npm vocabulary.

### Decisions (and why)

- **A missing toolchain is `toolchain-unavailable`, and it WAIVES — loudly.** Machine capability
  is the browser-unavailable case one toolchain over; an absence the harness will never install
  must not strand acceptance. The loudness is structural (folds track it apart), not prose.
- **Rows own the precondition WHY.** The old central curable rule was Node's answer hard-coded
  into generic control flow; only a row knows whether its blocker is curable, a machine gap, or
  a host incapability.
- **`cargo test` under a cross target refuses PERMANENTLY as `precondition`** — installed target
  or not, cross binaries cannot execute here, and the harness manages no hardware or emulators.
  That is the embedded line: host-verifiable vs target-dependent, drawn in the recipe table.
- **Go's typecheck deliberately duplicates build** (its compiler IS its typechecker) — an honest
  gate beats a `no-recipe` waiver. **gofmt has no format row** — an output-parsed verdict would
  break THE EXIT CODE IS THE VERDICT.
- **LangId and ProjectKind stay separate vocabularies** (per-file extraction vs per-unit build
  system); a lone `.rs` scratch file indexes without any cargo unit existing.
- **Go import edges by directory-suffix matching** — module paths are unknowable in a per-file
  resolver without go.mod context; centrality is a signal, never a claim, and the error mode is
  a missing edge, not a wrong claim.

### Open issues / boundaries

- Live claims cover the rustup **gnu** host and go.dev Go on this one Windows 11 machine; MSVC
  Rust, cgo, cargo features/build tags, `rust-toolchain` version selection are recorded facts
  the harness never manipulates. clippy/rustfmt/target probing unions across installed rustup
  toolchains (stated approximation; rustup's active-toolchain selection is not re-implemented).
- C/C++ is detection + indexing only; the gcc/clang missing-header output would false-fire
  `command-not-found` if it ever entered check normalization (unreachable today — no C recipe
  exists; documented in ARCHITECTURE).
- Rust `impl` methods, C++ templates and generated Go code are invisible to the map (column-0
  heuristics by design; live reads see them). `_test.go` penalty covers the basename convention
  only.
- No preview recipes for cargo/go servers (`cargo run`/`go run` have no representation) — the
  preview surface stays package.json-only this session.
- The go `test-targeted` all-paths-outside-the-unit case degrades to the argv-null `no-recipe`
  answer rather than `bad-request` (matches long-standing argv-null semantics; noted, not fixed).

### Recommended next step

Session 19 per BLUEPRINT: source-backed web research (`@research`, bounded network authority,
provenance-bearing findings), now that polyglot retrieval and checks are live-proven.

---

## Session 17 (2026-08-04/05) — The first non-coding workflow pack: documents and PDF

### Objective

Answer the question BLUEPRINT set for this session: do the contracts that made the coding
workflow trustworthy generalize beyond source code — without a second agent loop, a plugin
system, or a parallel framework? The deliverable is a documents/PDF workflow standing on the
existing kernel, with the same evidence and honesty discipline, plus a live proof.

The answer is yes, and the shape of the answer is the result: **three per-session tools, ONE new
policy fact, TWO additive event types, and a module of pure format logic outside the kernel.**
No new orchestration, no new loop, no widened `CheckKind`.

### The loop, and why the spec is a workspace file

`request → read sources → author a *.docspec.json → render → deterministic validation → SEE the
pages → revise THE SPEC → re-render → deliver.` The spec being an ordinary workspace file (not
harness state, not an in-memory object) is the load-bearing choice: revision inherits snapshots,
`/undo`, the session diff and attribution for free, and "targeted revision" needs no
incremental-artifact-patching machinery at all.

### What landed (commits `4c5db6a`…`HEAD`)

- **Substrate** (`artifacts/zip.ts`, `xml.ts`): in-memory-only OOXML zip access (nothing is ever
  extracted to disk, so zip-slip is structurally impossible rather than defended against) with
  entry-name validation and byte caps; deterministic zip writing (sorted entries, FIXED mtime —
  fflate would stamp the live clock into 2-second-resolution DOS fields); size- AND depth-bounded
  strict XML parsing plus the escapers all generation routes through.
- **Read layer**: DOCX/PPTX/PDF/XLSX identified by MAGIC BYTES and the content-types part, never
  the extension, each summary leading with a **coverage verdict** (`full`/`partial`/`structural`)
  and reasons. PPTX slide ORDER comes from the declared `sldIdLst` through the relationship map.
- **The DocSpec + deterministic DOCX renderer**: one strict schema returning the COMPLETE error
  list with nothing written; hand-rolled OOXML with real named styles, one numbering instance per
  list, field codes, fixed timestamps, no rsids — same spec + same images ⇒ same sha256.
- **PDF production** through the shared cached browser probe from one self-contained page, and
  **`inspect_pages`** rasterizing pages via unpdf's bundled pdf.js injected into a blank page of
  that same browser (native-free by construction: the zero-dep library that reads PDFs in Node
  renders them where a real DOM exists).
- **Deterministic validators** that parse each artifact BACK, with two severities kept apart:
  structural mismatches FAIL; layout heuristics are NOTES that can never block.
- **The `artifact` policy fact** (branch 0f) and `artifact.rendered`/`artifact.inspected` events
  on the S16 setup pattern — products, never verification, pinned by the same asymmetry test.

### Review: 4 lenses, 29 findings, all hand-verified, 19 fixed

Three lenses independently found the top defect. Every claim was reproduced against the built
code before any fix (`scratchpad/verify-findings.mjs`), and each fix carries a regression pin
(`test/artifacts.review-fixes.test.ts`, 18 tests). The four that mattered most:

- **The engine never evaluates `readsPaths` on a tool with a non-empty mutation plan**, so
  `render_document`'s claimed read coverage was structurally void: pointing it at `.env` read the
  file and echoed a fragment through V8's JSON error. Both the spec path and every image path are
  now validated at execute (containment + secret-name, raw AND resolved), and JSON syntax errors
  report POSITION only.
- **Zip caps gated the uncompressed-size field** while a STORED entry is materialized by its
  COMPRESSED size — a forged central directory pulled 300 KB past a 1 KB cap, refused only after
  the allocation. Both caps now gate `max(size, originalSize)`.
- **Validation compared artifacts against the READER's display bounds**, manufacturing "does not
  match its spec" failures on correct renders (25 tables, a heading containing `\r`) — which the
  acceptance caveat then repeated as fact. This is the class this project treats most seriously:
  a fabricated failure claim.
- **A render+inspect pair laundered arbitrary workspace pixels to the model** with no approval:
  a spec may embed any in-workspace image, the render auto-allows, and inspection inherited that
  consent. `embeddedWorkspaceImages` on the render event now gates inherited consent.

### Live proof (Kimi K3, `agent-cli-s17-live/`)

Two piped-REPL takes in a fresh fixture workspace (`notes.md` + a generated CRC-valid logo PNG),
both from one natural-language request, both `/accept` COMPLETE.

**Take 2 is the complete run: 21 minutes, 312 events, 49 turns, 48 tool calls, 10 approvals,
post-hoc validated 28/28 from persisted evidence alone.** The arc: read the notes → author
`report.docspec.json` iterating against the schema's verbatim errors → render both formats
(validation PASS) → SEE the pages and **disagree with them** (one page against a 2–3 page target)
→ build a throwaway `probe.docspec.json` to experiment with page breaks in isolation, render and
inspect it three times → apply the finding to the real spec → two balanced pages → take the
follow-up revision turn (discover the accent key by probing, set `styles.accentColor: "#1F3864"`,
add "Next Steps") → re-render + re-inspect → clean up the scratch files → `/accept` COMPLETE with
no caveats. **Both admission paths of the new fact fired in one run**: `report.pdf` (spec embeds
the logo) ASKED; `probe.pdf` (spec embeds nothing) auto-allowed under inherited consent — the
rule is provenance-driven, not blanket. The delivered artifacts match their recorded shas and the
spec on disk matches the `specSha256` the last render consumed.

**Take 1 (archived, 26/26): the same self-correcting arc, and an honest failure.** Its SECOND user
turn never ran — Kimi returned "engine currently overloaded", the harness recorded a typed
provider failure, said so, and continued cleanly through `/status`, `/accept` and `/quit`. So take
1 proves model-initiated revision from visual evidence; take 2 adds the user-driven one.

**What the takes found that the suites could not**: the inspect ask claimed "a workspace document
the harness did NOT produce" about a file the harness had just rendered (the true reason was the
embedded logo — the record now says so, and take 2's log shows the corrected wording); pdf.js
sprayed font-substitution warnings onto stderr, which is the REPL's CHROME stream (`verbosity: 0`);
and the agent wrote *"page-number tokens weren't documented, so I probed the renderer"* — burning
render calls rediscovering the spec shape, so `render_document`'s description now states the block
kinds, run fields and header/footer tokens outright.

### Verification evidence

`npm run typecheck` + `npm run build` clean per commit; suite **1373 → 1480** (1469 passed + 11
skipped) across 107 files, including two REAL-browser suites (PDF print + parse-back; page
rasterization) that skip honestly on a machine without one. A dev-time check opened the rendered
sample in real Word 16: 21 paragraphs, 1 table, 1 inline image, and the footer computed
"Page 1 of 2" — the field grammar is genuinely Word-valid.

### Decisions (and why)

- **The spec is a workspace file, not harness state.** Everything the coding workflow already
  built for files — snapshots, undo, diff, attribution, drift — applies to document revision for
  free, and the alternative (patching artifacts in place) is a fidelity contract this session
  deliberately did not sign.
- **Artifacts are PRODUCTS, never verification.** A render never marks a file CHECKED and never
  satisfies a plan gate; the S16 setup asymmetry is reused verbatim rather than widening
  `CheckKind`, because a kind that resolves `unsupported` everywhere silently WAIVES gates.
- **A heuristic must never become a gate.** Blank pages and stranded headings are notes; only
  structural mismatches fail. The first false positive would otherwise turn a guess into a
  blocker on the delivery path.
- **Validation reads at validation scale.** Display bounds exist to protect the model's context;
  applying them to harness-generated bytes made the validator lie about its own renderer.
- **DOCX visual fidelity belongs to Word**, so this session claims structural + parse-back
  verification for DOCX and does visual judgment on the PDF twin. Word COM conversion was cut
  deliberately rather than shipped shallow.
- **Inherited consent must not launder pixels.** Rasterizing shows the model bytes; a render that
  embedded workspace images does not get to convert "you approved a render" into "you approved
  showing me these images".

### Open issues / boundaries

- **Visual judgment is the MODEL's**: the harness proves the pixels were rendered and shown, and
  the deterministic spec↔artifact verdict is what `validation: pass` refers to. That an aesthetic
  verdict is *right* is not something the evidence can establish, and neither doc claims it.
- Take 2's delivered page 2 carries a lot of white space and its "Decisions Requested" / "Next
  Checkpoints" / "Next Steps" sections overlap — content quality the harness has no opinion
  about. Recorded in `DEMO.md` rather than glossed.
- **PPTX is read-only** this session; generation belongs to a slides pack. **Editing pre-existing
  DOCX** is out of scope (round-trip fidelity is a different contract). Footnotes, TOC fields,
  tracked changes, comments, multi-section layouts, cell merges, and RTL/complex-script fidelity
  are unsupported, not partially supported.
- **Word COM conversion is deferred** (S17.5 candidate): its four sharp edges (temp-file
  placement in the state dir, modal-dialog suppression, `-EncodedCommand` ask honesty, noUndo
  wording) deserve their own design.
- **`read_document` is parent-only**: reviewer/explorer children cannot open the artifacts they
  review (they can read the spec JSON). Child-tool admission needs the static-construction seam.
- No document CheckKind and no plan-gate integration: a document artifact cannot yet gate a plan
  task. Deferred until there is real pressure for it.
- PDF bytes are not deterministic (Chromium embeds dates/ids) and this is never claimed; DOCX
  bytes are, and that is test-pinned.

### Recommended next step

Session 18 per BLUEPRINT: polyglot repository intelligence and verification (Rust, Go, C/C++,
embedded), now that the kernel has been shown to carry a non-coding workflow without deforming.

---

## Earlier Milestones (compressed per the rolling-docs policy)

Contract detail lives in `ARCHITECTURE.md`; entries keep the objective, lasting decisions, the
evidence, and what stayed open.

### Session 16.5 (2026-08-01 … 08-03) — Proving S16 end to end

Two bounded adversarial reviews (5 lenses over the S16 diff: 30 findings, 16 fixed; then 5 over
the whole implementation: 25 findings, 16 fixed) and the live E2E S16 had owed since it shipped
(commits `08b978a`…`86d0f05`; suite 1342→1373). The review's lasting fixes: a compat stream
dying with NEITHER `[DONE]` nor a `finish_reason` was committing a truncated sentence as the
model's final answer (now a non-retryable typed error — part of the stream was consumed, so a
replay would double-bill); consecutive USER messages coalesce at the compat wire; reasoning
blocks weigh their PAYLOAD only (the display copy doubled every kimi/deepseek block and could
fire the context alarm at half the real volume); rate-limit 429s draw a deeper retry budget;
`cacheSuccessfulProbe` caches browser probe SUCCESS only (a cached failure silently converted
"the machine was busy" into "this session cannot produce browser evidence", and that conversion
WAIVED gates); a harness lifecycle stop between approval and a flow reports
`preview-stopped-lifecycle` instead of a crash; `MAX_REVIEW_ROUNDS` moved into the fold's own
module so a blocker can never prescribe a call delegate refuses. Plus the **"working" heartbeat**
for always-thinking models (one dim TTY-only status line; its own first recording proved the line
must be PLAIN text, because the status area sanitizes and ESCAPES anything styled) and the
**tolerant one-level decode** for double-encoded tool arguments — kimi serialized a nested object
as a string and, fed only the schema error, cycled serialization formats for twelve minutes
without ever un-stringifying it. **Live proof: one 84.6-minute Kimi K3 session, EXIT=0, validated
post hoc 38/38** — one request through installs ×2, migrate, seed, per-project checks incl. lint,
a parallel executor wave, two simultaneous dev servers, three passing project-attributed browser
flows, a three-lens review that recorded the seeded XSS, kill + resume on camera, and `/accept`
COMPLETE with no override; a 4.7-minute subtitled MP4 and honest limitations live in
`agent-cli-s165-live/DEMO.md`. Lasting decisions: a tolerant decode is not intent-guessing (the
adapter already JSON-decodes once; one more unambiguous level against the schema that rejected it
is the same operation, bounded); cache probe SUCCESS, never failure; a blocker must name a cure
the harness will allow; a display copy must not weigh; validator assertions are session-scoped.
Still open: multi-kind `run_check` batches re-probe drift once before the first spawn;
`planTouches` reads the plan document at decide (the documented purity exception); resume
identity is flags>config>default rather than sticky; reviewer wall-clock vs always-thinking
models.

### Session 16 (2026-07-31) — Real local software engineering: project units

The coding workflow made dependable for realistic local applications (commits `0b7aff1`…
`6f2a55e`; suite 1164→1322). Before it, a repository holding `web/` and `api/` with no root
manifest detected NOTHING — every check kind `unsupported`, no preview script, every gate
unrunnable: the workflow went inert, not loud. Landed: project UNITS (bounded never-throwing
discovery — declared workspaces + a general depth-1 scan + conventional containers; a unit
exists only where a MANIFEST exists; unglossed globs are refused with a reason); deterministic
ordering because unit ids qualify recipe ids and recipe ids are what consent binds to (the root
unit is never qualified, so single-project workspaces keep byte-identical grants); `selectUnit`
refuses ambiguity, never picks; per-unit checks/previews with per-unit cwd and `projectId` on
check events; `project_setup` (install/migrate/seed) — the model names an INTENT and a UNIT, the
harness names the command from the LOCKFILE, installs may replay under `[s]` bound to
`sha(lockfile + package.json + install-affecting config files)` while migrate/seed ask EVERY time
(not idempotent; destructive is structurally non-grantable); `setup.*` as NEW event types that can
never satisfy a verification gate (an install exiting 0 means dependencies were fetched — the
paired asymmetry test is the contract); `PlanTask.project` + `gates.projects` (sha-neutral when
absent); `run_command` cwd; ONE detection per session feeding the system prompt; secret-named
contents withheld from the session diff; the audited limits table (scale bounds raised, repetition
bounds deliberately not). Its four-lens review found four critical/high holes — each an S16 change
re-opening an earlier session's closed hole one axis over (an install `[s]` as standing shell
consent via a package.json rewrite; a monorepo root silently waiving gates; a repair proven by
another project's green; a plan strandable on a nonexistent project) — all fixed and pinned.
Live proof of the RESOLUTION layer: 21/21 against a real two-package fixture. The end-to-end
agent run it owed was delivered by Session 16.5.

### Session 15 (2026-07-29/30) — V1.1: the multi-provider runtime

Five providers over two genuinely different protocols behind one runtime (commits `1af04c6`…
`7932fed`; suite 1072→1155+1). Landed: an opaque `reasoning` ContentBlock carrying the
provider-NATIVE artifact verbatim, tagged provider+model, persisted additively and replayed per
each provider's documented scope (kimi `all`, anthropic/deepseek/openai `current-loop`, glm never)
— which is what makes always-thinking models and reasoning tool loops legal at all; `catalog.ts`
as capability DATA with a verified date; one profile-parameterized Chat-Completions adapter plus a
separate **OpenAI Responses** adapter (Chat Completions cannot tool-call with reasoning off since
GPT-5.4, so "OpenAI-compatible" would have been a false equivalence at the point that matters);
`/provider` + `/model` + `agent providers`; env-only key discovery; `DEFAULT_MODEL =
'claude-opus-5'` as ONE constant; catalog-driven `maxTokens`/`contextBudget`; honest vision
degradation at one choke. Lasting decisions: reasoning payloads are OPAQUE and only the emitting
adapter may interpret one; persist them VERBATIM and uncapped (kimi and deepseek reject a
tool-looping message whose reasoning was altered); capabilities are advisory DATA and the wire
answer always outranks them; availability is env presence, a switch VALIDATES, and every outcome is
labeled (`models-list` / `presence-only` / `unverified-network`). **Live proof: all five providers**
— 10/10 gated adapter smokes plus two multi-provider sessions, one switching through DeepSeek,
Kimi and GLM with each writing its own file; no key value, `sk-` prefix or `Bearer` token appears
anywhere in either log. The session's most valuable find was live: `validateKey` used a bare global
fetch, so on a proxied machine it returned 401/403 for a key that works — `/provider anthropic`
would have refused a valid credential. Review: 4 lenses, 17 findings, 11 fixed, including two of
the wire-invalid-history class (`scopeReasoning` could emit an empty assistant content array;
elision monotonicity broke once `contextBudget` became mutable) and two test-quality defects that
would have shipped a false green. Still relevant: only each provider's DEFAULT model was
live-tested; GLM's key check is presence-only; reasoning deltas are captured but never rendered.

### Session 14.5 (2026-07-28) — V1.0: consolidation, repo-wide review, live proof

Not a feature session (commits `a5ca9a7`…`6f3ca84`; suite 1043→1072+1). Landed: CLI correctness
(`agent version`/`help` were not in `KNOWN`, so they started a REAL one-shot session with the
literal task string; count flags refusing NaN; `agent plan <id>` joined the ONE reader);
`test-targeted` scope defaulting from the bound plan task's touches; `/diff` carrying the report's
CHECKED verdict through ONE shared correlation; and the review-gate coherence commit (round-voiding
narrowed to applies INSIDE the round window, executor captures counting as real work, the reviewer
budget raised to 24 steps because 15 starved exactly the diligent lenses into `budget-steps`, which
cannot qualify a round). **The executor-capture EOL pin** was the top live-found gap: with system
`core.autocrlf=true` over an LF tree, `worktree add` and `checkout-index` re-applied the smudge
filter, so EVERY captured file refused at apply as base drift — the harness now pins
`core.autocrlf=false -c core.eol=lf` on both invocations when the parent tree is uniformly LF, and
a mixed tree keeps the refusal with an honest diagnosis. Lasting decisions: **a display cap must
never be a consent identity** (`scripts` is truncated for prompts; `scriptShas` carries the full
hash — an append past character 200 had ridden the earlier `[s]`); blocks and stopReason can
diverge, so the loop answers tool_uses on their EXISTENCE (a `max_tokens` cut mid-call had left the
history permanently invalid); a non-verdict is not a diagnosis (timeout and abort sit together at
the top of classification); honest degrade beats silent proceed. Review: 4 lenses, 23 findings, all
23 fixed. **Live proof: the recorded V1.0 demo** — one continuous session on the "Pulse" fixture
with three seeded defects each reachable by a different capability, **48/48 post-hoc evidence
checks**, `/accept` REFUSING twice with honest lists, the security lens finding the seeded XSS, a
browser flow catching a real defect, exactly ONE surviving harness ref, and **zero commits added to
the user's branch**. Two honest notes recorded in `DEMO.md`: the first take was discarded for a
DRIVER bug, and the validator's own first run had a wrong assertion.

### Session 14 (2026-07-27/28) — the delivery boundary: Git audit lineage + the structural review gate

Git, review, and acceptance became one coherent delivery boundary (commits `f99f41b`…`82a1158`;
suite 972→1029+1). Landed: the `onRefReady` seam (event BEFORE ref, so the creation-instant leak
is structurally closed and a failed ref write leaves an honest self-converging phantom);
`harness.checkpoint` as a NEW event type with three kinds and a seq/kind-aware owed fold whose
delivery survival keys on the ref an acceptance actually CONSUMED; the pre-integration checkpoint
under the spawn-only covered-change rule; the `/accept` delivery anchor (idempotent across the
crash window, never hostage to git, `/commit` suggested not performed); and `src/review/` — typed
findings recorded at the source through `report_finding` (the second named childTools admission),
the pure `foldReview` deriving requirement/qualification/triage worth, and open critical/high
findings blocking `/accept`. Lasting decisions: a delivery ref's identity is the acceptance that
consumed it; recorded findings are the gate's only input (prose is narration); triage annotates,
never erases, and every rule is enforced twice. Review: 4 lenses, 16 findings, 8 fixed — all four
lenses independently found the phantom-delivery defect, and the first fix for it was itself wrong
until a regression pin caught it. Live proof: a two-life piped run on the QuickBoard fixture,
43/43 evidence checks, including a deterministic pre-work `/accept` refusal naming the review
blocker and a UI lens finding a seeded XSS. **Live-found and fixed in S14.5:** executor capture
refused everything under system `core.autocrlf=true`.

### Session 13 (2026-07-26) — managed previews + browser/visual verification

Locally built apps became verifiable as a user experiences them (commits `5b7b451`…`28fb29a`;
suite 868→972+1). Landed: `src/preview/` (a live handle over an fd-logged, TTL/log-capped,
unref'd process; a fixed dev/preview/serve/start allowlist; announced-port readiness; the
identity-verified crash sweep with no age hatch on kills) and `src/browser/` (playwright-core over
the system browser; a zod FlowSpec whose `goto` REQUIRES app-meaningful readiness; the typed
timeout/assertion/navigation/runtime/protocol taxonomy with a real origin comparison); wire images
(the model sees pixels live, the log keeps pointers, elision ages pixels to markers); check-kind
`browser` feeding the same gates/acceptance/recovery. Lasting decisions: **a preview is a
RESOURCE, not a check kind** (a check is a bounded process that ends; a preview deliberately does
not); browser evidence rides the check channel with `exitCode: null`, which satisfies gates while
staying structurally outside the file-CHECKED exit-0 rule; **kills need positive identity,
deletions do not**; flows inherit the preview's consent, origin-locked, with no ask path for
arbitrary origins. Live: two-life E2E with a browser-only seeded defect, classified repair, crash,
identity-verified orphan sweep, re-consent, 44/44 checks. Still relevant: readiness proves an
announced port answers HTTP (socket ownership unverified); a one-shot console Ctrl+C also reaches
the preview on Windows; grandchildren of a dead intermediate remain unreachable by kills.

### Session 12 (2026-07-25/26) — unified verification gate and typed recovery

Verification became a typed capability whose results are durable evidence (suite 689→868+1).
Landed: `src/checks/` (bounded never-throwing detection; a declarative recipe table where a
project's OWN script beats a guessed tool; `toCommand` as the single composer; normalization whose
one rule is **the exit code is the verdict**, with named SIGNALS keeping later classification
derivable from the log alone); the `check` policy fact with replay consent bound to the script
BODY; `PlanTask.checks`/`PlanGraph.gates` with one `depSatisfied` predicate plus integration and
completion boundary gates and honest waivers; and `src/recovery/` — failure classes as a DATA
catalogue, deterministic classification BEFORE any repair planning, a ledger whose outcomes are
DERIVED, and a bounded policy with typed stop reasons. Lasting decisions: **the model names KINDS,
the harness names COMMANDS** (the whole trust argument for consent-once checks — and why consent
had to bind the body: rewriting `package.json` otherwise turned one `[s]` into standing execution
consent, the critical review finding of that session); a FIELD, not a state, for verification; a
gate may only be waived by a PROJECT-capability fact; enforced/detected/recorded are three
different words. Live four-life E2E with four seeded defects: 39/40 checks, including a SIGKILL
inside a running check (replayed as "produced no verdict") and a `dependency-setup` failure that
REFUSED automatic repair and escalated.

### Session 11.5 (2026-07-24) — the durable session

A session became a durable, self-contained unit of work (suite 645→688+1). Landed: crash-covered
task-base ref lifecycle (creation events + resume-seeded pruning); truncation spill blobs
("captured" never "full"); definition-bound completed state with per-attempt history; the R10
retry ceiling (3 genuine failures per current definition; crashes and user stops never count); and
the `/accept` boundary — recorded consent, plan retirement via supersede (never archive-by-delete,
which would have added the system's only un-undoable act), immediate ref pruning, and a
deterministic journal Handoff. Live three-life E2E with a mid-wave SIGKILL and a second unplanned
kill absorbed: 30/30 checks. Still relevant: cleanup at acceptance is deliberately conservative
(snapshots, blobs, plan files, logs are never deleted); one-shot sessions cannot accept.

### Session 11 (2026-07-23/24) — iterative planning, task graphs, parallel-first execution

The planning/orchestration lifecycle (suite 574→645+1). Landed: ONE canonical `<id>.plan.json`
task graph with two deterministic projections; approval binding `planContentSha` so status flips
are sha-neutral BY CONSTRUCTION and any semantic amendment invalidates; structured `update_plan`
whose validation errors return complete with NOTHING written; observable routing (`@plan`/
`@direct`, no harness classifier); the delegate DAG gate with plan bindings and events-rebuilt
caps; bounded supervision dual-surfaced as events AND the head-of-result group digest; task-scoped
`/cancel`; and the TTY-only sticky status area with the live task table. Lasting decisions:
execution status is a PURE EVENT FOLD, never a field in the plan (two writable status sources
would be the double-truth trap); the scheduler is a GATE plus guidance, not an in-tool wave engine;
mid-turn interception is TTY-only because piped determinism is a contract.

### Session 10 (2026-07-23) — repository intelligence and focused exploration

Selective, ranked, task-directed retrieval replaced the broad file list (suite 515→574+1). The
Plan-agent critique caught two CRITICAL flaws pre-code: never redefine `WorkspaceMap.sha256`
(additive `inventorySha256` instead) and never let an observe tool write the index at query time.
Live proof on a 3,064-file vitest clone: flat map 0/14 packages visible → ranked map 14/14 in ≤16k
chars; two disjoint-focus explorers, zero shared reads; 16 uncached parent input tokens. Lasting
decisions: excerpts and line numbers ALWAYS come from live reads (a stale index may misrank, never
fabricate); recall backstop over ranking confidence; regex over tree-sitter (Windows-first, no
native deps, same interface if recall pressure demands).

### Session 9 (2026-07-22/23) — pre-expansion consolidation + the live V0.7 proof

Audit-driven fixes, no new capability (suite 498→515+1): concurrent-session worktree safety
(owner-stamped entries, in-process mutex + token `O_EXCL` lock, merge-on-save); plan-approval
state displayed at the executor spawn ask; task-base refs pruned with provenance; command grants
keyed on the command FACT (a session grant is stored only when `tool.command` is undefined; `[s]`
hidden where no grant would store — found live). The live V0.7 proof: `@plan` → sha-bound approve
→ ONE call → TWO parallel worktree executors → forwarded approvals → capture → apply ×2 → `/undo`
→ honest recovery → reviewer panel auto-denied its shell attempts and the parent re-ran the probe
itself; 42 uncached input tokens; sovereignty observed unprompted.

### Session 8 (2026-07-22) — coordinated parallelism + the minimal agent-teams layer

Roles as two-layer explicit contracts (policy fact table + runtime contract rows, pinned
consistent at load); parallel groups living in the delegate TOOL (one call = 1–3 tasks = one
evidence unit = ONE approval for a mutating group; `runTurn` byte-identical); plan mode; the
executor role (base checkpoint → detached worktree → bounded binary-safe capture that OUTLIVES the
worktree → reviewed drift-refusing apply). Lasting decisions: worktrees of a trusted workspace are
trusted BY DERIVATION; the plan-approval gate landed BEFORE the capability it gates; executor
spawns are never grantable; worktrees live in the OS temp dir because `validatePath` DICTATES it.

### Session 7 (2026-07-20/21) — main-agent control layer: memory + subagent tasks

Three-document project memory (AGENT.md user constitution; harness-generated rolling
JOURNAL/CODEBASE with deterministic event-derived Evidence and the verbatim "CONTEXT, NOT
AUTHORITY" framing) + the first read-only explorer tasks over the SAME `runTurn` +
`assembleSession` as the ONE construction path (trust is a parameter, so assembly is structurally
impossible untrusted). Lasting decisions: memory is context-not-authority STRUCTURALLY (evidence
from events; crash notes from log tails — absence of memory never accuses a session);
`aborted ≠ user-quit`; delegation budgets are harness-fixed, never model-controlled.

### Session 6.5 (2026-07-19) — V0.5 capability demo + production-style validation

One continuous ~68-min recorded run (real ConPTY → xterm.js → Playwright, byte-truthful): built
**LedgerLite** (20 files, 51 unit tests) from a natural-language brief with 13 live approvals,
then demonstrated diff/attributed-commit/checkpoint/restore/undo/report and deny-adapt honesty;
**124 uncached input tokens** total. Lasting decisions: validation sessions live OUTSIDE the
product repo; the bridge identifies itself truthfully; demo briefs state git authority explicitly.

### Session 6 (2026-07-18) — Git-native, reviewable, context-efficient

GitOps as a harness-only capability (a policy regression test PINS why it must never be a model
tool — a command-less, mutation-less "git_commit tool" would auto-allow as observe), with the
hardened git substrate, attributable `/diff`, session-scoped `/commit`, and hidden-ref checkpoints
whose restore is ONE applyUndo unit — git is never the undo mechanism (the Codex ghost-commit
data-loss lesson). Context efficiency: two-breakpoint prompt caching (~6 uncached input
tokens/session) + deterministic monotone elision + the git-backed map.

### Session 5 (2026-07-18) — enforced isolation + automatic command review

The OS-enforced Windows boundary (Low IL + Job Object; `WRITE_RESTRICTED` tokens FAILED in the
machine probe, which ran BEFORE any code) + deterministic automatic command review
(`analyzeCommand` as a POSITIVE proof of safety; auto-run requires proof AND an active probed
boundary, else ask; approved commands deliberately run unsandboxed — the user accepted the risk).
Enforcement is probed per session, never assumed, and degrades fail-closed. 8 real-OS win32 tests
and a 66-assertion adversarial corpus (40+ escape forms never auto-run).

### Session 4 (2026-07-17) — execution kernel hardening

The managed exec substrate (typed termination — a killed command has NO exit code, everywhere —
and the kill/drain state machine that never awaits `'close'` unconditionally: the
nodejs/node#21960 grandchild-pipe hang class) + real mid-command cancellation proven with a
genuine console CTRL_C against the live API. **Cost lesson (now a CLAUDE.md rule):** a per-finding
3-verifier fan-out exploded (19 findings → ~57 agents) and was aborted; findings were salvaged and
verified BY HAND — review workflows stay bounded, no per-finding verifier panels.

### Sessions 1–3 (2026-07-14/16) — the bounded local agent loop, the REPL, and the first recorded demo

V0.1's seven pillars (typed contracts, append-only JSONL with tail repair, one pure policy choke
point + Windows-first path validator, five file tools + run_command, snapshots with drift-refusing
undo, resume with crash reconciliation, deterministic evidence report); V0.2's REPL on the exact
same runtime (no parallel loop), workspace trust as recorded consent (TTY-only prompt, no
self-granting folders, corrupt store = hard error), and narrowing-only config; a reusable
proxy-aware transport (pure `resolveProxy`, per-request dispatcher, credentials never persisted);
and an 11m20s recorded E2E whose product yield was two real defects (an npm-link shim exiting 0
silently; a vitest hang backstop). Lasting decisions: no widenable allowlist config; in-workspace
writes auto-allow but snapshot first; sandbox vs approval kept separate and stated honestly;
secret reads redacted via salted HMAC and deliberately non-replayable on resume; state lives
outside the workspace. Still-true limitations: command output is not scrubbed for secrets; path
checks are TOCTOU-racy; undo is file-only; single-user lock assumption.

---

## Deferred pool (accumulated, still open)

**Design already agreed, not yet built:** `/review dismiss <id> <reason>` — a user-side
per-finding dismissal (`review.triage` widened with `action: 'dismiss'` + `source: 'user'|'model'`,
refused at the tool so consent stays the user's, marked ineffective in the fold when not
user-sourced, always a caveat); a static-server preview recipe for plain-HTML workspaces (a
harness-owned script, `workspaceAuthored: false`, requiring a declared port); `agent accept <id>`
so one-shot sessions can reach the acceptance boundary (needs `runAcceptFlow` extracted from the
REPL path, and the clean-end predicate already fixed in S14.5); `agent gc` — a dry-run-by-default
blob/plan-file collector over a conservative reference walk (treat every 64-hex string in every
event as a reference; refuse to delete anything when any log is corrupt or locked; age-gated).

**Cross-platform test portability (found by CI's first run, 2026-07-28):** the suite is
Windows-first in a way that is only now measured. On `ubuntu-latest`, 10 tests fail because the
TESTS encode win32 semantics, not because the runtime is wrong there: backslash traversal and UNC
rejection fixtures, case-insensitive child-env deduplication (Linux env vars are case-sensitive,
and `buildChildEnv` correctly does not fold them), taskkill-based tree-kill expectations, and a
git hook-failure fixture. The CI Linux job is kept and marked advisory so the gap stays visible;
the work is to gate or parameterize those fixtures per platform. Two REAL defects the same first
CI run found were fixed immediately: `resolveLayout` compared a realpath'd workspace against a
merely resolved state root (so a state dir inside the workspace could evade the refusal when
spelled as an 8.3 short path or through a symlink), and a test whose premise silently broke when
cwd and TEMP sit on different drives.

**Provider/model (new, S15; amended S16.5):** surface `Usage.reasoningTokens` in the report and
`/status` (recorded on `assistant.message`; no reader folds it yet); a live reasoning render
channel — the S16.5 heartbeat covers the frozen-screen half; the CONTENT half (streaming the
reasoning text dim) remains open; reasoning-payload spill-to-blob if event logs grow
uncomfortable; strict-schema transformation for OpenAI/Kimi strict tool mode (currently
`strict:false` — the S16.5 tolerant decode handles the observed double-encoding, but strict mode
would prevent it at the source); resume identity stickiness (a bare `agent resume` of a kimi
session resumes on the default provider — recorded honestly, but the least-surprising default is
the session's own identity, flags overriding); per-provider reviewer/executor budget scale (two
of three kimi lenses hit the 8-minute wall; budgets stay harness-fixed, but a slow
always-thinking model may deserve a scaled wall); per-role model tiers (a cheap explorer model);
exposing Anthropic `output_config.effort` / reasoning-effort controls per provider; `undici` 8
and `diff` 9 majors (deferred deliberately — proxy dispatcher and patch API need live
verification).

**Kernel/runtime:** `pause_turn` is mapped but the loop would end the turn; per-action / `--to` /
`--steps` undo; conversation rewind; session
pruning/sanitized export; prompt-history persistence + line-editing niceties; PTY support (the
supervised preview substrate deliberately stops at non-interactive servers); SQLite indexing of
events and long-term memory topic retrieval.

**Delivery/review:** the review requirement is plan-scoped, so an events-derived requirement for
plan-less executor work is available if "any mutating session" ever becomes the wanted default; a
phantom harness checkpoint suppresses the covered-change rule until the next spawn.

**Preview/browser:** socket-ownership verification for readiness (owner-pid via
Get-NetTCPConnection is the likely shape); deterministic screenshot BASELINE comparison where
stable baselines exist; preview log files join the blob-retention question; executor-side preview
(blocked on the same worktree-lacks-deps seam as `run_check`); headed/devtools browser mode and
multi-context flows; `ps` etime parsing for macOS/BSD sweep identity (Linux-shaped today, fails
safe); a Windows one-shot Ctrl+C console-group workaround if the documented 'crashed' mislabel
ever bites.

**Retrieval:** tree-sitter (or richer) extraction behind the same extract interface; more
languages as data-shaped table additions; a user config knob for the map budget; a post-group
child read-set overlap metric; retrieval-aware journal topics.

**Verification/recovery (amended S16.5):** multi-kind `run_check` batches re-probe drift once,
before the first spawn — a workspace-authored script run by an earlier kind could rewrite a later
kind's body within one approved batch (per-iteration re-probe is the likely shape); run_check's
`planTouches` fact reads the plan document at decide and the plan file is outside the drift
stamps (stamp it in); a `session`-targeted escalation has no harness-derived resolution (a
user-side dismissal recorded as an event is the likely shape); per-task gates are unit-tested only,
since a plan of all-`main` tasks cannot declare them; executors cannot self-verify (parent-only
`run_check`, because a worktree lacks gitignored deps); more ecosystems as data-shaped recipe rows;
an incremental check cache keyed by file hashes + tool versions.

**Planning/orchestration:** a width-aware status-area clip before free-form text may land in status
lines; sibling-task chrome printing over a DISPLAYED forwarded-approval prompt (part of the io
redesign); plan-file pruning (folded into `agent gc` above); a `/cancel` surface for non-TTY
sessions; richer wave guidance.

**Tasks/memory/git/sandbox:** task resume/continue; deeper scanning of child reports for
instruction-shaped content (v1 ships delimiters + provenance labels); the stale-displayed-
forwarded-prompt line-consumption wart (needs an io redesign); per-child sandbox scratch TEMP
isolation; a cross-process memory-doc lock (today: a seconds-wide last-writer-wins window at
simultaneous quits); model-generated compaction of assistant/user text; patch/multi-edit editing;
model-generated commit messages; attribution of approved `run_command` file effects (structurally
under-claimed); push/PR flows; submodule + multi-repo workspaces; network-egress control and a
read/confidentiality boundary (the two enforced gaps that most matter); a cached/compiled sandbox
host to cut per-command Add-Type latency; macOS/Linux enforcement backends; containment of
service-reparented work that escapes the Job Object.

**Cosmetics (informational only):** command-label noise — word-boundary matches can mislabel (the
literal "format" in `format.js` → destructive); labels never grant and never gate. PowerShell
CLIXML progress-stream noise on some chained commands' stderr.
