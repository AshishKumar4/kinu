// The cf memory-index path must keep the semantic (vector) index in sync with
// FTS5: writing/indexing a memory embeds its chunks, changed line ranges drop
// their stale vectors, and the one-time backfill embeds pre-existing chunks
// exactly once. Drives the real adaptMemory / backfillMemoryVectors against a
// real MemoryStore (bun:sqlite) and a fake VectorStore that records calls.
import { describe, test, expect, setSystemTime } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createWorkspaceBundle, makeSql } from '../../core/tests/helpers';
import { MemoryStore } from '@kinu.run/agent-utils/memory';
import {
  createAgentConfigStore, createCloudflareVectorStore, VECTOR_BACKEND_COOLDOWN_MS,
  type Embedder, type VectorizeIndex, type VectorStore, type VectorMemoryChunk,
} from '@kinu.run/core';
import { adaptMemory, backfillMemoryVectors } from '../src/memory-sync';

function createStore() {
  const database = new Database(':memory:');
  const sql = makeSql(database);
  const store = new MemoryStore(createWorkspaceBundle(database).vfs, sql);
  store.ensureSchema();
  void sql`CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
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
    const { store, config } = createStore();
    const vs = fakeVectorStore();
    const memory = adaptMemory(store, vs.store, config);

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
    const { store, config } = createStore();
    const vs = fakeVectorStore();
    const memory = adaptMemory(store, vs.store, config);

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

  test('a Vectorize outage does not fail the memory write, and does not claim the chunks were indexed', async () => {
    const { store, config } = createStore();
    const throwing: VectorStore = {
      available: true,
      async upsertChunk() { throw new Error('vectorize down'); },
      async upsertChunks() { throw new Error('vectorize down'); },
      async deleteChunks() { throw new Error('vectorize down'); },
      async search() { return []; },
    };
    // A completed backfill: without invalidation the marker would keep claiming
    // a complete semantic index over chunks that never reached the vector store.
    config.set('memory_vector_backfill_done', 'true');
    config.set('memory_vector_backfill_cursor', 'memory/MEMORY.md:9999-9999');

    const memory = adaptMemory(store, throwing, config);
    await memory.write(PATH, doc(60));
    await expect(memory.index(PATH)).resolves.toBeUndefined();
    // FTS5 still indexed the content.
    expect((await memory.search('note', 5)).length).toBeGreaterThan(0);

    expect(config.get('memory_vector_backfill_done')).toBe('false');
    expect(config.get('memory_vector_backfill_cursor')).toBe('');

    // …and the next boot's backfill actually re-embeds them.
    const vs = fakeVectorStore();
    await backfillMemoryVectors(store, config, vs.store);
    expect(vs.upserted.length).toBe(store.allChunksAfter('', 10000).length);
    expect(config.get('memory_vector_backfill_done')).toBe('true');
  });

  test('a successful sync leaves the completeness marker alone', async () => {
    const { store, config } = createStore();
    const vs = fakeVectorStore();
    config.set('memory_vector_backfill_done', 'true');
    const memory = adaptMemory(store, vs.store, config);
    await memory.write(PATH, doc(60));
    await memory.index(PATH);
    expect(config.get('memory_vector_backfill_done')).toBe('true');
  });

  test('an unavailable vector store is never called', async () => {
    const { store, config } = createStore();
    const vs = fakeVectorStore(false);
    const memory = adaptMemory(store, vs.store, config);
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

  test('a failed page holds the cursor and never marks itself done', async () => {
    const { store, config } = createStore();
    await store.indexFile(PATH, doc(60));
    const all = store.allChunksAfter('', 10000);
    expect(all.length).toBeGreaterThanOrEqual(3);

    // The real store over a Vectorize index that is down — the shape that used
    // to advance the cursor and set the marker over chunks it never embedded.
    let down = true;
    const index: VectorizeIndex = {
      async insert() { return {}; },
      async upsert() { if (down) throw new Error('vectorize down'); return {}; },
      async query() { return { matches: [] }; },
      async deleteByIds() { return {}; },
      async getByIds() { return []; },
    };
    const embedded: string[] = [];
    const embedder: Embedder = {
      dimensions: 1,
      async embed(text) { embedded.push(text); return [1]; },
    };
    const vectorStore = createCloudflareVectorStore({ index, embedder });

    const start = Date.now();
    setSystemTime(new Date(start));
    try {
      await backfillMemoryVectors(store, config, vectorStore, 1);
      expect(config.get('memory_vector_backfill_done')).toBeNull();
      expect(config.get('memory_vector_backfill_cursor')).toBeNull();

      // The backend recovers and the failure cooldown lapses; the same page is
      // retried from the held cursor and the run completes over every chunk,
      // in order, exactly once.
      down = false;
      embedded.length = 0;
      setSystemTime(new Date(start + VECTOR_BACKEND_COOLDOWN_MS));
      let guard = 0;
      while (config.get('memory_vector_backfill_done') !== 'true' && guard++ < 100) {
        await backfillMemoryVectors(store, config, vectorStore, 1);
      }
      expect(config.get('memory_vector_backfill_done')).toBe('true');
      expect(embedded).toEqual(all.map((c) => c.text));
    } finally {
      setSystemTime();
    }
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
