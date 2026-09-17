// The background policy follows the turn's surface for the FOREGROUND half and
// this host's durability for the WAKE half.
//
// The defect this locks: the CLI adopted the surface split (interactive
// detaches at 30s, one-shot at 300s) while the cf runner silently took the
// interactive default for every turn — even though beforeTurn already
// classified the arriving turn via body.oneShot. cf knows the surface; the
// runner must read it. And the wake half never follows the surface here: a
// Durable Object outlives every turn — its alarms deliver wakes with nobody
// connected, which is the whole fiber-recovery design — so even an unwatched
// turn may detach spawn-shaped work into a wake that will arrive. Keying both
// halves off the surface alone gave cloud programmatic turns
// `wakesAfterTurn: false` on the very turn that proved a wake had arrived.
import { BACKGROUND_POLICY, invocationBackgroundPolicy } from '@kinu.run/core';
import { describe, test, expect } from 'bun:test';

import { chatSessionTurns, orchestratorHarness } from './helpers/actor-harness';
import * as v from 'valibot';

type RunnerView = {
  _turnContinuity: 'conversation' | 'independent_task';
  jobRunner: {
    policy: { detachAfterMs: number; settleGraceMs: number; wakesAfterTurn: boolean };
  };
};

const RunnerViewSchema = v.object({
  policy: v.object({
    detachAfterMs: v.number(),
    settleGraceMs: v.number(),
    wakesAfterTurn: v.boolean(),
  }),
});

type HarnessAgent = ReturnType<typeof orchestratorHarness>['agent'];

function setTurnContinuity(agent: HarnessAgent, continuity: RunnerView['_turnContinuity']): void {
  if (!Reflect.set(agent, '_turnContinuity', continuity)) throw new Error('failed to set turn continuity');
}

function runnerPolicy(agent: HarnessAgent): RunnerView['jobRunner']['policy'] {
  let prototype = Object.getPrototypeOf(agent);

  while (prototype) {
    const getter = Object.getOwnPropertyDescriptor(prototype, 'jobRunner')?.get;

    if (getter) return v.parse(RunnerViewSchema, getter.call(agent)).policy;
    prototype = Object.getPrototypeOf(prototype);
  }

  throw new Error('Agent jobRunner getter is missing');
}

describe('cf background policy follows the turn surface', () => {
  test('a conversational turn detaches on the interactive policy', () => {
    const agent = orchestratorHarness().agent;
    setTurnContinuity(agent, 'conversation');
    expect(runnerPolicy(agent)).toEqual(BACKGROUND_POLICY.interactive);
  });

  test('a one-shot turn a human steered mid-turn is interactive from that step on', async () => {
    // The first-run background-settle row on build cba44dcb9: the ask landed
    // as a steer inside the genesis turn, a turn nobody was watching, so the
    // run tool kept the one-shot detach window (300 s) and a 45 s sleep ran
    // inline — the wake half never engaged. Someone typed the steer, so
    // someone is watching the stream from that step on.
    const { agent } = orchestratorHarness();
    await agent.activateActor();
    const turns = chatSessionTurns(agent);
    const request = await turns.prepare({ messages: [{ role: 'user', content: 'an unwatched turn' }] });
    setTurnContinuity(agent, 'independent_task');
    expect(runnerPolicy(agent)).toEqual(invocationBackgroundPolicy('one-shot', true));

    expect(await agent.send('a human typed this while it ran')).toEqual({ landed: 'mid-turn' });
    await turns.step(0, [{ role: 'user', content: 'an unwatched turn' }]);
    expect(runnerPolicy(agent)).toEqual(BACKGROUND_POLICY.interactive);

    await turns.settle({ messageId: request.identity.messageId, text: 'done' });
  });

  test('a one-shot turn takes the one-shot thresholds with wakes enabled — same runner, per turn', () => {
    const agent = orchestratorHarness().agent;
    setTurnContinuity(agent, 'independent_task');
    // The DO is durable: `kinu exec`'s no-wake answer does not transfer here,
    // only its foreground thresholds do.
    expect(runnerPolicy(agent)).toEqual(invocationBackgroundPolicy('one-shot', true));
    // The runner is cached; the policy must still follow the NEXT turn.
    setTurnContinuity(agent, 'conversation');
    expect(runnerPolicy(agent)).toEqual(BACKGROUND_POLICY.interactive);
  });
});
