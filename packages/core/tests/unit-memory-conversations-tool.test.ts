// Behavior tests for the `memory` tool's `conversations` action over the same
// ConversationSearchStore on both backends.
import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';
import {
  buildBuiltinTools,
  type MemoryToolInput,
  type JsonValue,
} from '../src/index';
import { createTestRuntime } from './helpers';

function setup() {
  const { rt, stores } = createTestRuntime();
  const tools = buildBuiltinTools({ rt, history: stores.history });
  const memoryExec = toolExecute<MemoryToolInput, JsonValue>(tools.memory);
  let row = 0;

  // The canonical write both backends make: one message and its transcript
  // entry, published together. `recorded_at` is wall-clock, so the stamp the
  // browse order reads is set explicitly.
  const insert = async (conversationId: string, role: 'user' | 'assistant', content: string): Promise<string> => {
    const id = `m-${++row}`;
    const recordedAt = 1_000_000 + row * 1000;
    await stores.history.record(conversationId, {
      id, parentId: null, message: { role, content },
      origin: role === 'user' ? 'input' : 'output',
    });
    void rt.storage.sql`UPDATE conversation_entries SET recorded_at = ${recordedAt}
      WHERE actor_id = ${rt.actor.actorId} AND session_id = ${conversationId} AND id = ${id}`;

    return id;
  };

  return { memoryExec, insert };
}

describe('memory tool — conversations action', () => {
  const SearchResultSchema = v.object({
    mode: v.string(),
    hits: v.array(v.object({
      messageId: v.string(),
      conversationId: v.string(),
      snippet: v.string(),
    })),
  });

  const ScrollResultSchema = v.object({
    mode: v.string(),
    messages: v.array(v.object({
      content: v.string(),
      anchor: v.optional(v.literal(true)),
    })),
  });

  const BrowseResultSchema = v.object({
    mode: v.string(),
    conversations: v.array(v.object({ conversationId: v.string(), preview: v.string() })),
  });

  test('searches past transcripts and returns ranked hits with refs', async () => {
    const { memoryExec, insert } = setup();
    const id = await insert('proj', 'assistant', 'we shipped the cloudflare tunnel fix yesterday');
    await insert('proj', 'user', 'unrelated chatter');

    const res = v.parse(
      SearchResultSchema,
      await memoryExec({ action: 'conversations', query: 'cloudflare tunnel' }),
    );

    expect(res.mode).toBe('search');
    expect(res.hits.length).toBe(1);
    expect(res.hits[0].messageId).toBe(id);
    expect(res.hits[0].conversationId).toBe('proj');
  });

  test('scrolls a window around a hit when around_message_id is set', async () => {
    const { memoryExec, insert } = setup();
    await insert('proj', 'user', 'before');
    const anchor = await insert('proj', 'assistant', 'anchor message');
    await insert('proj', 'user', 'after');

    const res = v.parse(
      ScrollResultSchema,
      await memoryExec({ action: 'conversations', around_message_id: anchor, window: 1 }),
    );

    expect(res.mode).toBe('scroll');
    expect(res.messages.map((m) => m.content)).toEqual(['before', 'anchor message', 'after']);
    expect(res.messages[1].anchor).toBe(true);
  });

  test('browses archived conversation roots when no query or anchor is given', async () => {
    const { memoryExec, insert } = setup();
    await insert('a', 'user', 'first conversation kickoff');
    await insert('b', 'user', 'second conversation kickoff');
    const res = v.parse(BrowseResultSchema, await memoryExec({ action: 'conversations' }));
    expect(res.mode).toBe('browse');
    expect(res.conversations.map((conversation) => conversation.conversationId)).toEqual(['b', 'a']);
    expect(res.conversations[1].preview).toBe('first conversation kickoff');
  });

  test('returns a clean error for an unknown anchor id', async () => {
    const { memoryExec } = setup();
    await expect(memoryExec({ action: 'conversations', around_message_id: 'missing' }))
      .rejects.toMatchObject({ code: 'missing', message: expect.stringContaining('missing') });
  });

  test('save and search actions are unchanged', async () => {
    const { memoryExec } = setup();
    await expect(memoryExec({ action: 'search' })).rejects.toThrow('memory.search requires `query`.');
    await expect(memoryExec({ action: 'save' })).rejects.toThrow('memory.save requires `content`.');
  });
});
