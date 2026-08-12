import { describe, it, expect } from 'vitest';
import { DEFAULT_MAX_STEPS } from '../src/runtime/session.js';
import { EXECUTOR_BUDGET, ROLE_CONTRACTS } from '../src/runtime/roles.js';
import {
  CONTENT_CHARS_PER_SESSION,
  CREDITS_PER_SESSION,
  EXTRACTS_PER_RESEARCH_TASK,
  EXTRACTS_PER_SESSION,
  EXTRACT_TIMEOUT_MS,
  MAX_RESULTS_PER_SEARCH,
  MAX_URLS_PER_EXTRACT,
  SEARCHES_PER_SESSION,
  SEARCH_TIMEOUT_MS,
} from '../src/research/types.js';
import { MAX_NOTES_PER_RESEARCHER } from '../src/tools/record-source.js';
import {
  GH_AUTH_STATUS_FIXED_VERSION,
  MAX_PREVIEW_COMMITS,
  MAX_PREVIEW_PATHS,
  MAX_RELEASE_NOTES_CHARS,
  MAX_REMOTE_CONTENT_CHARS,
  MAX_REMOTE_ITEMS,
  REMOTE_CALL_TIMEOUT_MS,
  REMOTE_PUSH_TIMEOUT_MS,
  REMOTE_READS_PER_SESSION,
  REMOTE_WRITES_PER_SESSION,
} from '../src/remote/types.js';
import { REMOTE_OBSERVATION_MAX_AGE_MS } from '../src/types.js';
import { SESSION_CHILD_OUTPUT_TOKEN_CAP, TASKS_PER_SESSION } from '../src/runtime/subagent.js';
import { MAX_TASK_CHANGE_FILES, MAX_TASK_CHANGE_FILE_BYTES } from '../src/runtime/task-changes.js';
import { CHECKS_PER_SESSION } from '../src/tools/run-check.js';
import { INSTALL_TIMEOUT_MS } from '../src/setup/intents.js';
import { SETUPS_PER_SESSION } from '../src/tools/project-setup.js';
import { MAX_CONCURRENT_PREVIEWS, PREVIEWS_PER_SESSION } from '../src/tools/preview.js';
import { runCommandTool } from '../src/tools/run-command.js';
import { DEFAULT_PREVIEW_TTL_MS } from '../src/preview/process.js';
import { DEFAULT_READY_WAIT_MS } from '../src/preview/ready.js';
import { FLOW_WALL_MS } from '../src/browser/types.js';
import { MAX_REPAIR_ATTEMPTS, REPAIRS_PER_SESSION, REPAIR_WALL_MS } from '../src/recovery/policy.js';
import { MAX_REVIEW_ROUNDS, MAX_TASK_ATTEMPTS } from '../src/tools/delegate.js';
import { MAX_PROJECT_UNITS, MAX_UNIT_DEPTH } from '../src/checks/workspace.js';
import { DEFAULT_TRIGGER_CHARS, DEFAULT_TARGET_CHARS } from '../src/runtime/elision.js';
import { SWEEP_LIVE_MAX_AGE_MS } from '../src/runtime/worktrees.js';
import { MODELS, UNKNOWN_MODEL_CAPS, capsFor, contextBudgetFor } from '../src/provider/catalog.js';
import { AGENT_MD_CAP_CHARS, JOURNAL_INJECT_CAP_CHARS, CODEBASE_CAP_CHARS, USER_AGENT_CAP_CHARS } from '../src/memory/load.js';
import { JOURNAL_KEEP_FULL, JOURNAL_MAX_CHARS } from '../src/memory/journal.js';
import { LESSONS_MAX_CHARS, LESSONS_INJECT_CAP_CHARS, MAX_LESSONS, MAX_LESSONS_PER_SESSION } from '../src/memory/lessons.js';
import { RESEARCH_MAX_CHARS, RESEARCH_INJECT_CAP_CHARS, MAX_RESEARCH_ENTRIES, RESEARCH_STALE_DAYS } from '../src/memory/research.js';

