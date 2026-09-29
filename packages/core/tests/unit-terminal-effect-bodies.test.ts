/** The effect bodies both backends construct through core: pins the disposition mapping. */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { Database } from 'bun:sqlite';

import {
  TERMINAL_EFFECT_RETRY_BASE_MS, TerminalEffectLedger, initTerminalEffectTable, shadowTrialTerminalEffect,
  terminalEffect, turnRecordTerminalEffect, TerminalEffectInterrupt,
} from '../src/orchestrator/terminal-effects';
import { projectJsonValue, type CompletedTurn } from '../src/index';
import { makeSql, makeExecRaw } from './helpers';
import { testActorHandle } from '@kinu.run/test-utils';

const TURN: CompletedTurn = {
  userMessage: 'name the parser', assistantResponse: 'the parser is sound',
  toolCalls: [], steps: 1, durationMs: 5, hadError: false, feedback: null,
};

const TURN_JSON = projectJsonValue({ value: TURN });

describe('shadowTrialTerminalEffect', () => {
  const effectOver = (outcome: 'queued' | 'not_sampled' | 'queue_full' | 'failed') => {
    const asked: unknown[] = [];

    const effect = shadowTrialTerminalEffect({
      queueShadowTrial: (turn, context, plan) => {
        asked.push({ turn, context, plan });

        return outcome;
      },
    });

    return { effect, asked };
  };

  const input = { turn: TURN_JSON, trialContext: [], pendingVersion: 7 };

  test('a refusal discharges the row; only a full queue or a failed insert stays owed', async () => {
    expect(await effectOver('queued').effect.run(input, 'msg-1')).toEqual({ status: 'completed' });
    expect(await effectOver('not_sampled').effect.run(input, 'msg-1'))
      .toEqual({ status: 'completed', detail: 'no trial to queue: not_sampled' });
    expect(await effectOver('queue_full').effect.run(input, 'msg-1'))
      .toEqual({ status: 'owed', detail: 'the shadow trial for this turn is queue_full' });
    expect(await effectOver('failed').effect.run(input, 'msg-1'))
      .toEqual({ status: 'owed', detail: 'the shadow trial for this turn is failed' });
  });

  test('the trial is keyed on the response scope, and an unkeyed scope carries no id', async () => {
    const keyed = effectOver('queued');
    await keyed.effect.run(input, 'msg-1');
    expect(keyed.asked).toMatchObject([{ plan: { pendingVersion: 7, id: 'trial-msg-1' } }]);
    const unkeyed = effectOver('queued');
    await unkeyed.effect.run(input, '');
    expect(unkeyed.asked).toEqual([{ turn: TURN, context: [], plan: { pendingVersion: 7 } }]);
  });
});

describe('turnRecordTerminalEffect', () => {
  const recorderOver = () => {
    const recorded: unknown[] = [];

    const effect = turnRecordTerminalEffect({
      recordedTurn: (status, turn) => ({ ...turn, status }),
      recordTurn: (turn, continuity, options) => { recorded.push({ turn, continuity, options }); },
    });

    return { effect, recorded };
  };

  const row = (workMode: 'plan' | 'build', autoEvolve: boolean) => ({
    messageId: 'msg-1', status: 'completed', turn: TURN_JSON, continuity: 'conversation',
    workMode, recordedAt: 1_000, autoEvolve,
  });

  test('a plan turn records nothing, live or replayed', async () => {
    const { effect, recorded } = recorderOver();
    expect(await effect.run(row('plan', true), 'msg-1'))
      .toEqual({ status: 'completed', detail: 'a plan turn records no evolution state' });
    expect(recorded).toEqual([]);
  });

  test('the evolution gate and the append id come off the row', async () => {
    const { effect, recorded } = recorderOver();
    expect(await effect.run(row('build', false), 'msg-1'))
      .toEqual({ status: 'completed', detail: 'the turn was produced with auto-evolution off' });
    expect(recorded).toMatchObject([{
      continuity: 'conversation', options: { recordedAt: 1_000, enabled: false, id: 'turn-msg-1' },
    }]);
  });
});

describe('a held owed outcome', () => {
  // `held` is a look, not a failed attempt: no attempt counted, re-arm at the base delay.
  test.each(['inline', 'detached'] as const)('%s keeps the attempt count and the base delay across repeated looks', async (lane) => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    initTerminalEffectTable(makeExecRaw(db));
    let now = 1_000;
    const looks = { held: 0, failing: 0 };

    const effects = {
      branches: terminalEffect({ input: v.object({}), runSync: () => {
        looks.held += 1;

        return { status: 'owed', held: true, detail: 'carrier live' };
      } }),
      craft_usage: terminalEffect({ input: v.object({}), runSync: () => {
        looks.failing += 1;

        return { status: 'owed', detail: 'undelivered' };
      } }),
    };

    const ledger = new TerminalEffectLedger({
      sql, actor: testActorHandle(sql, { actorId: 'actor-a' }), effects, now: () => now,
      transaction: (body) => db.transaction(body)(),
      scheduleRetry: async () => {},
    });

    const row = (key: string) => sql<{ attempts: number; next_attempt_at: number }>`
      SELECT attempts, next_attempt_at FROM terminal_effects WHERE effect_name = ${key}`[0];

    const run = await ledger.run('seq', [
      { name: 'branches', scope: '', input: {}, lane },
      { name: 'craft_usage', scope: '', input: {}, lane },
    ]);

    await run.reported;

    for (const step of [1, 2, 3]) {
      now = row('craft_usage')?.next_attempt_at ?? now;
      await ledger.replayOwed('seq');
      expect(looks).toEqual({ held: step + 1, failing: step + 1 });
      expect(row('branches')).toEqual({ attempts: 0, next_attempt_at: now + TERMINAL_EFFECT_RETRY_BASE_MS });
      expect(row('craft_usage')?.attempts).toBe(step + 1);
    }

    expect(row('craft_usage')?.next_attempt_at).toBeGreaterThan(now + TERMINAL_EFFECT_RETRY_BASE_MS);
    db.close();
  });
});

