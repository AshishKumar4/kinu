// Behavior tests for the single-shot baseline strategy.
import { describe, test, expect } from 'bun:test';
import { createSingleShotStrategy, type StrategyContext } from '../src/index.ts';
import { createTestRuntime } from '@proteus/test-utils';

// Build a minimal Vercel-AI-compatible LanguageModel stub. generateText only
// reads `specificationVersion`, `provider`, `modelId`, and doGenerate — we
// mock the bare minimum to exercise the strategy without hitting a real LLM.
function fakeModel(answer: string, usage = { inputTokens: 5, outputTokens: 10 }) {
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text: answer }],
      finishReason: 'stop' as const,
      usage,
      response: { id: 'r', modelId: 'fake-model', timestamp: new Date() },
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text', text: answer });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
          controller.close();
        },
      }),
      response: { headers: {} },
    }),
  };
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
      rt,
      model: fakeModel('here is your answer') as never,
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
      task: 't', rt,
      model: fakeModel('done', { inputTokens: 12, outputTokens: 34 }) as never,
    });
    expect(result.cost.iterations).toBe(1);
    expect(result.cost.tokens).toBe(46);
    expect(result.cost.durationMs).toBeGreaterThanOrEqual(0);
  });
});
