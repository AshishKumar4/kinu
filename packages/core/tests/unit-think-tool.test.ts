// Behavior tests for the unified `think(strategy, task, ...)` dispatcher.
// Verifies registry-based routing, error envelopes, defaultOptions wiring,
// and that the input schema enumerates registered strategies.
import { describe, test, expect } from 'bun:test';
import {
  createStrategyRegistry, createSingleShotStrategy, createThinkTool,
  type StrategyContext,
} from '../src/index.ts';
import { createTestRuntime, createTestStrategy } from '@proteus/test-utils';

describe('createThinkTool — strategy dispatch', () => {
  test('routes to the requested strategy by id', async () => {
    const reg = createStrategyRegistry();
    reg.register(createTestStrategy({ id: 'alpha', answer: 'from alpha' }));
    reg.register(createTestStrategy({ id: 'beta',  answer: 'from beta' }));
    const { rt } = createTestRuntime();
    const tool = createThinkTool({
      registry: reg, rt, model: rt.llm as never,
    });
    const result = await tool.execute(
      { strategy: 'beta', task: 'x' },
      {} as never,
    ) as { strategy: string; text: string };
    expect(result.strategy).toBe('beta');
    expect(result.text).toBe('from beta');
  });

  test('returns structured error for unknown strategy id', async () => {
    const reg = createStrategyRegistry();
    reg.register(createTestStrategy({ id: 'only' }));
    const { rt } = createTestRuntime();
    const tool = createThinkTool({
      registry: reg, rt, model: rt.llm as never,
    });
    const result = await tool.execute(
      { strategy: 'nonexistent', task: 't' },
      {} as never,
    ) as { error: string };
    expect(result.error).toMatch(/Unknown strategy/);
    expect(result.error).toContain('only');  // available list
  });

  test('catches strategy throws and surfaces as {error}', async () => {
    const reg = createStrategyRegistry();
    reg.register(createTestStrategy({ id: 'boom', throwError: 'kaboom' }));
    const { rt } = createTestRuntime();
    const tool = createThinkTool({
      registry: reg, rt, model: rt.llm as never,
    });
    const result = await tool.execute(
      { strategy: 'boom', task: 't' },
      {} as never,
    ) as { error: string };
    expect(result.error).toMatch(/boom failed/);
    expect(result.error).toMatch(/kaboom/);
  });

  test('merges defaultOptions with caller-supplied options', async () => {
    const reg = createStrategyRegistry();
    let observedOpts: StrategyContext['options'] | undefined;
    reg.register({
      id: 'inspect',
      async explore(ctx) {
        observedOpts = ctx.options;
        return {
          strategy: 'inspect',
          best: { text: '', score: 1, source: '' },
          all: [],
          cost: { durationMs: 0 },
        };
      },
    });
    const { rt } = createTestRuntime();
    const tool = createThinkTool({
      registry: reg, rt, model: rt.llm as never,
      defaultOptions: () => ({ mcts: { iterations: 7 }, heads: { count: 3 } }),
    });
    await tool.execute(
      { strategy: 'inspect', task: 't', options: { heads: { count: 5 } } },
      {} as never,
    );
    // defaultOptions is spread first; caller options override per-key
    expect(observedOpts?.mcts).toEqual({ iterations: 7 });
    expect(observedOpts?.heads).toEqual({ count: 5 });
  });

  test('passes through budget to strategy context', async () => {
    const reg = createStrategyRegistry();
    let observedBudget: StrategyContext['budget'] | undefined;
    reg.register({
      id: 'inspect-budget',
      async explore(ctx) {
        observedBudget = ctx.budget;
        return {
          strategy: 'inspect-budget',
          best: { text: '', score: 1, source: '' },
          all: [],
          cost: { durationMs: 0 },
        };
      },
    });
    const { rt } = createTestRuntime();
    const tool = createThinkTool({ registry: reg, rt, model: rt.llm as never });
    await tool.execute(
      { strategy: 'inspect-budget', task: 't', budget: 42, wall_clock_ms: 999 },
      {} as never,
    );
    expect(observedBudget?.maxIterations).toBe(42);
    expect(observedBudget?.wallClockMs).toBe(999);
  });

  test('inputSchema enum is built from the registry at construction time', () => {
    const reg = createStrategyRegistry();
    reg.register(createSingleShotStrategy());
    reg.register(createTestStrategy({ id: 'custom' }));
    const { rt } = createTestRuntime();
    const tool = createThinkTool({ registry: reg, rt, model: rt.llm as never });
    // Schema's strategy field enum should list both ids.
    const schema = tool.inputSchema as { jsonSchema: { properties: { strategy: { enum: string[] } } } };
    expect(schema.jsonSchema.properties.strategy.enum).toEqual(['single-shot', 'custom']);
  });
});
