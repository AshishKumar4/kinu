import * as v from 'valibot';
import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { createRoutedModelLane, routedLlm } from '../src/profiles/model-lane';
import { profileCatalogDigest, resolveTurnProfile } from '../src/profiles';
import {
  runSleepTimeCompute, applySleepTimeUpdate,
  SLEEP_TIME_CADENCE,
  initEffectTombstoneTable, initFactsTable, initSleepTimeTables, SleepTimeLane,
  sleepTimeDue, sleepTimeWakeAt, sleepTimeWindow,
  type ConversationProjection,
} from '../src/index';
import { createTestFactsStore, createJSONLLM, createScriptedLLM, createTestRuntime, present } from '@kinu.run/test-utils';
import { KinuError } from '../src/obs';
import type { SleepTimeTurn } from '../src/memory/sleep-time-compute';

/** A rejection's shape, as a pass's failure carries it. */
const FailureSchema = v.object({ code: v.string() });

const ONE_TURN = [{ task: 't', output: 'o', ownerWords: 't' }];

describe('sleepTimeDue', () => {
  test('a workspace\'s first turn never runs, whatever else is true', () => {
    expect(sleepTimeDue({ completedTurns: 1, lastRunTurn: null })).toBe(false);
    expect(sleepTimeDue({ completedTurns: 1, lastRunTurn: null, idleMs: SLEEP_TIME_CADENCE.idleMs * 2 })).toBe(false);
    expect(sleepTimeDue({ completedTurns: 1, lastRunTurn: null, lastConnectionClosedMs: SLEEP_TIME_CADENCE.closeGraceMs * 2 })).toBe(false);
    expect(sleepTimeDue({ completedTurns: 0, lastRunTurn: null })).toBe(false);
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
  const user = (id: string, content: string): ConversationProjection => ({ id, position: 0, role: 'user', turnId: null, runId: null, content, toolCalls: [], recordedAt: 0 });
  const answer = (id: string, content: string, toolCalls: string[] = []): ConversationProjection => ({ id, position: 0, role: 'assistant', turnId: null, runId: null, content, toolCalls, recordedAt: 0 });
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
      { task: 'hello', output: 'first', ownerWords: 'hello' },
      { task: 'now deploy\nalso check the tests', output: 'second', ownerWords: 'now deploy\nalso check the tests' },
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
    expect(sleepTimeWindow(rows, (id) => id === 'a5')).toMatchObject({ lastRunTurn: 5, newestId: null, turns: [] });
  });

  test('a run reads at most the interval, the oldest unprocessed turns, and a running turn belongs to none', () => {
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
    expect(window.newestId).toBe('a3');
    expect(window.turns.map((turn) => turn.output)).toEqual(['one', 'two', 'three']);
    expect(window.turns.map((turn) => turn.task)).toEqual(['1', '2', '3']);
  });

  test('successive backlog windows advance only through the messages each pass includes', () => {
    const chronological = Array.from({ length: 8 }, (_, index) => index + 1);

    const rows = [...chronological].reverse().flatMap((turn) => [
      answer(`a${String(turn)}`, `answer ${String(turn)}`),
      user(`u${String(turn)}`, `ask ${String(turn)}`),
    ]);

    const processed = new Set<string>();
    const seen: SleepTimeTurn[] = [];
    const turnOf = (turn: number): SleepTimeTurn => ({ task: `ask ${String(turn)}`, output: `answer ${String(turn)}`, ownerWords: `ask ${String(turn)}` });

    for (const [index, batch] of [[1, 2, 3], [4, 5, 6], [7, 8]].entries()) {
      const window = sleepTimeWindow(rows, (id) => processed.has(id));

      expect(window.completedTurns).toBe(8);
      expect(window.lastRunTurn).toBe(index === 0 ? null : index * 3);
      expect(window.newestId).toBe(`a${String(batch.at(-1))}`);
      expect(window.turns).toEqual(batch.map(turnOf));
      seen.push(...window.turns);
      processed.add(present(window.newestId, 'the included batch marker'));
    }

    expect(seen).toEqual(chronological.map(turnOf));
    const done = sleepTimeWindow(rows, (id) => processed.has(id));
    expect(done).toEqual({ completedTurns: 8, lastRunTurn: 8, newestId: null, turns: [], inputPending: false });
    expect(sleepTimeDue({ ...done, idleMs: SLEEP_TIME_CADENCE.idleMs })).toBe(false);
  });
});

