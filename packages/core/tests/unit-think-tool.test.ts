// Behavior tests for the unified `think(strategy, task, ...)` dispatcher.
// Verifies registry-based routing, error envelopes, defaultOptions wiring,
// and that the input schema enumerates registered strategies.
import { describe, test, expect } from 'bun:test';
import {
  createStrategyRegistry, createSingleShotStrategy, createThinkTool,
  BUILTIN_TOOL_DESCRIPTIONS,
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

  test('deep-merges caller options under injected infra (host deps survive)', async () => {
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
    const controller = { __infra: true };
    const tool = createThinkTool({
      registry: reg, rt, model: rt.llm as never,
      defaultOptions: () => ({ mcts: { iterations: 7 }, heads: { controller, count: 3 } }),
    });
    await tool.execute(
      { strategy: 'inspect', task: 't', options: { heads: { count: 5 } } },
      {} as never,
    );
    // Untouched strategy bag passes through verbatim.
    expect(observedOpts?.mcts).toEqual({ iterations: 7 });
    // One-level deep merge: caller's `count` overrides, but the host-injected
    // `controller` is NOT clobbered. This is the bug the shallow spread had.
    expect(observedOpts?.heads).toEqual({ controller, count: 5 });
  });

  test('folds typed heads / merge_strategy input into options.heads', async () => {
    const reg = createStrategyRegistry();
    let observedOpts: StrategyContext['options'] | undefined;
    reg.register({
      id: 'heads',
      async explore(ctx) {
        observedOpts = ctx.options;
        return {
          strategy: 'heads',
          best: { text: '', score: 1, source: '' },
          all: [],
          cost: { durationMs: 0 },
        };
      },
    });
    const { rt } = createTestRuntime();
    const controller = { __infra: true };
    const tool = createThinkTool({
      registry: reg, rt, model: rt.llm as never,
      defaultOptions: () => ({ heads: { controller } }),
    });
    const specs = [
      { task: 'survey prior art', rationale: 'establish baseline' },
      { task: 'sketch design', rationale: 'exercise constraints' },
    ];
    await tool.execute(
      { strategy: 'heads', task: 't', heads: specs, merge_strategy: 'consensus' },
      {} as never,
    );
    // Injected controller + LLM-supplied specs coexist under options.heads.
    expect(observedOpts?.heads).toEqual({
      controller,
      heads: specs,
      mergeStrategy: 'consensus',
    });
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

  test('docstring is single-sourced from the registry think spec + live strategy ids', () => {
    const reg = createStrategyRegistry();
    reg.register(createTestStrategy({ id: 'heads' }));
    reg.register(createTestStrategy({ id: 'mcts' }));
    const { rt } = createTestRuntime();
    const tool = createThinkTool({ registry: reg, rt, model: rt.llm as never });
    // The strategy doctrine comes verbatim from the canonical tool registry —
    // no parallel description assembly.
    expect(tool.description!.startsWith(BUILTIN_TOOL_DESCRIPTIONS.think)).toBe(true);
    expect(tool.description).toContain('Strategies available this turn: heads, mcts.');
  });

  test('inputSchema enum lists only ADVERTISED strategies', () => {
    const reg = createStrategyRegistry();
    reg.register(createSingleShotStrategy());   // advertised: false (eval baseline)
    reg.register(createTestStrategy({ id: 'custom' }));
    const { rt } = createTestRuntime();
    const tool = createThinkTool({ registry: reg, rt, model: rt.llm as never });
    const schema = tool.inputSchema as { jsonSchema: { properties: { strategy: { enum: string[] } } } };
    expect(schema.jsonSchema.properties.strategy.enum).toEqual(['custom']);
    expect(tool.description).not.toContain('single-shot');
  });

  test('non-advertised strategies stay dispatchable by id (eval harness path)', async () => {
    const reg = createStrategyRegistry();
    reg.register({ ...createTestStrategy({ id: 'baseline', answer: 'from baseline' }), advertised: false });
    const { rt } = createTestRuntime();
    const tool = createThinkTool({ registry: reg, rt, model: rt.llm as never });
    const result = await tool.execute(
      { strategy: 'baseline', task: 'x' },
      {} as never,
    ) as { strategy: string; text: string };
    expect(result.strategy).toBe('baseline');
    expect(result.text).toBe('from baseline');
  });
});
