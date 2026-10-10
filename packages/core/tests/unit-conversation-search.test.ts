// ConversationSearchStore, seeded through `SessionHistory.record` so text reaches the index only via `transcript.project`.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { ConversationSearchStore, createAgentStores, invalidateConversationSearchIndex, type AgentStores, type SessionTranscriptReader } from '../src/index';
import { createTestActorsOver, seedTranscriptEntry, present } from '@kinu.run/test-utils';

function setup() {
  const { rt, stores } = createTestRuntime();
  const store = stores.conversationSearch;
  let seq = 0;

  const record = async (sessionId: string, role: 'user' | 'assistant', text: string): Promise<string> => {
    const id = `entry-${++seq}`;
    await seedTranscriptEntry(stores.history, sessionId, {
      id, message: { role, content: text },
      origin: role === 'user' ? 'input' : 'output',
    });

    return id;
  };

  return { rt, store, record };
}

function heldProjection(history: AgentStores['history'], entered: () => void, release: Promise<void>): (sessionId: string) => SessionTranscriptReader {
  return (sessionId) => {
    const reader = history.transcript(sessionId);
    const project = reader.project.bind(reader);

    reader.project = async (id) => {
      entered();
      await release;

      return await project(id);
    };

    return reader;
  };
}

describe('ConversationSearchStore.search', () => {
  test('interleaved actor projections cannot publish each other\'s private conversation', async () => {
    const { rt, stores, db } = createTestRuntime();
    const actors = createTestActorsOver(db, { name: rt.actor.name });
    const peer = actors.sibling('search-peer');

    const peerStores = createAgentStores(() => rt.storage.sql, () => peer, rt.storage.transactionSync,
      async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/peer/.kinu/context' }));

    await seedTranscriptEntry(stores.history, 'chat', { id: 'private-main', message: { role: 'user', content: 'shared confidential alpha' }, origin: 'input' });
    await seedTranscriptEntry(peerStores.history, 'chat', { id: 'private-peer', message: { role: 'user', content: 'shared confidential beta' }, origin: 'input' });

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const mainSearch = new ConversationSearchStore(rt.storage.sql, rt.actor, heldProjection(stores.history, entered.resolve, release.promise), rt.storage.transactionSync);
    const peerSearch = new ConversationSearchStore(rt.storage.sql, peer, (sessionId) => peerStores.history.transcript(sessionId), rt.storage.transactionSync);
    const readingMain = mainSearch.search('shared');

    try {
      await entered.promise;

      const peerHits = await peerSearch.search('shared');

      release.resolve();

      const mainHits = await readingMain;

      expect(peerHits.map((hit) => hit.messageId)).toEqual(['private-peer']);
      expect(mainHits.map((hit) => hit.messageId)).toEqual(['private-main']);
    } finally {
      release.resolve();
      await readingMain;
      db.close();
    }
  });

  test('concurrent refreshes index one canonical row only once', async () => {
    const { rt, stores, db } = createTestRuntime();

    await seedTranscriptEntry(stores.history, 'chat', { id: 'one-entry', message: { role: 'user', content: 'unique indexed subject' }, origin: 'input' });

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const first = new ConversationSearchStore(rt.storage.sql, rt.actor, heldProjection(stores.history, entered.resolve, release.promise), rt.storage.transactionSync);
    const second = new ConversationSearchStore(rt.storage.sql, rt.actor, (sessionId) => stores.history.transcript(sessionId), rt.storage.transactionSync);
    const readingFirst = first.search('unique');

    try {
      await entered.promise;
      await second.search('unique');
      release.resolve();
      await readingFirst;

      expect(rt.storage.sql<{ count: number }>`SELECT COUNT(*) AS count FROM conversation_fts WHERE msg_id = 'one-entry'`[0]?.count).toBe(1);
    } finally {
      release.resolve();
      await readingFirst;
      db.close();
    }
  });

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
    expect(capped.messages[0].content).toContain('[+4300 chars: pass max_chars to read the full message]');
    expect(full.messages[0].content).toBe('x'.repeat(5000));
  });
});

describe('ConversationSearchStore.browse', () => {
  test('lists sessions newest-active first with counts and previews', async () => {
    const { rt, store, record } = setup();
    await record('old', 'user', 'old kickoff question');
    await record('old', 'assistant', 'old answer');
    await record('new', 'user', 'new kickoff question');
    // `record` wall-clock time does not separate same-millisecond writes; activity order does.
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
  test('invalidation discards the index and rebuilds it from the canonical store', async () => {
    const { rt, store, record } = setup();
    await record('chat', 'user', 'canonical subject matter');
    expect((await store.search('canonical')).length).toBe(1);
    // A projection row the rowid watermark cannot see; only invalidation clears it.
    void rt.storage.sql`INSERT INTO conversation_fts (content, actor_id, msg_id, session_id, role, created_at)
      VALUES ('stale ghost text', ${rt.actor.actorId}, 'ghost', 'chat', 'user', 1000)`;
    expect((await store.search('ghost')).map((hit) => hit.messageId)).toEqual(['ghost']);

    invalidateConversationSearchIndex(rt.storage.sql, rt.actor.actorId);
    expect(await store.search('ghost')).toEqual([]);
    expect((await store.search('canonical')).length).toBe(1);
  });
});
