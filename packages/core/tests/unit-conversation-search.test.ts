// Behavior tests for ConversationSearchStore, the zero-LLM transcript reader
// over the canonical `messages` table (the store both backends persist to).
import { describe, test, expect } from 'bun:test';
import { createTestSql, type TestSql } from '@kinu.run/test-utils';
import { ConversationSearchStore, initAllTables } from '../src/index';

interface Fixture { sql: TestSql['sql']; store: ConversationSearchStore }

let nextRow = 0;
function insert(sql: TestSql['sql'], sessionId: string, role: string, content: string, createdAt?: number): string {
  const id = `m-${++nextRow}-${sessionId}`;
  const ts = createdAt ?? 1_000_000 + nextRow * 1000;
  void sql`INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES (${id}, ${sessionId}, ${role}, ${content}, ${ts})`;
  return id;
}

function setup(): Fixture {
  const { sql, execRaw } = createTestSql();
  initAllTables(execRaw, sql);
  return { sql, store: new ConversationSearchStore(sql) };
}

describe('ConversationSearchStore.search', () => {
  test('backfills messages persisted before the index existed', () => {
    const { sql, store } = setup();
    insert(sql, 'alpha', 'user', 'we decided to deploy with wrangler to staging');
    insert(sql, 'alpha', 'assistant', 'staging deploy done via wrangler');
    const hits = store.search('wrangler staging');
    expect(hits.length).toBe(2);
    expect(hits[0]!.conversationId).toBe('alpha');
    expect(hits[0]!.snippet).toContain('[wrangler]');
  });

  test('indexes messages inserted after the index exists (trigger path)', () => {
    const { sql, store } = setup();
    expect(store.search('kubernetes')).toEqual([]);   // forces schema creation
    insert(sql, 'beta', 'user', 'how do I configure kubernetes ingress');
    const hits = store.search('kubernetes ingress');
    expect(hits.length).toBe(1);
    expect(hits[0]!.role).toBe('user');
    expect(hits[0]!.conversationId).toBe('beta');
  });

  test('ranks the denser match first and carries conversation/message refs', () => {
    const { sql, store } = setup();
    insert(sql, 'a', 'assistant', 'postgres mentioned once in passing among many other words here');
    const dense = insert(sql, 'b', 'assistant', 'postgres tuning: postgres vacuum and postgres indexes');
    const hits = store.search('postgres');
    expect(hits.length).toBe(2);
    expect(hits[0]!.messageId).toBe(dense);
    expect(hits[0]!.conversationId).toBe('b');
    expect(Number.isFinite(hits[0]!.createdAt)).toBe(true);
  });

  test('falls back to OR matching when the AND query has no joint hits', () => {
    const { sql, store } = setup();
    insert(sql, 's1', 'user', 'we migrated the billing service');
    insert(sql, 's2', 'user', 'the search index rebuild finished');
    const hits = store.search('billing rebuild');
    expect(hits.length).toBe(2);
  });

  test('excludes internal mcts rows and clamps limit', () => {
    const { sql, store } = setup();
    insert(sql, 'mcts', 'assistant', 'topicword inside the mcts tree');
    for (let i = 0; i < 15; i++) insert(sql, 'chat', 'user', `topicword number ${i}`);
    expect(store.search('topicword', 50).length).toBe(10);   // clamped to 10
    expect(store.search('topicword').every((hit) => hit.conversationId === 'chat')).toBe(true);
  });

  test('is safe for empty and FTS-hostile queries', () => {
    const { sql, store } = setup();
    insert(sql, 'chat', 'user', 'plain message');
    expect(store.search('')).toEqual([]);
    expect(store.search('"unbalanced (NEAR *')).toEqual([]);
  });
});

describe('ConversationSearchStore.scroll', () => {
  test('returns the anchored window in transcript order with edge counts', () => {
    const { sql, store } = setup();
    const ids = Array.from({ length: 9 }, (_, i) =>
      insert(sql, 'long', i % 2 === 0 ? 'user' : 'assistant', `message number ${i}`));
    const view = store.scroll(ids[4]!, 2)!;
    expect(view.conversationId).toBe('long');
    expect(view.messages.map((m) => m.content)).toEqual([
      'message number 2', 'message number 3', 'message number 4',
      'message number 5', 'message number 6',
    ]);
    expect(view.messages[2]!.anchor).toBe(true);
    expect(view.messagesBefore).toBe(2);   // messages 0,1 outside the window
    expect(view.messagesAfter).toBe(2);    // messages 7,8 outside the window
  });

  test('clips at conversation edges and never crosses archived roots', () => {
    const { sql, store } = setup();
    insert(sql, 'other', 'user', 'unrelated conversation');
    const first = insert(sql, 'short', 'user', 'first');
    insert(sql, 'short', 'assistant', 'second');
    const view = store.scroll(first, 5)!;
    expect(view.messages.map((m) => m.content)).toEqual(['first', 'second']);
    expect(view.messagesBefore).toBe(0);
    expect(view.messagesAfter).toBe(0);
  });

  test('returns null for an unknown anchor; long content truncates WITH a recipe', () => {
    const { sql, store } = setup();
    expect(store.scroll('nope')).toBeNull();
    const id = insert(sql, 'chat', 'assistant', 'x'.repeat(5000));
    const view = store.scroll(id)!;
    expect(view.messages[0]!.content).toContain('x'.repeat(700));
    expect(view.messages[0]!.content).toContain('[+4300 chars — pass max_chars to read the full message]');
  });

  test('scroll honours a caller max_chars — the read-back path is not capped', () => {
    const { sql, store } = setup();
    const id = insert(sql, 'chat', 'assistant', 'y'.repeat(5000));
    const view = store.scroll(id, 5, 10_000)!;
    expect(view.messages[0]!.content).toBe('y'.repeat(5000));
  });
});

describe('ConversationSearchStore.browse', () => {
  test('lists archived roots newest-active first with counts and previews', () => {
    const { sql, store } = setup();
    insert(sql, 'old', 'user', 'old kickoff question', 1000);
    insert(sql, 'old', 'assistant', 'old answer', 2000);
    insert(sql, 'new', 'user', 'new kickoff question', 3000);
    insert(sql, 'mcts', 'user', 'tree node', 9000);
    const conversations = store.browse();
    expect(conversations.map((conversation) => conversation.conversationId)).toEqual(['new', 'old']);
    expect(conversations[1]!.messageCount).toBe(2);
    expect(conversations[1]!.startedAt).toBe(1000);
    expect(conversations[1]!.lastActiveAt).toBe(2000);
    expect(conversations[1]!.preview).toBe('old kickoff question');
  });
});
