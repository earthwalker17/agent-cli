import { describe, it, expect } from 'vitest';
import { DEFAULT_MAX_STEPS } from '../src/runtime/session.js';
import { EXECUTOR_BUDGET, ROLE_CONTRACTS } from '../src/runtime/roles.js';
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

/**
 * The harness's bounds, asserted as ONE visible contract (Session 16).
 *
 * Every value here is a deliberate answer to "how much legitimate work should this permit before
 * it stops?", and they were spread across a dozen modules where a change could pass review as an
 * innocuous tweak. This file exists so that raising or lowering any of them is a decision someone
 * has to make explicitly, in a diff that says what it is.
 *
 * Two kinds of bound live here and they are NOT interchangeable:
 *   - SCALE bounds (steps, concurrency, time, bytes) — how much real work fits. Session 16 raised
 *     these, because a dependency-bearing full-stack project is simply bigger than a demo fixture.
 *   - REPETITION bounds (attempts, rounds, retries) — how many times the agent may try the same
 *     thing. Session 16 raised NONE of these: they bound looping, and a looser loop bound buys
 *     more looping, never more capability.
 */

describe('scale bounds (Session 16 raised these)', () => {
  it('per-turn tool calls', () => {
    expect(DEFAULT_MAX_STEPS).toBe(40);
  });

  it('shell command timeout ceiling — asserted through the schema that enforces it', () => {
    expect(runCommandTool.schema.safeParse({ command: 'x', timeoutMs: 900_000 }).success).toBe(true);
    expect(runCommandTool.schema.safeParse({ command: 'x', timeoutMs: 900_001 }).success).toBe(false);
  });

  it('managed preview processes', () => {
    expect(MAX_CONCURRENT_PREVIEWS).toBe(4);
    expect(PREVIEWS_PER_SESSION).toBe(12);
    expect(DEFAULT_PREVIEW_TTL_MS).toBe(60 * 60 * 1000);
    expect(DEFAULT_READY_WAIT_MS).toBe(60_000);
  });

  it('the executor budget', () => {
    expect(EXECUTOR_BUDGET).toEqual({ maxSteps: 40, timeoutMs: 1_200_000, maxOutputTokens: 50_000 });
    // Read-only roles are unchanged: they survey and report, and neither got bigger.
    expect(ROLE_CONTRACTS.explorer.budget).toEqual({ maxSteps: 15, timeoutMs: 300_000, maxOutputTokens: 30_000 });
    expect(ROLE_CONTRACTS.reviewer.budget).toEqual({ maxSteps: 24, timeoutMs: 480_000, maxOutputTokens: 30_000 });
  });

  it('delegated work', () => {
    expect(TASKS_PER_SESSION).toBe(16);
    expect(SESSION_CHILD_OUTPUT_TOKEN_CAP).toBe(200_000);
  });

  it('captured executor changes', () => {
    expect(MAX_TASK_CHANGE_FILES).toBe(400);
    expect(MAX_TASK_CHANGE_FILE_BYTES).toBe(5 * 1024 * 1024);
  });

  it('verification and setup budgets', () => {
    expect(CHECKS_PER_SESSION).toBe(80);
    expect(SETUPS_PER_SESSION).toBe(12);
    expect(INSTALL_TIMEOUT_MS).toBe(900_000);
  });

  it('browser flow wall clock', () => {
    expect(FLOW_WALL_MS).toBe(90_000);
  });

  it('project discovery', () => {
    expect(MAX_PROJECT_UNITS).toBe(12);
    expect(MAX_UNIT_DEPTH).toBe(2);
  });
});

describe('repetition bounds (deliberately UNCHANGED)', () => {
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

  it('the context budget is untouched — elision is about cost, not about capability', () => {
    expect(DEFAULT_TRIGGER_CHARS).toBe(400_000);
    expect(DEFAULT_TARGET_CHARS).toBe(200_000);
  });
});
