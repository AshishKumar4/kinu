/** Alternate Takes: a steer branch's take set and the pick rated in turn_ratings ('take_pick'). */
import { describe, test, expect } from 'bun:test';
import { makeSql, createTestActor, createTestWorkspace } from './helpers';
import { SessionHistory } from '../src/session/history';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import {
  initAlternateTakesTable, recordBranchTakeSet, latestAlternateTakeSet, recordTakePick,
  buildTakeContinuationPrompt,
} from '../src/mcts/takes';
import { seedTranscriptEntry, present } from '@kinu.run/test-utils';
import { listTurnRatings } from '../src/evolution/ratings';
import { conversationTurnPair } from '../src/identity/conversation-store';

/** Production schema: the eval split reconstructs evidence from the message and run-event ledgers. */
function setup() {
  const { db, sql, execRaw, vfs } = createTestWorkspace();
  initAlternateTakesTable(execRaw);
  // A real directory row: the pick reads through the actor-scoped conversation store.
  const actor = createTestActor(sql, execRaw, 'ws-takes', 'takes');

  const history = new SessionHistory({
    sql, actor, transactionSync: write => db.transaction(write)(),
    files: async () => ({ vfs, artifactDirectory: '/actor/.kinu/context' }),
  });

  return { db, sql, execRaw, actor, history, transcript: history.transcript(CHAT_SESSION_ID) };
}

/** The live answer and a steer branch's, claimed against the turn that answered. */
async function capturedSet(sql: ReturnType<typeof makeSql>, actor: ReturnType<typeof setup>['actor'], history: SessionHistory) {
  recordBranchTakeSet(sql, actor, {
    task: 'the task', turnId: 'msg-9', sessionId: 'default',
    liveText: 'winning approach', branchText: 'alternative approach',
  });
  await seedTranscriptEntry(history, CHAT_SESSION_ID, { id: 'u-9', origin: 'input',
    message: { role: 'user', content: 'please solve it' } });
  await seedTranscriptEntry(history, CHAT_SESSION_ID, { id: 'msg-9', origin: 'output',
    message: { role: 'assistant', content: 'I used the winning approach' } });

  const set = present(latestAlternateTakeSet(sql, actor), 'the latest take set');

  return { set, win: set.candidates[0].nodeId, alt: set.candidates[1].nodeId };
}

describe('recordTakePick — the preference signal', () => {
  test('picking the answered winner rates it high and moves nothing', async () => {
    const { sql, actor, history, transcript } = setup();
    const { set, win } = await capturedSet(sql, actor, history);
    const result = await recordTakePick(sql, actor, async (messageId) => await conversationTurnPair(transcript, messageId), { takeId: set.id, nodeId: win, scaffoldVersion: 3 });
    expect(result).toMatchObject({ changedAnswer: false });

    const rows = listTurnRatings(sql, actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      turnId: 'msg-9', score: 4, corrected: 0, source: 'take_pick',
      request: 'please solve it', answer: 'I used the winning approach', followup: null, scaffoldVersion: 3,
    });
    expect(latestAlternateTakeSet(sql, actor)).toMatchObject({ chosenNodeId: win, winnerNodeId: win });
  });

  test('picking the branch rates the delivered answer low and re-points the set', async () => {
    const { sql, actor, history, transcript } = setup();
    const { set, alt } = await capturedSet(sql, actor, history);
    const result = await recordTakePick(sql, actor, async (messageId) => await conversationTurnPair(transcript, messageId), { takeId: set.id, nodeId: alt });
    expect(result).toMatchObject({ changedAnswer: true });
    expect(result.chosen.text).toBe('alternative approach');

    const row = present(listTurnRatings(sql, actor)[0], 'the pick rating');
    expect(row).toMatchObject({ score: 2, corrected: 1, source: 'take_pick' });
    // The chosen take is the correction follow-up GEPA optimizes toward.
    expect(row.followup).toBe('alternative approach');
    expect(latestAlternateTakeSet(sql, actor)).toMatchObject({ chosenNodeId: alt, winnerNodeId: alt });
  });

  test('a re-pick leaves one effective rating per turn', async () => {
    const { sql, actor, history, transcript } = setup();
    const { set, alt } = await capturedSet(sql, actor, history);
    await recordTakePick(sql, actor, async (messageId) => await conversationTurnPair(transcript, messageId), { takeId: set.id, nodeId: alt });
    await recordTakePick(sql, actor, async (messageId) => await conversationTurnPair(transcript, messageId), { takeId: set.id, nodeId: alt });
    expect(listTurnRatings(sql, actor)).toHaveLength(1);
  });

  test('switching the pick re-points the set to the newly chosen take', async () => {
    const { sql, actor, history, transcript } = setup();
    const { set, win, alt } = await capturedSet(sql, actor, history);
    await recordTakePick(sql, actor, async (messageId) => await conversationTurnPair(transcript, messageId), { takeId: set.id, nodeId: alt });
    const switched = await recordTakePick(sql, actor, async (messageId) => await conversationTurnPair(transcript, messageId), { takeId: set.id, nodeId: win });
    expect(switched).toMatchObject({ changedAnswer: true });
    expect(latestAlternateTakeSet(sql, actor)).toMatchObject({ chosenNodeId: win, winnerNodeId: win });
    expect(listTurnRatings(sql, actor)).toHaveLength(1);
  });

  test('rejects unknown take sets and non-candidate nodes', async () => {
    const { sql, actor, history, transcript } = setup();
    const { set, win } = await capturedSet(sql, actor, history);
    await expect(recordTakePick(sql, actor, async (messageId) => await conversationTurnPair(transcript, messageId), { takeId: 'take-nope', nodeId: win })).rejects.toThrow('Unknown take set');
    await expect(recordTakePick(sql, actor, async (messageId) => await conversationTurnPair(transcript, messageId), { takeId: set.id, nodeId: 'stranger' })).rejects.toThrow('not a candidate');
  });

  test('the continuation prompt carries the task and the chosen take', async () => {
    const { sql, actor, history, transcript } = setup();
    const { set, alt } = await capturedSet(sql, actor, history);
    const { chosen } = await recordTakePick(sql, actor, async (messageId) => await conversationTurnPair(transcript, messageId), { takeId: set.id, nodeId: alt });
    const prompt = buildTakeContinuationPrompt(set, chosen);
    expect(prompt).toContain('the task');
    expect(prompt).toContain('alternative approach');
    expect(prompt).toContain('continue with this approach');
  });
});

