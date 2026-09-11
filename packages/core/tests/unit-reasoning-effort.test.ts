// The reasoning-effort levels a control offers are the MODEL's (#9).
//
// The settings control once hardcoded low|medium|high beside a "model
// default" entry, so a model that takes xhigh could not be set to it and a
// model that takes only low|high offered a medium it would refuse. The
// offer is now derived from the model's catalog entry through one helper,
// which every surface (web settings, CLI /effort, TUI pickers) renders.
import { describe, expect, test } from 'bun:test';
import {
  REASONING_EFFORTS, isReasoningEffort, knownReasoningEfforts, offeredReasoningEfforts,
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
    // The row must show what the assignment HOLDS: silently rendering it as
    // "model default" would hide a value that still reaches the wire.
    expect(offeredReasoningEfforts(['low', 'high'], 'medium')).toEqual(['low', 'high', 'medium']);
    expect(offeredReasoningEfforts(['low', 'high'], 'high')).toEqual(['low', 'high']);
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
