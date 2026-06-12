/**
 * Unit tests: real token-budget enforcement + recursive wall-clock bound
 * (THINKING-AUDIT §4 #7).
 *
 * Before: maxTokens was never decremented so the `tokens` exhaustion branch was
 * dead, and deriveChildBudget handed each recursive child the FULL parent
 * wall-clock with a reset spawnedAt — a deep split could blow the operator
 * ceiling. These tests lock both contracts.
 */

import { describe, test, expect } from 'bun:test';
import type { LanguageModel } from 'ai';
import { budgetExhausted, deriveChildBudget, type HeadBudget } from '../src/heads/types.js';
import { runHeadInference, HeadCapture } from '../src/heads/head-inference.js';
import type { HeadInput } from '../src/heads/types.js';

describe('budgetExhausted — token ceiling gates on consumed tokens', () => {
  const base: HeadBudget = { maxDepth: 3, maxTokens: 1_000, maxWallClockMs: 60_000, spawnedAt: Date.now() };

  test('under the ceiling: not exhausted', () => {
    expect(budgetExhausted(base, 999).exhausted).toBe(false);
  });

  test('at/over the ceiling: exhausted with reason tokens', () => {
    expect(budgetExhausted(base, 1_000)).toEqual({ exhausted: true, reason: 'tokens' });
    expect(budgetExhausted(base, 1_500)).toEqual({ exhausted: true, reason: 'tokens' });
  });

  test('omitting consumed tokens never trips the token branch (depth/wall-clock only)', () => {
    expect(budgetExhausted(base).exhausted).toBe(false);
  });
});

describe('deriveChildBudget — recursive wall-clock bounded by parent remaining', () => {
  test("a child cannot outlive the parent's remaining wall-clock even at ratio 1", () => {
    const now = 1_000_000;
    // Parent spawned 40s ago with a 60s ceiling → 20s remaining.
    const parent: HeadBudget = {
      maxDepth: 3, maxTokens: 10_000, maxWallClockMs: 60_000, spawnedAt: now - 40_000,
    };
    const child = deriveChildBudget(parent, 2, undefined, now);
    // Full ratio would give 60s; bound to the 20s the parent has left.
    expect(child.maxWallClockMs).toBe(20_000);
    // The child's deadline does not exceed the parent's deadline.
    const parentDeadline = parent.spawnedAt + parent.maxWallClockMs;
    const childDeadline = child.spawnedAt + child.maxWallClockMs;
    expect(childDeadline).toBeLessThanOrEqual(parentDeadline);
  });

  test('a 3-deep recursive split keeps every descendant under the operator ceiling', () => {
    const start = 5_000_000;
    const ceiling = 30_000;
    const root: HeadBudget = { maxDepth: 4, maxTokens: 80_000, maxWallClockMs: ceiling, spawnedAt: start };
    const rootDeadline = root.spawnedAt + root.maxWallClockMs;

    // Each level spawns 8s after the previous (cold start + work).
    let parent = root;
    let now = start;
    for (let depth = 0; depth < 3; depth++) {
      now += 8_000;
      const child = deriveChildBudget(parent, 2, undefined, now);
      const childDeadline = child.spawnedAt + child.maxWallClockMs;
      expect(childDeadline).toBeLessThanOrEqual(rootDeadline);
      parent = child;
    }
  });

  test('respects an explicit wallClockRatio<1 and still clamps to remaining', () => {
    const now = 2_000;
    const parent: HeadBudget = { maxDepth: 2, maxTokens: 1_000, maxWallClockMs: 10_000, spawnedAt: now };
    // ratio 0.5 → 5000, parent-remaining is 10000 → min = 5000.
    const child = deriveChildBudget(parent, 1, { wallClockRatio: 0.5 }, now);
    expect(child.maxWallClockMs).toBe(5_000);
  });
});

// ── A real run that overspends its token budget must stop ─────────────

/** A v2 model that always wants to call `record_evidence` (so the agentic loop
 *  keeps going), reporting `perStep` token usage each step. Lets a run accrue
 *  tokens past its ceiling unless the budget gate stops it. */
function loopingHeadModel(perStep: { inputTokens: number; outputTokens: number }): LanguageModel {
  return {
    specificationVersion: 'v2', provider: 'fake', modelId: 'fake-loop', supportedUrls: {},
    doGenerate: async () => ({
      content: [
        { type: 'tool-call', toolCallId: `tc-${Math.random()}`, toolName: 'record_evidence',
          input: JSON.stringify({ kind: 'fact', body: 'still working' }) },
      ],
      finishReason: 'tool-calls' as const,
      usage: perStep,
      response: { id: 'r', modelId: 'fake-loop', timestamp: new Date(0) },
      warnings: [],
    }),
  } as unknown as LanguageModel;
}

import { buildHeadAccumulatorTools } from '../src/heads/head-inference.js';

function loopInput(maxTokens: number): HeadInput {
  return {
    id: 'h1', rootId: 'r1', parentId: null, depth: 0,
    task: 'keep recording evidence', rationale: 'exercise the token gate',
    inheritedContext: [{ id: 'm1', role: 'user', content: 'go', createdAt: 1 }],
    // Generous wall-clock + depth so ONLY the token ceiling can stop the run.
    budget: { maxDepth: 5, maxTokens, maxWallClockMs: 600_000, spawnedAt: Date.now() },
    mergeStrategy: 'synthesize',
  };
}

describe('runHeadInference — token budget actually stops a run', () => {
  test('a run that overspends its token budget stops with budget_exceeded', async () => {
    const capture = new HeadCapture();
    // maxTokens 6000 → step cap floor(6000/1200)=5 steps. Per-step 2500 tokens
    // crosses the 6000 ceiling on step 3 — BEFORE the step cap — so a stop here
    // can only be the token gate (THINKING-AUDIT §4 #7).
    const report = await runHeadInference(
      loopInput(6_000),
      { model: loopingHeadModel({ inputTokens: 1_500, outputTokens: 1_000 }), tools: buildHeadAccumulatorTools(capture), capture, isAborted: () => false },
    );
    expect(report.status).toBe('budget_exceeded');
    expect(report.tokenUsage.total).toBeGreaterThanOrEqual(6_000);
    // Stopped on the token gate (step 3), strictly before the 5-step cap.
    expect(report.steps.length).toBeLessThan(5);
  });
});
