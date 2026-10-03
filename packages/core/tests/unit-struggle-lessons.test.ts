/**
 * A turn that fought a tool teaches one lesson about it (docs/EVOLUTION-REDESIGN.md §2): every reviewed turn records
 * its struggles, the fast tier writes the lesson whether or not the turn is rated, and the later turns that use the
 * tool score it until it retires.
 */
import { describe, expect, test } from 'bun:test';
import { EvolutionEngine } from '../src/evolution/engine';
import type { CompletedTurn } from '../src/evolution/types';
import type { Struggle } from '../src/evolution/struggles';
import { createTestRuntime } from './helpers';

const LESSON = 'Name `path` in every edit call; edit refuses one without it.';

const REFUSED: Struggle = { kind: 'schema_refusal', tool: 'edit', count: 2, sample: 'edit: path is required' };

function turn(turnId: string, struggles: readonly Struggle[]): CompletedTurn {
  return {
    userMessage: 'fix the typo in the README', assistantResponse: 'Fixed.',
    toolCalls: [
      { name: 'edit', args: { text: 'teh' }, result: 'edit: path is required', outcome: { success: false, reason: 'bad_input' } },
      { name: 'edit', args: { path: 'README.md', text: 'the' }, result: 'ok', outcome: { success: true } },
    ],
    durationMs: 1, steps: 3, hadError: false, feedback: null, turnId, sessionId: 'default', origin: 'user', struggles,
  };
}

/** The fast tier answers every lesson prompt with `answer`. */
function engine(answer: { update: string | null; text: string }) {
  const { rt, stores } = createTestRuntime({ llmResponses: { 'spared this turn the struggle': JSON.stringify(answer) } });

  const lessons = () => rt.storage.sql<{ id: string; tool: string; text: string; helpful: number; harmful: number; status: string }>`
    SELECT id, tool, text, helpful, harmful, status FROM tool_lessons ORDER BY created_at, id`;

  return { rt, lessons, review: (reviewed: CompletedTurn) => new EvolutionEngine(rt, stores.history).reviewTurn(reviewed, null) };
}

describe('a struggling turn teaches one lesson about its tool', () => {
  test('an unrated turn records its struggles and the fast tier writes the lesson', async () => {
    const { rt, lessons, review } = engine({ update: null, text: LESSON });

    await review(turn('t-1', [REFUSED]));

    expect(rt.storage.sql<{ turn_id: string; errors: number; steps: number; struggles: string }>`
      SELECT turn_id, errors, steps, struggles FROM turn_struggles`)
      .toEqual([{ turn_id: 't-1', errors: 1, steps: 3, struggles: JSON.stringify([REFUSED]) }]);
    expect(lessons()).toEqual([{ id: 'tl-t-1', tool: 'edit', text: LESSON, helpful: 0, harmful: 0, status: 'active' }]);
  });

  test('a turn without a struggle is recorded and asks no model', async () => {
    const { rt, lessons, review } = engine({ update: null, text: LESSON });

    await review(turn('t-1', []));

    expect(rt.storage.sql<{ turn_id: string }>`SELECT turn_id FROM turn_struggles`).toEqual([{ turn_id: 't-1' }]);
    expect(lessons()).toEqual([]);
  });

  test('a lesson the model names is rewritten in place, not added beside', async () => {
    const { lessons, review } = engine({ update: 'tl-t-1', text: LESSON });

    await review(turn('t-1', [REFUSED]));
    await review(turn('t-2', [REFUSED]));

    expect(lessons().map(({ id, text }) => ({ id, text }))).toEqual([{ id: 'tl-t-1', text: LESSON }]);
  });

  test('later uses score it, and one that hurt more than it helped over five uses retires', async () => {
    const { lessons, review } = engine({ update: 'tl-t-1', text: LESSON });

    await review(turn('t-1', [REFUSED]));
    await review(turn('t-2', []));
    expect(lessons()[0]).toMatchObject({ helpful: 1, harmful: 0, status: 'active' });

    for (const id of ['t-3', 't-4', 't-5', 't-6']) await review(turn(id, [REFUSED]));

    // The retired lesson is not rewritten: the sixth struggle teaches afresh.
    expect(lessons().map(({ id, helpful, harmful, status }) => ({ id, helpful, harmful, status }))).toEqual([
      { id: 'tl-t-1', helpful: 1, harmful: 4, status: 'retired' },
      { id: 'tl-t-6', helpful: 0, harmful: 0, status: 'active' },
    ]);
  });

  test('a deferred review keeps the struggles the turn was stored with', async () => {
    const { rt, stores } = createTestRuntime({ llmResponses: { 'spared this turn the struggle': JSON.stringify({ update: null, text: LESSON }) } });
    const deferred = new EvolutionEngine(rt, stores.history);

    expect(deferred.deferTurnReview(turn('t-1', [REFUSED]), null)).toBe('queued');
    await deferred.runDeferredTurnReviews();

    expect(rt.storage.sql<{ id: string }>`SELECT id FROM tool_lessons`).toEqual([{ id: 'tl-t-1' }]);
  });

  test('a stall alone teaches no lesson, as no one tool owns it', async () => {
    const { lessons, review } = engine({ update: null, text: LESSON });

    await review(turn('t-1', [{ kind: 'no_progress', tool: null, count: 12, sample: '' }]));

    expect(lessons()).toEqual([]);
  });
});
