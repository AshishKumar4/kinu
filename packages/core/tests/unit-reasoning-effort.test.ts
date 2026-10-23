// The reasoning-effort levels a control offers are the model's (#9), via one shared helper.
import { describe, expect, test } from 'bun:test';
import {
  REASONING_EFFORTS, carriedReasoningEffort, isReasoningEffort, knownReasoningEfforts, offeredReasoningEfforts,
} from '../src/providers/reasoning-effort';

describe('what a control offers for one model', () => {
  test('a model that declares xhigh offers it, after model default', () => {
    expect(offeredReasoningEfforts(['none', 'low', 'medium', 'high', 'xhigh'], undefined))
      .toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
  });

  test('a model that declares only low and high offers no medium', () => {
    expect(offeredReasoningEfforts(['low', 'high'], undefined)).toEqual(['low', 'high']);
  });

  test('a model that declares nothing offers nothing, and an unknown model too', () => {
    expect(offeredReasoningEfforts([], undefined)).toEqual([]);
    expect(offeredReasoningEfforts(undefined, undefined)).toEqual([]);
  });

  test('a stored level the catalog no longer lists stays visible rather than reading as unset', () => {
    // Rendering a held value as "model default" would hide what still reaches the wire.
    expect(offeredReasoningEfforts(['low', 'high'], 'medium')).toEqual(['low', 'high', 'medium']);
    expect(offeredReasoningEfforts(['low', 'high'], 'high')).toEqual(['low', 'high']);
  });
});

// PROV-3: a tier moved to a model that does not take its level kept that level, stored and shown, while turns sent another.
describe('a tier\'s stored effort when its model changes', () => {
  test('is the level the new model declares: its own, else the nearest below, else its lowest', () => {
    const glm = ['low', 'high', 'max'] as const;

    expect(carriedReasoningEffort('high', glm)).toBe('high');
    expect(carriedReasoningEffort('medium', glm)).toBe('low');
    expect(carriedReasoningEffort('xhigh', glm)).toBe('high');
    expect(carriedReasoningEffort('minimal', glm)).toBe('low');
  });

  test('is dropped for a model that takes none, kept where the levels are unknown, and an unset one stays unset', () => {
    expect(carriedReasoningEffort('medium', [])).toBeUndefined();
    expect(carriedReasoningEffort('medium', undefined)).toBe('medium');
    expect(carriedReasoningEffort(undefined, ['low', 'high'])).toBeUndefined();
  });
});

describe('the wire vocabulary', () => {
  test('runs low to high and is what the guard accepts', () => {
    expect([...REASONING_EFFORTS]).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

    for (const level of REASONING_EFFORTS) expect(isReasoningEffort(level)).toBe(true);
    expect(isReasoningEffort('ultra')).toBe(false);
    expect(isReasoningEffort(3)).toBe(false);
  });

  test('a provider list narrows to known spellings in the provider order', () => {
    expect(knownReasoningEfforts(['xhigh', { effort: 'low' }, 'low', 'ultra', null])).toEqual(['xhigh', 'low']);
  });
});
