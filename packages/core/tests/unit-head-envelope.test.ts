/**
 * A head is a fork of its parent turn and runs in the same open envelope: no default wall clock,
 * step count, or token pool. The remaining bounds are recursion depth, a caller-requested deadline,
 * and cancellation by the spawner.
 */

import { REAL_CLOCK } from '../src/types/clock';
import { describe, test, expect } from 'bun:test';
import type { LanguageModel } from 'ai';
import { createTestRuntime, present, scriptedTurnModel } from '@kinu.run/test-utils';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import {
  budgetExhausted, deriveChildBudget, type HeadBudget, type HeadInput,
} from '../src/heads/types';
import { runHeadInference, HeadCapture, buildHeadAccumulatorTools } from '../src/heads/head-inference';
import { usageTotal } from '../src/usage';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';
import { hostedSeatsOver } from './helpers-actor-host';
import type { HostedNodeSeat } from '../src/strategy/node-agent';

/** The hosted actor one head's turn runs on, via the production `hostedSeatsOver` path. */
async function hostedHead(): Promise<HostedNodeSeat> {
  const { rt, testSql } = createTestRuntime();

  return hostedSeatsOver({ rt, db: testSql.db }).seat('head-envelope', 'head');
}

describe('budgetExhausted — a deadline only if one was requested', () => {
  test('a head without a deadline is not exhausted by time or spend', () => {
    const b: HeadBudget = { maxDepth: 1, spawnedAt: Date.now() - 60 * 60_000 };
    expect(budgetExhausted(b).exhausted).toBe(false);
  });

  test('zero split depth does not exhaust an existing head', () => {
    const b: HeadBudget = { maxDepth: 0, spawnedAt: Date.now() };
    expect(budgetExhausted(b)).toEqual({ exhausted: false });
  });

  test('a caller-requested deadline is enforced once it passes', () => {
    const spawnedAt = Date.now() - 10_000;
    expect(budgetExhausted({ maxDepth: 3, maxWallClockMs: 60_000, spawnedAt }).exhausted).toBe(false);
    expect(budgetExhausted({ maxDepth: 3, maxWallClockMs: 5_000, spawnedAt }))
      .toEqual({ exhausted: true, reason: 'wall-clock' });
  });
});


describe('deriveChildBudget', () => {
  test('decrements depth and inherits the open envelope', () => {
    const parent: HeadBudget = { maxDepth: 2, spawnedAt: 1_000 };
    const child = deriveChildBudget(parent, 2_000);
    expect(child.maxDepth).toBe(parent.maxDepth - 1);
    expect(child.maxWallClockMs).toBeUndefined();
    expect(child.spawnedAt).toBe(2_000);
  });

  test('fan-out does not shrink a child — six siblings each get the parent envelope', () => {
    const parent: HeadBudget = { maxDepth: 2, spawnedAt: 1_000 };
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
    const childCeiling = present(child.maxWallClockMs, "the child's wall-clock ceiling");
    const parentCeiling = present(parent.maxWallClockMs, "the parent's wall-clock ceiling");

    expect(child.spawnedAt + childCeiling).toBeLessThanOrEqual(parent.spawnedAt + parentCeiling);
  });

  test('a 3-deep recursive split keeps every descendant under the requested deadline', () => {
    const start = 5_000_000;
    const root: HeadBudget = { maxDepth: 4, maxWallClockMs: 30_000, spawnedAt: start };
    const rootDeadline = root.spawnedAt + present(root.maxWallClockMs, "the root's wall-clock ceiling");
    let parent = root;
    let now = start;

    for (let depth = 0; depth < 3; depth++) {
      now += 8_000;
      const child = deriveChildBudget(parent, now);
      expect(child.spawnedAt + present(child.maxWallClockMs, "the child's wall-clock ceiling")).toBeLessThanOrEqual(rootDeadline);
      parent = child;
    }
  });
});

/** Keeps calling `record_evidence`, re-sending its whole context each step like a real head. */
function loopingHeadModel(perStep: {
  promptTokens: number; outputTokens: number;
  text?: string;
  /** Steps before the model stops on its own; omitted = loops forever. */
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
    budget: { maxDepth: 0, spawnedAt: Date.now(), ...budget },
    mergeStrategy: 'synthesize',
    loop: defaultLoopOrigin('head'),
  };
}