/**
 * The harness's bounds, asserted as ONE visible contract (Session 16; retuned Session 20.5).
 *
 * Every value here is a deliberate answer to "how much legitimate work should this permit before
 * it stops?", and they were spread across a dozen modules where a change could pass review as an
 * innocuous tweak. This file exists so that raising or lowering any of them is a decision someone
 * has to make explicitly, in a diff that says what it is.
 *
 * Two kinds of bound live here and they are NOT interchangeable:
 *   - SCALE bounds (steps, concurrency, time, bytes) — how much real work fits. S16 raised these
 *     for the full-stack shape; S20.5 raised them again for the v1.6 shape (research, documents,
 *     remote delivery inside one coherent session) after a limits audit found several sized for
 *     the fixtures they were introduced against.
 *   - REPETITION bounds (attempts, rounds, retries) — how many times the agent may try the same
 *     thing. Neither session raised ANY of these: they bound looping, and a looser loop bound
 *     buys more looping, never more capability. The same is true of CONSENT bounds (migrate/seed
 *     ask every time; a remote write asks every time; observation freshness) — those are not
 *     capacity, they are authority, and they do not scale with project size.
 */

describe('scale bounds (S16 raised these; S20.5 retuned them for the v1.6 shape)', () => {
  it('per-turn tool calls', () => {
    expect(DEFAULT_MAX_STEPS).toBe(60);
  });

  it('shell command timeout ceiling — asserted through the schema that enforces it', () => {
    expect(runCommandTool.schema.safeParse({ command: 'x', timeoutMs: 900_000 }).success).toBe(true);
    expect(runCommandTool.schema.safeParse({ command: 'x', timeoutMs: 900_001 }).success).toBe(false);
  });

  it('managed preview processes', () => {
    expect(MAX_CONCURRENT_PREVIEWS).toBe(4);
    expect(PREVIEWS_PER_SESSION).toBe(16);
    // 60 → 120 min (S20.5): a multi-hour session OUTLIVED the TTL — servers were reaped
    // mid-work and every restart spent one of the session's starts.
    expect(DEFAULT_PREVIEW_TTL_MS).toBe(120 * 60 * 1000);
    expect(DEFAULT_READY_WAIT_MS).toBe(60_000);
  });

  it('the executor budget — and the wall clock now excludes approval wait', () => {
    // 20 → 30 min (S20.5), with time spent waiting on a forwarded approval EXCLUDED (measured
    // and subtracted by the runner): an away human used to kill the executor mid-work.
    expect(EXECUTOR_BUDGET).toEqual({ maxSteps: 40, timeoutMs: 1_800_000, maxOutputTokens: 50_000 });
    expect(ROLE_CONTRACTS.explorer.budget).toEqual({ maxSteps: 15, timeoutMs: 300_000, maxOutputTokens: 30_000 });
    // 8 → 12 min (S20.5): two of three kimi lenses hit the 8-minute wall in the S15 live review —
    // an always-thinking model spends wall clock on reasoning the step count cannot see.
    expect(ROLE_CONTRACTS.reviewer.budget).toEqual({ maxSteps: 24, timeoutMs: 720_000, maxOutputTokens: 30_000 });
    // Session 19. 600s, not 420s: the live run showed a researcher timing out mid-reading with
    // nothing recorded; the ceiling landed with the per-task page cap and the extract timeout.
    expect(ROLE_CONTRACTS.researcher.budget).toEqual({ maxSteps: 20, timeoutMs: 600_000, maxOutputTokens: 30_000 });
    // Session 21.5. The @review inspector inherits the reviewer's numbers, not the 15-step
    // read-only default: its work has the same interleaved read → confirm → record → read shape
    // that starved the diligent lenses at 15.
    expect(ROLE_CONTRACTS.inspector.budget).toEqual({ maxSteps: 24, timeoutMs: 720_000, maxOutputTokens: 30_000 });
    // The worktree sweep's live-pid age hatch is COUPLED to the executor clock (S20.5): with
    // approval wait excluded, a live task can legitimately be hours old.
    expect(SWEEP_LIVE_MAX_AGE_MS).toBe(8 * 60 * 60 * 1000);
    expect(SWEEP_LIVE_MAX_AGE_MS).toBeGreaterThan(EXECUTOR_BUDGET.timeoutMs * 4);
  });

  it('web research (Session 19; S20.5 raised the session pools)', () => {
    // The bounds the approval prompt shows and the engine enforces. A quiet edit here widens a
    // capability that leaves the machine, which is exactly what a pin is for. S20.5: three
    // researcher tasks at the per-task cap used to drain the whole session extract allowance
    // (12 = 3×4, zero slack); the session pools now carry headroom beyond one full group.
    expect(SEARCHES_PER_SESSION).toBe(36);
    expect(EXTRACTS_PER_SESSION).toBe(20);
    expect(CREDITS_PER_SESSION).toBe(120);
    expect(CONTENT_CHARS_PER_SESSION).toBe(1_200_000);
    expect(EXTRACTS_PER_RESEARCH_TASK).toBe(6);
    expect(MAX_RESULTS_PER_SEARCH).toBe(10);
    expect(MAX_URLS_PER_EXTRACT).toBe(5);
    expect(MAX_NOTES_PER_RESEARCHER).toBe(10);
    // Per-call time bounds. The extract ceiling must not exceed Tavily's own effective 30s, or it
    // is time a researcher can only ever lose off its wall clock.
    expect(SEARCH_TIMEOUT_MS).toBe(20_000);
    expect(EXTRACT_TIMEOUT_MS).toBe(30_000);
    // A single task must not be able to spend the whole session's page allowance — and a full
    // 3-task group must leave the session (and the parent's searches) something to work with.
    expect(EXTRACTS_PER_RESEARCH_TASK * 3).toBeLessThan(EXTRACTS_PER_SESSION);
    // Nor should one task's reading alone be able to exhaust its own wall clock.
    expect(EXTRACTS_PER_RESEARCH_TASK * EXTRACT_TIMEOUT_MS).toBeLessThan(ROLE_CONTRACTS.researcher.budget.timeoutMs / 2);
  });

  it('remote delivery (Session 20; S20.5 raised reads only)', () => {
    // Reads are session-grantable, so REMOTE_READS_PER_SESSION is what an [s] is actually
    // bounded by — and every observation-staleness re-read spends one, so 40 was tight for a
    // session that publishes several refs. Writes are deliberately UNCHANGED: a session that
    // publishes as often as it looks has stopped being a delivery flow.
    expect(REMOTE_READS_PER_SESSION).toBe(60);
    expect(REMOTE_WRITES_PER_SESSION).toBe(10);
    expect(MAX_REMOTE_ITEMS).toBe(30);
    expect(MAX_PREVIEW_COMMITS).toBe(20);
    expect(MAX_PREVIEW_PATHS).toBe(60);
    expect(MAX_REMOTE_CONTENT_CHARS).toBe(40_000);
    expect(MAX_RELEASE_NOTES_CHARS).toBe(60_000);
    expect(REMOTE_CALL_TIMEOUT_MS).toBe(30_000);
    expect(REMOTE_PUSH_TIMEOUT_MS).toBe(120_000);
    // The freshness bound is KERNEL-owned so the engine can enforce it without depending on a
    // workflow pack; the pack must not be able to widen its own leash.
    expect(REMOTE_OBSERVATION_MAX_AGE_MS).toBe(300_000);
    expect(REMOTE_PUSH_TIMEOUT_MS).toBeGreaterThan(REMOTE_CALL_TIMEOUT_MS);
    expect(REMOTE_WRITES_PER_SESSION).toBeLessThan(REMOTE_READS_PER_SESSION);
    // The gh release that fixed the auth-status token leak (GHSA-cg6r-mpgc-h9mm).
    expect(GH_AUTH_STATUS_FIXED_VERSION).toBe('2.97.0');
  });

  it('delegated work — one pool for five roles', () => {
    // 16/200k → 32/400k (S20.5): explorers, planners, researchers, reviewers AND executors share
    // this pool, and two review rounds (≤6) + one researcher group (≤3) + a few executor waves
    // exhausted it at exactly the point delegation matters most. Group size (≤3) and the per-task
    // budgets are unchanged — this buys breadth, not longer or less bounded children.
    expect(TASKS_PER_SESSION).toBe(32);
    expect(SESSION_CHILD_OUTPUT_TOKEN_CAP).toBe(400_000);
  });

  it('captured executor changes', () => {
    expect(MAX_TASK_CHANGE_FILES).toBe(400);
    expect(MAX_TASK_CHANGE_FILE_BYTES).toBe(5 * 1024 * 1024);
  });

  it('verification and setup budgets', () => {
    // 80 → 160 (S20.5): the budget is SHARED with browser flows, and a multi-unit stack at ~5
    // kinds per unit spends ~20 per verification pass — four passes plus flows hit the old wall,
    // whose refusal makes gated plan tasks unsatisfiable without a plan re-approval.
    expect(CHECKS_PER_SESSION).toBe(160);
    expect(SETUPS_PER_SESSION).toBe(12);
    expect(INSTALL_TIMEOUT_MS).toBe(900_000);
  });

  it('browser flow wall clock', () => {
    // 90s → 120s (S20.5): a cold-start dev server's first compile can eat most of 90s before
    // the first goto settles.
    expect(FLOW_WALL_MS).toBe(120_000);
  });

  it('project discovery', () => {
    // 12 → 16 (S20.5) — and the dropped-units note now renders into the system prompt, so a
    // unit past the cap is a VISIBLE drop, not a silent nonexistence.
    expect(MAX_PROJECT_UNITS).toBe(16);
    expect(MAX_UNIT_DEPTH).toBe(2);
  });
});

