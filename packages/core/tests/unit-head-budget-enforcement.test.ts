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
import {
  budgetExhausted, deriveChildBudget, DEFAULT_HEAD_BUDGET,
  MAX_HEAD_STEPS, NOMINAL_STEP_TOKENS, MAX_FORK_WIDTH, type HeadBudget,
} from '../src/heads/types.js';
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

/**
 * A v2 model that always wants to call `record_evidence` (so the agentic loop
 * keeps going), reporting a prompt of `promptTokens + step * promptGrowth` and a
 * fixed `outputTokens` each step — the shape of a real head, which re-sends its
 * whole accumulated context every step and grows it by whatever it pulled in.
 */
function loopingHeadModel(perStep: {
  promptTokens: number; promptGrowth: number; outputTokens: number;
  /** Mid-flight prose the model emits alongside its tool call each step. */
  text?: string;
}): LanguageModel {
  let step = 0;
  return {
    specificationVersion: 'v2', provider: 'fake', modelId: 'fake-loop', supportedUrls: {},
    doGenerate: async () => ({
      content: [
        ...(perStep.text ? [{ type: 'text' as const, text: perStep.text }] : []),
        { type: 'tool-call' as const, toolCallId: `tc-${Math.random()}`, toolName: 'record_evidence',
          input: JSON.stringify({ kind: 'fact', body: 'still working' }) },
      ],
      finishReason: 'tool-calls' as const,
      usage: {
        inputTokens: perStep.promptTokens + step++ * perStep.promptGrowth,
        outputTokens: perStep.outputTokens,
      },
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

describe('runHeadInference — the budget meters marginal work, not the re-sent prefix', () => {
  test('a run whose prompt GROWS past its ceiling stops with budget_exceeded', async () => {
    const capture = new HeadCapture();
    // maxTokens 6000 → step cap floor(6000/1200)=5 steps. The prompt grows 1500
    // per step and each step emits 1000 output, so the marginal charge crosses
    // 6000 on step 3 — BEFORE the step cap — and only the token gate can stop it.
    const report = await runHeadInference(
      loopInput(6_000),
      {
        model: loopingHeadModel({ promptTokens: 4_000, promptGrowth: 1_500, outputTokens: 1_000 }),
        tools: buildHeadAccumulatorTools(capture), capture, isAborted: () => false,
      },
    );
    expect(report.status).toBe('budget_exceeded');
    expect(report.steps.length).toBeLessThan(5);
  });

  test('a head on a long parent turn is NOT starved by its own re-sent prefix', async () => {
    const capture = new HeadCapture();
    // The defect this locks: a 20k inherited prompt re-sent every step used to
    // be charged in full every step, so a 25k head died after one or two steps
    // having produced nothing. The prompt here never grows — the head adds only
    // its own 400-token turns — so it must run its full step cap instead.
    const report = await runHeadInference(
      loopInput(25_000),
      {
        model: loopingHeadModel({ promptTokens: 20_000, promptGrowth: 0, outputTokens: 400 }),
        tools: buildHeadAccumulatorTools(capture), capture, isAborted: () => false,
      },
    );
    expect(report.status).toBe('completed');
    expect(report.steps.length).toBe(MAX_HEAD_STEPS);
    expect(capture.tokenUsage.budgetCharged).toBe(400 * MAX_HEAD_STEPS);
  });

  test('gross provider spend is still reported in full', async () => {
    const capture = new HeadCapture();
    const report = await runHeadInference(
      loopInput(25_000),
      {
        model: loopingHeadModel({ promptTokens: 20_000, promptGrowth: 0, outputTokens: 400 }),
        tools: buildHeadAccumulatorTools(capture), capture, isAborted: () => false,
      },
    );
    // The cost ledger debits real tokens; only the BUDGET is metered marginally.
    expect(report.tokenUsage.input).toBe(20_000 * MAX_HEAD_STEPS);
    expect(report.tokenUsage.output).toBe(400 * MAX_HEAD_STEPS);
    expect(report.tokenUsage.total).toBeGreaterThan(capture.tokenUsage.budgetCharged);
  });
});

describe('runHeadInference — a head that stopped never reports a conclusion it did not reach', () => {
  const SPECULATION = 'The immediate blockage is the sandbox provisioning failure.';

  test("a starved head's mid-flight prose is not returned as its finding", async () => {
    const capture = new HeadCapture();
    const report = await runHeadInference(
      loopInput(6_000),
      {
        model: loopingHeadModel({ promptTokens: 4_000, promptGrowth: 1_500, outputTokens: 1_000, text: SPECULATION }),
        tools: buildHeadAccumulatorTools(capture), capture, isAborted: () => false,
      },
    );
    expect(report.status).toBe('budget_exceeded');
    // This is the fabrication path: the speculation reached the parent as fact.
    expect(report.summary).not.toContain('sandbox provisioning');
    expect(report.summary).toContain('did not complete');
    // What it genuinely banked is still reported.
    expect(report.summary).toContain('still working');
  });

  test('an aborted head that banked nothing says exactly that', async () => {
    const capture = new HeadCapture();
    const report = await runHeadInference(
      loopInput(50_000),
      {
        model: loopingHeadModel({ promptTokens: 1_000, promptGrowth: 0, outputTokens: 10, text: SPECULATION }),
        tools: {}, capture, isAborted: () => true, abortReason: () => 'wall-clock budget exhausted',
      },
    );
    expect(report.status).toBe('aborted');
    expect(report.evidence).toHaveLength(0);
    expect(report.summary).not.toContain('sandbox provisioning');
    expect(report.summary).toContain('It produced no findings.');
    expect(report.summary).toContain('wall-clock budget exhausted');
  });

  test('a completed head still reports its own final text', async () => {
    const capture = new HeadCapture();
    const report = await runHeadInference(
      loopInput(50_000),
      {
        model: loopingHeadModel({ promptTokens: 500, promptGrowth: 0, outputTokens: 10, text: 'Here is what I found.' }),
        tools: buildHeadAccumulatorTools(capture), capture, isAborted: () => false,
      },
    );
    expect(report.status).toBe('completed');
    expect(report.summary).toBe('Here is what I found.');
  });
});

describe('HeadCapture.recordStepUsage — the marginal charge', () => {
  test('charges output plus prompt growth, never the inherited prefix', () => {
    const c = new HeadCapture();
    c.recordStepUsage(10_000, 500);   // entry prompt: charged for output only
    c.recordStepUsage(12_000, 300);   // +2000 growth
    c.recordStepUsage(12_000, 200);   // no growth: re-read costs nothing
    expect(c.tokenUsage.budgetCharged).toBe(500 + 2_000 + 300 + 200);
    expect(c.tokenUsage.input).toBe(34_000);
    expect(c.tokenUsage.output).toBe(1_000);
  });

  test('a prompt that shrinks never yields a negative charge', () => {
    const c = new HeadCapture();
    c.recordStepUsage(9_000, 100);
    c.recordStepUsage(3_000, 100);
    c.recordStepUsage(9_500, 100);
    // Growth is measured against the LARGEST prompt seen, so the rebound to
    // 9_500 is charged 500 rather than 6_500.
    expect(c.tokenUsage.budgetCharged).toBe(300 + 500);
  });
});

describe('DEFAULT_HEAD_BUDGET — the pool survives its own divisor', () => {
  test('every head at the widest legal fan-out still gets the full step cap', () => {
    const parent: HeadBudget = { ...DEFAULT_HEAD_BUDGET, spawnedAt: Date.now() };
    const child = deriveChildBudget(parent, MAX_FORK_WIDTH, undefined, parent.spawnedAt);
    // Below this the pool, not the step cap, is what stops a head — which is how
    // a fork comes back empty having produced nothing.
    expect(child.maxTokens).toBeGreaterThanOrEqual(MAX_HEAD_STEPS * NOMINAL_STEP_TOKENS);
  });
});
