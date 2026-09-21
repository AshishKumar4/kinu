import { describe, test, expect } from 'bun:test';
import {
  runSleepTimeCompute, applySleepTimeUpdate,
  SLEEP_TIME_CADENCE,
  sleepTimeDue, sleepTimeWakeAt, sleepTimeWindow,
  type ConversationProjection,
} from '../src/index';
import { createTestFactsStore, createJSONLLM, createScriptedLLM } from '@kinu.run/test-utils';

const ONE_TURN = [{ task: 't', output: 'o', toolCalls: [] }];

describe('sleepTimeDue', () => {
  test('a workspace\'s first turn never runs, whatever else is true', () => {
    expect(sleepTimeDue({ completedTurns: 1, lastRunTurn: null })).toBe(false);
    expect(sleepTimeDue({ completedTurns: 1, lastRunTurn: null, idleMs: SLEEP_TIME_CADENCE.idleMs * 2 })).toBe(false);
    expect(sleepTimeDue({ completedTurns: 1, lastRunTurn: null, lastConnectionClosedMs: SLEEP_TIME_CADENCE.closeGraceMs * 2 })).toBe(false);
    expect(sleepTimeDue({ completedTurns: 0, lastRunTurn: null })).toBe(false);
  });

  test('the turn count: due on the third turn since the last run, not before', () => {
    expect(sleepTimeDue({ completedTurns: 2, lastRunTurn: null })).toBe(false);
    expect(sleepTimeDue({ completedTurns: 3, lastRunTurn: null })).toBe(true);
    // The turn right after a run, and a run that lands exactly on the interval.
    expect(sleepTimeDue({ completedTurns: 4, lastRunTurn: 3 })).toBe(false);
    expect(sleepTimeDue({ completedTurns: 5, lastRunTurn: 3 })).toBe(false);
    expect(sleepTimeDue({ completedTurns: 3 + SLEEP_TIME_CADENCE.everyTurns, lastRunTurn: 3 })).toBe(true);
  });

  test('idle: due after the interval with an unprocessed turn, never over processed ones', () => {
    expect(sleepTimeDue({ completedTurns: 2, lastRunTurn: null, idleMs: SLEEP_TIME_CADENCE.idleMs - 1 })).toBe(false);
    expect(sleepTimeDue({ completedTurns: 2, lastRunTurn: null, idleMs: SLEEP_TIME_CADENCE.idleMs })).toBe(true);
    expect(sleepTimeDue({ completedTurns: 4, lastRunTurn: 3, idleMs: SLEEP_TIME_CADENCE.idleMs })).toBe(true);
    expect(sleepTimeDue({ completedTurns: 3, lastRunTurn: 3, idleMs: SLEEP_TIME_CADENCE.idleMs * 3 })).toBe(false);
  });

  test('tab closed: due after the grace with an unprocessed turn, and a distinct input from idle', () => {
    expect(sleepTimeDue({ completedTurns: 2, lastRunTurn: null, lastConnectionClosedMs: SLEEP_TIME_CADENCE.closeGraceMs - 1 })).toBe(false);
    expect(sleepTimeDue({ completedTurns: 2, lastRunTurn: null, lastConnectionClosedMs: SLEEP_TIME_CADENCE.closeGraceMs })).toBe(true);
    // A minute of idle is not a closed tab.
    expect(sleepTimeDue({ completedTurns: 2, lastRunTurn: null, idleMs: SLEEP_TIME_CADENCE.closeGraceMs })).toBe(false);
    expect(sleepTimeDue({ completedTurns: 3, lastRunTurn: 3, lastConnectionClosedMs: SLEEP_TIME_CADENCE.closeGraceMs * 2 })).toBe(false);
  });
});

describe('sleepTimeWakeAt', () => {
  test('owes nothing without an unprocessed turn, the idle instant with one, and the sooner of the two once closed', () => {
    expect(sleepTimeWakeAt({ settledAt: null, closedAt: 5_000 })).toBeNull();
    expect(sleepTimeWakeAt({ settledAt: 1_000, closedAt: null })).toBe(1_000 + SLEEP_TIME_CADENCE.idleMs);
    expect(sleepTimeWakeAt({ settledAt: 1_000, closedAt: 2_000 })).toBe(2_000 + SLEEP_TIME_CADENCE.closeGraceMs);
    expect(sleepTimeWakeAt({ settledAt: 1_000, closedAt: 1_000 + SLEEP_TIME_CADENCE.idleMs })).toBe(1_000 + SLEEP_TIME_CADENCE.idleMs);
  });
});

