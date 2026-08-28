/**
 * The control plane every ActorAgent root exposes, exercised through each root.
 *
 * These four RPCs — getStoredModelSpec, setModel, steerTurn, cancelCurrentWork —
 * were declared twice, once on OrchestratorAgent and once on SubordinateAgent,
 * over the same four core implementations and with the same bodies. What is worth
 * asserting after collapsing them onto the substrate is not the delegation: it is
 * that ONE implementation still behaves correctly through BOTH classes, and that
 * the single real difference between the old copies survived the collapse —
 * cancelling work settles the orchestrator's own turn state and does not touch a
 * subordinate's, which is now an overridable hook rather than a second body.
 *
 * Behaviour through the public classes, not source text: the source-level ratchet
 * that stops the copies reappearing lives in unit-rpc-surface.test.ts, where the
 * declared-member machinery already is.
 */

import { describe, expect, test } from 'bun:test';
import { TURN_AUTHOR_METADATA_KEY, type JsonObject } from '@kinu.run/core';
import { orchestratorHarness, subordinateHarness } from './helpers/actor-harness';
import type { Database } from 'bun:sqlite';

/** Activity rows the cancel hook is the only writer of. */
function cancelActivity(db: Database): unknown[] {
  return db.prepare("SELECT detail FROM activity_log WHERE event = 'work_cancelled'").all();
}

describe('the actor control plane answers on both roots', () => {
  test('a stored model spec round-trips on the workspace root', async () => {
    const { agent } = orchestratorHarness();

    expect(await agent.getStoredModelSpec()).toEqual({ spec: null });
    await agent.setModel('anthropic/claude-sonnet-4-5');

    expect(await agent.getStoredModelSpec()).toEqual({ spec: 'anthropic/claude-sonnet-4-5' });
  });

  test('the same one answers on a subordinate root', async () => {
    const { agent } = subordinateHarness();

    expect(await agent.getStoredModelSpec()).toEqual({ spec: null });
    await agent.setModel('anthropic/claude-sonnet-4-5');

    expect(await agent.getStoredModelSpec()).toEqual({ spec: 'anthropic/claude-sonnet-4-5' });
  });

  /**
   * The turn ended before the steer arrived. The old contract answered 'idle'
   * and left the text with the caller to re-send — the race KINU-N026 closes:
   * another turn could start first and file the guidance as some later turn.
   * Now the actor commits the text to its own turn queue in the same slice as
   * the decision and answers 'queued'. A subordinate chat is a chat, so it
   * answers the same way.
   */
  test('steering with no turn running queues the text as the next ordinary turn', async () => {
    for (const { agent } of [orchestratorHarness(), subordinateHarness()]) {
      const enqueued: Array<{ text: string; metadata?: JsonObject }> = [];
      Reflect.set(agent, '_host', {
        broadcast: () => {},
        enqueueTurn: async (turn: { text: string; metadata?: JsonObject }) => {
          enqueued.push(turn);
          return { status: 'queued' as const };
        },
        turnInFlight: () => false,
        setTimer: () => {},
        headRuntime: undefined,
      });

      expect(await agent.steerTurn('use the other parser')).toEqual({ landed: 'queued' });
      expect(enqueued).toEqual([{
        text: 'use the other parser',
        metadata: { [TURN_AUTHOR_METADATA_KEY]: 'operator', kinuMode: 'build' },
      }]);
    }
  });

  test('cancelling with nothing running is a settled no-op, not a failure', async () => {
    const outcome = await orchestratorHarness().agent.cancelCurrentWork();

    expect(outcome.ok).toBe(true);
    expect(outcome.abortedTools).toBe(0);
  });

  /**
   * The kept difference. The orchestrator owns a turn the composer's Stop button
   * ends, so it settles that turn and files the line the Activity view reads; a
   * subordinate's turn state is driven by the parent that assigned the work, so
   * its Stop settles nothing of its own. Two behaviours, one call, one hook.
   */
  test('only the workspace root settles its own turn state when work is cancelled', async () => {
    const orchestrator = orchestratorHarness();
    const subordinate = subordinateHarness();

    await orchestrator.agent.cancelCurrentWork();
    await subordinate.agent.cancelCurrentWork();

    expect(cancelActivity(orchestrator.db)).toEqual([{ detail: '0 foreground aborted' }]);
    expect(cancelActivity(subordinate.db)).toEqual([]);
  });
});
