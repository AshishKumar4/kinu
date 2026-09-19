/**
 * When the sleep-time compute runs, and what it reads when it does.
 *
 * The lane used to run after EVERY completed turn over that one turn, so a
 * fresh workspace's "hello" paid a model call to record an empty workspace.
 * Now one core rule decides three triggers — the third completed turn since
 * the last run, ten idle minutes, a closed tab — and every run reads the
 * turns since the last run. The oracle throughout is the scripted fast model:
 * how many prompts it was asked, and what each carried.
 *
 * The timed triggers ride the workspace's one durable wake, so they are driven
 * the way the platform drives them: the settled instant is stored, the clock
 * moves, `_kinuTimerTick` fires.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { Connection } from 'agents';
import { SLEEP_TIME_CADENCE } from '@kinu.run/core';
import {
  chatSessionTurns, orchestratorHarness,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';

const EMPTY = { upserts: [], decay: [] };

const ONE_FACT = { upserts: [{ key: 'user.editor', value: 'helix', confidence: 0.9, rationale: 'said so' }], decay: [] };

/** Settle one turn under its own names and join the detached lane it owes. */
async function settle(harness: ActorHarness<HarnessOrchestratorAgent>, n: number): Promise<void> {
  await chatSessionTurns(harness.agent).settle({ turnId: `ask-${n}`, messageId: `answer-${n}` });
  await joinHarnessFibers();
}

/** What the world model holds, off the durable table the compute writes and
 *  the "Learned N things" card reads. */
function facts(harness: ActorHarness<HarnessOrchestratorAgent>): { key: string; value: string }[] {
  return harness.db.prepare<{ key: string; value: string }, []>(
    'SELECT key, value_json AS value FROM agent_facts ORDER BY key',
  ).all();
}

/** A tab's socket, as the actor's own hooks see one: an id and no actor tag. */
function tab(id: string): Connection {
  const partial: Partial<Connection> = {};
  Object.assign(partial, { id, tags: [], send: () => {}, close: () => {} });

  // SAFETY: every member the connect and close hooks touch is constructed
  // above — the platform contract for a hibernated connection carries its tags
  // and its wire and nothing else, so the checked members above exhaust what
  // the code under test can reach.
  return partial as Connection;
}

afterEach(() => { setSystemTime(); });

describe('the turn-count trigger', () => {
  test('a fresh workspace\'s first turn runs no model call, the third runs one over all three', async () => {
    const harness = orchestratorHarness(undefined, undefined, undefined, { sleepTimeModel: ONE_FACT });
    const prompts = harness.sleepTimePrompts;

    await settle(harness, 1);
    expect(prompts).toHaveLength(0);
    // And nothing was learned: the store the "Learned N things" card reads is empty.
    expect(facts(harness)).toEqual([]);

    await settle(harness, 2);
    expect(prompts).toHaveLength(0);

    await settle(harness, 3);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;

    for (const turn of ['ask-1', 'ask-2', 'ask-3']) expect(prompt).toContain(turn);
    expect(prompt.indexOf('ask-1')).toBeLessThan(prompt.indexOf('ask-3'));
    expect(facts(harness)).toEqual([{ key: 'user.editor', value: '"helix"' }]);

    // The fourth turn is one turn past a run: nothing.
    await settle(harness, 4);
    expect(prompts).toHaveLength(1);
  });

  test('the next run reads only the turns since the last one', async () => {
    const harness = orchestratorHarness(undefined, undefined, undefined, { sleepTimeModel: EMPTY });
    const prompts = harness.sleepTimePrompts;

    for (let n = 1; n <= 6; n++) await settle(harness, n);
    expect(prompts).toHaveLength(2);
    const second = prompts[1]!;

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

    // A second wake over the same turns has nothing unprocessed.
    await harness.agent._kinuTimerTick();
    expect(prompts).toHaveLength(1);

    // And the turn-count trigger does not run over turns the wake read: two
    // more turns are two since the last run, not four.
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
