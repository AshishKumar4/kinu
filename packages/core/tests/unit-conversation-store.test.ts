/**
 * The canonical conversation store's flat reads: the fork-cut preflight, the
 * status count, the turn pair every grader attributes from, and the drain
 * answers a recovery finishes a reply with.
 *
 * Everything below writes through the canonical writers — `SessionHistory`
 * and the transcript it hands out — so a reader that drifted from what a turn
 * actually records goes red here rather than in production.
 */

import { describe, test, expect } from 'bun:test';
import { answersForDrainTurns, conversationCount, conversationTurnPair, forkPointExists } from '../src/identity/conversation-store';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { SessionHistory } from '../src/session/history';
import type { SessionTranscript } from '../src/session/transcript';
import type { ActorHandle } from '../src/identity/actor-handle';
import { createTestActor, createTestWorkspace, type TestWorkspace } from './helpers';
import { present } from '@kinu.run/test-utils';

/** A workspace, the actor its transcript belongs to, and the canonical writers
 *  every seed below goes through — the entries are keyed by actor, so a
 *  fixture handing back the database alone is a chat no reader can answer for. */
interface Fixture extends TestWorkspace {
  readonly actor: ActorHandle;
  readonly history: SessionHistory;
  readonly transcript: SessionTranscript;
}

function setup(): Fixture {
  const ws = createTestWorkspace();
  const actor = createTestActor(ws.sql, ws.execRaw, 'ws-conversation', 'conversation');

  const history = new SessionHistory({
    sql: ws.sql, actor, transactionSync: write => ws.db.transaction(write)(),
    files: async () => ({ vfs: ws.vfs, artifactDirectory: '/actor/.kinu/context' }),
  });

  return { ...ws, actor, history, transcript: history.transcript(CHAT_SESSION_ID) };
}

/** One completed turn: the ask, then the answer parented on it. */
async function turn(
  history: SessionHistory,
  ids: { ask: string; answer: string },
  text: { ask: string; answer: string },
  sessionId = CHAT_SESSION_ID,
): Promise<void> {
  await history.record(sessionId, { id: ids.ask, parentId: null, origin: 'input',
    message: { role: 'user', content: text.ask } });
  await history.record(sessionId, { id: ids.answer, parentId: ids.ask, origin: 'output',
    message: { role: 'assistant', content: text.answer } });
}

describe('conversationCount — the default chat alone', () => {
  test('counts the default session and no other tree', async () => {
    const s = setup();
    await turn(s.history, { ask: 'u1', answer: 'a1' }, { ask: 'first ask', answer: 'first answer' });
    await turn(s.history, { ask: 'm-u', answer: 'm-a' }, { ask: 'score this', answer: 'a score' }, 'mcts');

    expect(conversationCount(s.sql, s.actor)).toBe(2);
  });

  test('an empty workspace counts nothing rather than failing', () => {
    const s = setup();
    expect(conversationCount(s.sql, s.actor)).toBe(0);
  });
});

describe('forkPointExists — the cut preflight', () => {
  test('a default-chat entry is forkable; an unknown id and a non-default one are not', async () => {
    const s = setup();
    await turn(s.history, { ask: 'u1', answer: 'a1' }, { ask: 'first ask', answer: 'first answer' });
    await turn(s.history, { ask: 'm-u', answer: 'm-a' }, { ask: 'score this', answer: 'a score' }, 'mcts');

    expect(forkPointExists(s.sql, s.actor, 'a1')).toBe(true);
    expect(forkPointExists(s.sql, s.actor, 'u1')).toBe(true);
    expect(forkPointExists(s.sql, s.actor, 'nobody')).toBe(false);
    // A search trajectory is a different tree, and its ids are not cut points.
    expect(forkPointExists(s.sql, s.actor, 'm-a')).toBe(false);
  });
});

