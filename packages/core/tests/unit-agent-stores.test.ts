import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createMemoryVfs } from '@kinu.run/test-utils';
import { createAgentStores } from '../src/state/agent-stores';
import { initRunEventTables } from '../src/events/recorder';
import { ConversationSearchStore } from '../src/memory/conversation-search';
import { makeSql, makeExecRaw, createTestActor } from './helpers';

const files = async () => ({ vfs: createMemoryVfs().vfs, artifactDirectory: '/actor/.kinu/context' });

describe('createAgentStores', () => {
  test('conversation tools share the actor-owned search instance', () => {
    const db = new Database(':memory:');

    try {
      const sql = makeSql(db);
      const actor = createTestActor(sql, makeExecRaw(db), crypto.randomUUID(), 'conversation-owner');
      const stores = createAgentStores(() => sql, () => actor, write => db.transaction(write)(), files);

      expect(stores.conversationSearch).toBeInstanceOf(ConversationSearchStore);
      expect(stores.conversationSearch).toBe(stores.conversationSearch);
    } finally { db.close(); }
  });

  test('does not reach Durable Object SQL before its initializer can finish', () => {
    const db = new Database(':memory:');

    try {
      let calls = 0;
      createAgentStores(() => {
        calls += 1;

        return makeSql(db);
      },
        () => { throw new Error('Actor identity is not ready'); }, write => db.transaction(write)(), files);
      expect(calls).toBe(0);
    } finally { db.close(); }
  });

  test('a run-event listener survives re-reading the recorder', () => {
    const db = new Database(':memory:');

    try {
      const sql = makeSql(db);
      const execRaw = makeExecRaw(db);
      initRunEventTables(execRaw);
      const actor = createTestActor(sql, execRaw, crypto.randomUUID(), 'stores-test');
      const stores = createAgentStores(() => sql, () => actor, write => db.transaction(write)(), files);
      let seen = 0;
      stores.eventRecorder.observe(() => { seen += 1; });
      stores.eventRecorder.emit('run-1', { type: 'run_start', agentId: 'a' });
      expect(seen).toBe(1);
    } finally { db.close(); }
  });
});
