/**
 * A turn review re-run after a refusal (a replayed lane on a fresh activation) rates the turn once:
 * the rating and the review step are tombstoned in storage, so a second engine over the same rows
 * appends nothing and asks the decision model nothing.
 */
import { describe, expect, test } from 'bun:test';
import { EvolutionEngine } from '../src/evolution/engine';
import type { CompletedTurn } from '../src/evolution/types';
import { createTestRuntime } from './helpers';

const FOLLOWUP = 'no, that is the batch API again';

function reviewedTurn(): CompletedTurn {
  return {
    userMessage: 'use the streaming API', assistantResponse: 'here is a batch call',
    toolCalls: [], durationMs: 1, steps: 1, hadError: false, feedback: null,
    turnId: 'u-review', sessionId: 'default', origin: 'user',
  };
}

describe('a replayed turn review', () => {
  test('rates the turn once and writes one lesson', async () => {
    const { rt, stores } = createTestRuntime();
    let asked = 0;

    rt.decide = async () => {
      asked++;

      return {
        satisfaction: { type: 'score', score: 0.5 }, corrected: { type: 'noul', noul: 0.95 },
        wrong: { type: 'choice', choice: 'ignored_instruction' },
      };
    };

    const counts = () => ({
      ratings: rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM turn_ratings`[0]?.n,
      lessons: rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM lessons`[0]?.n,
      asked,
    });

    await new EvolutionEngine(rt, stores.history).reviewTurn(reviewedTurn(), FOLLOWUP);
    expect(counts()).toEqual({ ratings: 1, lessons: 1, asked: 1 });

    // A second engine over the same rows: what the next activation replaying the lane is.
    await new EvolutionEngine(rt, stores.history).reviewTurn(reviewedTurn(), FOLLOWUP);
    expect(counts()).toEqual({ ratings: 1, lessons: 1, asked: 1 });
  });
});
