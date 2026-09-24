/**
 * A head is a fork of its parent turn and runs in the same open envelope: no wall clock, step count,
 * or token pool. The remaining bounds are recursion depth and cancellation by the spawner.
 */

import { REAL_CLOCK } from '../src/types/clock';
import { describe, test, expect } from 'bun:test';
import type { LanguageModel } from 'ai';
import { createTestRuntime, scriptedTurnModel } from '@kinu.run/test-utils';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { deriveChildBudget, type HeadBudget, type HeadInput } from '../src/heads/types';
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

describe('deriveChildBudget', () => {
  test('decrements depth and inherits the open envelope', () => {
    const parent: HeadBudget = { maxDepth: 2, spawnedAt: 1_000 };
    expect(deriveChildBudget(parent, 2_000)).toEqual({ maxDepth: 1, spawnedAt: 2_000 });
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
