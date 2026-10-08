/** What the turn review reads besides the rating itself: the trivial-turn pre-filter and the provisional-lesson corroboration mechanics. */
import { compactToolCall } from '../src/evolution/tool-call-record';
import { describe, test, expect } from 'bun:test';
import { createTestActor, createTestWorkspace } from './helpers';
import { recordLesson, listLessons, corroborateLessonsForTurn } from '../src/evolution/lessons';
import { isTrivialTurn } from '../src/evolution/ratings';
import { SessionHistory } from '../src/session/history';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import type { ToolCallRecord } from '../src/evolution/types';

/** The production schema. */
function setup() {
  const ws = createTestWorkspace();

  // A real workspace actor, since `conversationTurnPair` scopes transcript entries by `actor_id`.
  const actor = createTestActor(ws.sql, ws.execRaw, 'ws-outcomes', 'outcomes');

  const history = new SessionHistory({
    sql: ws.sql, actor, transactionSync: write => ws.db.transaction(write)(),
    files: async () => ({ vfs: ws.vfs, artifactDirectory: '/actor/.kinu/context' }),
  });

  return { ...ws, actor, history, transcript: history.transcript(CHAT_SESSION_ID) };
}

describe('isTrivialTurn — the LLM-call pre-filter', () => {
  const turn = (userMessage: string, toolCalls: ToolCallRecord[] = []) =>
    ({ userMessage, toolCalls });

  test('greetings and acknowledgements are trivial', () => {
    for (const msg of ['hi', 'Hey!', 'thanks', 'Thank you!!', 'ok', 'cool', 'good morning', 'bye']) {
      expect(isTrivialTurn(turn(msg))).toBe(true);
    }
  });

  test('real requests are not trivial, even short ones with a question', () => {
    expect(isTrivialTurn(turn('why?'))).toBe(false);
    expect(isTrivialTurn(turn('Refactor the auth module to use the new token store'))).toBe(false);
  });

  test('a turn that ran tools is never trivial', () => {
    expect(isTrivialTurn(turn('ok', [compactToolCall({ name: 'eval', args: {}, result: 1 })]))).toBe(false);
  });
});

describe('lessons ledger — provisional until corroborated', () => {
  test("the user's own negative on a tied turn corroborates provisional lessons", () => {
    const { sql, actor } = setup();
    recordLesson(sql, actor, { turnIds: ['m7'], text: 'always check the year', source: 'turn_reflection', status: 'provisional' });
    recordLesson(sql, actor, { turnIds: ['m8'], text: 'unrelated lesson', source: 'turn_reflection', status: 'provisional' });

    const upgraded = corroborateLessonsForTurn(sql, actor, 'm7', 999);
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0].text).toBe('always check the year');
    expect(upgraded[0].status).toBe('corroborated');

    expect(listLessons(sql, actor, { status: 'corroborated' })).toHaveLength(1);
    expect(listLessons(sql, actor, { status: 'provisional' })).toHaveLength(1);
    // Idempotent: a second negative on the same turn upgrades nothing new.
    expect(corroborateLessonsForTurn(sql, actor, 'm7')).toHaveLength(0);
  });

  test('session lessons tied to a window corroborate from any window turn', () => {
    const { sql, actor } = setup();
    recordLesson(sql, actor, { turnIds: ['t1', 't2', 't3'], text: 'window pattern', source: 'session_reflection', status: 'provisional' });
    expect(corroborateLessonsForTurn(sql, actor, 't2')).toHaveLength(1);
  });
});
