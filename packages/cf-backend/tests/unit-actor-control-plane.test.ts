/**
 * The control plane the workspace root exposes, plus the per-actor stores a
 * hosted child keeps for itself.
 *
 * These four RPCs — getStoredModelSpec, setModel, send, cancelCurrentWork —
 * are declared ONCE, on the one Durable Object: a hosted subordinate has no
 * Think turn queue to steer or stop. What is per actor is the durable state the
 * surface reads — the model row, the turn queue rows, and the activity rows —
 * so this suite keeps the root's behaviour and then proves the child's rows are
 * its own.
 *
 * Behaviour through the public classes, not source text: the source-level ratchet
 * that stops a second copy of the surface appearing lives in
 * unit-rpc-surface.test.ts, where the declared-member machinery already is.
 */

import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { TURN_AUTHOR_METADATA_KEY } from '@kinu.run/core';
import { hostedSubordinateHarness, orchestratorHarness, thinkTurns } from './helpers/actor-harness';
import type { Database } from 'bun:sqlite';

/** Activity rows for one actor. Scoped by handle: an unscoped read would let a
 * sibling's cancellation satisfy — or pollute — this actor's assertion. */
function cancelActivity(db: Database, actorId: string): unknown[] {
  return db.prepare("SELECT detail FROM activity_log WHERE event = 'work_cancelled' AND actor_id = ?").all(actorId);
}

describe('the workspace root answers the actor control plane', () => {
  test('a stored model spec round-trips on the workspace root', async () => {
    const { agent } = orchestratorHarness();

    expect(await agent.getStoredModelSpec()).toEqual({ spec: null });
    await agent.setModel('anthropic/claude-sonnet-4-5');

    expect(await agent.getStoredModelSpec()).toEqual({ spec: 'anthropic/claude-sonnet-4-5' });
  });

  test('a hosted child keeps its own model row in the same database', async () => {
    const workspace = orchestratorHarness();

    const child = await hostedSubordinateHarness(workspace, {
      name: 'control-plane-child',
      displayName: 'Control Plane Child',
      nameOrigin: 'user',
      mission: 'hold one model row',
    });

    expect(child.actor.stores.config.getModel()).toBeNull();
    child.actor.stores.config.setModel('anthropic/claude-sonnet-4-5');

    expect(child.actor.stores.config.getModel()).toBe('anthropic/claude-sonnet-4-5');
    expect(await workspace.agent.getStoredModelSpec()).toEqual({ spec: null });
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
    const { agent } = orchestratorHarness();
    const turns = thinkTurns(agent);
    const next = turns.park();

    // The send is the turn: the loop admits it as the operator's own next
    // turn, under the operator's stamp and the mode it was typed in, and the
    // caller hears it landed as one once it has.
    const landing = agent.send('use the other parser');
    await next;
    await turns.settle({ messageId: 'a-parser', text: 'ok' });
    expect(await landing).toEqual({ landed: 'turn' });

    const opened = agent.harnessTranscript.history().find((message) => message.role === 'user');
    expect(opened?.parts).toEqual([{ type: 'text', text: 'use the other parser' }]);
    expect(v.parse(v.looseObject({ metadata: v.optional(v.unknown()) }), opened).metadata)
      .toEqual({ [TURN_AUTHOR_METADATA_KEY]: 'operator', kinuMode: 'build' });
  });

  test('cancelling with nothing running is a settled no-op, not a failure', async () => {
    const outcome = await orchestratorHarness().agent.cancelCurrentWork();

    expect(outcome.ok).toBe(true);
    expect(outcome.abortedTools).toBe(0);
  });

  /**
   * The kept difference. The orchestrator owns the composer's Stop path, so it
   * settles that path and files the line the Activity view reads under its own
   * actor id. A hosted child interrupts only its own ActorSession: with no live
   * turn there is nothing to drop and, crucially, nothing for it to file on
   * the root's behalf.
   */
  test('only the workspace root files its own cancellation, under its own actor id', async () => {
    const orchestrator = orchestratorHarness();

    const child = await hostedSubordinateHarness(orchestrator, {
      name: 'cancel-scope-child',
      displayName: 'Cancel Scope Child',
      nameOrigin: 'user',
      mission: 'prove one cancellation row',
    });

    await orchestrator.agent.cancelCurrentWork();
    expect(child.actor.session.interrupt()).toEqual([]);

    const rootId = orchestrator.agent.observeRuntime().actor.actorId;
    expect(cancelActivity(orchestrator.db, rootId)).toEqual([{ detail: '0 foreground aborted' }]);
    expect(cancelActivity(orchestrator.db, child.actor.handle.actorId)).toEqual([]);
  });
});
