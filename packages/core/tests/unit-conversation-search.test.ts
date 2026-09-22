// Behaviour tests for ConversationSearchStore, the zero-LLM recall surface over
// the canonical conversation store. Rows are seeded the way a runtime writes
// them — `SessionHistory.record` publishes a message and its transcript entry
// together — so the text these tests search for only exists in canonical
// message parts, and reaches the index through `transcript.project`.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { ConversationSearchStore, invalidateConversationSearchIndex } from '../src/index';
import { present } from '@kinu.run/test-utils';

function setup() {
  const { rt, stores } = createTestRuntime();
  const store = new ConversationSearchStore(rt.storage.sql, rt.actor, (sessionId) => stores.history.transcript(sessionId));
  let seq = 0;

  const record = async (sessionId: string, role: 'user' | 'assistant', text: string): Promise<string> => {
    const id = `entry-${++seq}`;
    await stores.history.record(sessionId, {
      id, parentId: null, message: { role, content: text },
      origin: role === 'user' ? 'input' : 'output',
    });

    return id;
  };

  return { rt, store, record };
}

describe('ConversationSearchStore.search', () => {
  test('ranks the denser match first and carries the entry\'s session, id and role', async () => {
    const { store, record } = setup();
    await record('a', 'assistant', 'postgres mentioned once in passing among many other words here');
    const dense = await record('b', 'assistant', 'postgres tuning: postgres vacuum and postgres indexes');

    const hits = await store.search('postgres');
    expect(hits.length).toBe(2);
    expect(hits[0].messageId).toBe(dense);
    expect(hits[0].conversationId).toBe('b');
    expect(hits[0].role).toBe('assistant');
    expect(hits[0].snippet).toContain('[postgres]');
  });

  test('entries recorded after the index exists are indexed by the next search', async () => {
    const { store, record } = setup();
    expect(await store.search('kubernetes')).toEqual([]);
    const later = await record('beta', 'user', 'how do I configure kubernetes ingress');

    expect((await store.search('kubernetes ingress')).map((hit) => hit.messageId)).toEqual([later]);
  });

  test('a partial-term page is filled with ranked partial matches behind the strict hit', async () => {
    const { store, record } = setup();
    const strict = await record('s1', 'user', 'wrangler staging deploy succeeded');
    const partialA = await record('s2', 'user', 'wrangler tail is noisy');
    const partialB = await record('s3', 'user', 'staging database was reseeded');
    await record('s4', 'user', 'unrelated kubernetes ingress question');

    const hits = await store.search('wrangler staging', 5);
    expect(hits[0].messageId).toBe(strict);
    expect(hits.map((hit) => hit.messageId).slice(1).sort()).toEqual([partialA, partialB].sort());
  });

  test('is safe for empty and FTS-hostile queries', async () => {
    const { store, record } = setup();
    await record('chat', 'user', 'plain message');
    expect(await store.search('')).toEqual([]);
    expect(await store.search('"unbalanced (NEAR *')).toEqual([]);
  });
});

describe('ConversationSearchStore.scroll', () => {
  test('returns the anchored window in transcript order with edge counts', async () => {
    const { store, record } = setup();
    const ids: string[] = [];

    for (let i = 0; i < 9; i++) ids.push(await record('long', i % 2 === 0 ? 'user' : 'assistant', `message number ${i}`));

    const view = present(await store.scroll(ids[4], 2), 'the window around the fifth message');

    expect(view.conversationId).toBe('long');
    expect(view.messages.map((message) => message.content)).toEqual([
      'message number 2', 'message number 3', 'message number 4',
      'message number 5', 'message number 6',
    ]);
    expect(view.messages[2].anchor).toBe(true);
    expect(view.messagesBefore).toBe(2);
    expect(view.messagesAfter).toBe(2);
  });

  test('a window never crosses into another session', async () => {
    const { store, record } = setup();
    await record('other', 'user', 'unrelated conversation');
    const first = await record('short', 'user', 'first');
    await record('short', 'assistant', 'second');

    const view = present(await store.scroll(first, 5), 'the window around the first message');

    expect(view.messages.map((message) => message.content)).toEqual(['first', 'second']);
    expect(view.messagesBefore).toBe(0);
    expect(view.messagesAfter).toBe(0);
  });

  test('returns null for an anchor no entry holds', async () => {
    const { store, record } = setup();
    await record('chat', 'user', 'anything');
    expect(await store.scroll('nope')).toBeNull();
  });

  test('truncates to the default budget WITH a recipe, and honours a caller max_chars', async () => {
    const { store, record } = setup();
    const id = await record('chat', 'assistant', 'x'.repeat(5000));

    const capped = present(await store.scroll(id), 'the truncated window');
    const full = present(await store.scroll(id, 5, 10_000), 'the untruncated window');

    expect(capped.messages[0].content).toContain('x'.repeat(700));
    expect(capped.messages[0].content).toContain('[+4300 chars — pass max_chars to read the full message]');
    expect(full.messages[0].content).toBe('x'.repeat(5000));
  });
});

describe('ConversationSearchStore.browse', () => {
  test('lists sessions newest-active first with counts and previews', async () => {
    const { rt, store, record } = setup();
    await record('old', 'user', 'old kickoff question');
    await record('old', 'assistant', 'old answer');
    await record('new', 'user', 'new kickoff question');
    // `record` stamps wall-clock time, which does not separate writes landing
    // in the same millisecond. The activity order under test does.
    void rt.storage.sql`UPDATE conversation_entries SET recorded_at = 1000 WHERE session_id = 'old' AND role = 'user'`;
    void rt.storage.sql`UPDATE conversation_entries SET recorded_at = 2000 WHERE session_id = 'old' AND role = 'assistant'`;
    void rt.storage.sql`UPDATE conversation_entries SET recorded_at = 3000 WHERE session_id = 'new'`;

    const conversations = await store.browse();
    expect(conversations.map((conversation) => conversation.conversationId)).toEqual(['new', 'old']);
    expect(conversations[1].messageCount).toBe(2);
    expect(conversations[1].startedAt).toBe(1000);
    expect(conversations[1].lastActiveAt).toBe(2000);
    expect(conversations[1].preview).toBe('old kickoff question');
  });
});

describe('the derived index', () => {
  test('excludes the mcts session from search and browse, and still anchors a scroll there', async () => {
    const { store, record } = setup();
    const node = await record('mcts', 'assistant', 'topicword inside the search tree');
    await record('chat', 'user', 'topicword in the conversation');

    expect((await store.search('topicword')).map((hit) => hit.conversationId)).toEqual(['chat']);
    expect((await store.browse()).map((conversation) => conversation.conversationId)).toEqual(['chat']);
    expect(present(await store.scroll(node), 'the window around the tree node').conversationId).toBe('mcts');
  });

  test('invalidation discards the index and rebuilds it from the canonical store', async () => {
    const { rt, store, record } = setup();
    await record('chat', 'user', 'canonical subject matter');
    expect((await store.search('canonical')).length).toBe(1);
    // A projection row no conversation entry backs: what a rewrite the rowid
    // watermark cannot see leaves behind. Nothing about it is observable to
    // the watermark, so only invalidation clears it.
    void rt.storage.sql`INSERT INTO conversation_fts (content, msg_id, session_id, role, created_at)
      VALUES ('stale ghost text', 'ghost', 'chat', 'user', 1000)`;
    expect((await store.search('ghost')).map((hit) => hit.messageId)).toEqual(['ghost']);

    invalidateConversationSearchIndex(rt.storage.sql);
    expect(await store.search('ghost')).toEqual([]);
    expect((await store.search('canonical')).length).toBe(1);
  });
});
