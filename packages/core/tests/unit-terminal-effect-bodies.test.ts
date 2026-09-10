/**
 * The five effect bodies both backends declare through core rather than
 * spelling for themselves: `takes`, `branches`, `turn_record`, `event_drain`
 * and `shadow_trial`. Each was two near-copies that differed only in how the
 * backend named its own storage, and the disposition mapping — what a refusal
 * is, what stays owed — is the part that drifts when two hands maintain it.
 * These pin the mapping at the one body both now construct.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import {
  shadowTrialTerminalEffect, takesTerminalEffect, turnRecordTerminalEffect,
} from '../src/orchestrator/terminal-effects';
import { initAlternateTakesTable, latestAlternateTakeSet, unclaimedAlternateTakeIds } from '../src/mcts/takes';
import { projectJsonValue, type CompletedTurn } from '../src/index';
import { makeSql, makeExecRaw } from './helpers';
import { createTestActors } from '@kinu.run/test-utils';

const TURN: CompletedTurn = {
  userMessage: 'name the parser', assistantResponse: 'the parser is sound',
  toolCalls: [], steps: 1, durationMs: 5, hadError: false, feedback: null,
};
const TURN_JSON = projectJsonValue({ value: TURN });

describe('shadowTrialTerminalEffect', () => {
  const effectOver = (outcome: 'queued' | 'not_sampled' | 'queue_full' | 'failed') => {
    const asked: unknown[] = [];
    const effect = shadowTrialTerminalEffect({
      queueShadowTrial: (turn, context, plan) => { asked.push({ turn, context, plan }); return outcome; },
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

describe('takesTerminalEffect', () => {
  test('a credited turn claims the takes it competed against; an uncredited one purges them', async () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);
    initAlternateTakesTable(execRaw);
    const actor = createTestActors(sql, execRaw).main;
    const seed = (id: string) => sql`INSERT INTO alternate_takes
      (actor_id, id, turn_id, session_id, task, source, winner_node_id, chosen_node_id, candidates, created_at, picked_at)
      VALUES (${actor.actorId}, ${id}, ${null}, ${null}, ${'pick'}, ${'mcts'}, ${'a'}, ${null},
              ${JSON.stringify([{ nodeId: 'a', text: 'A', score: 0.9, visits: 1, depth: 1 }, { nodeId: 'b', text: 'B', score: 0.8, visits: 1, depth: 1 }])},
              ${1}, ${null})`;
    const effect = takesTerminalEffect({ sql, actor, sessionId: 's' });

    seed('take-first');
    expect(unclaimedAlternateTakeIds(sql, actor)).toEqual(['take-first']);
    expect(await effect.run({ credited: 'msg-1', startedAt: 0, takeIds: ['take-first'] }, 'msg-1'))
      .toEqual({ status: 'completed' });
    expect(latestAlternateTakeSet(sql, actor)?.turnId).toBe('msg-1');
    expect(unclaimedAlternateTakeIds(sql, actor)).toEqual([]);

    seed('take-second');
    expect(await effect.run({ credited: null, startedAt: 0, takeIds: ['take-second'] }, 'msg-2'))
      .toEqual({ status: 'completed' });
    // Purged, never claimed: the earlier claimed set is what the surfaces read.
    expect(unclaimedAlternateTakeIds(sql, actor)).toEqual([]);
    expect(latestAlternateTakeSet(sql, actor)?.id).toBe('take-first');
  });
});
