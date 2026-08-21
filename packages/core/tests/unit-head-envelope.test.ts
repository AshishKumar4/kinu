/**
 * Unit tests: the envelope a head actually runs in.
 *
 * A head is a FORK of its parent turn — same workspace, same files, same
 * sandbox — so it gets the same working envelope: the turn's step count, no
 * wall clock, no token pool. It used to get a private one instead (a ~5 min
 * clock, a token pool divided by fan-out, and a step guard derived from that
 * pool), and a 6-wide fork of a real audit died at 32 steps having produced
 * nothing. These tests lock the envelope open, and lock the two bounds that
 * remain to what they actually are: recursion depth, and a deadline only a
 * caller can ask for.
 */

import { describe, test, expect } from 'bun:test';
import type { LanguageModel } from 'ai';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import {
  budgetExhausted, deriveChildBudget, DEFAULT_HEAD_BUDGET, type HeadBudget, type HeadInput,
} from '../src/heads/types';
import { runHeadInference, HeadCapture, buildHeadAccumulatorTools } from '../src/heads/head-inference';
import { usageTotal } from '../src/usage';

describe('budgetExhausted — depth, and a deadline only if one was requested', () => {
  test('a default head is never exhausted by time or spend', () => {
    const b: HeadBudget = { ...DEFAULT_HEAD_BUDGET, spawnedAt: Date.now() - 60 * 60_000 };
    expect(budgetExhausted(b).exhausted).toBe(false);
  });

  test('depth 0 refuses further splits', () => {
    const b: HeadBudget = { maxDepth: 0, spawnedAt: Date.now() };
    expect(budgetExhausted(b)).toEqual({ exhausted: true, reason: 'max-depth' });
  });

  test('a caller-requested deadline is enforced once it passes', () => {
    const spawnedAt = Date.now() - 10_000;
    expect(budgetExhausted({ maxDepth: 3, maxWallClockMs: 60_000, spawnedAt }).exhausted).toBe(false);
    expect(budgetExhausted({ maxDepth: 3, maxWallClockMs: 5_000, spawnedAt }))
      .toEqual({ exhausted: true, reason: 'wall-clock' });
  });
});

describe('DEFAULT_HEAD_BUDGET — recursion room and nothing else', () => {
  test('carries no wall clock', () => {
    expect(DEFAULT_HEAD_BUDGET.maxWallClockMs).toBeUndefined();
  });

  test('has no token dimension at all', () => {
    expect(Object.keys(DEFAULT_HEAD_BUDGET)).toEqual(['maxDepth']);
  });
});

describe('deriveChildBudget', () => {
  test('decrements depth and inherits the open envelope', () => {
    const parent: HeadBudget = { ...DEFAULT_HEAD_BUDGET, spawnedAt: 1_000 };
    const child = deriveChildBudget(parent, 2_000);
    expect(child.maxDepth).toBe(parent.maxDepth - 1);
    expect(child.maxWallClockMs).toBeUndefined();
    expect(child.spawnedAt).toBe(2_000);
  });

  test('fan-out does not shrink a child — six siblings each get the parent envelope', () => {
    const parent: HeadBudget = { ...DEFAULT_HEAD_BUDGET, spawnedAt: 1_000 };
    const children = Array.from({ length: 6 }, () => deriveChildBudget(parent, 1_000));
    for (const c of children) {
      expect(c).toEqual({ maxDepth: parent.maxDepth - 1, spawnedAt: 1_000 });
    }
  });

  test("a requested deadline still bounds every descendant by the parent's remaining time", () => {
    const now = 1_000_000;
    // Parent spawned 40s ago with a 60s ceiling → 20s left.
    const parent: HeadBudget = { maxDepth: 3, maxWallClockMs: 60_000, spawnedAt: now - 40_000 };
    const child = deriveChildBudget(parent, now);
    expect(child.maxWallClockMs).toBe(20_000);
    expect(child.spawnedAt + child.maxWallClockMs!)
      .toBeLessThanOrEqual(parent.spawnedAt + parent.maxWallClockMs!);
  });

  test('a 3-deep recursive split keeps every descendant under the requested deadline', () => {
    const start = 5_000_000;
    const root: HeadBudget = { maxDepth: 4, maxWallClockMs: 30_000, spawnedAt: start };
    const rootDeadline = root.spawnedAt + root.maxWallClockMs!;
    let parent = root;
    let now = start;
    for (let depth = 0; depth < 3; depth++) {
      now += 8_000;
      const child = deriveChildBudget(parent, now);
      expect(child.spawnedAt + child.maxWallClockMs!).toBeLessThanOrEqual(rootDeadline);
      parent = child;
    }
  });
});

