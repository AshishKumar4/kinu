// Alternate Takes view logic — the pure half of the chat's takes chip +
// comparison (cycling, labels, evidence) used by AlternateTakes.tsx.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlternateTakeSet } from '@kinu.run/core';
import { takeEvidence } from '@kinu.run/core';
import {
  currentTakeIndex, cycleTakeIndex, hasComparableTakes, takeChipLabel,
} from '../src/components/alternate-takes-logic';

function makeSet(overrides: Partial<AlternateTakeSet> = {}): AlternateTakeSet {
  return {
    id: 'take-1', turnId: 'm2', sessionId: 'default', task: 'choose a plan', source: 'mcts',
    winnerNodeId: 'win', chosenNodeId: null, createdAt: 1, pickedAt: null,
    candidates: [
      { nodeId: 'win', text: 'plan A', score: 0.9, visits: 3, depth: 1 },
      { nodeId: 'alt', text: 'plan B', score: 0.85, visits: 1, depth: 2 },
      { nodeId: 'alt2', text: 'plan C', score: 0.82, visits: 2, depth: 1 },
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

  test('evidence line carries score, visits, and depth', () => {
    expect(takeEvidence(makeSet().candidates[0]!)).toBe('score 0.90 · 3 visits · depth 1');
    expect(takeEvidence(makeSet().candidates[1]!)).toBe('score 0.85 · 1 visit · depth 2');
  });

  test('branch-sourced candidates are labeled by their split side, not a fabricated score', () => {
    expect(takeEvidence({ nodeId: 'l', text: 'a', score: 0.5, visits: 1, depth: 0, origin: 'live' }))
      .toBe("the live turn's answer");
    expect(takeEvidence({ nodeId: 'b', text: 'b', score: 0.5, visits: 1, depth: 0, origin: 'branch' }))
      .toBe("the branched redirect's answer");
  });

  test('only sets with a genuine choice are comparable', () => {
    expect(hasComparableTakes(makeSet())).toBe(true);
    expect(hasComparableTakes(makeSet({ candidates: makeSet().candidates.slice(0, 1) }))).toBe(false);
    expect(hasComparableTakes(undefined)).toBe(false);
    expect(hasComparableTakes(null)).toBe(false);
  });
});

describe('take-pick schema ordering (lazy-engine hole)', () => {
  test('the boot schema inits the outcome ledger before any pick RPC can run', () => {
    // Regression: the take_pick CHECK-widening rebuild lived only in the lazy
    // EvolutionEngine constructor, so a freshly-woken actor whose first action
    // was pickAlternateTake hit the legacy CHECK and lost the preference. The
    // fix now lives in core's one workspace schema, which every root boots
    // through (core/tests/contract-workspace-schema.test.ts pins that).
    const schema = readFileSync(
      join(import.meta.dir, '..', '..', 'core', 'src', 'identity', 'workspace-schema.ts'), 'utf8',
    );
    const body = schema.slice(schema.indexOf('export function initWorkspaceSchema'));
    expect(body).toContain('initTurnOutcomeTables(execRaw, sql)');
  });
});
