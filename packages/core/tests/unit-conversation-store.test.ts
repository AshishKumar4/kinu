/** Conversation store reads, seeded through the canonical writers. */

import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { answersForDrainTurns, conversationTurnPair, forkPointExists } from '../src/identity/conversation-store';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { SessionHistory } from '../src/session/history';
import { readSessionTranscript, type SessionTranscript } from '../src/session/transcript';
import type { ActorHandle } from '../src/identity/actor-handle';
import type { SqlExecutor, SqlValue } from '../src/types/primitives';
import { createTestActor, createTestWorkspace, type TestWorkspace } from './helpers';
import { seedTranscriptEntry, present } from '@kinu.run/test-utils';

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

async function turn(
  history: SessionHistory,
  ids: { ask: string; answer: string },
  text: { ask: string; answer: string },
  sessionId = CHAT_SESSION_ID,
): Promise<void> {
  await seedTranscriptEntry(history, sessionId, { id: ids.ask, origin: 'input',
    message: { role: 'user', content: text.ask } });
  await seedTranscriptEntry(history, sessionId, { id: ids.answer, origin: 'output',
    message: { role: 'assistant', content: text.answer } });
}

describe('the message count — the default chat alone', () => {
  test('counts the default session and no other tree', async () => {
    const s = setup();
    await turn(s.history, { ask: 'u1', answer: 'a1' }, { ask: 'first ask', answer: 'first answer' });
    await turn(s.history, { ask: 'm-u', answer: 'm-a' }, { ask: 'score this', answer: 'a score' }, 'mcts');

    expect(s.transcript.count()).toBe(2);
  });

  // MSG-COUNT-0927: the Agent tab and fork modal counted a rewound branch.
  test('counts the chat the head reads, not a branch a rewind left behind', async () => {
    const s = setup();
    await turn(s.history, { ask: 'u1', answer: 'a1' }, { ask: 'first ask', answer: 'first answer' });
    await seedTranscriptEntry(s.history, CHAT_SESSION_ID, { id: 'u2', origin: 'input', message: { role: 'user', content: 'second ask' } });
    await seedTranscriptEntry(s.history, CHAT_SESSION_ID, { id: 'a2', origin: 'output', message: { role: 'assistant', content: 'second answer' } });
    s.history.revertTo(CHAT_SESSION_ID, 'u2', () => {});

    expect(s.transcript.count()).toBe(2);

    await seedTranscriptEntry(s.history, CHAT_SESSION_ID, { id: 'u3', origin: 'input', message: { role: 'user', content: 'another ask' } });

    expect(s.transcript.count()).toBe(3);
  });

  // Owner 2026-09-28: a rewind deletes what it rewound; the chat is a list, so the count is its length.
  test('a rewind deletes the entries it rewound, and the next ask continues the list', async () => {
    const s = setup();
    await turn(s.history, { ask: 'u1', answer: 'a1' }, { ask: 'first ask', answer: 'first answer' });
    await seedTranscriptEntry(s.history, CHAT_SESSION_ID, { id: 'u2', origin: 'input', message: { role: 'user', content: 'second ask' } });
    await seedTranscriptEntry(s.history, CHAT_SESSION_ID, { id: 'a2', origin: 'output', message: { role: 'assistant', content: 'second answer' } });
    s.history.revertTo(CHAT_SESSION_ID, 'u2', () => {});

    const stored = () => s.sql<{ id: string }>`SELECT id FROM conversation_entries WHERE session_id=${CHAT_SESSION_ID} ORDER BY rowid`.map((row) => row.id);

    expect(stored()).toEqual(['u1', 'a1']);

    await seedTranscriptEntry(s.history, CHAT_SESSION_ID, { id: 'u3', origin: 'input', message: { role: 'user', content: 'another ask' } });

    expect(stored()).toEqual(['u1', 'a1', 'u3']);
    expect(s.transcript.entries().map((entry) => entry.id)).toEqual(['u1', 'a1', 'u3']);
    expect(s.transcript.count()).toBe(3);
  });

  // 2026-09-27: walking a 10k-entry chat took 4.4 s per status read; the count is now its newest position.
  test('the count is one indexed read of the newest position', async () => {
    const s = setup();
    await turn(s.history, { ask: 'u1', answer: 'a1' }, { ask: 'first ask', answer: 'first answer' });

    const asked: { strings: TemplateStringsArray; values: SqlValue[] }[] = [];

    const recording: SqlExecutor = <T = unknown>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] => {
      asked.push({ strings, values });

      return s.sql<T>(strings, ...values);
    };

    expect(readSessionTranscript(recording, s.actor, CHAT_SESSION_ID, null).count()).toBe(2);
    expect(asked).toHaveLength(1);
    const [count] = asked;

    if (count === undefined) throw new Error('the count asked nothing');

    const explain = [`EXPLAIN QUERY PLAN ${count.strings[0] ?? ''}`, ...count.strings.slice(1)];

    const plan = v.parse(v.array(v.object({ detail: v.string() })), s.sql(Object.assign(explain, { raw: explain }), ...count.values));

    expect(plan.map((row) => row.detail)).toEqual([expect.stringMatching(/^SEARCH conversation_entries USING (COVERING )?INDEX \S+ \(actor_id=\? AND session_id=\?\)$/)]);
  });

  test('an empty workspace counts nothing rather than failing', () => {
    const s = setup();
    expect(s.transcript.count()).toBe(0);
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

  test('a turn is named by its answer: the ask\'s id or an unknown one has no pair', async () => {
    const s = setup();
    await turn(s.history, { ask: 'u1', answer: 'a1' }, { ask: 'first ask', answer: 'first answer' });

    expect(await conversationTurnPair(s.transcript, 'u1')).toBeUndefined();
    expect(await conversationTurnPair(s.transcript, 'nobody')).toBeUndefined();
  });

  test('a sibling answer attributes to its own parent edge, not to the newest leaf', async () => {
    const s = setup();
    await turn(s.history, { ask: 'u1', answer: 'a1' }, { ask: 'first ask', answer: 'first answer' });
    await seedTranscriptEntry(s.history, CHAT_SESSION_ID, { id: 'sib', origin: 'output',
      message: { role: 'assistant', content: 'branch take' } });
    await seedTranscriptEntry(s.history, CHAT_SESSION_ID, { id: 'u2', origin: 'input',
      message: { role: 'user', content: 'second ask' } });

    const pair = present(await conversationTurnPair(s.transcript, 'sib'), 'the turn pair for sib');

    expect(pair.request).toBe('first answer');
    expect(pair.response).toBe('branch take');
  });

  test('an answer that roots its own chain reports a null request, not an absent pair', async () => {
    const s = setup();
    await seedTranscriptEntry(s.history, CHAT_SESSION_ID, { id: 'orphan', origin: 'output',
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
    expect(await conversationTurnPair(s.transcript, 'm-a')).toBeUndefined();
  });
});

describe('answersForDrainTurns — what a recovery finishes a reply with', () => {
  /** Stamped with the drain turn it came from, the only link to its answer. */
  async function drainAsk(s: Fixture, id: string, drainTurnId: string): Promise<void> {
    const reference = s.history.messages.insert(
      await s.history.messages.prepare({ role: 'user', content: `ask for ${drainTurnId}` }, id), 'input');

    s.transcript.appendUser(await s.transcript.prepareUser({
      id, turnId: drainTurnId, message: reference, metadata: { drainTurnId },
    }));
  }

  async function drainAnswer(s: Fixture, id: string, turnId: string, text: string): Promise<void> {
    s.history.messages.insert(await s.history.messages.prepare({ role: 'assistant', content: text }, id), 'output');
    s.transcript.appendAssistant(await s.transcript.prepareAssistant({ id, turnId, runId: turnId, parts: [{ messageId: id, partNo: 0 }], finalText: null }));
  }

  test('each named drain turn gets its answer, and an unanswered one is absent', async () => {
    const s = setup();
    await drainAsk(s, 'ask-1', 'drain-1');
    await drainAnswer(s, 'answer-1', 'drain-1', 'the job finished');
    await drainAsk(s, 'ask-2', 'drain-2');

    const answers = await answersForDrainTurns(s.transcript, ['drain-1', 'drain-2']);
    expect(answers).toEqual(new Map([['drain-1', 'the job finished']]));
  });

  test('an answer is found when the transcript is longer than the window entries() reads', async () => {
    const s = setup();

    // 9,998 older entries, then the ask and its answer: 10,000 in all, and one more pushes the oldest out.
    for (let at = 0; at < 4_999; at++) {
      await drainAsk(s, `old-ask-${String(at)}`, `old-${String(at)}`);
      await drainAnswer(s, `old-answer-${String(at)}`, `old-${String(at)}`, 'old');
    }

    await drainAsk(s, 'ask-1', 'drain-1');
    await drainAnswer(s, 'answer-1', 'drain-1', 'the job finished');
    await drainAsk(s, 'ask-later', 'drain-later');

    expect(await answersForDrainTurns(s.transcript, ['drain-1'])).toEqual(new Map([['drain-1', 'the job finished']]));
  });

  test('an empty answer is absent rather than delivered as nothing', async () => {
    const s = setup();
    await drainAsk(s, 'ask-1', 'drain-1');
    await drainAnswer(s, 'answer-1', 'drain-1', '   ');

    expect(await answersForDrainTurns(s.transcript, ['drain-1'])).toEqual(new Map());
  });
});
