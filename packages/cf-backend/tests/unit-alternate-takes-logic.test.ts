import { describe, test, expect } from 'bun:test';
import type { AlternateTakeSet } from '@kinu.run/core';
import { takeEvidence } from '@kinu.run/core';
import {
  currentTakeIndex, cycleTakeIndex, hasComparableTakes, takeChipLabel,
} from '@kinu.run/core';

function makeSet(overrides: Partial<AlternateTakeSet> = {}): AlternateTakeSet {
  return {
    id: 'take-1', turnId: 'm2', sessionId: 'default', task: 'choose a plan',
    winnerNodeId: 'win', chosenNodeId: null, createdAt: 1,
    candidates: [
      { nodeId: 'win', text: 'plan A', origin: 'live' },
      { nodeId: 'alt', text: 'plan B', origin: 'branch' },
      { nodeId: 'alt2', text: 'plan C', origin: 'branch' },
    ],
    ...overrides,
  };
}

describe('alternate-takes view logic', () => {
  test('the current take is the pick when one exists, else the winner', () => {
    expect(currentTakeIndex(makeSet())).toBe(0);
    expect(currentTakeIndex(makeSet({ chosenNodeId: 'alt2' }))).toBe(2);
    // A repointed set whose node vanished degrades to the first candidate.
    expect(currentTakeIndex(makeSet({ winnerNodeId: 'gone' }))).toBe(0);
  });

  test('the chip labels the current take among the explored count', () => {
    expect(takeChipLabel(makeSet())).toBe('Take 1 of 3');
    expect(takeChipLabel(makeSet({ chosenNodeId: 'alt' }))).toBe('Take 2 of 3');
  });

  test('cycling wraps in both directions', () => {
    expect(cycleTakeIndex(0, 1, 3)).toBe(1);
    expect(cycleTakeIndex(2, 1, 3)).toBe(0);
    expect(cycleTakeIndex(0, -1, 3)).toBe(2);
    expect(cycleTakeIndex(0, 1, 0)).toBe(0);
  });

  test('a candidate is labeled by its split side', () => {
    expect(takeEvidence({ nodeId: 'l', text: 'a', origin: 'live' })).toBe("the live turn's answer");
    expect(takeEvidence({ nodeId: 'b', text: 'b', origin: 'branch' })).toBe("the branched redirect's answer");
  });

  test('only sets with a genuine choice are comparable', () => {
    expect(hasComparableTakes(makeSet())).toBe(true);
    expect(hasComparableTakes(makeSet({ candidates: makeSet().candidates.slice(0, 1) }))).toBe(false);
    expect(hasComparableTakes(undefined)).toBe(false);
    expect(hasComparableTakes(null)).toBe(false);
  });
});
