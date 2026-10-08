// The `memory` tool's conversation operations over the same ConversationSearchStore on both backends.
import { describe, test, expect } from 'bun:test';
import { seedTranscriptEntry, toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';
import {
  buildBuiltinTools,
  type JsonValue,
} from '../src/index';
import { conversationsFor, createTestRuntime } from './helpers';
import type { JsonObject } from '../src/utils/json';

function setup() {
  const { rt, stores } = createTestRuntime();
  const tools = buildBuiltinTools({ rt, conversations: conversationsFor(rt, stores.history) });
  const memoryExec = toolExecute<JsonObject, JsonValue>(tools.memory);
  let row = 0;

  // One message and its transcript entry published together; `recorded_at` is wall-clock, so it is set explicitly.
  const insert = async (conversationId: string, role: 'user' | 'assistant', content: string): Promise<string> => {
    const id = `m-${++row}`;
    const recordedAt = 1_000_000 + row * 1000;
    await seedTranscriptEntry(stores.history, conversationId, {
      id, message: { role, content },
      origin: role === 'user' ? 'input' : 'output',
    });
    void rt.storage.sql`UPDATE conversation_entries SET recorded_at = ${recordedAt}
      WHERE actor_id = ${rt.actor.actorId} AND session_id = ${conversationId} AND id = ${id}`;

    return id;
  };

  return { memoryExec, insert };
}

describe('memory tool — conversations', () => {
  const SearchResultSchema = v.object({
    hits: v.array(v.object({
      messageId: v.string(),
      conversationId: v.string(),
      snippet: v.string(),
    })),
  });

  const ScrollResultSchema = v.object({
    messages: v.array(v.object({
      content: v.string(),
      anchor: v.optional(v.literal(true)),
    })),
  });

  const BrowseResultSchema = v.object({
    conversations: v.array(v.object({ conversationId: v.string(), preview: v.string() })),
  });

  test('searches past transcripts and returns ranked hits with refs', async () => {
    const { memoryExec, insert } = setup();
    const id = await insert('proj', 'assistant', 'we shipped the cloudflare tunnel fix yesterday');
    await insert('proj', 'user', 'unrelated chatter');

    const res = v.parse(
      SearchResultSchema,
      await memoryExec({ op: 'searchConversations', query: 'cloudflare tunnel' }),
    );

    expect(res.hits.length).toBe(1);
    expect(res.hits[0].messageId).toBe(id);
    expect(res.hits[0].conversationId).toBe('proj');
  });

  test('reads a window around a hit', async () => {
    const { memoryExec, insert } = setup();
    await insert('proj', 'user', 'before');
    const anchor = await insert('proj', 'assistant', 'anchor message');
    await insert('proj', 'user', 'after');

    const res = v.parse(
      ScrollResultSchema,
      await memoryExec({ op: 'readConversation', messageId: anchor, window: 1 }),
    );

    expect(res.messages.map((m) => m.content)).toEqual(['before', 'anchor message', 'after']);
    expect(res.messages[1].anchor).toBe(true);
  });

  test('lists archived conversations, newest first', async () => {
    const { memoryExec, insert } = setup();
    await insert('a', 'user', 'first conversation kickoff');
    await insert('b', 'user', 'second conversation kickoff');
    const res = v.parse(BrowseResultSchema, await memoryExec({ op: 'listConversations' }));
    expect(res.conversations.map((conversation) => conversation.conversationId)).toEqual(['b', 'a']);
    expect(res.conversations[1].preview).toBe('first conversation kickoff');
  });

  test('returns a clean error for an unknown anchor id', async () => {
    const { memoryExec } = setup();
    await expect(memoryExec({ op: 'readConversation', messageId: 'missing' }))
      .rejects.toMatchObject({ code: 'missing', message: expect.stringContaining('missing') });
  });

  test('a missing required field is refused by name', async () => {
    const { memoryExec } = setup();
    await expect(memoryExec({ op: 'search' })).rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('"query" is required') });
    await expect(memoryExec({ op: 'note' })).rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('"content" is required') });
  });
});