describe('conversationTurnPair — what a grader attributes from', () => {
  test('an answer resolves its ask, its text and its window', async () => {
    const s = setup();
    await turn(s.history, { ask: 'u1', answer: 'a1' }, { ask: 'first ask', answer: 'first answer' });

    const pair = present(await conversationTurnPair(s.transcript, 'a1'), 'the turn pair for a1');

    expect(pair.sessionId).toBe(CHAT_SESSION_ID);
    expect(pair.responseId).toBe('a1');
    expect(pair.request).toBe('first ask');
    expect(pair.response).toBe('first answer');
    expect(pair.startedAtMs).not.toBeNull();
    expect(pair.endedAtMs).toBeGreaterThanOrEqual(present(pair.startedAtMs, 'the pair start'));
  });

  test('a turn id that names no answer has no pair', async () => {
    const s = setup();
    await turn(s.history, { ask: 'u1', answer: 'a1' }, { ask: 'first ask', answer: 'first answer' });

    // The ask is not a turn: a turn is named by the answer it produced.
    expect(await conversationTurnPair(s.transcript, 'u1')).toBeUndefined();
    expect(await conversationTurnPair(s.transcript, 'nobody')).toBeUndefined();
  });

  test('a sibling answer attributes to its own parent edge, not to the newest leaf', async () => {
    const s = setup();
    await turn(s.history, { ask: 'u1', answer: 'a1' }, { ask: 'first ask', answer: 'first answer' });
    await s.history.record(CHAT_SESSION_ID, { id: 'sib', parentId: 'a1', origin: 'output',
      message: { role: 'assistant', content: 'branch take' } });
    await s.history.record(CHAT_SESSION_ID, { id: 'u2', parentId: 'a1', origin: 'input',
      message: { role: 'user', content: 'second ask' } });

    const pair = present(await conversationTurnPair(s.transcript, 'sib'), 'the turn pair for sib');

    expect(pair.request).toBe('first answer');
    expect(pair.response).toBe('branch take');
  });

  test('an answer that roots its own chain reports a null request, not an absent pair', async () => {
    const s = setup();
    await s.history.record(CHAT_SESSION_ID, { id: 'orphan', parentId: null, origin: 'output',
      message: { role: 'assistant', content: 'unprompted' } });

    const pair = present(await conversationTurnPair(s.transcript, 'orphan'), 'the turn pair for orphan');

    expect(pair.request).toBeNull();
    expect(pair.startedAtMs).toBeNull();
    expect(pair.response).toBe('unprompted');
  });

  test('a non-default tree answers for its own session', async () => {
    const s = setup();
    await turn(s.history, { ask: 'm-u', answer: 'm-a' }, { ask: 'score this', answer: 'a score' }, 'mcts');

    const pair = await conversationTurnPair(s.history.transcript('mcts'), 'm-a');
    expect(pair).toMatchObject({ sessionId: 'mcts', request: 'score this', response: 'a score' });
    // …and the default chat's reader cannot see it.
    expect(await conversationTurnPair(s.transcript, 'm-a')).toBeUndefined();
  });
});

describe('answersForDrainTurns — what a recovery finishes a reply with', () => {
  /** The enqueue seam's shape: a user entry stamped with the drain turn it
   *  came from, which is the only link an answer can be found through. */
  async function drainAsk(s: Fixture, id: string, drainTurnId: string): Promise<void> {
    const reference = s.history.messages.insert(
      await s.history.messages.prepare({ role: 'user', content: `ask for ${drainTurnId}` }, id), 'input');

    s.transcript.appendUser(await s.transcript.prepareUser({
      id, turnId: drainTurnId, message: reference, metadata: { drainTurnId },
    }));
  }

  test('each named drain turn gets its answer, and an unanswered one is absent', async () => {
    const s = setup();
    await drainAsk(s, 'ask-1', 'drain-1');
    await s.history.record(CHAT_SESSION_ID, { id: 'answer-1', parentId: 'ask-1', origin: 'output',
      message: { role: 'assistant', content: 'the job finished' } });
    await drainAsk(s, 'ask-2', 'drain-2');

    const answers = await answersForDrainTurns(s.transcript, ['drain-1', 'drain-2']);
    expect(answers).toEqual(new Map([['drain-1', 'the job finished']]));
  });

  test('an empty answer is absent rather than delivered as nothing', async () => {
    const s = setup();
    await drainAsk(s, 'ask-1', 'drain-1');
    await s.history.record(CHAT_SESSION_ID, { id: 'answer-1', parentId: 'ask-1', origin: 'output',
      message: { role: 'assistant', content: '   ' } });

    expect(await answersForDrainTurns(s.transcript, ['drain-1'])).toEqual(new Map());
  });
});
