/**
 * The hosted root's transcript store, over the SDK's real session provider.
 *
 * Every write goes through `AgentSessionProvider`, so what these cases pin is
 * the SDK's own tree discipline seen through core's `TranscriptStore` contract:
 * a user row is idempotent on its id, the chain runs opening row → steer →
 * steer → answer, an attachment rides the row as a file part, the streamed
 * UIMessage is what the answer row persists, and the newest-first restore
 * reads the text the client wrote.
 */
import { describe, expect, test } from 'bun:test';
import { createTestActorsOver, createTestSql } from '@kinu.run/test-utils';
import { STEER_METADATA_KEY, STEER_STEP_METADATA_KEY, uiMessageText } from '@kinu.run/core';
import { AssistantMessagesTranscript } from '../src/chat-transcript';

function transcript() {
  const { sql, db } = createTestSql();
  const actor = createTestActorsOver(db).main;
  const store = new AssistantMessagesTranscript({ sql }, sql, actor);

  const rows = () => db.query<{ id: string; parent_id: string | null; role: string; content: string }, []>(
    'SELECT id, parent_id, role, content FROM assistant_messages ORDER BY rowid',
  ).all();

  return { store, rows, db };
}

describe('AssistantMessagesTranscript', () => {
  test('the opening row parents to the latest leaf and a re-append is ignored', () => {
    const { store, rows } = transcript();
    store.appendUser({ id: 'u1', text: 'one' });
    store.appendAssistant({ id: 'a1', parentId: 'u1', text: 'answer one' });
    store.appendUser({ id: 'u2', text: 'two' });
    store.appendUser({ id: 'u2', text: 'two again' });

    expect(rows().map((row) => [row.id, row.parent_id, row.role])).toEqual([
      ['u1', null, 'user'], ['a1', 'u1', 'assistant'], ['u2', 'a1', 'user'],
    ]);
    expect(store.has('u2')).toBe(true);
    expect(store.has('u3')).toBe(false);
    expect(JSON.parse(rows()[2]!.content)).toEqual({ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'two' }] });
  });

  test('a steer row carries its stamp and its attachment, chained under the row before it', () => {
    const { store, rows } = transcript();
    store.appendUser({ id: 'u1', text: 'one' });
    const metadata = { [STEER_METADATA_KEY]: true, [STEER_STEP_METADATA_KEY]: 1 };
    const file = { filename: 'note.txt', mediaType: 'text/plain', url: 'data:text/plain;base64,aGk=' };
    store.appendUser({ id: 's1', text: 'steer one', parentId: 'u1', metadata, files: [file] });
    store.appendUser({ id: 's2', text: 'steer two', parentId: 's1', metadata });
    store.appendAssistant({ id: 'a1', parentId: 's2', text: 'answer' });

    expect(rows().map((row) => [row.id, row.parent_id])).toEqual([['u1', null], ['s1', 'u1'], ['s2', 's1'], ['a1', 's2']]);
    expect(JSON.parse(rows()[1]!.content)).toEqual({
      id: 's1', role: 'user', metadata,
      parts: [{ type: 'file', url: file.url, mediaType: file.mediaType, filename: file.filename }, { type: 'text', text: 'steer one' }],
    });
  });

  test('the answer row is the streamed UIMessage when the transport has one, else the text', () => {
    const { store, rows } = transcript();
    store.appendUser({ id: 'u1', text: 'read it' });

    const streamed = {
      id: 'a1', role: 'assistant',
      parts: [{ type: 'step-start' }, { type: 'tool-file', toolCallId: 'c1', state: 'output-available', input: {}, output: 'x' }, { type: 'text', text: 'done' }],
    };

    const source = (id: string) => id === 'a1' ? streamed : null;
    store.answersFrom({ answer: source, streamed: source });
    store.appendAssistant({ id: 'a1', parentId: 'u1', text: 'done' });
    store.appendAssistant({ id: 'a2', parentId: 'a1', text: 'plain' });

    expect(JSON.parse(rows()[1]!.content)).toEqual(streamed);
    expect(JSON.parse(rows()[2]!.content)).toEqual({ id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'plain' }] });
  });

  test('a narrated multi-step answer stores the answer, keeping what the turn did', () => {
    const { store, rows } = transcript();
    store.appendUser({ id: 'u1', text: 'build the slate' });

    // What a ten-step turn streams: prose before each tool call, then the
    // answer it stopped on. Every text part here is the client's live view.
    const streamed = {
      id: 'a1', role: 'assistant',
      parts: [
        { type: 'text', text: "I'll look at the workspace first." },
        { type: 'step-start' },
        { type: 'tool-file', toolCallId: 'c1', state: 'output-available', input: {}, output: 'x' },
        { type: 'text', text: 'Files in place. Starting the preview.' },
        { type: 'step-start' },
        { type: 'text', text: 'pong\n\nhttps://preview.invalid/' },
      ],
    };

    const source = (id: string) => id === 'a1' ? streamed : null;
    store.answersFrom({ answer: source, streamed: source });
    store.appendAssistant({ id: 'a1', parentId: 'u1', text: 'pong\n\nhttps://preview.invalid/' });

    // The row holds the answer as its one text part — what a reader that
    // projects the row to text reads — with the tool call and the step
    // markers it did the work through still on it.
    expect(JSON.parse(rows()[1]!.content)).toEqual({
      id: 'a1', role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'tool-file', toolCallId: 'c1', state: 'output-available', input: {}, output: 'x' },
        { type: 'step-start' },
        { type: 'text', text: 'pong\n\nhttps://preview.invalid/' },
      ],
    });
    expect(uiMessageText(rows()[1]!.content)).toBe('pong\n\nhttps://preview.invalid/');
  });

  test('the restore reads user and assistant text newest first, and the operator check reads authorship', () => {
    const { store } = transcript();
    expect(store.operatorSpoke()).toBe(false);
    store.appendUser({ id: 'programmatic:g', text: 'genesis', metadata: { kinuAuthor: 'harness' } });
    expect(store.operatorSpoke()).toBe(false);
    store.appendUser({ id: 'u1', text: 'hello' });
    store.appendAssistant({ id: 'a1', parentId: 'u1', text: 'hi' });

    expect(store.newestFirst()).toEqual([
      { role: 'assistant', content: 'hi' }, { role: 'user', content: 'hello' }, { role: 'user', content: 'genesis' },
    ]);
    expect(store.operatorSpoke()).toBe(true);
  });
});
