/**
 * Sleep-time compute cadence: third turn since the last run, idle interval, or
 * closed tab; each run reads the turns since the last. Timed triggers fire via `_kinuTimerTick`.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { Connection } from 'agents';
import { SLEEP_TIME_CADENCE } from '@kinu.run/core';
import {
  chatSessionTurns, orchestratorHarness,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { socketConnection } from './helpers/bindings';

const EMPTY = { upserts: [], decay: [] };

const ONE_FACT = { upserts: [{ key: 'user.editor', value: 'helix', confidence: 0.9, rationale: 'said so' }], decay: [] };

/** Settle one turn under its own names and join the detached lane it owes. */
async function settle(harness: ActorHarness<HarnessOrchestratorAgent>, n: number): Promise<void> {
  await chatSessionTurns(harness.agent).settle({ turnId: `ask-${n}`, messageId: `answer-${n}` });
  await joinHarnessFibers();
}

/** The world model, off the durable table the "Learned N things" card reads. */
function facts(harness: ActorHarness<HarnessOrchestratorAgent>): { key: string; value: string }[] {
  return harness.db.prepare<{ key: string; value: string }, []>(
    'SELECT key, value_json AS value FROM agent_facts ORDER BY key',
  ).all();
}

/** A tab's socket: an id, no actor tag, a wire that swallows frames; other members refuse. */
function tab(id: string): Connection {
  return socketConnection({ id, send: () => {} });
}

afterEach(() => { setSystemTime(); });

describe('the turn-count trigger', () => {
  test('a fresh workspace\'s first turn runs no model call, the third runs one over all three', async () => {
    const harness = orchestratorHarness(undefined, undefined, undefined, { sleepTimeModel: ONE_FACT });
    const prompts = harness.sleepTimePrompts;

    await settle(harness, 1);
    expect(prompts).toHaveLength(0);
    expect(facts(harness)).toEqual([]);

    await settle(harness, 2);
    expect(prompts).toHaveLength(0);

    await settle(harness, 3);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];

    for (const turn of ['ask-1', 'ask-2', 'ask-3']) expect(prompt).toContain(turn);
    expect(prompt.indexOf('ask-1')).toBeLessThan(prompt.indexOf('ask-3'));
    expect(facts(harness)).toEqual([{ key: 'user.editor', value: '"helix"' }]);

    await settle(harness, 4);
    expect(prompts).toHaveLength(1);
  });

  test('the next run reads only the turns since the last one', async () => {
    const harness = orchestratorHarness(undefined, undefined, undefined, { sleepTimeModel: EMPTY });
    const prompts = harness.sleepTimePrompts;

    for (let n = 1; n <= 6; n++) await settle(harness, n);
    expect(prompts).toHaveLength(2);
    const second = prompts[1];

    for (const turn of ['ask-4', 'ask-5', 'ask-6']) expect(second).toContain(turn);

    for (const turn of ['ask-1', 'ask-2', 'ask-3']) expect(second).not.toContain(turn);
  });
});

describe('the idle trigger', () => {
  test('a turn left alone for the idle interval is read on the wake, and only once', async () => {
    const harness = orchestratorHarness(undefined, undefined, undefined, { sleepTimeModel: EMPTY });
    const prompts = harness.sleepTimePrompts;
    await settle(harness, 1);
    await settle(harness, 2);
    expect(prompts).toHaveLength(0);

    // Short of the interval: the wake finds nothing due.
    setSystemTime(new Date(Date.now() + SLEEP_TIME_CADENCE.idleMs - 1_000));
    await harness.agent._kinuTimerTick();
    expect(prompts).toHaveLength(0);

    setSystemTime(new Date(Date.now() + 2_000));
    await harness.agent._kinuTimerTick();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('ask-1');
    expect(prompts[0]).toContain('ask-2');

    await harness.agent._kinuTimerTick();
    expect(prompts).toHaveLength(1);

    // Turns the wake read do not count toward the next turn-count trigger.
    await settle(harness, 3);
    await settle(harness, 4);
    expect(prompts).toHaveLength(1);
  });

  test('a first turn never arms the idle wake', async () => {
    const harness = orchestratorHarness(undefined, undefined, undefined, { sleepTimeModel: EMPTY });
    const prompts = harness.sleepTimePrompts;
    await settle(harness, 1);

    setSystemTime(new Date(Date.now() + SLEEP_TIME_CADENCE.idleMs * 2));
    await harness.agent._kinuTimerTick();
    expect(prompts).toHaveLength(0);
  });
});

describe('the closed-tab trigger', () => {
  test('the last tab closing runs the pending turns after the grace', async () => {
    const harness = orchestratorHarness(undefined, undefined, undefined, { sleepTimeModel: EMPTY });
    const prompts = harness.sleepTimePrompts;
    await settle(harness, 1);
    await settle(harness, 2);

    await harness.agent.onClose(tab('t1'), 1000, 'gone', true);
    setSystemTime(new Date(Date.now() + SLEEP_TIME_CADENCE.closeGraceMs - 1_000));
    await harness.agent._kinuTimerTick();
    expect(prompts).toHaveLength(0);

    setSystemTime(new Date(Date.now() + 2_000));
    await harness.agent._kinuTimerTick();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('ask-2');
  });

  test('a reconnect inside the grace runs nothing', async () => {
    const harness = orchestratorHarness(undefined, undefined, undefined, { sleepTimeModel: EMPTY });
    const prompts = harness.sleepTimePrompts;
    await settle(harness, 1);
    await settle(harness, 2);

    await harness.agent.onClose(tab('t1'), 1000, 'gone', true);
    setSystemTime(new Date(Date.now() + 5_000));
    await harness.agent.onConnect(tab('t2'), { request: new Request('https://agent/connect') });

    setSystemTime(new Date(Date.now() + SLEEP_TIME_CADENCE.closeGraceMs));
    await harness.agent._kinuTimerTick();
    expect(prompts).toHaveLength(0);
  });

  test('a tab closing with nothing unprocessed arms nothing', async () => {
    const harness = orchestratorHarness(undefined, undefined, undefined, { sleepTimeModel: EMPTY });
    const prompts = harness.sleepTimePrompts;
    await settle(harness, 1);

    await harness.agent.onClose(tab('t1'), 1000, 'gone', true);
    setSystemTime(new Date(Date.now() + SLEEP_TIME_CADENCE.closeGraceMs * 2));
    await harness.agent._kinuTimerTick();
    expect(prompts).toHaveLength(0);
  });
});
