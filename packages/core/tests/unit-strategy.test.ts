import { describe, test, expect } from 'bun:test';
import {
  createStrategyRegistry, createSingleShotStrategy,
  workersAIEffortOption, effortFor, REASONING_EFFORT_FOR_STAGE,
} from '../src/index.ts';
import type { ExplorationStrategy } from '../src/index.ts';

describe('StrategyRegistry', () => {
  function fakeStrategy(id: string): ExplorationStrategy {
    return {
      id,
      async explore() {
        return {
          strategy: id,
          best: { text: `from ${id}`, score: 1, source: id },
          all: [{ text: `from ${id}`, score: 1, source: id }],
          cost: { durationMs: 0 },
        };
      },
    };
  }

  test('register + list', () => {
    const r = createStrategyRegistry();
    r.register(fakeStrategy('a'));
    r.register(fakeStrategy('b'));
    expect(r.list().map(s => s.id)).toEqual(['a', 'b']);
    expect(r.get('a')?.id).toBe('a');
    expect(r.get('missing')).toBeUndefined();
  });

  test('register rejects duplicate', () => {
    const r = createStrategyRegistry();
    r.register(fakeStrategy('x'));
    expect(() => r.register(fakeStrategy('x'))).toThrow('already registered');
  });

  test('single-shot strategy exists with correct id', () => {
    const s = createSingleShotStrategy();
    expect(s.id).toBe('single-shot');
    expect(s.label).toBe('Single shot');
  });
});

describe('reasoning_effort plumbing', () => {
  test('REASONING_EFFORT_FOR_STAGE has all stages', () => {
    expect(REASONING_EFFORT_FOR_STAGE.chat).toBe('medium');
    expect(REASONING_EFFORT_FOR_STAGE.mcts_rollout).toBe('low');
    expect(REASONING_EFFORT_FOR_STAGE.scaffold_mutation).toBe('high');
    expect(REASONING_EFFORT_FOR_STAGE.rlm_subcall).toBe('low');
  });

  test('workersAIEffortOption returns empty when no effort', () => {
    expect(workersAIEffortOption()).toEqual({});
    expect(workersAIEffortOption(undefined)).toEqual({});
  });

  test('workersAIEffortOption returns providerOptions shape', () => {
    const opt = workersAIEffortOption('high');
    expect(opt.providerOptions?.['workers-ai'].reasoning_effort).toBe('high');
  });

  test('effortFor(stage) shortcut', () => {
    const opt = effortFor('scaffold_mutation');
    expect(opt.providerOptions?.['workers-ai'].reasoning_effort).toBe('high');
  });
});
