// The cf memory-index path must keep the semantic (vector) index in sync with
// FTS5: writing/indexing a memory embeds its chunks, changed line ranges drop
// their stale vectors, and the one-time backfill embeds pre-existing chunks
// exactly once. Drives the real adaptMemory / backfillMemoryVectors against a
// real MemoryStore (bun:sqlite) and a fake VectorStore that records calls.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SqliteFS } from '@proteus/agent-utils/vfs';
import { MemoryStore } from '@proteus/agent-utils/memory';
import { createAgentConfigStore, type VectorStore, type VectorMemoryChunk } from '@proteus/core';
import { adaptMemory, backfillMemoryVectors } from '../src/memory-sync';

function createSql() {
  const db = new Database(':memory:');
  return (<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');
    const bound = values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
    const stmt = db.prepare(query);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return stmt.all(...(bound as never[])) as T[];
    stmt.run(...(bound as never[]));
    return [];
  }) as never;
}

function createStore() {
  const sql = createSql();
  const fs = new SqliteFS(sql);
  fs.init();
  const store = new MemoryStore(fs, sql);
  store.ensureSchema();
  sql`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  const config = createAgentConfigStore(sql);
  return { sql, store, config };
}

/** A VectorStore that records upserts/deletes for assertions. */
function fakeVectorStore(available = true) {
  const upserted: VectorMemoryChunk[] = [];
  const deleted: string[] = [];
  const live = new Map<string, VectorMemoryChunk>();
  const store: VectorStore = {
    available,
    async upsertChunk(c) { upserted.push(c); live.set(c.id, c); },
    async upsertChunks(cs) { for (const c of cs) { upserted.push(c); live.set(c.id, c); } },
    async deleteChunks(ids) { for (const id of ids) { deleted.push(id); live.delete(id); } },
    async search() { return []; },
  };
  return { store, upserted, deleted, live };
}

const PATH = 'memory/MEMORY.md';
const doc = (count: number, fill = 'x') =>
  Array.from({ length: count }, (_, i) => `note line ${i + 1} ${fill.repeat(40)}`).join('\n');

describe('adaptMemory — semantic index sync on write', () => {
  test('indexing embeds every chunk with its verbatim text', async () => {
    const { store } = createStore();
    const vs = fakeVectorStore();
    const memory = adaptMemory(store, vs.store);

    await memory.write(PATH, doc(60));
    await memory.index(PATH);

    expect(vs.upserted.length).toBeGreaterThan(1);
    for (const c of vs.upserted) {
      expect(c.id).toBe(`${PATH}:${c.startLine}-${c.endLine}`);
      expect(c.text.length).toBeGreaterThan(0);
    }
    expect(vs.deleted).toEqual([]);
  });

  test('shrinking a memory deletes the vanished chunk vectors', async () => {
    const { store } = createStore();
    const vs = fakeVectorStore();
    const memory = adaptMemory(store, vs.store);

    await memory.write(PATH, doc(60));
    await memory.index(PATH);
    const embeddedIds = new Set(vs.upserted.map((c) => c.id));

    await memory.write(PATH, doc(3));
    await memory.index(PATH);

    expect(vs.deleted.length).toBeGreaterThan(0);
    for (const id of vs.deleted) expect(embeddedIds.has(id)).toBe(true);
    // The surviving chunk's vector is still live; the deleted ones are gone.
    for (const id of vs.deleted) expect(vs.live.has(id)).toBe(false);
  });

  test('a Vectorize outage does not fail the memory write', async () => {
    const { store } = createStore();
    const throwing: VectorStore = {
      available: true,
      async upsertChunk() { throw new Error('vectorize down'); },
      async upsertChunks() { throw new Error('vectorize down'); },
      async deleteChunks() { throw new Error('vectorize down'); },
      async search() { return []; },
    };
    const memory = adaptMemory(store, throwing);
    await memory.write(PATH, doc(60));
    await expect(memory.index(PATH)).resolves.toBeUndefined();
    // FTS5 still indexed the content.
    expect((await memory.search('note', 5)).length).toBeGreaterThan(0);
  });

  test('an unavailable vector store is never called', async () => {
    const { store } = createStore();
    const vs = fakeVectorStore(false);
    const memory = adaptMemory(store, vs.store);
    await memory.write(PATH, doc(60));
    await memory.index(PATH);
    expect(vs.upserted).toEqual([]);
    expect(vs.deleted).toEqual([]);
  });
});

describe('backfillMemoryVectors — one-time embed of pre-existing chunks', () => {
  test('embeds every existing chunk once, sets the marker, 2nd run no-ops', async () => {
    const { store, config } = createStore();
    // Seed FTS5 directly (no vector store) — the pre-Vectorize state.
    await store.indexFile(PATH, doc(60));
    const total = store.allChunksAfter('', 10000).length;
    expect(total).toBeGreaterThan(1);

    const vs = fakeVectorStore();
    await backfillMemoryVectors(store, config, vs.store);
    expect(vs.upserted.length).toBe(total);
    expect(config.get('memory_vector_backfill_done')).toBe('true');

    // Second run: marker set → no re-embedding.
    await backfillMemoryVectors(store, config, vs.store);
    expect(vs.upserted.length).toBe(total);
  });

  test('pages a table larger than the cap across boots without re-embedding', async () => {
    const { store, config } = createStore();
    await store.indexFile(PATH, doc(60));
    const all = store.allChunksAfter('', 10000);
    expect(all.length).toBeGreaterThanOrEqual(3);

    const vs = fakeVectorStore();
    // Cap of 1 → one chunk per boot; marker stays unset until the last page.
    await backfillMemoryVectors(store, config, vs.store, 1);
    expect(vs.upserted.length).toBe(1);
    expect(config.get('memory_vector_backfill_done')).toBeNull();

    // Keep booting until done; ids must be embedded exactly once, in order.
    let guard = 0;
    while (config.get('memory_vector_backfill_done') !== 'true' && guard++ < 100) {
      await backfillMemoryVectors(store, config, vs.store, 1);
    }
    expect(config.get('memory_vector_backfill_done')).toBe('true');
    expect(vs.upserted.map((c) => c.id)).toEqual(all.map((c) => c.id));
  });

  test('does nothing when the vector store is unavailable', async () => {
    const { store, config } = createStore();
    await store.indexFile(PATH, doc(60));
    const vs = fakeVectorStore(false);
    await backfillMemoryVectors(store, config, vs.store);
    expect(vs.upserted).toEqual([]);
    expect(config.get('memory_vector_backfill_done')).toBeNull();
  });
});