describe('runHeadInference — a fork works until the work is done', () => {
  test('a leaf head finishes its tool work when no split depth remains', async () => {
    const capture = new HeadCapture();

    const report = await runHeadInference(loopInput({ maxDepth: 0 }), { ...await hostedHead(), model: loopingHeadModel({ promptTokens: 100, outputTokens: 10, text: 'Leaf work complete.', stopAfterSteps: 3 }),
    tools: buildHeadAccumulatorTools(capture), capture,
    workspaceLayout: 'shared-workspace', clock: REAL_CLOCK, isAborted: () => false, });

    expect(report.status).toBe('completed');
    expect(report.stepCount).toBe(4);
    expect(report.summary).toBe('Leaf work complete.');
  });

  test('a head completes 61 steps and reports 305,000 output tokens without a private spend cap', async () => {
    const capture = new HeadCapture();

    const report = await runHeadInference(loopInput(), { ...await hostedHead(), model: loopingHeadModel({
      promptTokens: 40_000, outputTokens: 5_000,
      text: 'Here is what I found.', stopAfterSteps: 60,
    }),
    tools: buildHeadAccumulatorTools(capture), capture,
    workspaceLayout: 'shared-workspace', clock: REAL_CLOCK, isAborted: () => false, });

    expect(report.status).toBe('completed');
    expect(report.stepCount).toBe(61);
    expect(report.usage.output).toBe(5_000 * 61);
    expect(usageTotal(report.usage)).toBeGreaterThan(19_200);
    expect(report.summary).toBe('Here is what I found.');
  });

  test('a head spending 28,800 output tokens is not stopped by spend', async () => {
    const capture = new HeadCapture();

    const report = await runHeadInference(loopInput(), { ...await hostedHead(), model: loopingHeadModel({ promptTokens: 20_000, outputTokens: 3_200, stopAfterSteps: 8 }),
    tools: buildHeadAccumulatorTools(capture), capture,
    workspaceLayout: 'shared-workspace', clock: REAL_CLOCK, isAborted: () => false, });

    expect(report.status).toBe('completed');
    expect(report.usage.output).toBe(3_200 * 9);
  });

  test('a head spawned an hour into a long parent turn is not already out of time', async () => {
    const capture = new HeadCapture();

    const report = await runHeadInference(loopInput({ spawnedAt: Date.now() - 60 * 60_000 }), { ...await hostedHead(), model: loopingHeadModel({ promptTokens: 1_000, outputTokens: 100, text: 'Done.', stopAfterSteps: 3 }),
    tools: buildHeadAccumulatorTools(capture), capture,
    workspaceLayout: 'shared-workspace', clock: REAL_CLOCK, isAborted: () => false, });

    expect(report.status).toBe('completed');
  });

  test('gross provider spend is reported in full', async () => {
    const capture = new HeadCapture();

    const report = await runHeadInference(loopInput(), { ...await hostedHead(), model: loopingHeadModel({ promptTokens: 20_000, outputTokens: 400, stopAfterSteps: 9 }),
    tools: buildHeadAccumulatorTools(capture), capture,
    workspaceLayout: 'shared-workspace', clock: REAL_CLOCK, isAborted: () => false, });

    expect(report.usage.input).toBe(20_000 * 10);
    expect(report.usage.output).toBe(400 * 10);
    expect(usageTotal(report.usage)).toBe(20_400 * 10);
  });

  test('the spawner abort is the backstop, and it reports itself honestly', async () => {
    const capture = new HeadCapture();

    // No default step bound exists; the caller cancels after forty evidence rows.
    const report = await runHeadInference(loopInput(), { ...await hostedHead(), model: loopingHeadModel({ promptTokens: 4_000, outputTokens: 1 }),
    tools: buildHeadAccumulatorTools(capture), capture,
    workspaceLayout: 'shared-workspace',
    clock: REAL_CLOCK, isAborted: () => capture.evidence.length >= 40,
    abortReason: () => 'the parent stopped the head after 40 findings', });

    expect(report.stepCount).toBe(40);
    expect(report.status).toBe('aborted');
    expect(report.errorMessage).toContain('parent stopped');
    expect(report.summary).toContain('did not complete');
    expect(report.summary).toContain('still working');
  });
});

describe('runHeadInference — a head that stopped never reports a conclusion it did not reach', () => {
  const SPECULATION = 'The immediate blockage is the sandbox provisioning failure.';

  test("an aborted head's mid-flight prose is not returned as its finding", async () => {
    const capture = new HeadCapture();

    const report = await runHeadInference(loopInput(), { ...await hostedHead(), model: loopingHeadModel({ promptTokens: 4_000, outputTokens: 1_000, text: SPECULATION }),
    tools: buildHeadAccumulatorTools(capture), capture,
    workspaceLayout: 'shared-workspace',
    clock: REAL_CLOCK, isAborted: () => capture.evidence.length >= 4,
    abortReason: () => 'the parent cancelled this head', });

    expect(report.status).toBe('aborted');
    expect(report.summary).not.toContain('sandbox provisioning');
    expect(report.summary).toContain('did not complete');
    expect(report.summary).toContain('still working');
  });

  test('an aborted head that banked nothing says exactly that', async () => {
    const capture = new HeadCapture();

    const report = await runHeadInference(loopInput(), { ...await hostedHead(), model: loopingHeadModel({ promptTokens: 1_000, outputTokens: 10, text: SPECULATION }),
    tools: {}, capture, workspaceLayout: 'shared-workspace', clock: REAL_CLOCK, isAborted: () => true, abortReason: () => 'the parent turn was cancelled', });

    expect(report.status).toBe('aborted');
    expect(report.evidence).toHaveLength(0);
    expect(report.summary).not.toContain('sandbox provisioning');
    expect(report.summary).toContain('It produced no findings.');
    expect(report.summary).toContain('the parent turn was cancelled');
  });

  test('a completed head still reports its own final text', async () => {
    const capture = new HeadCapture();

    const report = await runHeadInference(loopInput(), { ...await hostedHead(), model: loopingHeadModel({
      promptTokens: 500, outputTokens: 10, text: 'Here is what I found.', stopAfterSteps: 3,
    }),
    tools: buildHeadAccumulatorTools(capture), capture,
    workspaceLayout: 'shared-workspace', clock: REAL_CLOCK, isAborted: () => false, });

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

    // The tool is off the surface at depth 0 (head-tools.ts), so the prompt must not advertise a recursion allowance.
    const prompt = buildHeadSystemPrompt(
      loopInput({ maxDepth: 0 }),
      ['record_evidence', 'record_decision', 'shell'],
    );

    expect(prompt).not.toContain('more level(s) deep');
    expect(prompt).toContain('split_subheads is not available in this run');
  });
});