describe('sleepTimeWindow', () => {
  const user = (id: string, content: string): ConversationProjection => ({ id, parentId: null, role: 'user', content, toolCalls: [], recordedAt: 0 });
  const answer = (id: string, content: string, toolCalls: string[] = []): ConversationProjection => ({ id, parentId: null, role: 'assistant', content, toolCalls, recordedAt: 0 });
  const never = () => false;

  test('an empty transcript, and one with only an unanswered opening row', () => {
    expect(sleepTimeWindow([], never)).toEqual({
      completedTurns: 0, lastRunTurn: null, newestId: null, turns: [], inputPending: false,
    });
    expect(sleepTimeWindow([user('u1', 'hello')], never)).toEqual({
      completedTurns: 0, lastRunTurn: null, newestId: null, turns: [], inputPending: true,
    });
  });

  test('turns are read oldest first, each answer over its opening row and steers', () => {
    const window = sleepTimeWindow([
      answer('a2', 'second', ['workspace.exec']),
      user('s1', 'also check the tests'), user('u2', 'now deploy'),
      answer('a1', 'first'), user('u1', 'hello'),
    ], never);

    expect(window.completedTurns).toBe(2);
    expect(window.lastRunTurn).toBeNull();
    expect(window.newestId).toBe('a2');
    expect(window.inputPending).toBe(false);
    expect(window.turns).toEqual([
      { task: 'hello', output: 'first', toolCalls: [] },
      { task: 'now deploy\nalso check the tests', output: 'second', toolCalls: ['workspace.exec'] },
    ]);
  });

  test('the walk stops at the newest processed answer, which fixes the last run turn', () => {
    const rows = [
      answer('a5', 'five'), user('u5', '5'),
      answer('a4', 'four'), user('u4', '4'),
      answer('a3', 'three'), user('u3', '3'),
      answer('a2', 'two'), user('u2', '2'),
      answer('a1', 'one'), user('u1', '1'),
    ];

    const window = sleepTimeWindow(rows, (id) => id === 'a3' || id === 'a1');
    expect(window.completedTurns).toBe(5);
    expect(window.lastRunTurn).toBe(3);
    expect(window.turns.map((turn) => turn.output)).toEqual(['four', 'five']);
    // Processed up to the newest answer: nothing to read, and the count says so.
    expect(sleepTimeWindow(rows, (id) => id === 'a5')).toMatchObject({ lastRunTurn: 5, turns: [] });
  });

  test('a run reads at most the interval, the newest turns, and a running turn belongs to none', () => {
    const rows = [
      user('u6', 'still typing'),
      answer('a5', 'five'), user('u5', '5'),
      answer('a4', 'four'), user('u4', '4'),
      answer('a3', 'three'), user('u3', '3'),
      answer('a2', 'two'), user('u2', '2'),
      answer('a1', 'one'), user('u1', '1'),
    ];

    const window = sleepTimeWindow(rows, never);
    expect(window.inputPending).toBe(true);
    expect(window.newestId).toBe('a5');
    expect(window.turns.map((turn) => turn.output)).toEqual(['three', 'four', 'five']);
  });
});

