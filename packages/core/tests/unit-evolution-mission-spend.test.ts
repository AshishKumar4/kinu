/**
 * Turn-review spend under a mission budget: a governed turn's review debits its
 * mission through the swarm's seam; an ungoverned turn is untouched; a spent cap
 * refuses the call and leaves the row queued as `budget` until the cap is raised.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { EvolutionEngine } from '../src/evolution/engine';
import { MissionGovernor } from '../src/mission-budget';
import type { CompletedTurn } from '../src/evolution/types';
import { listTurnOutcomes } from '../src/evolution/outcomes';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { unobservedSpend } from '@kinu.run/test-utils';

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

/** Counted fast tier, with the governor wired as a live workspace wires it. */
function workspace() {
  const { rt, stores } = createTestRuntime({
    llmResponses: { [CLASSIFY]: '{"outcome":"corrected","confidence":0.9,"evidence":"test"}' },
  });

  let completions = 0;
  const inner = rt.llm.complete.bind(rt.llm);

  const counted: AgentRuntime = {
    ...rt,
    llm: { stream: rt.llm.stream.bind(rt.llm), complete: async (p) => {
      completions++;

      return inner(p);
    } },
  };

  const governor = new MissionGovernor({ storage: rt.storage, actor: rt.actor });

  return {
    rt: counted,
    governor,
    engine: new EvolutionEngine(counted, stores.history, { reportModelCall: unobservedSpend, governor }),
    calls: () => completions,
  };
}

describe('evolution spend under a mission budget', () => {
  test('a governed turn\'s review debits the mission that ran the turn', async () => {
    const ws = workspace();
    ws.governor.declare('checkout-fixes', { tokens: 1_000_000 }, {});

    // The control: the same review with no label.
    await ws.engine.reviewTurn(makeTurn({ turnId: 'unscoped' }), FOLLOWUP);
    expect(ws.governor.snapshot('checkout-fixes')[0].calls).toBe(0);
    expect(ws.governor.snapshot('checkout-fixes')[0].spent.tokens).toBe(0);

    await ws.engine.reviewTurn(
      makeTurn({ turnId: 'scoped', missionLabels: ['checkout-fixes'] }),
      FOLLOWUP,
    );

    const spent = ws.governor.snapshot('checkout-fixes')[0];
    // Same verdict for both, so the ledger difference is the label alone.
    expect(listTurnOutcomes(ws.rt.storage.sql, ws.rt.actor).map((r) => r.turnId ?? '')
      .sort((a, b) => a.localeCompare(b)))
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

    // An undeclared label charges its own absent row, never the nearest real one.
    expect(listTurnOutcomes(ws.rt.storage.sql, ws.rt.actor)).toHaveLength(1);
    expect(ws.governor.snapshot('checkout-fixes')[0].calls).toBe(0);
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
    // No verdict from a call that never happened.
    expect(listTurnOutcomes(ws.rt.storage.sql, ws.rt.actor)).toEqual([]);
  });

  test('an ungoverned turn still runs its review with a mission fully spent beside it', async () => {
    const ws = workspace();
    ws.governor.declare('someone-elses-mission', { tokens: 1 }, {});
    ws.governor.debit(10_000, { labels: ['someone-elses-mission'], calls: 1 });

    await ws.engine.reviewTurn(makeTurn(), FOLLOWUP);

    expect(listTurnOutcomes(ws.rt.storage.sql, ws.rt.actor)).toHaveLength(1);
    // The exhausted label was never consulted.
    expect(ws.governor.snapshot('someone-elses-mission')[0].calls).toBe(1);
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
    // The drain runs with no active scope.
    ws.governor.activate([]);

    expect(await ws.engine.runDeferredTurnReviews()).toEqual({ reviewed: 1, refused: [] });
    expect(ws.governor.snapshot('checkout-fixes')[0].calls).toBeGreaterThan(0);
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
    // Re-queued: the turn is sound, the mission is just out of money.
    expect(ws.engine.sessionWindow.countQueuedReviews()).toBe(1);
    expect(listTurnOutcomes(ws.rt.storage.sql, ws.rt.actor)).toEqual([]);
    // No tombstone: a refusal is not a completion, or recovery would settle the row.
    expect(ws.rt.storage.sql`SELECT key FROM effect_tombstones
      WHERE actor_id = ${ws.rt.actor.actorId} AND scope = 'turn_review'`)
      .toEqual([]);
    expect(ws.engine.sessionWindow.resetStaleClaims()).toBe(0);
    expect(ws.engine.sessionWindow.countQueuedReviews()).toBe(1);

    // A roomier parent the label nests under lets the same row run.
    ws.governor.declare('checkout-fixes', { tokens: 1_000_000 }, {});
    void ws.rt.storage.sql`UPDATE mission_budget SET limit_tokens = 1000000, exhausted_at = NULL
      WHERE actor_id = ${ws.rt.actor.actorId} AND label = 'checkout-fixes'`;

    expect(await ws.engine.runDeferredTurnReviews()).toEqual({ reviewed: 1, refused: [] });
    expect(ws.engine.sessionWindow.countQueuedReviews()).toBe(0);
    expect(listTurnOutcomes(ws.rt.storage.sql, ws.rt.actor)).toHaveLength(1);
  });
});
