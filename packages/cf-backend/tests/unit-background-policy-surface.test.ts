// The background policy follows the turn's surface on cf.
//
// The defect this locks: the CLI adopted the surface split (interactive
// detaches at 30s, one-shot at 300s) while the cf runner silently took the
// interactive default for every turn — even though beforeTurn already
// classified the arriving turn via body.oneShot. cf knows the surface; the
// runner must read it.
import { describe, test, expect } from 'bun:test';
import { BACKGROUND_POLICY } from '@proteus/core';
import { orchestratorHarness } from './helpers/actor-harness.js';
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

  test('a one-shot turn detaches on the one-shot policy — same runner, per turn', () => {
    const agent = orchestratorHarness().agent;
    setTurnContinuity(agent, 'independent_task');
    expect(runnerPolicy(agent)).toEqual(BACKGROUND_POLICY['one-shot']);
    // The runner is cached; the policy must still follow the NEXT turn.
    setTurnContinuity(agent, 'conversation');
    expect(runnerPolicy(agent)).toEqual(BACKGROUND_POLICY.interactive);
  });
});
