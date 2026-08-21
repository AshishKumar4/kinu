/**
 * The composer's line about a steer the server is holding.
 *
 * The report (#210): "the 'Queued' thing also doesn't go away". It was written
 * into component state by the keypress and cleared by nothing, so a composer
 * promised to deliver words the model had already read and answered — under a
 * thread that was, in the same screenshot, labelling that steer "steered
 * mid-turn". The two rows contradicted each other.
 *
 * The line is a fact about `steerRuns`, so it is read from `steerRuns`.
 */
import { describe, expect, test } from 'bun:test';
import { queuedSteerNotice } from '../src/hooks/use-steer-actions';
import type { InlineSteer } from '@kinu.run/core';

const queued = (id: string): InlineSteer =>
  ({ id, text: 'use the swarm for this', state: 'queued', atStep: null });
const landed = (id: string, atStep = 3): InlineSteer =>
  ({ id, text: 'use the swarm for this', state: 'landed', atStep });

describe('the queued line', () => {
  test('there is nothing to say when no steer is waiting', () => {
    expect(queuedSteerNotice([], false)).toBeNull();
  });

  test('a waiting steer says it lands at the next step', () => {
    expect(queuedSteerNotice([queued('s1')], false)).toEqual({
      id: 'steer', tone: 'progress',
      text: "Queued — it lands at the agent's next step.",
    });
  });

  test('the line is GONE once the model has it', () => {
    // The defect, stated as the property that closes it: the same steer, one
    // broadcast later, and the composer has nothing left to promise.
    expect(queuedSteerNotice([landed('s1')], false)).toBeNull();
  });

  test('one steer still waiting keeps the line while an earlier one has landed', () => {
    expect(queuedSteerNotice([landed('s1'), queued('s2')], false)?.tone).toBe('progress');
  });

  test('a draft carrying attachments says what a steer cannot take with it', () => {
    expect(queuedSteerNotice([queued('s1')], true)?.text)
      .toContain('a steer carries text only');
  });
});
