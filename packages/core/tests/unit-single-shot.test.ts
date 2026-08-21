// Behavior tests for the single-shot baseline strategy.
import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { createSingleShotStrategy, type StrategyContext } from '../src/index';
import { createTestRuntime } from '@kinu.run/test-utils';

// Build a minimal Vercel-AI-compatible LanguageModel stub. generateText only
// reads `specificationVersion`, `provider`, `modelId`, and doGenerate — we
// mock the bare minimum to exercise the strategy without hitting a real LLM.
function fakeModel(answer: string, usage = { inputTokens: 5, outputTokens: 10 }) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: answer }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: usage.inputTokens, noCache: usage.inputTokens, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: usage.outputTokens, text: usage.outputTokens, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

describe('single-shot strategy', () => {
  test('registers as `single-shot` with a label', () => {
    const s = createSingleShotStrategy();
    expect(s.id).toBe('single-shot');
    expect(s.label).toBe('Single shot');
    expect(s.description).toMatch(/baseline/i);
  });

  test('returns best.text from generateText', async () => {
    const { rt } = createTestRuntime();
    const strategy = createSingleShotStrategy();
    const ctx: StrategyContext = {
      task: 'pick the best',
      mode: 'build',
      rt,
      model: fakeModel('here is your answer'),
    };
    const result = await strategy.explore(ctx);
    expect(result.strategy).toBe('single-shot');
    expect(result.best.text).toBe('here is your answer');
    expect(result.best.score).toBe(1);
    expect(result.all.length).toBe(1);
  });

  test('records cost summary with tokens + ms + iterations=1', async () => {
    const { rt } = createTestRuntime();
    const strategy = createSingleShotStrategy();
    const result = await strategy.explore({
      task: 't', mode: 'build', rt,
      model: fakeModel('done', { inputTokens: 12, outputTokens: 34 }),
    });
    expect(result.cost.iterations).toBe(1);
    expect(result.cost.tokens).toBe(46);
    expect(result.cost.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('a provider that reported no usage leaves cost.tokens ABSENT, not zero', async () => {
    // The AI SDK carries undefined totals when the provider said nothing, and a
    // baseline whose cost reads `0` is a baseline that looks free in an eval
    // comparison. `cost.tokens` is optional exactly so this can be said.
    const { rt } = createTestRuntime();
    const result = await createSingleShotStrategy().explore({
      task: 't', mode: 'build', rt,
      model: new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'done' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: undefined, text: undefined, reasoning: undefined },
          },
          warnings: [],
        }),
      }),
    });
    expect(result.cost.tokens).toBeUndefined();
    expect(result.best.text).toBe('done');
  });
});