/**
 * A model that keeps calling `record_evidence` (so the agentic loop keeps
 * going), reporting a fixed prompt + output per step — the shape of a real head,
 * which re-sends its whole accumulated context every step.
 */
function loopingHeadModel(perStep: {
  promptTokens: number; outputTokens: number;
  /** Mid-flight prose the model emits alongside its tool call each step. */
  text?: string;
  /** After this many steps the model CHOOSES to stop (text only, finishReason
   *  'stop') — a head that genuinely finishes. Omitted = loops forever. */
  stopAfterSteps?: number;
}): LanguageModel {
  let step = 0;
  return scriptedTurnModel({
    provider: 'fake', modelId: 'fake-loop',
    doGenerate: async () => {
      const finishes = perStep.stopAfterSteps !== undefined && step >= perStep.stopAfterSteps;
      step++;
      const content: LanguageModelV3Content[] = [];
      if (perStep.text) content.push({ type: 'text', text: perStep.text });
      if (!finishes) {
        content.push({
          type: 'tool-call', toolCallId: `tc-${step}`, toolName: 'record_evidence',
          input: JSON.stringify({ kind: 'fact', body: 'still working' }),
        });
      }
      return {
        content,
        finishReason: { unified: finishes ? 'stop' : 'tool-calls', raw: undefined },
        usage: {
          inputTokens: {
            total: perStep.promptTokens, noCache: perStep.promptTokens,
            cacheRead: undefined, cacheWrite: undefined,
          },
          outputTokens: {
            total: perStep.outputTokens, text: perStep.outputTokens, reasoning: undefined,
          },
        },
        warnings: [],
      };
    },
  });
}

function loopInput(budget: Partial<HeadBudget> = {}): HeadInput {
  return {
    id: 'h1', rootId: 'r1', parentId: null, depth: 0,
    task: 'keep recording evidence', rationale: 'exercise the envelope',
    mode: 'build',
    inheritedContext: [{ id: 'm1', role: 'user', content: 'go', createdAt: 1 }],
    budget: { ...DEFAULT_HEAD_BUDGET, spawnedAt: Date.now(), ...budget },
    mergeStrategy: 'synthesize',
  };
}

describe('runHeadInference — a fork works until the work is done', () => {
  test('runs far past the old 32-step guard and the old fan-out token pool', async () => {
    const capture = new HeadCapture();
    // The old envelope for a 6-wide fork: 19,200 tokens and a 32-step guard.
    // This head spends 15x the pool over 60 steps and finishes on its own terms.
    const report = await runHeadInference(loopInput(), {
      model: loopingHeadModel({
        promptTokens: 40_000, outputTokens: 5_000,
        text: 'Here is what I found.', stopAfterSteps: 60,
      }),
      tools: buildHeadAccumulatorTools(capture), capture,
      workspaceLayout: 'shared-workspace', isAborted: () => false,
    });
    expect(report.status).toBe('completed');
    expect(report.stepCount).toBe(61);
    expect(report.usage.output).toBe(5_000 * 61);
    expect(usageTotal(report.usage)).toBeGreaterThan(19_200);
    expect(report.summary).toBe('Here is what I found.');
  });

  test('an old-pool-sized head is no longer stopped by spend', async () => {
    const capture = new HeadCapture();
    // 8 steps x 3,200 output = 25,600 — over the pool a 6-wide split used to
    // divide out. Nothing meters it now.
    const report = await runHeadInference(loopInput(), {
      model: loopingHeadModel({ promptTokens: 20_000, outputTokens: 3_200, stopAfterSteps: 8 }),
      tools: buildHeadAccumulatorTools(capture), capture,
      workspaceLayout: 'shared-workspace', isAborted: () => false,
    });
    expect(report.status).toBe('completed');
    expect(report.usage.output).toBe(3_200 * 9);
  });

  test('a head spawned an hour into a long parent turn is not already out of time', async () => {
    const capture = new HeadCapture();
    const report = await runHeadInference(
      loopInput({ spawnedAt: Date.now() - 60 * 60_000 }),
      {
        model: loopingHeadModel({ promptTokens: 1_000, outputTokens: 100, text: 'Done.', stopAfterSteps: 3 }),
        tools: buildHeadAccumulatorTools(capture), capture,
        workspaceLayout: 'shared-workspace', isAborted: () => false,
      },
    );
    expect(report.status).toBe('completed');
  });

  test('gross provider spend is reported in full', async () => {
    const capture = new HeadCapture();
    const report = await runHeadInference(loopInput(), {
      model: loopingHeadModel({ promptTokens: 20_000, outputTokens: 400, stopAfterSteps: 9 }),
      tools: buildHeadAccumulatorTools(capture), capture,
      workspaceLayout: 'shared-workspace', isAborted: () => false,
    });
    expect(report.usage.input).toBe(20_000 * 10);
    expect(report.usage.output).toBe(400 * 10);
    expect(usageTotal(report.usage)).toBe(20_400 * 10);
  });

  test('the turn step envelope is the backstop, and it reports itself honestly', async () => {
    const capture = new HeadCapture();
    // A model that never stops. The only thing that ends it is the same step
    // envelope the parent turn runs to — and the report says so rather than
    // presenting a mid-flight thought as a finished answer.
    const report = await runHeadInference(loopInput(), {
      model: loopingHeadModel({ promptTokens: 4_000, outputTokens: 1 }),
      tools: buildHeadAccumulatorTools(capture), capture,
      workspaceLayout: 'shared-workspace',
 isAborted: () => false,
    });
    expect(report.stepCount).toBe(40);
    expect(report.status).toBe('budget_exceeded');
    expect(report.errorMessage).toContain('step envelope (40 steps)');
    expect(report.summary).toContain('did not complete');
    // What it genuinely banked is still reported.
    expect(report.summary).toContain('still working');
  });
});