describe('an interrupted attempt keeps only committed work', () => {
  for (const phase of ['before', 'after'] as const) {
    test(`a synchronous ${phase} cut rolls back its nested body and attempt together`, async () => {
      const db = new Database(':memory:');
      const sql = makeSql(db);
      const transaction = <T>(body: () => T): T => db.transaction(body)();
      initTerminalEffectTable(makeExecRaw(db));
      db.exec('CREATE TABLE effect_output (answer TEXT NOT NULL)');
      let cutting = true;

      const deps = {
        sql, actor: testActorHandle(sql, { actorId: 'actor-a' }), now: () => 1_000,
        transaction,
        scheduleRetry: async () => {},
        fault: () => cutting ? (at: string) => {
          if (at === phase) throw new TerminalEffectInterrupt(phase, 'turn_record', '');
        } : null,
        effects: { turn_record: terminalEffect({ input: v.object({}), runSync: () => transaction(() => {
          void sql`INSERT INTO effect_output (answer) VALUES ('kept')`;

          return { status: 'completed' };
        }) }) },
      };

      const ledger = new TerminalEffectLedger(deps);
      ledger.claim('seq', [{ name: 'turn_record', scope: '', input: {}, lane: 'inline' }]);

      await expect(ledger.drive('seq')).rejects.toBeInstanceOf(TerminalEffectInterrupt);
      expect(sql`SELECT answer FROM effect_output`).toEqual([]);
      expect(sql`SELECT status, attempts, next_attempt_at FROM terminal_effects`)
        .toEqual([{ status: 'pending', attempts: 0, next_attempt_at: 1_000 }]);
      cutting = false;
      await ledger.replayOwed('seq');
      expect(sql`SELECT answer FROM effect_output`).toEqual([{ answer: 'kept' }]);
      expect(sql`SELECT status, attempts FROM terminal_effects`).toEqual([{ status: 'completed', attempts: 1 }]);
      db.close();
    });
  }

  test('a synchronous failure rolls back its body, but keeps the growing backoff', async () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    initTerminalEffectTable(makeExecRaw(db));
    db.exec('CREATE TABLE effect_output (answer TEXT NOT NULL)');
    let now = 1_000;

    const deps = {
      sql, actor: testActorHandle(sql, { actorId: 'actor-a' }), now: () => now,
      transaction: <T>(body: () => T): T => db.transaction(body)(),
      scheduleRetry: async () => {},
      effects: { turn_record: terminalEffect({ input: v.object({}), runSync: () => {
        void sql`INSERT INTO effect_output (answer) VALUES ('partial')`;
        throw new Error('the recorder failed');
      } }) },
    };

    const ledger = new TerminalEffectLedger(deps);
    await (await ledger.run('seq', [{ name: 'turn_record', scope: '', input: {}, lane: 'inline' }])).reported;
    now += TERMINAL_EFFECT_RETRY_BASE_MS;
    await ledger.replayOwed('seq');

    expect(sql`SELECT status, attempts, next_attempt_at FROM terminal_effects`)
      .toEqual([{ status: 'pending', attempts: 2, next_attempt_at: now + 2 * TERMINAL_EFFECT_RETRY_BASE_MS }]);
    expect(sql`SELECT answer FROM effect_output`).toEqual([]);
    db.close();
  });

  test('an asynchronous interruption retains the attempt recorded before the body', async () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    initTerminalEffectTable(makeExecRaw(db));
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const deps = {
      sql, actor: testActorHandle(sql, { actorId: 'actor-a' }), now: () => 1_000,
      transaction: <T>(body: () => T): T => db.transaction(body)(),
      scheduleRetry: async () => {},
      effects: { auto_title: terminalEffect({ input: v.object({}), run: async () => {
        paused.resolve();
        await release.promise;
        throw new TerminalEffectInterrupt('after', 'auto_title', '');
      } }) },
    };

    const ledger = new TerminalEffectLedger(deps);
    const running = ledger.run('seq', [{ name: 'auto_title', scope: '', input: {}, lane: 'inline' }]);
    await paused.promise;
    expect(sql`SELECT status, attempts, next_attempt_at FROM terminal_effects`)
      .toEqual([{ status: 'pending', attempts: 1, next_attempt_at: 1_000 + TERMINAL_EFFECT_RETRY_BASE_MS }]);
    release.resolve();
    await expect(running).rejects.toBeInstanceOf(TerminalEffectInterrupt);
    expect(sql`SELECT status, attempts FROM terminal_effects`).toEqual([{ status: 'pending', attempts: 1 }]);
    db.close();
  });
});
