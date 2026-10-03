/**
 * The deferred turn-review lane (evolution/session-window.ts): deferring changes when
 * the review runs and nothing else — same call, inputs and `turn_ratings` row.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { EvolutionEngine } from '../src/evolution/engine';
import type { CompletedTurn } from '../src/evolution/types';
import { listLessons } from '../src/evolution/lessons';
import { listTurnRatings, type TurnRating } from '../src/evolution/ratings';
import type { DecisionPort } from '../src/providers/decision-model';
import { MAX_TURN_REVIEWS_PER_OPEN } from '../src/evolution/session-window';

/** A reply read as a correction, as Clef answers one. */
const CORRECTED: DecisionPort = async () => ({ answers: {
  satisfaction: { type: 'score', score: 0.4 }, corrected: { type: 'noul', noul: 0.95 }, wrong: { type: 'choice', choice: 'misunderstood' },
}, usage: { input: 0, output: 0 } });

function makeTurn(overrides: Partial<CompletedTurn> = {}): CompletedTurn {
  return {
    userMessage: 'how do I rotate the API keys for the staging cluster?',
    assistantResponse: 'rotated them with the staging profile; the new keys are in the vault under staging/',
    toolCalls: [],
    steps: 3,
    durationMs: 5_000,
    feedback: null,
    hadError: false,
    turnId: 'msg-1',
    sessionId: 'default',
    origin: 'user',
    ...overrides,
  };
}

/** A stub decision model over the production workspace schema. */
function workspace() {
  const { rt, stores } = createTestRuntime();
  Object.assign(rt, { decide: CORRECTED });

  return { rt, engine: new EvolutionEngine(rt, stores.history) };
}

/** A rating minus the identity and clock a deferral legitimately changes. */
function comparable(row: TurnRating): Omit<TurnRating, 'id' | 'createdAt'> {
  const { id: _id, createdAt: _createdAt, ...rest } = row;

  return rest;
}

