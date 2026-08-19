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
   * `'idle'` is the whole point of the return value: it means the turn ended
   * before the steer arrived and NOTHING was buffered, so the caller has to send
   * the text as an ordinary message instead. A subordinate chat is a chat, so it
   * answers the same way.
   */
  test('steering with no turn running reports idle rather than swallowing the text', async () => {
    expect(await orchestratorHarness().agent.steerTurn('use the other parser')).toEqual({ landed: 'idle' });
    expect(await subordinateHarness().agent.steerTurn('use the other parser')).toEqual({ landed: 'idle' });
  });

  test('cancelling with nothing running is a settled no-op, not a failure', async () => {
    const outcome = await orchestratorHarness().agent.cancelCurrentWork();

    expect(outcome.ok).toBe(true);
    expect(outcome.cancelledJobs).toEqual([]);
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

    expect(cancelActivity(orchestrator.db)).toEqual([{ detail: '0 foreground, 0 background' }]);
    expect(cancelActivity(subordinate.db)).toEqual([]);
  });
});