describe('the catalog context budgets follow the derivation rule (S20.5)', () => {
  // budget×1.25 (chars≈4×tokens undercounts code at ~3.3) + 40k un-elidable overhead (system
  // prompt, map, tool schemas, injections) + the output reservation must FIT the window. The old
  // flat 100k merely reproduced the pre-S15 400k/200k chars: ~10% of a 1M window, and an
  // OVERFLOW on the 200k/128k-window models once the overhead was priced in.
  it('every catalog model fits its own window with slop and overhead', () => {
    for (const models of Object.values(MODELS)) {
      for (const m of models) {
        expect(m.budgetTokens * 1.25 + 40_000 + m.defaultMaxTokens, `${m.id} must fit its window`).toBeLessThanOrEqual(m.contextTokens);
      }
    }
    const u = UNKNOWN_MODEL_CAPS;
    expect(u.budgetTokens * 1.25 + 40_000 + u.defaultMaxTokens).toBeLessThanOrEqual(u.contextTokens);
    // The mock provider is exempt by nature: offline, never billed, never near a real window.
  });

  it('billing clamps and the load-bearing per-model choices', () => {
    // gpt-5.6 bills the WHOLE request 2x-in/1.5x-out above 272K input (verified 2026-08-09):
    // worst-case real input must stay under it.
    for (const m of MODELS.openai) {
      expect(m.budgetTokens * 1.25 + 40_000, `${m.id} must stay under the 272K billing threshold`).toBeLessThanOrEqual(272_000);
    }
    // Anthropic 1M flagships bill FLAT across the window (verified 2026-08-09) — the 250k budget
    // is a latency/cost opinion, not a billing clamp.
    expect(capsFor('anthropic', 'claude-opus-5').budgetTokens).toBe(250_000);
    // kimi-k3 is 1M flat-priced, but its replay-all reasoning is un-elidable wire floor.
    expect(capsFor('kimi', 'kimi-k3').budgetTokens).toBe(150_000);
    // glm-5.2's base id is a 200K window (1M is the separate glm-5.2[1m] variant id) — the old
    // row claimed its sibling's window.
    expect(capsFor('glm', 'glm-5.2').contextTokens).toBe(200 * 1024);
    // The derived chars stay ×4/half — the elision contract is unchanged, only the inputs moved.
    const b = contextBudgetFor('anthropic', 'claude-opus-5');
    expect(b).toEqual({ triggerChars: 1_000_000, targetChars: 500_000 });
  });
});

