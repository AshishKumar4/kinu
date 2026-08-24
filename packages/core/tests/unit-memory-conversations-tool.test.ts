// Behavior tests for the `memory` tool's `conversations` action over the same
// ConversationSearchStore on both backends.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime, toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';
import {
  buildBuiltinTools,
  initAllTables,
  type MemoryToolInput,
  type JsonValue,
} from '../src/index';

function setup() {
  const { rt, testSql } = createTestRuntime();
  initAllTables(testSql.execRaw, testSql.sql);
  const tools = buildBuiltinTools({ rt });
  const memoryExec = toolExecute<MemoryToolInput, JsonValue>(tools.memory);
  let row = 0;
  const insert = (conversationId: string, role: string, content: string): string => {
    const id = `m-${++row}`;
    void testSql.sql`INSERT INTO messages (id, session_id, role, content, created_at)
                VALUES (${id}, ${conversationId}, ${role}, ${content}, ${1_000_000 + row * 1000})`;
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
    const id = insert('proj', 'assistant', 'we shipped the cloudflare tunnel fix yesterday');
    insert('proj', 'user', 'unrelated chatter');
    const res = v.parse(
      SearchResultSchema,
      await memoryExec({ action: 'conversations', query: 'cloudflare tunnel' }),
    );
    expect(res.mode).toBe('search');
    expect(res.hits.length).toBe(1);
    expect(res.hits[0]!.messageId).toBe(id);
    expect(res.hits[0]!.conversationId).toBe('proj');
  });

  test('scrolls a window around a hit when around_message_id is set', async () => {
    const { memoryExec, insert } = setup();
    insert('proj', 'user', 'before');
    const anchor = insert('proj', 'assistant', 'anchor message');
    insert('proj', 'user', 'after');
    const res = v.parse(
      ScrollResultSchema,
      await memoryExec({ action: 'conversations', around_message_id: anchor, window: 1 }),
    );
    expect(res.mode).toBe('scroll');
    expect(res.messages.map((m) => m.content)).toEqual(['before', 'anchor message', 'after']);
    expect(res.messages[1]!.anchor).toBe(true);
  });

  test('browses archived conversation roots when no query or anchor is given', async () => {
    const { memoryExec, insert } = setup();
    insert('a', 'user', 'first conversation kickoff');
    insert('b', 'user', 'second conversation kickoff');
    const res = v.parse(BrowseResultSchema, await memoryExec({ action: 'conversations' }));
    expect(res.mode).toBe('browse');
    expect(res.conversations.map((conversation) => conversation.conversationId)).toEqual(['b', 'a']);
    expect(res.conversations[1]!.preview).toBe('first conversation kickoff');
  });

  test('returns a clean error for an unknown anchor id', async () => {
    const { memoryExec } = setup();
    const res = v.parse(
      v.object({ error: v.string() }),
      await memoryExec({ action: 'conversations', around_message_id: 'missing' }),
    );
    expect(res.error).toContain('missing');
  });

  test('save and search actions are unchanged', async () => {
    const { memoryExec } = setup();
    expect(await memoryExec({ action: 'search' })).toBe('memory.search requires `query`.');
    expect(await memoryExec({ action: 'save' })).toBe('memory.save requires `content`.');
  });
});