describe('runHeadInference — a head that stopped never reports a conclusion it did not reach', () => {
  const SPECULATION = 'The immediate blockage is the sandbox provisioning failure.';

  test("a cut-off head's mid-flight prose is not returned as its finding", async () => {
    const capture = new HeadCapture();
    const report = await runHeadInference(loopInput(), {
      model: loopingHeadModel({ promptTokens: 4_000, outputTokens: 1_000, text: SPECULATION }),
      tools: buildHeadAccumulatorTools(capture), capture,
      workspaceLayout: 'shared-workspace',
 isAborted: () => false,
    });
    expect(report.status).toBe('budget_exceeded');
    // This is the fabrication path: the speculation reached the parent as fact.
    expect(report.summary).not.toContain('sandbox provisioning');
    expect(report.summary).toContain('did not complete');
    expect(report.summary).toContain('still working');
  });

  test('an aborted head that banked nothing says exactly that', async () => {
    const capture = new HeadCapture();
    const report = await runHeadInference(loopInput(), {
      model: loopingHeadModel({ promptTokens: 1_000, outputTokens: 10, text: SPECULATION }),
      tools: {}, capture, workspaceLayout: 'shared-workspace', isAborted: () => true, abortReason: () => 'the parent turn was cancelled',
    });
    expect(report.status).toBe('aborted');
    expect(report.evidence).toHaveLength(0);
    expect(report.summary).not.toContain('sandbox provisioning');
    expect(report.summary).toContain('It produced no findings.');
    expect(report.summary).toContain('the parent turn was cancelled');
  });

  test('a completed head still reports its own final text', async () => {
    const capture = new HeadCapture();
    const report = await runHeadInference(loopInput(), {
      model: loopingHeadModel({
        promptTokens: 500, outputTokens: 10, text: 'Here is what I found.', stopAfterSteps: 3,
      }),
      tools: buildHeadAccumulatorTools(capture), capture,
      workspaceLayout: 'shared-workspace', isAborted: () => false,
    });
    expect(report.status).toBe('completed');
    expect(report.summary).toBe('Here is what I found.');
  });
});

describe('buildHeadSystemPrompt — the head is told the truth about its envelope', () => {
  test('an uncapped head is told there is no limit, not a number to race', async () => {
    const { buildHeadSystemPrompt } = await import('../src/heads/head-inference');
    const prompt = buildHeadSystemPrompt(loopInput());
    expect(prompt).toContain('no time or token limit');
    expect(prompt).not.toContain('wall-clock');
  });

  test('a caller-requested deadline IS disclosed', async () => {
    const { buildHeadSystemPrompt } = await import('../src/heads/head-inference');
    const prompt = buildHeadSystemPrompt(loopInput({ maxWallClockMs: 90_000 }));
    expect(prompt).toContain('90000ms wall-clock');
  });

  test('remaining recursion depth is stated as the number it actually is', async () => {
    const { buildHeadSystemPrompt } = await import('../src/heads/head-inference');
    const prompt = buildHeadSystemPrompt(loopInput({ maxDepth: 2 }));
    expect(prompt).toContain('split 2 more level(s) deep');
  });

  test('a head with no depth left is not told it may split zero levels', async () => {
    const { buildHeadSystemPrompt } = await import('../src/heads/head-inference');
    // The tool is off the surface entirely at depth 0 (head-tools.ts), so the
    // prompt must not advertise a recursion allowance of 0 beside it — and the
    // tool-derived conventions say plainly that recursion is unavailable.
    const prompt = buildHeadSystemPrompt(
      loopInput({ maxDepth: 0 }),
      ['record_evidence', 'record_decision', 'run'],
    );
    expect(prompt).not.toContain('more level(s) deep');
    expect(prompt).toContain('split_subheads is not available in this run');
  });
});
