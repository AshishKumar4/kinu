/**
 * The user's reply is the one signal a turn is judged by (docs/EVOLUTION-REDESIGN.md §1). A turn nobody answered
 * stays unrated however cleanly its tools ran, and a reply that corrects the turn is read by the decision model,
 * not inferred from tool exits.
 */
import { describe, expect, test } from 'bun:test';
import { EvolutionEngine } from '../src/evolution/engine';
import type { CompletedTurn } from '../src/evolution/types';
import type { DecisionPort } from '../src/providers/decision-model';
import { createTestRuntime } from './helpers';

const REFLECTION = 'When the user names an API, call that API and no other.';

function turn(overrides: Partial<CompletedTurn> = {}): CompletedTurn {
  return {
    userMessage: 'use the streaming API to export the report', assistantResponse: 'Exported it with the batch API.',
    toolCalls: [{ name: 'eval', args: { code: 'await tools.export_report()' }, outcome: { success: true } }],
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
  }, usage: {} });
}

describe('a turn is judged by the user reply alone', () => {
  test('a turn nobody answered moves no crafted tool score, however cleanly its tools ran', async () => {
    const { rt, stores } = createTestRuntime();
    rt.craftStore.create({ name: 'export_report', description: 'exports', code: 'async () => "ok"' });
    const before = rt.storage.sql<{ score: number }>`SELECT score FROM crafted_tools WHERE name = 'export_report'`[0]?.score;

    await new EvolutionEngine(rt, stores.history).reviewTurn(turn(), null);

    expect(rt.storage.sql<{ score: number }>`SELECT score FROM crafted_tools WHERE name = 'export_report'`[0]?.score)
      .toBe(before);
  });

  test("a reply that corrects the turn is rated low and the user's correction corroborates its lesson", async () => {
    const { rt, stores } = createTestRuntime({ llmResponses: { 'should be done differently next time': REFLECTION } });
    Object.assign(rt, { decide: decide(0.2, 0.95, 'misunderstood') });

    await new EvolutionEngine(rt, stores.history).reviewTurn(turn(), 'No, I said the streaming API. Do it again.');

    expect(rt.storage.sql<{ text: string; status: string }>`SELECT text, status FROM lessons`)
      .toEqual([{ text: REFLECTION, status: 'corroborated' }]);
  });
});