describe('Sleep-time compute', () => {
  test('parses valid LLM response', async () => {
    const judge = createJSONLLM({
      upserts: [{ key: 'user.tz', value: 'America/Los_Angeles', confidence: 0.9, rationale: 'mentioned in turn' }],
      decay: ['stale.fact'],
    });

    const update = await runSleepTimeCompute(judge, {
      turns: [{ task: 'configure deploy', output: '...', toolCalls: ['workspace.exec'] }],
      currentFacts: [],
    });

    expect(update).not.toBeNull();
    expect(update!.upserts.length).toBe(1);
    expect(update!.decay).toEqual(['stale.fact']);
  });

  test('the prompt carries every turn of the window, oldest first, with its tools', async () => {
    const judge = createScriptedLLM(['{"upserts":[],"decay":[]}']);

    await runSleepTimeCompute(judge, {
      turns: [
        { task: 'first ask', output: 'first answer', toolCalls: [] },
        { task: 'second ask', output: 'second answer', toolCalls: ['workspace.exec', 'memory.save'] },
      ],
      currentFacts: [],
    });

    const prompt = judge.prompts[0]!;
    expect(prompt.indexOf('first ask')).toBeLessThan(prompt.indexOf('second ask'));
    expect(prompt).toContain('second answer');
    expect(prompt).toContain('workspace.exec, memory.save');
  });

  test('prompt explicitly lists existing keys for exact reuse', async () => {
    const judge = createScriptedLLM(['{"upserts":[],"decay":[]}']);

    const currentFacts = Array.from({ length: 31 }, (_, index) => ({
      key: `existing.key_${index}`,
      value: index,
      confidence: 1,
    }));

    await runSleepTimeCompute(judge, { turns: ONE_TURN, currentFacts });

    expect(judge.prompts[0]).toContain('Existing fact keys (reuse these exact keys');
    expect(judge.prompts[0]).toContain('existing.key_0');
    expect(judge.prompts[0]).toContain('existing.key_30');
  });

  test('returns null on unparseable response', async () => {
    const judge = createScriptedLLM(['No JSON here']);

    const update = await runSleepTimeCompute(judge, { turns: ONE_TURN, currentFacts: [] });

    expect(update).toBeNull();
  });

  test('applySleepTimeUpdate upserts facts + decays existing', () => {
    const { facts } = createTestFactsStore();
    facts.upsert('keep.this', 'value', { confidence: 1.0 });
    facts.upsert('decay.this', 'old', { confidence: 1.0 });

    const summary = applySleepTimeUpdate(facts, {
      upserts: [{ key: 'new.fact', value: 42, confidence: 0.9, rationale: '' }],
      decay: ['decay.this'],
    });

    expect(summary.upserted).toBe(1);
    expect(summary.decayed).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(facts.recall('decay.this')!.confidence).toBeLessThan(1.0);
  });

  test('rejects an update with a missing fact value before any write', async () => {
    const { facts } = createTestFactsStore();

    const judge = createScriptedLLM([
      '{"upserts":[{"key":"ok.1","value":"fine","confidence":1,"rationale":""},{"key":"bad","confidence":1,"rationale":""}],"decay":[]}',
    ]);

    const update = await runSleepTimeCompute(judge, { turns: ONE_TURN, currentFacts: [] });

    expect(update).toBeNull();
    expect(facts.recall('ok.1')).toBeNull();
    expect(facts.recall('bad')).toBeNull();
  });

  test('canonicalizes upsert keys before writing', () => {
    const { facts } = createTestFactsStore();

    const summary = applySleepTimeUpdate(facts, {
      upserts: [{
        key: '  Sandbox.NPM   Version  ', value: 'npm v10', confidence: 0.9, rationale: '',
      }],
      decay: [],
    });

    expect(summary.upserted).toBe(1);
    expect(facts.recall('sandbox.npm_version')?.value).toBe('npm v10');
    expect(facts.recall('  Sandbox.NPM   Version  ')?.value).toBe('npm v10');
  });

  test('same-value re-observation is not counted as an upsert or refreshed', () => {
    const { facts, testSql } = createTestFactsStore();
    facts.upsert('sandbox.npm_version', 'npm v10');
    void testSql.sql`UPDATE agent_facts SET last_observed_at = 1000
                WHERE key = 'sandbox.npm_version'`;

    const summary = applySleepTimeUpdate(facts, {
      upserts: [{ key: 'Sandbox.NPM_Version', value: 'npm v10', confidence: 0.95, rationale: '' }],
      decay: [],
    });

    expect(summary.upserted).toBe(0);
    expect(facts.recall('sandbox.npm_version')?.lastObservedAt).toBe(1000);
    expect(facts.recall('sandbox.npm_version')?.confidence).toBe(0.95);
  });

  test('changed value is counted and refreshes the fact', () => {
    const { facts, testSql } = createTestFactsStore();
    facts.upsert('sandbox.npm_version', 'npm v9');
    void testSql.sql`UPDATE agent_facts SET last_observed_at = 1000
                WHERE key = 'sandbox.npm_version'`;

    const summary = applySleepTimeUpdate(facts, {
      upserts: [{ key: 'sandbox.npm_version', value: 'npm v10', confidence: 0.9, rationale: '' }],
      decay: [],
    });

    expect(summary.upserted).toBe(1);
    expect(facts.recall('sandbox.npm_version')?.value).toBe('npm v10');
    expect(facts.recall('sandbox.npm_version')?.lastObservedAt).toBeGreaterThan(1000);
  });

  test('rejects an update with out-of-range confidence before any write', async () => {
    const { facts } = createTestFactsStore();

    const judge = createScriptedLLM([
      '{"upserts":[{"key":"ok.1","value":"fine","confidence":99,"rationale":""}],"decay":[]}',
    ]);

    const update = await runSleepTimeCompute(judge, { turns: ONE_TURN, currentFacts: [] });

    expect(update).toBeNull();
    expect(facts.recall('ok.1')).toBeNull();
  });
});