describe('Sleep-time compute', () => {
  test('parses valid LLM response', async () => {
    const judge = createJSONLLM({
      upserts: [{ key: 'user.tz', value: 'America/Los_Angeles', confidence: 0.9, rationale: 'mentioned in turn' }],
      decay: ['stale.fact'],
    });

    const update = await runSleepTimeCompute(judge, {
      turns: [{ task: 'configure deploy', output: '...', ownerWords: 'configure deploy' }],
      currentFacts: [],
    });

    expect(update.upserts).toEqual([{ key: 'user.tz', value: 'America/Los_Angeles', confidence: 0.9, rationale: 'mentioned in turn' }]);
    expect(update.decay).toEqual(['stale.fact']);
  });

  test('the prompt carries every turn of the window, oldest first, each ask before its answer', async () => {
    const judge = createScriptedLLM(['{"upserts":[],"decay":[]}']);

    await runSleepTimeCompute(judge, {
      turns: [
        { task: 'first ask', output: 'first answer', ownerWords: 'first ask' },
        { task: 'second ask', output: 'second answer', ownerWords: 'second ask' },
      ],
      currentFacts: [],
    });

    const prompt = present(judge.prompts[0], 'the pass prompt');
    const at = ['first ask', 'first answer', 'second ask', 'second answer'].map((said) => prompt.indexOf(said));

    expect(at.every((index, position) => index >= 0 && (position === 0 || index > (at[position - 1] ?? 0)))).toBe(true);
  });

  test('prompt explicitly lists existing keys for exact reuse', async () => {
    const judge = createScriptedLLM(['{"upserts":[],"decay":[]}']);

    const currentFacts = Array.from({ length: 31 }, (_, index) => ({
      key: `existing.key_${index}`,
      value: index,
      confidence: 1,
    }));

    await runSleepTimeCompute(judge, { turns: ONE_TURN, currentFacts });

    expect(judge.prompts[0]).toContain('existing.key_0');
    expect(judge.prompts[0]).toContain('existing.key_30');
  });

  test('an answer off the schema is no update, and a definitive failure', async () => {
    const judge = createScriptedLLM(['Live answer from the fake model.']);

    await expect(runSleepTimeCompute(judge, { turns: ONE_TURN, currentFacts: [] })).rejects.toMatchObject({ code: 'bad_input' });
  });

  // rc24 staging: the fast tier's model left `rationale` out on text alone, and on a replay of those turns
  // glm-4.7-flash once answered `{}`. Asked through the structured output, an answer off the schema goes to the next
  // model on the route, and the update that comes back is the schema's.
  test('is asked for its schema, and an answer off it ends the route walk, as a wrong answer does', async () => {
    const formats: string[] = [];

    const answering = (text: string) => new MockLanguageModelV3({
      doGenerate: async (options) => {
        formats.push(options.responseFormat?.type === 'json' && options.responseFormat.schema !== undefined ? 'json schema' : 'text');

        return {
          content: [{ type: 'text' as const, text }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: { inputTokens: { total: 9, noCache: 9, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 2, text: 2, reasoning: undefined } },
          warnings: [],
        };
      },
    });

    // The fast lane a host builds: glm-4.7-flash serving, glm-5.3-flash its fallback.
    const lane = (first: string) => {
      const served = new Map([['workers-ai/glm-4.7-flash', answering(first)], ['workers-ai/glm-5.3-flash', answering('{"upserts":[],"decay":[]}')]]);
      const tiers = { default: { model: 'workers-ai/glm-5.3-flash' }, fast: { model: 'workers-ai/glm-4.7-flash' } };
      const catalog = { roles: {}, tiers, modelFallbacks: { 'workers-ai/glm-4.7-flash': ['workers-ai/glm-5.3-flash'] } };

      return createRoutedModelLane({ actorId: 'actor-test', workspaceId: 'ws-test', parentActorId: null }, 'fast', {
        llm: (serving) => routedLlm((bound) => ({ model: present(served.get(bound.model), bound.model) }), serving, { report: () => {} }),
        resolveProfile: async () => resolveTurnProfile({
          envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
          provider: { revision: 'r', availableModels: [...served.keys()] },
          roleId: 'task', workMode: 'build', availableTools: [], activeSkills: [],
        }),
      });
    };

    expect(await runSleepTimeCompute(lane('{"upserts":[{"key":"build.dir","value":"dist","confidence":0.9,"rationale":"the build said so"}],"decay":[]}'), { turns: ONE_TURN, currentFacts: [] }))
      .toEqual({ upserts: [{ key: 'build.dir', value: 'dist', confidence: 0.9, rationale: 'the build said so' }], decay: [] });
    // The fallback is never asked: a wrong answer is not the serving model's outage.
    await expect(runSleepTimeCompute(lane('{}'), { turns: ONE_TURN, currentFacts: [] })).rejects.toMatchObject({ code: 'bad_input' });
    expect(formats).toEqual(['json schema', 'json schema']);
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
    expect(present(facts.recall('decay.this'), 'the decayed fact').confidence).toBeLessThan(1.0);
  });

  test('rejects an update with a missing fact value before any write', async () => {
    const { facts } = createTestFactsStore();

    const judge = createScriptedLLM([
      '{"upserts":[{"key":"ok.1","value":"fine","confidence":1,"rationale":""},{"key":"bad","confidence":1,"rationale":""}],"decay":[]}',
    ]);

    await expect(runSleepTimeCompute(judge, { turns: ONE_TURN, currentFacts: [] }))
      .rejects.toMatchObject({ code: 'bad_input' });
    expect(facts.recall('ok.1')).toBeNull();
    expect(facts.recall('bad')).toBeNull();
  });

  test('canonicalizes upsert keys before writing', () => {
    const { facts } = createTestFactsStore();

    const summary = applySleepTimeUpdate(facts, {
      upserts: [{
        key: '  Computer.NPM   Version  ', value: 'npm v10', confidence: 0.9, rationale: '',
      }],
      decay: [],
    });

    expect(summary.upserted).toBe(1);
    expect(facts.recall('computer.npm_version')?.value).toBe('npm v10');
    expect(facts.recall('  Computer.NPM   Version  ')?.value).toBe('npm v10');
  });

  test('same-value re-observation is not counted as an upsert or refreshed', () => {
    const { facts, testSql } = createTestFactsStore();
    facts.upsert('computer.npm_version', 'npm v10');
    void testSql.sql`UPDATE agent_facts SET last_observed_at = 1000
                WHERE key = 'computer.npm_version'`;

    const summary = applySleepTimeUpdate(facts, {
      upserts: [{ key: 'Computer.NPM_Version', value: 'npm v10', confidence: 0.95, rationale: '' }],
      decay: [],
    });

    expect(summary.upserted).toBe(0);
    expect(facts.recall('computer.npm_version')?.lastObservedAt).toBe(1000);
    expect(facts.recall('computer.npm_version')?.confidence).toBe(0.95);
  });

  test('changed value is counted and refreshes the fact', () => {
    const { facts, testSql } = createTestFactsStore();
    facts.upsert('computer.npm_version', 'npm v9');
    void testSql.sql`UPDATE agent_facts SET last_observed_at = 1000
                WHERE key = 'computer.npm_version'`;

    const summary = applySleepTimeUpdate(facts, {
      upserts: [{ key: 'computer.npm_version', value: 'npm v10', confidence: 0.9, rationale: '' }],
      decay: [],
    });

    expect(summary.upserted).toBe(1);
    expect(facts.recall('computer.npm_version')?.value).toBe('npm v10');
    expect(facts.recall('computer.npm_version')?.lastObservedAt).toBeGreaterThan(1000);
  });

  test('rejects an update with out-of-range confidence before any write', async () => {
    const { facts } = createTestFactsStore();

    const judge = createScriptedLLM([
      '{"upserts":[{"key":"ok.1","value":"fine","confidence":99,"rationale":""}],"decay":[]}',
    ]);

    await expect(runSleepTimeCompute(judge, { turns: ONE_TURN, currentFacts: [] }))
      .rejects.toMatchObject({ code: 'bad_input' });
    expect(facts.recall('ok.1')).toBeNull();
  });
});

describe('an idle wake dreams first', () => {
  /** Answered turns, newest first, as the transcript reads them. */
  const turns = (count: number): ConversationProjection[] => Array.from({ length: count }, (_, index) => count - index).flatMap((turn) => [
    { id: `a${String(turn)}`, position: 0, role: 'assistant' as const, turnId: null, runId: null, content: `answer ${String(turn)}`, toolCalls: [], recordedAt: 0 },
    { id: `u${String(turn)}`, position: 0, role: 'user' as const, turnId: null, runId: null, content: `step ${String(turn)}`, toolCalls: [], recordedAt: 0 },
  ]);

  /** `unreadable`: how many first passes the model answers with what no update can be read from; `held`: called as the
   *  first pass reaches its model, its answer waiting on what it returns; `decay`: the facts every answer decays. */
  function lane(count: number, { unreadable = 0, held, decay = [] }: { readonly unreadable?: number; readonly held?: () => Promise<void>; readonly decay?: readonly string[] } = {}) {
    const { rt, stores, testSql } = createTestRuntime();
    initFactsTable(testSql.execRaw);
    initSleepTimeTables(testSql.execRaw);
    initEffectTombstoneTable(testSql.execRaw);
    stores.config.setSleepTimeComputeEnabled(true);
    const order: string[] = [];
    const prompts: string[] = [];
    const rows = turns(count);

    const reopen = () => new SleepTimeLane({
      sql: rt.storage.sql, actor: rt.actor, config: stores.config, facts: stores.facts,
      // As the transcript reads: the newest `limit` rows.
      transcript: () => ({ newestFirst: async (limit) => rows.slice(0, limit) }),
      llm: () => ({ stream: () => { throw new Error('not streamed'); }, complete: () => { throw new Error('sleep-time asks for a schema'); }, object: async (prompt, schema) => {
        order.push('facts');
        prompts.push(prompt);

        if (prompts.length === 1 && held !== undefined) await held();

        if (prompts.length <= unreadable) throw new KinuError('bad_input', 'the fast tier answered off its schema');

        return v.parse(schema, { upserts: [], decay: [...decay] });
      } }),
      transactionSync: (write) => write(),
      armWake: () => {},
      workspace: 'research',
      idle: async () => { order.push('dream'); },
    });

    return { lane: reopen(), reopen, order, prompts, rows, facts: stores.facts };
  }

  test('a due idle wake runs the dream before it compresses facts, and an early one runs neither', async () => {
    const { lane: idle, order } = lane(2);

    // Two turns are not the cadence: the pass arms the idle wake instead.
    await idle.runTerminal();
    const settledAt = Date.now();
    expect(await idle.runIfDue(settledAt + SLEEP_TIME_CADENCE.idleMs - 1_000)).toBe(false);
    expect(order).toEqual([]);

    expect(await idle.runIfDue(settledAt + SLEEP_TIME_CADENCE.idleMs + 1_000)).toBe(true);
    expect(order).toEqual(['dream', 'facts']);
  });

  test("a backlog past the first read drains on the lane's own wakes, across reopening, each turn read once and oldest first", async () => {
    // 20 turns are 40 rows, past the 32 a pass reads first: a pass that read only those marked the oldest 4 read unread.
    const fixture = lane(20);

    await fixture.lane.runTerminal();

    for (let owed = fixture.reopen(), at = owed.nextWakeAt(); at !== null; owed = fixture.reopen(), at = owed.nextWakeAt()) {
      await owed.wake(at + SLEEP_TIME_CADENCE.idleMs);
    }

    // Each pass's turns, as its prompt lists them: each answer under the ask that opened it.
    const read = fixture.prompts.map((prompt) => [...prompt.matchAll(/- Task: step (\d+)\n(?:.*\n)*?- Assistant output: answer \1\b/gu)].map((said) => Number(said[1])));
    const batches = Array.from({ length: 7 }, (_batch, index) => Array.from({ length: Math.min(3, 20 - index * 3) }, (_turn, at) => index * 3 + at + 1));

    expect(read).toEqual(batches);
  });

  test("a batch the model cannot read is consumed once, and the backlog after it still drains on the lane's own wakes", async () => {
    const fixture = lane(8, { unreadable: 1 });
    const first = await Promise.allSettled([fixture.lane.runTerminal()]);

    for (let owed = fixture.reopen(), at = owed.nextWakeAt(); at !== null; owed = fixture.reopen(), at = owed.nextWakeAt()) {
      await owed.wake(at + SLEEP_TIME_CADENCE.idleMs);
    }

    const read = fixture.prompts.map((prompt) => [...prompt.matchAll(/- Task: step (\d+)\n(?:.*\n)*?- Assistant output: answer \1\b/gu)].map((said) => Number(said[1])));

    expect({ first: first.map((settled) => (settled.status === 'rejected' ? v.parse(FailureSchema, settled.reason).code : 'completed')), read })
      .toEqual({ first: ['bad_input'], read: [[1, 2, 3], [4, 5, 6], [7, 8]] });
  });

  test('a turn that settles while a pass waits on its model is read on its own wake, and the batch both passes read applies once', async () => {
    const [reached, answer] = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];

    const fixture = lane(3, {
      held: () => {
        reached.resolve();

        return answer.promise;
      },
      decay: ['stale.fact'],
    });

    fixture.facts.upsert('stale.fact', 'kept', { confidence: 0.9 });

    const waiting = fixture.lane.runTerminal();

    await reached.promise;
    // The fourth turn settles, and its own pass runs while the first still waits.
    fixture.rows.unshift(...turns(4).slice(0, 2));
    await fixture.reopen().runTerminal();
    answer.resolve();
    await waiting;

    for (let owed = fixture.reopen(), at = owed.nextWakeAt(); at !== null; owed = fixture.reopen(), at = owed.nextWakeAt()) {
      await owed.wake(at + SLEEP_TIME_CADENCE.idleMs);
    }

    const read = fixture.prompts.map((prompt) => [...prompt.matchAll(/- Task: step (\d+)\n(?:.*\n)*?- Assistant output: answer \1\b/gu)].map((said) => Number(said[1])));

    // Each pass decays the fact once: the first batch once though two passes read it, the fourth turn's once.
    const confidence = present(fixture.facts.recall('stale.fact'), 'the seeded fact').confidence;

    expect({ last: read.at(-1), decays: Math.round((0.9 - confidence) / 0.2) }).toEqual({ last: [4], decays: 2 });
  });

  test('an idle wake refuses pending input and includes it only after its answer completes', async () => {
    const fixture = lane(2);
    await fixture.lane.runTerminal();
    const pending: ConversationProjection = { id: 'u3', position: 0, role: 'user', turnId: null, runId: null, content: 'pending request', toolCalls: [], recordedAt: 0 };
    fixture.rows.unshift(pending);

    const pendingLane = fixture.reopen();
    expect(await pendingLane.runIfDue(Date.now() + SLEEP_TIME_CADENCE.idleMs + 1_000)).toBe(false);
    expect(fixture.order).toEqual([]);
    expect(fixture.prompts).toEqual([]);

    fixture.rows.unshift({ ...pending, id: 'a3', role: 'assistant', content: 'third answer completed' });
    await fixture.reopen().runTerminal();
    expect(fixture.prompts).toHaveLength(1);
    expect(fixture.prompts[0]).toContain('pending request');
    expect(fixture.prompts[0]).toContain('third answer completed');
    expect(fixture.prompts[0]).toContain('step 1');
    expect(fixture.prompts[0]).toContain('step 2');
    await fixture.reopen().runTerminal();
    expect(fixture.prompts).toHaveLength(1);
  });

  test('the third turn compresses facts at once, with no dream: the agent is not idle', async () => {
    const { lane: busy, order } = lane(3);

    await busy.runTerminal();
    expect(order).toEqual(['facts']);
  });
});