describe('repetition and consent bounds (deliberately UNCHANGED — in S16 and again in S20.5)', () => {
  it('a task may fail three times under one definition, and no more', () => {
    expect(MAX_TASK_ATTEMPTS).toBe(3);
  });

  it('a repair may be attempted three times, eight times a session', () => {
    expect(MAX_REPAIR_ATTEMPTS).toBe(3);
    expect(REPAIRS_PER_SESSION).toBe(8);
  });

  it('the repair WINDOW grew but the attempt ceiling did not — slower work, not more of it', () => {
    expect(REPAIR_WALL_MS).toBe(30 * 60 * 1000);
    expect(MAX_REPAIR_ATTEMPTS).toBe(3);
  });

  it('a third adversarial review round is still refused outright', () => {
    expect(MAX_REVIEW_ROUNDS).toBe(2);
  });

  it('the elision DEFAULTS are untouched — per-model budgets moved in the catalog, where they are data', () => {
    // These are the fallback for sessions with no catalog identity (tests, exotic wiring).
    // Production budgets flow from catalog budgetTokens via contextBudgetFor.
    expect(DEFAULT_TRIGGER_CHARS).toBe(400_000);
    expect(DEFAULT_TARGET_CHARS).toBe(200_000);
  });
});

describe('memory-doc budgets (S21 — every startup-injection bound is a visible contract)', () => {
  // These caps decide how many chars of durable memory ride the cached stable prefix of EVERY
  // request. They were previously private to their modules; a growing doc raised nobody's hand.
  it('per-doc injection caps', () => {
    expect(AGENT_MD_CAP_CHARS).toBe(24_576);
    expect(JOURNAL_INJECT_CAP_CHARS).toBe(12_288);
    expect(CODEBASE_CAP_CHARS).toBe(16_384);
    // The global profile is deliberately SMALLER than the project constitution: machine-wide
    // prose about the person, not a project rulebook.
    expect(USER_AGENT_CAP_CHARS).toBe(16_384);
  });

  it('the TOTAL worst-case memory injection is one deliberate ceiling — adding a doc must trip this', () => {
    // Every char here rides the cached stable prefix of EVERY request (and the end-of-session
    // narrative call re-reads the same prefix). ~86k chars ≈ ~21k tokens worst case; real docs
    // run far smaller, but the ceiling is the contract.
    const total =
      USER_AGENT_CAP_CHARS +
      AGENT_MD_CAP_CHARS +
      JOURNAL_INJECT_CAP_CHARS +
      CODEBASE_CAP_CHARS +
      LESSONS_INJECT_CAP_CHARS +
      RESEARCH_INJECT_CAP_CHARS;
    expect(total).toBe(86_016);
    expect(total).toBeLessThanOrEqual(90_000);
  });

  it('the journal growth policy: 2 full entries, 24 KiB on disk', () => {
    expect(JOURNAL_KEEP_FULL).toBe(2);
    expect(JOURNAL_MAX_CHARS).toBe(24_576);
  });

  it('the lessons growth policy (S21): 30 entries / 16 KiB on disk, 8 KiB injected, ≤3 proposals per session', () => {
    expect(MAX_LESSONS).toBe(30);
    expect(LESSONS_MAX_CHARS).toBe(16_384);
    expect(LESSONS_INJECT_CAP_CHARS).toBe(8_192);
    // A repetition-flavored bound: how much durable memory ONE session may mint. Deliberately
    // small — a session that "learned" ten lessons learned none worth keeping.
    expect(MAX_LESSONS_PER_SESSION).toBe(3);
  });

  it('the research surface (S21): 50 entries / 16 KiB on disk, 8 KiB injected, 30-day staleness horizon', () => {
    expect(MAX_RESEARCH_ENTRIES).toBe(50);
    expect(RESEARCH_MAX_CHARS).toBe(16_384);
    expect(RESEARCH_INJECT_CAP_CHARS).toBe(8_192);
    // The perishability bound: a research note without an expiry is stale confidence deferred.
    expect(RESEARCH_STALE_DAYS).toBe(30);
  });
});
