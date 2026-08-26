/**
 * The deferred turn-review lane — the one-shot host's exit from the turn
 * review it owes.
 *
 * A `kinu exec` process cannot afford to JOIN the outcome review it owes, so
 * it parks one durable row in `completed_turns` (evolution/session-window.ts)
 * and the next host runs it. The contract these tests hold is that deferring
 * changes WHEN the review runs and nothing else: same call, same inputs, same
 * `turn_outcomes` row.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { EvolutionEngine } from '../src/evolution/engine';
import type { CompletedTurn } from '../src/evolution/types';
import { listTurnOutcomes, listLessons, type TurnOutcomeRow } from '../src/evolution/outcomes';
import { MAX_TURN_REVIEWS_PER_OPEN } from '../src/evolution/session-window';

const CLASSIFY = 'Classify what the follow-up reveals';

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

/** One workspace with a keyed stub model, wired exactly as a live one is. The
 *  production workspace schema already carries `completed_turns` and the
 *  crafted-tool quality columns. */
function workspace(outcome: 'accepted' | 'corrected' = 'corrected') {
  const { rt } = createTestRuntime({
    llmResponses: { [CLASSIFY]: `{"outcome":"${outcome}","confidence":0.9,"evidence":"test"}` },
  });
  return { rt, engine: new EvolutionEngine(rt) };
}

/** Everything about an outcome row EXCEPT its row identity and clock, which are
 *  the two things a deferral legitimately changes. */
function comparable(row: TurnOutcomeRow): Omit<TurnOutcomeRow, 'id' | 'createdAt'> {
  const { id: _id, createdAt: _createdAt, ...rest } = row;
  return rest;
}

