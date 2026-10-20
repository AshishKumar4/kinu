// Ratings are append-only and readers resolve one effective rating per turn by source
// precedence, keeping the model's row beneath the user's.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { listTurnRatings, recordTurnRating } from '../src/evolution/ratings';

describe("S8 — the user's rating overrules the model's without erasing it", () => {
  test('the effective reader resolves one rating per turn, the thumb wins', () => {
    const { rt } = createTestRuntime();
    recordTurnRating(rt.storage.sql, rt.actor, {
      turnId: 't1', score: 4.5, corrected: 0, wrong: 'nothing', source: 'model', request: 'u', answer: 'a', scaffoldVersion: 3,
    });
    recordTurnRating(rt.storage.sql, rt.actor, {
      turnId: 't1', score: 1, corrected: 1, wrong: null, source: 'thumbs', request: 'u', answer: 'a', scaffoldVersion: 3,
    });

    // One effective rating per turn; the model's row stays beneath it.
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toMatchObject([{ turnId: 't1', score: 1, source: 'thumbs' }]);
    expect(rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM turn_ratings`[0]?.n).toBe(2);
    // A low-rating read sees the effective rating too.
    expect(listTurnRatings(rt.storage.sql, rt.actor, { turnIds: ['t1'], low: true })).toHaveLength(1);
  });
});