describe('EvolutionEngine.deferTurnReview — the one-shot turn-lane exit', () => {
  test('a deferred review lands the SAME rating an inline review would', async () => {
    const followup = 'No — that rotates production keys. I said STAGING.';
    const inline = workspace();
    await inline.engine.reviewTurn(makeTurn(), followup);

    const deferred = workspace();
    expect(deferred.engine.deferTurnReview(makeTurn(), followup)).toBe('queued');
    // Deferring records nothing by itself.
    expect(listTurnRatings(deferred.rt.storage.sql, deferred.rt.actor)).toEqual([]);
    expect(await deferred.engine.runDeferredTurnReviews()).toEqual({ reviewed: 1, refused: [] });

    const inlineRows = listTurnRatings(inline.rt.storage.sql, inline.rt.actor);
    const deferredRows = listTurnRatings(deferred.rt.storage.sql, deferred.rt.actor);
    expect(inlineRows).toHaveLength(1);
    expect(deferredRows.map(comparable)).toEqual(inlineRows.map(comparable));
    expect(deferredRows[0].score).toBeCloseTo(1.4);
    expect(deferredRows[0].source).toBe('model');
    expect(deferredRows[0].followup).toBe(followup);
    // The downstream evolution ran too: the correction corroborates the one lesson it teaches.
    expect(listLessons(inline.rt.storage.sql, inline.rt.actor, { status: 'corroborated' })).toHaveLength(1);
    expect(listLessons(deferred.rt.storage.sql, deferred.rt.actor, { status: 'corroborated' })).toHaveLength(1);
    // The row is retired only once its review has run.
    expect(deferred.engine.sessionWindow.countQueuedReviews()).toBe(0);
  });

  test('a headless turn with no follow-up stays unrated, deferred or not', async () => {
    // A turn that acted and errored: its tool exit decides nothing.
    const headless = (): CompletedTurn => makeTurn({
      hadError: true,
      turnId: 'msg-err',
      toolCalls: [{ name: 'shell', args: { command: 'bun test' }, result: 'exit 1' }],
    });

    const inline = workspace();
    await inline.engine.reviewTurn(headless(), null);

    const deferred = workspace();
    deferred.engine.deferTurnReview(headless(), null);
    expect(await deferred.engine.runDeferredTurnReviews()).toEqual({ reviewed: 1, refused: [] });

    expect(listTurnRatings(inline.rt.storage.sql, inline.rt.actor)).toEqual([]);
    expect(listTurnRatings(deferred.rt.storage.sql, deferred.rt.actor)).toEqual([]);
  });

  test('a corrupt row is refused by name — never reviewed as a default', async () => {
    const { rt, engine } = workspace();
    let completions = 0;
    const complete = rt.llm.complete.bind(rt.llm);
    rt.llm.complete = async (prompt: string) => {
      completions++;

      return complete(prompt);
    };

    void rt.storage.sql`INSERT INTO completed_turns (actor_id, id, turn, followup, in_window, review, created_at)
      VALUES (${rt.actor.actorId}, 'rev-corrupt', ${'{not json at all'}, ${'a follow-up'}, 0, 'queued', 1)`;

    expect(await engine.runDeferredTurnReviews())
      .toEqual({ reviewed: 0, refused: [{ id: 'rev-corrupt', reason: 'unreadable' }] });
    // No verdict fabricated, no model paid.
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toEqual([]);
    expect(completions).toBe(0);
    // Retired anyway, so one unreadable row cannot wedge the queue.
    expect(engine.sessionWindow.countQueuedReviews()).toBe(0);
  });

  test('a well-formed row that is not a CompletedTurn is refused the same way', async () => {
    const { rt, engine } = workspace();
    void rt.storage.sql`INSERT INTO completed_turns (actor_id, id, turn, followup, in_window, review, created_at)
      VALUES (${rt.actor.actorId}, 'rev-shape', ${'{"userMessage":"u"}'}, ${null}, 0, 'queued', 1)`;
    const taken = engine.sessionWindow.takeQueuedReviews(5);
    expect(taken.reviews).toEqual([]);
    expect(taken.refused).toEqual([{ id: 'rev-shape', reason: 'unreadable' }]);
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toEqual([]);
  });

  test('a review that throws keeps its row for the next open', async () => {
    const { rt, engine } = workspace();
    engine.deferTurnReview(makeTurn(), 'that broke the build');
    const reviewTurn = engine.reviewTurn.bind(engine);
    engine.reviewTurn = async () => { throw new Error('the decision model host is down'); };

    expect(await engine.runDeferredTurnReviews()).toEqual({ reviewed: 0, refused: [] });
    expect(engine.sessionWindow.countQueuedReviews()).toBe(1);   // carried forward

    engine.reviewTurn = reviewTurn;
    expect(await engine.runDeferredTurnReviews()).toEqual({ reviewed: 1, refused: [] });
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toHaveLength(1);
  });

  test('one open drains a bounded batch — a backlog is not the next turn\'s latency', async () => {
    const { rt, engine } = workspace();
    const owed = MAX_TURN_REVIEWS_PER_OPEN + 3;

    for (let i = 0; i < owed; i++) {
      engine.deferTurnReview(makeTurn({ turnId: `msg-${i}` }), `follow-up ${i}`);
    }

    expect(await engine.runDeferredTurnReviews())
      .toEqual({ reviewed: MAX_TURN_REVIEWS_PER_OPEN, refused: [] });
    expect(engine.sessionWindow.countQueuedReviews()).toBe(3);   // the rest waits for the next open
    // Oldest first: a later lesson is worth more with the earlier one in the ledger.

    const graded = listTurnRatings(rt.storage.sql, rt.actor).map((r) => r.turnId).sort((a, b) => a.localeCompare(b));

    expect(graded).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4']);
  });

  test('the queue refuses past its ceiling rather than growing without bound', () => {
    const { engine } = workspace();
    // The contract, not the number: the count stops exactly at the first refusal.
    let queued = 0;

    while (engine.deferTurnReview(makeTurn({ turnId: `msg-${String(queued)}` }), null) === 'queued') {
      queued += 1;

      if (queued > 1_000) throw new Error('no ceiling: 1000 reviews queued without a refusal');
    }

    expect(queued).toBeGreaterThan(0);
    expect(engine.sessionWindow.countQueuedReviews()).toBe(queued);
    expect(engine.deferTurnReview(makeTurn({ turnId: 'still-refused' }), null)).toBe('queue_full');
    expect(engine.sessionWindow.countQueuedReviews()).toBe(queued);
  });

  test('an unserializable turn is refused at the queue, never written as a corrupt row', () => {
    const { engine } = workspace();
    // SAFETY: a plain JSON-shaped object widened by one property models a tool result
    // holding a reference cycle.
    const cyclic: CompletedTurn & { self?: unknown } = makeTurn();
    cyclic.self = cyclic;
    expect(engine.sessionWindow.enqueueReview(cyclic, null)).toBe('unserializable');
    expect(engine.sessionWindow.countQueuedReviews()).toBe(0);
  });

  test('with auto-evolution off nothing is deferred and nothing is drained', async () => {
    const { rt, stores } = createTestRuntime({ llmResponses: {} });
    const engine = new EvolutionEngine(rt, stores.history, { enabled: false });
    engine.deferTurnReview(makeTurn(), 'anything');
    expect(engine.sessionWindow.countQueuedReviews()).toBe(0);
    expect(await engine.runDeferredTurnReviews()).toEqual({ reviewed: 0, refused: [] });
  });
});
