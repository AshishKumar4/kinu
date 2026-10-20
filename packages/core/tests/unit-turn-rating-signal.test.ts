/**
 * The user's reply is the one signal a turn is judged by (docs/EVOLUTION-REDESIGN.md §1). A turn nobody answered
 * stays unrated however cleanly its tools ran, and a reply that corrects the turn is read by the decision model,
 * not inferred from tool exits.
 */
import { compactToolCall } from '../src/evolution/tool-call-record';
import { describe, expect, test } from 'bun:test';
import { EvolutionEngine } from '../src/evolution/engine';
import { listLessons } from '../src/evolution/lessons';
import { listTurnRatings } from '../src/evolution/ratings';
import type { CompletedTurn } from '../src/evolution/types';
import type { DecisionPort } from '../src/providers/decision-model';
import { createTestRuntime } from './helpers';
import { historyTurnPairs } from '../src/identity/conversation-store';

function turn(overrides: Partial<CompletedTurn> = {}): CompletedTurn {
  return {
    userMessage: 'use the streaming API to export the report', assistantResponse: 'Exported it with the batch API.',
    toolCalls: [compactToolCall({ name: 'eval', args: { code: 'await tools.export_report()' }, outcome: { success: true } })],
    craftedToolsUsed: ['export_report'], durationMs: 1, steps: 2, hadError: false, feedback: null,
    turnId: 'u-1', sessionId: 'default', origin: 'user',
    ...overrides,
  };
}

/** Answers as Clef does, 0-based on the score's criteria. */
function decide(score: number, corrected: number, wrong: string): DecisionPort {
  return async () => ({ answers: {
    satisfaction: { type: 'score', score },
    corrected: { type: 'noul', noul: corrected },
    wrong: { type: 'choice', choice: wrong },
  }, usage: { input: 0, output: 0 } });
}

describe('a turn is judged by the user reply alone', () => {
  test('a turn nobody answered credits no crafted tool, however cleanly its tools ran', async () => {
    const { rt, stores } = createTestRuntime();
    rt.craftStore.create({ name: 'export_report', description: 'exports', code: 'async () => "ok"' });

    await new EvolutionEngine(rt, historyTurnPairs(stores.history)).reviewTurn(turn(), null);

    expect(rt.storage.sql<{ rated: number }>`SELECT rated FROM crafted_tools WHERE name = 'export_report'`[0]?.rated).toBe(0);
  });

  test('a reply that corrects the turn is rated low on what went wrong, and leaves the lesson to the dream', async () => {
    const { rt, stores } = createTestRuntime();
    Object.assign(rt, { decide: decide(0.2, 0.95, 'misunderstood') });

    await new EvolutionEngine(rt, historyTurnPairs(stores.history)).reviewTurn(turn(), 'No, I said the streaming API. Do it again.');

    expect(listTurnRatings(rt.storage.sql, rt.actor)).toMatchObject([{ turnId: 'u-1', source: 'model', wrong: 'misunderstood' }]);
    expect(listLessons(rt.storage.sql, rt.actor)).toEqual([]);
  });
});
