/**
 * Turn-review spend under a mission budget.
 *
 * The outcome review is spend the user never asked for and never watches: up to
 * three fast completions fired after the answer, on a lane the turn accumulator
 * has already closed. Nothing bounded it. `MissionGovernor.govern` had exactly
 * one call site in the tree — the swarm — so a mission could declare a $5 cap,
 * spend it, and go on paying for reviews of the turns it already ran.
 *
 * What these tests hold:
 *   • a governed turn's review debits the mission that ran the turn, through
 *     the SAME seam the swarm uses;
 *   • an ungoverned turn is untouched — no label is invented for it, and no
 *     query reaches the ledger;
 *   • a spent cap refuses the CALL and never corrupts the queue: the row stays,
 *     named as `budget`, and a raised cap runs it.
 *
 * Each is proven RED in both directions: the debit test also asserts the
 * unlabelled turn charges nothing, and the refusal test also asserts the review
 * runs once the cap is raised.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { EvolutionEngine } from '../src/evolution/engine';
import { MissionGovernor } from '../src/mission-budget';
import type { CompletedTurn } from '../src/evolution/types';
import { listTurnOutcomes } from '../src/evolution/outcomes';
import type { AgentRuntime } from '../src/types/agent-runtime';

const CLASSIFY = 'Classify what the follow-up reveals';
const FOLLOWUP = 'No — that rotates production keys. I said STAGING.';

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

/** A workspace whose fast tier is counted, wired exactly as a live one is: the
 *  governor over the workspace's own storage, handed to the engine as config. */
function workspace() {
  const { rt } = createTestRuntime({
    llmResponses: { [CLASSIFY]: '{"outcome":"corrected","confidence":0.9,"evidence":"test"}' },
  });
  let completions = 0;
  const inner = rt.llm.complete.bind(rt.llm);
  const counted: AgentRuntime = {
    ...rt,
    llm: { stream: rt.llm.stream.bind(rt.llm), complete: async (p) => { completions++; return inner(p); } },
  };
  const governor = new MissionGovernor({ storage: rt.storage });
  return {
    rt: counted,
    governor,
    engine: new EvolutionEngine(counted, { governor }),
    calls: () => completions,
  };
}

describe('evolution spend under a mission budget', () => {
  test('a governed turn\'s review debits the mission that ran the turn', async () => {
    const ws = workspace();
    ws.governor.declare('checkout-fixes', { tokens: 1_000_000 }, {});

    // The control: the same review on the same workspace, with no label.
    await ws.engine.reviewTurn(makeTurn({ turnId: 'unscoped' }), FOLLOWUP);
    expect(ws.governor.snapshot('checkout-fixes')[0]!.calls).toBe(0);
    expect(ws.governor.snapshot('checkout-fixes')[0]!.spent.tokens).toBe(0);

    await ws.engine.reviewTurn(
      makeTurn({ turnId: 'scoped', missionLabels: ['checkout-fixes'] }),
      FOLLOWUP,
    );

    const spent = ws.governor.snapshot('checkout-fixes')[0]!;
    // Both graded turns produced the same verdict, so the difference in the
    // ledger is attributable to the label and to nothing else.
    expect(listTurnOutcomes(ws.rt.storage.sql).map((r) => r.turnId).sort())
      .toEqual(['scoped', 'unscoped']);
    expect(spent.calls).toBeGreaterThan(0);
    expect(spent.spent.tokens).toBeGreaterThan(0);
  });

  test('a turn under a label nobody declared debits nothing — a review invents no budget', async () => {
    const ws = workspace();
    ws.governor.declare('checkout-fixes', { tokens: 1_000_000 }, {});

    await ws.engine.reviewTurn(
      makeTurn({ missionLabels: ['a-label-that-was-never-declared'] }),
      FOLLOWUP,
    );

    // The review ran, and the one declared mission is untouched: an undeclared
    // label charges its own absent row, never the nearest real one.
    expect(listTurnOutcomes(ws.rt.storage.sql)).toHaveLength(1);
    expect(ws.governor.snapshot('checkout-fixes')[0]!.calls).toBe(0);
  });

  test('a spent cap refuses the review\'s CALL, and the model is never reached', async () => {
    const ws = workspace();
    ws.governor.declare('checkout-fixes', { tokens: 10 }, {});
    ws.governor.debit(50, { labels: ['checkout-fixes'], calls: 1 });
    const before = ws.calls();

    await expect(ws.engine.reviewTurn(
      makeTurn({ missionLabels: ['checkout-fixes'] }),
      FOLLOWUP,
    )).rejects.toThrow('budget');

    expect(ws.calls()).toBe(before);
    // No verdict was written from a call that never happened.
    expect(listTurnOutcomes(ws.rt.storage.sql)).toEqual([]);
  });

  test('an ungoverned turn still runs its review with a mission fully spent beside it', async () => {
    const ws = workspace();
    ws.governor.declare('someone-elses-mission', { tokens: 1 }, {});
    ws.governor.debit(10_000, { labels: ['someone-elses-mission'], calls: 1 });

    await ws.engine.reviewTurn(makeTurn(), FOLLOWUP);

    expect(listTurnOutcomes(ws.rt.storage.sql)).toHaveLength(1);
    // The exhausted label was never consulted: nothing bound this turn to it.
    expect(ws.governor.snapshot('someone-elses-mission')[0]!.calls).toBe(1);
  });
});

