// The foreground half of the background policy follows the turn surface (body.oneShot); the wake half
// follows host durability: a Durable Object delivers wakes with nobody connected, so any turn may detach.
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
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'jobRunner');

    if (descriptor?.get) return v.parse(RunnerViewSchema, descriptor.get.call(agent)).policy;
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
    // A steer inside the genesis turn means someone is watching the stream from that step on.
    const { agent } = orchestratorHarness();
    await agent.activateActor();
    const turns = chatSessionTurns(agent);
    const request = await turns.prepare({ messages: [{ role: 'user', content: 'an unwatched turn' }] });
    setTurnContinuity(agent, 'independent_task');
    expect(runnerPolicy(agent)).toEqual(invocationBackgroundPolicy('one-shot', true));

    await agent.send('a human typed this while it ran', 'steer-human');
    await turns.step(0, [{ role: 'user', content: 'an unwatched turn' }]);
    expect(runnerPolicy(agent)).toEqual(BACKGROUND_POLICY.interactive);

    await turns.settle({ messageId: request.identity.messageId, text: 'done' });
  });

  test('a one-shot turn takes the one-shot thresholds with wakes enabled — same runner, per turn', () => {
    const agent = orchestratorHarness().agent;
    setTurnContinuity(agent, 'independent_task');
    // The DO is durable: `kinu exec`'s no-wake answer does not transfer, only its foreground thresholds.
    expect(runnerPolicy(agent)).toEqual(invocationBackgroundPolicy('one-shot', true));
    setTurnContinuity(agent, 'conversation');
    expect(runnerPolicy(agent)).toEqual(BACKGROUND_POLICY.interactive);
  });
});