describe('EvolutionEngine.deferTurnReview — the one-shot turn-lane exit', () => {
  test('a deferred review lands the SAME outcome row an inline review would', async () => {
    const followup = 'No — that rotates production keys. I said STAGING.';
    const inline = workspace();
    await inline.engine.reviewTurn(makeTurn(), followup);

    const deferred = workspace();
    expect(deferred.engine.deferTurnReview(makeTurn(), followup)).toBe('queued');
    // Deferring records nothing by itself: the verdict does not exist yet.
    expect(listTurnOutcomes(deferred.rt.storage.sql)).toEqual([]);
    expect(await deferred.engine.runDeferredTurnReviews()).toEqual({ reviewed: 1, refused: [] });

    const inlineRows = listTurnOutcomes(inline.rt.storage.sql);
    const deferredRows = listTurnOutcomes(deferred.rt.storage.sql);
    expect(inlineRows).toHaveLength(1);
    expect(deferredRows.map(comparable)).toEqual(inlineRows.map(comparable));
    expect(deferredRows[0].outcome).toBe('corrected');
    expect(deferredRows[0].source).toBe('classifier');
    expect(deferredRows[0].followup).toBe(followup);
    // And the downstream evolution the review gates ran too, not just the row.
    expect(listLessons(deferred.rt.storage.sql, { status: 'corroborated' }))
      .toHaveLength(listLessons(inline.rt.storage.sql, { status: 'corroborated' }).length);
    // The row is retired only once its review has run.
    expect(deferred.engine.sessionWindow.countQueuedReviews()).toBe(0);
  });

  test('a headless turn with no follow-up defers the same execution verdict', async () => {
    // The execution verdict needs real tool work to read — a turn that acted
    // and errored is the one signal a headless run produces.
    const headless = (): CompletedTurn => makeTurn({
      hadError: true,
      turnId: 'msg-err',
      toolCalls: [{ name: 'run', args: { command: 'bun test' }, result: 'exit 1' }],
    });
    const inline = workspace();
    await inline.engine.reviewTurn(headless(), null);

    const deferred = workspace();
    deferred.engine.deferTurnReview(headless(), null);
    await deferred.engine.runDeferredTurnReviews();

    const rows = listTurnOutcomes(deferred.rt.storage.sql);
    expect(rows).toHaveLength(1);
    expect(rows.map(comparable)).toEqual(listTurnOutcomes(inline.rt.storage.sql).map(comparable));
    expect(rows[0].source).toBe('execution');
    expect(rows[0].outcome).toBe('corrected');
  });

  test('a corrupt row is refused by name — never reviewed as a default', async () => {
    const { rt, engine } = workspace();
    let completions = 0;
    const complete = rt.llm.complete.bind(rt.llm);
    rt.llm.complete = async (prompt: string) => { completions++; return complete(prompt); };

    void rt.storage.sql`INSERT INTO completed_turns (id, turn, followup, in_window, review, created_at)
      VALUES ('rev-corrupt', ${'{not json at all'}, ${'a follow-up'}, 0, 'queued', 1)`;

    expect(await engine.runDeferredTurnReviews())
      .toEqual({ reviewed: 0, refused: [{ id: 'rev-corrupt', reason: 'unreadable' }] });
    // No verdict was fabricated from an empty turn, and no model was paid to
    // grade one.
    expect(listTurnOutcomes(rt.storage.sql)).toEqual([]);
    expect(completions).toBe(0);
    // The row is retired anyway: one unreadable row must not wedge the queue
    // behind it forever.
    expect(engine.sessionWindow.countQueuedReviews()).toBe(0);
  });

  test('a well-formed row that is not a CompletedTurn is refused the same way', async () => {
    const { rt, engine } = workspace();
    void rt.storage.sql`INSERT INTO completed_turns (id, turn, followup, in_window, review, created_at)
      VALUES ('rev-shape', ${'{"userMessage":"u"}'}, ${null}, 0, 'queued', 1)`;
    const taken = engine.sessionWindow.takeQueuedReviews(5);
    expect(taken.reviews).toEqual([]);
    expect(taken.refused).toEqual([{ id: 'rev-shape', reason: 'unreadable' }]);
    expect(listTurnOutcomes(rt.storage.sql)).toEqual([]);
  });

  test('a review that throws keeps its row for the next open', async () => {
    const { rt, engine } = workspace();
    engine.deferTurnReview(makeTurn(), 'that broke the build');
    const reviewTurn = engine.reviewTurn.bind(engine);
    engine.reviewTurn = async () => { throw new Error('the classifier host is down'); };
    expect(await engine.runDeferredTurnReviews()).toEqual({ reviewed: 0, refused: [] });
    expect(engine.sessionWindow.countQueuedReviews()).toBe(1);   // carried forward

    engine.reviewTurn = reviewTurn;
    expect(await engine.runDeferredTurnReviews()).toEqual({ reviewed: 1, refused: [] });
    expect(listTurnOutcomes(rt.storage.sql)).toHaveLength(1);
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
    // Oldest first: a later turn's lesson is worth more with the earlier one's
    // already in the ledger.
    const graded = listTurnOutcomes(rt.storage.sql).map((r) => r.turnId).sort();
    expect(graded).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4']);
  });

  test('the queue refuses past its ceiling rather than growing without bound', () => {
    const { engine } = workspace();
    // The contract, not the number: a ceiling exists, everything under it
    // queues, and the first refusal is exactly where the count stops moving.
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
    // SAFETY: a CompletedTurn is a plain JSON-shaped object, so widening it by
    // one own property models exactly the failure under test — a tool result
    // holding a reference cycle — without changing anything the queue reads.
    const cyclic: CompletedTurn & { self?: unknown } = makeTurn();
    cyclic.self = cyclic;
    expect(engine.sessionWindow.enqueueReview(cyclic, null)).toBe('unserializable');
    expect(engine.sessionWindow.countQueuedReviews()).toBe(0);
  });

  test('with auto-evolution off nothing is deferred and nothing is drained', async () => {
    const { rt } = createTestRuntime({ llmResponses: {} });
    const engine = new EvolutionEngine(rt, { enabled: false });
    engine.deferTurnReview(makeTurn(), 'anything');
    expect(engine.sessionWindow.countQueuedReviews()).toBe(0);
    expect(await engine.runDeferredTurnReviews()).toEqual({ reviewed: 0, refused: [] });
  });
});
