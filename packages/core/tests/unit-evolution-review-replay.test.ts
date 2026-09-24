/**
 * A turn review re-run after a refusal (a replayed lane on a fresh activation) grades the turn once:
 * the grading and the review step are tombstoned in storage, so a second engine over the same rows
 * appends nothing.
 */
import { describe, expect, test } from 'bun:test';
import { EvolutionEngine } from '../src/evolution/engine';
import type { CompletedTurn } from '../src/evolution/types';
import { createTestRuntime } from './helpers';
import { unobservedSpend } from '@kinu.run/test-utils';

const CLASSIFY = 'Classify what the follow-up reveals';

const FOLLOWUP = 'no, that is the batch API again';

function reviewedTurn(): CompletedTurn {
  return {
    userMessage: 'use the streaming API', assistantResponse: 'here is a batch call',
    toolCalls: [], durationMs: 1, steps: 1, hadError: false, feedback: null,
    turnId: 'u-review', sessionId: 'default', origin: 'user',
  };
}

describe('a replayed turn review', () => {
  test('grades the turn once and writes one lesson', async () => {
    const { rt, stores } = createTestRuntime({
      llmResponses: { [CLASSIFY]: '{"outcome":"corrected","confidence":0.9,"evidence":"the user restated it"}' },
    });

    const counts = () => ({
      outcomes: rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM turn_outcomes`[0]?.n,
      lessons: rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM lessons`[0]?.n,
    });

    await new EvolutionEngine(rt, stores.history, { reportModelCall: unobservedSpend }).reviewTurn(reviewedTurn(), FOLLOWUP);
    expect(counts()).toEqual({ outcomes: 1, lessons: 1 });

    // A second engine over the same rows: what the next activation replaying the lane is.
    await new EvolutionEngine(rt, stores.history, { reportModelCall: unobservedSpend }).reviewTurn(reviewedTurn(), FOLLOWUP);
    expect(counts()).toEqual({ outcomes: 1, lessons: 1 });
  });
});
