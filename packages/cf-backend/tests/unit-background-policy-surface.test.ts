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

type RunnerView = {
  _turnContinuity: 'conversation' | 'independent_task';
  jobRunner: { policy: { detachAfterMs: number; settleGraceMs: number } };
};

describe('cf background policy follows the turn surface', () => {
  test('a conversational turn detaches on the interactive policy', () => {
    const agent = orchestratorHarness().agent as unknown as RunnerView;
    agent._turnContinuity = 'conversation';
    expect(agent.jobRunner.policy).toEqual(BACKGROUND_POLICY.interactive);
  });

  test('a one-shot turn detaches on the one-shot policy — same runner, per turn', () => {
    const agent = orchestratorHarness().agent as unknown as RunnerView;
    agent._turnContinuity = 'independent_task';
    expect(agent.jobRunner.policy).toEqual(BACKGROUND_POLICY['one-shot']);
    // The runner is cached; the policy must still follow the NEXT turn.
    agent._turnContinuity = 'conversation';
    expect(agent.jobRunner.policy).toEqual(BACKGROUND_POLICY.interactive);
  });
});