describe('a deferred review carries its mission across processes', () => {
  test('the queued row runs against the turn\'s own label, not the drain\'s scope', async () => {
    const ws = workspace();
    ws.governor.declare('checkout-fixes', { tokens: 1_000_000 }, {});

    expect(ws.engine.deferTurnReview(
      makeTurn({ missionLabels: ['checkout-fixes'] }),
      FOLLOWUP,
    )).toBe('queued');
    // The drain runs with NO active scope — the process that queued it is gone.
    ws.governor.activate([]);

    expect(await ws.engine.runDeferredTurnReviews()).toEqual({ reviewed: 1, refused: [] });
    expect(ws.governor.snapshot('checkout-fixes')[0]!.calls).toBeGreaterThan(0);
    expect(ws.engine.sessionWindow.countQueuedReviews()).toBe(0);
  });

  test('a spent mission leaves its row queued, named `budget`, and a raised cap runs it', async () => {
    const ws = workspace();
    ws.governor.declare('checkout-fixes', { tokens: 10 }, {});
    ws.engine.deferTurnReview(makeTurn({ missionLabels: ['checkout-fixes'] }), FOLLOWUP);
    ws.governor.debit(50, { labels: ['checkout-fixes'], calls: 1 });

    const drain = await ws.engine.runDeferredTurnReviews();
    expect(drain.reviewed).toBe(0);
    expect(drain.refused.map((r) => r.reason)).toEqual(['budget']);
    // Re-queued, explicitly: the turn is sound and the evidence is not thrown
    // away because the mission happens to be out of money right now.
    expect(ws.engine.sessionWindow.countQueuedReviews()).toBe(1);
    expect(listTurnOutcomes(ws.rt.storage.sql)).toEqual([]);
    // And nothing recorded the review as HAVING RUN. A governor declining is a
    // decision, not a completion: a tombstone here would make activation
    // recovery settle the row and the raised cap below would find nothing owed.
    expect(ws.rt.storage.sql`SELECT key FROM effect_tombstones WHERE scope = 'turn_review'`)
      .toEqual([]);
    expect(ws.engine.sessionWindow.resetStaleClaims()).toBe(0);
    expect(ws.engine.sessionWindow.countQueuedReviews()).toBe(1);

    // Raise the cap by declaring a roomier parent the label already nests under
    // — the same row now runs.
    ws.governor.declare('checkout-fixes', { tokens: 1_000_000 }, {});
    void ws.rt.storage.sql`UPDATE mission_budget SET limit_tokens = 1000000, exhausted_at = NULL
      WHERE label = 'checkout-fixes'`;

    expect(await ws.engine.runDeferredTurnReviews()).toEqual({ reviewed: 1, refused: [] });
    expect(ws.engine.sessionWindow.countQueuedReviews()).toBe(0);
    expect(listTurnOutcomes(ws.rt.storage.sql)).toHaveLength(1);
  });
});
