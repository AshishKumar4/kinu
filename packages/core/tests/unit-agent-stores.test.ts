import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createAgentStores } from '../src/state/agent-stores';
import { initRunEventTables } from '../src/events/recorder';
import { makeSql, makeExecRaw, createTestActor } from './helpers';

describe('createAgentStores', () => {
  test('does not reach Durable Object SQL before its initializer can finish', () => {
    const db = new Database(':memory:');

    try {
      let calls = 0;
      createAgentStores(() => {
        calls += 1;

        return makeSql(db);
      },
        () => { throw new Error('Actor identity is not ready'); }, write => db.transaction(write)());
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
      const stores = createAgentStores(() => sql, () => actor, write => db.transaction(write)());
      let seen = 0;
      stores.eventRecorder.observe(() => { seen += 1; });
      stores.eventRecorder.emit('run-1', { type: 'run_start', agentId: 'a' });
      expect(seen).toBe(1);
    } finally { db.close(); }
  });
});
