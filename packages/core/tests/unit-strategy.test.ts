import { describe, test, expect } from 'bun:test';
import {
  createStrategyRegistry, createSingleShotStrategy,
  workersAIEffortOption, effortFor, reasoningEffortOptions,
  mergeProviderOptions, REASONING_EFFORT_FOR_STAGE,
} from '../src/index';
import type { ExplorationStrategy } from '../src/index';

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

  test('maps user effort to each provider family exactly', () => {
    expect(reasoningEffortOptions('low', 'workers-ai')).toEqual({
      'workers-ai': { reasoning_effort: 'low' },
    });
    for (const provider of ['openai', 'opencode', 'codex', 'openai-compat', 'openai-compat:groq'] as const) {
      expect(reasoningEffortOptions('medium', provider)).toEqual({
        openai: { reasoningEffort: 'medium' },
      });
    }
    expect(reasoningEffortOptions('low', 'openrouter')).toEqual({
      openrouter: { reasoningEffort: 'low' },
    });
    expect(reasoningEffortOptions('high', 'anthropic')).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 32_000 } },
    });
  });

  test('maps Anthropic effort levels to their token budgets', () => {
    expect(reasoningEffortOptions('low', 'anthropic')).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 4_000 } },
    });
    expect(reasoningEffortOptions('medium', 'anthropic')).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 16_000 } },
    });
  });

  test('returns no options for an unsupported provider or missing effort', () => {
    expect(reasoningEffortOptions(undefined, 'openai')).toBeUndefined();
    expect(reasoningEffortOptions('high', 'unknown')).toBeUndefined();
  });

  test('merges effort into an existing provider namespace without clobbering it', () => {
    expect(mergeProviderOptions(
      { openai: { promptCacheKey: 'session-1' } },
      reasoningEffortOptions('high', 'openai'),
    )).toEqual({
      openai: { promptCacheKey: 'session-1', reasoningEffort: 'high' },
    });
  });
});
