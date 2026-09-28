/** The effect bodies both backends construct through core: pins the disposition mapping. */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { Database } from 'bun:sqlite';

import {
  TERMINAL_EFFECT_RETRY_BASE_MS, TerminalEffectLedger, initTerminalEffectTable, shadowTrialTerminalEffect,
  terminalEffect, turnRecordTerminalEffect,
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
  test('keeps the attempt count and the base delay across repeated looks', async () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    initTerminalEffectTable(makeExecRaw(db));
    let now = 1_000;
    const looks = { held: 0, failing: 0 };

    const effects = {
      branches: terminalEffect({ input: v.object({}), run: () => {
        looks.held += 1;

        return { status: 'owed', held: true, detail: 'carrier live' };
      } }),
      craft_usage: terminalEffect({ input: v.object({}), run: () => {
        looks.failing += 1;

        return { status: 'owed', detail: 'undelivered' };
      } }),
    };

    const ledger = new TerminalEffectLedger({
      sql, actor: testActorHandle(sql, { actorId: 'actor-a' }), effects, now: () => now,
      scheduleRetry: async () => {},
    });

    const row = (key: string) => sql<{ attempts: number; next_attempt_at: number }>`
      SELECT attempts, next_attempt_at FROM terminal_effects WHERE effect_name = ${key}`[0];

    const run = await ledger.run('seq', [
      { name: 'branches', scope: '', input: {}, lane: 'detached' },
      { name: 'craft_usage', scope: '', input: {}, lane: 'detached' },
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
