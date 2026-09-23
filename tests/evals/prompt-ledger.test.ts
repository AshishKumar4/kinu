/**
 * The relay subgoal of `public-delegation-across-turns` (trajectory.eval.ts):
 * the second turn must repeat what the helper hired in the first one said.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { RunEventSchema } from '../../packages/core/src/index';
import { hireAnswer, isToolCallEnd, relaysAnswer } from './prompt-ledger';

/** The hire the deployed build settled on 2026-09-23 (2036733d0,
 *  trajectory-product-1790180914313): its helper answered "Three.". */
const RECORDED_HIRE = v.parse(RunEventSchema, {
  eventIndex: 29,
  runId: 'run-5d065577-0d08-4af2-a955-d3c60a676b2c',
  timestamp: '2026-09-23T16:40:37.437Z',
  type: 'tool_call_end',
  name: 'agents',
  toolCallId: 'call_55d86abab59b441fadc1bf3c',
  args: {
    action: 'hire', lifetime: 'task', role: 'task',
    mission: 'Research exactly one fact: the number of relays the BLUEBIRD protocol requires before failover is three. '
      + 'Reply with exactly that number as one word and nothing else.',
  },
  result: {
    status: 'completed', agent: 'ask-task-apuura', lifetime: 'task', role: 'task',
    answer: 'Three.', transcript: 'kept', elapsed_ms: 334219,
  },
  durationMs: 334219,
  outcome: { success: true },
});

const said = isToolCallEnd(RECORDED_HIRE) ? hireAnswer(RECORDED_HIRE) : null;

describe('a lead relays what its helper said', () => {
  test('the recorded run: the helper said "Three." and the lead relayed it word for word', () => {
    expect(said).toBe('Three.');
    expect(relaysAnswer('RELAYED Three.', said, 'three')).toBe(true);
  });

  test('an answer no helper gave is not a relay, even when it states the fact', () => {
    // The lead wrote the fact into its helper's mission, so it can state it unaided.
    expect(relaysAnswer('RELAYED three', null, 'three')).toBe(false);
  });

  test('a relay of words the helper never said fails', () => {
    expect(relaysAnswer('RELAYED four', said, 'three')).toBe(false);
  });

  test('a faithful relay of a wrong answer fails', () => {
    expect(relaysAnswer('RELAYED four', 'four', 'three')).toBe(false);
  });
});
