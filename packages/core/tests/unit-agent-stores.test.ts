// createAgentStores — the SQL-derived store set both backends inherit.
//
// This runs ONCE against the shared implementation. Before it existed, the CLI
// constructed these seven eagerly in its constructor and CF lazily in seven
// getters over `boundSql`, so the two properties the backends actually depend on
// — that reading a store never re-builds it, and that building the bundle never
// touches SQL — were asserted nowhere and held by coincidence on each side.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createAgentStores, type AgentStores } from '../src/state/agent-stores';
import { initRunEventTables } from '../src/events/recorder';
import { makeSql, makeExecRaw } from './helpers';

/** Every store on the bundle, so a store added to the interface without being
 *  named here fails the count assertion below rather than going untested. */
const STORE_KEYS = [
  'config', 'facts', 'taskList', 'headJournal', 'eventRecorder', 'jobs', 'mctsSearchStore',
] as const satisfies ReadonlyArray<keyof AgentStores>;

function countingProvider() {
  const db = new Database(':memory:');
  initRunEventTables(makeExecRaw(db));
  const handle = makeSql(db);
  let calls = 0;
  return { sql: () => { calls += 1; return handle; }, calls: () => calls };
}

describe('createAgentStores', () => {
  test('exposes exactly the seven stores an agent has', () => {
    const stores = createAgentStores(countingProvider().sql);
    for (const key of STORE_KEYS) expect(stores[key]).toBeDefined();
    // A store reachable on the bundle but absent from STORE_KEYS would be a
    // capability one backend silently gained and this test never covered.
    expect(Object.keys(stores).sort()).toEqual([...STORE_KEYS].sort());
  });

  test('touches no SQL until a store is first read', () => {
    // Load-bearing for CF: the bundle is a Durable Object field initializer, and
    // a DO must not reach storage while those run. Eager construction here would
    // resolve `boundSql` before its memo exists.
    const { sql, calls } = countingProvider();
    createAgentStores(sql);
    expect(calls()).toBe(0);
  });

  test('returns the same instance on every read', () => {
    // Both backends document that the store they hand to a tool is the SAME
    // instance the per-step dynamic context reads. Rebuilding per access would
    // also silently drop RunEventRecorder's listeners and its per-run index.
    const stores = createAgentStores(countingProvider().sql);
    for (const key of STORE_KEYS) expect(stores[key]).toBe(stores[key]);
  });

  test('resolves the SQL handle at most once per store', () => {
    const { sql, calls } = countingProvider();
    const stores = createAgentStores(sql);
    for (const key of STORE_KEYS) { void stores[key]; void stores[key]; }
    expect(calls()).toBe(STORE_KEYS.length);
  });

  test('a run-event listener survives re-reading the recorder', () => {
    // The memoization above, stated as the behaviour that depends on it.
    const stores = createAgentStores(countingProvider().sql);
    let seen = 0;
    stores.eventRecorder.observe(() => { seen += 1; });
    stores.eventRecorder.emit('run-1', { type: 'run_start', agentId: 'a' });
    expect(seen).toBe(1);
  });
});
