// The cf memory index keeps the vector index in sync with FTS5: embeds on write, drops stale
// ranges, and backfills pre-existing chunks exactly once.
import { describe, test, expect, setSystemTime } from 'bun:test';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { Database } from 'bun:sqlite';
import { createWorkspaceBundle, makeSql } from '../../core/tests/helpers';
import { MemoryStore } from '@kinu.run/agent-utils/memory';
import {
  createCloudflareVectorStore, VECTOR_BACKEND_COOLDOWN_MS,
  type Embedder, type VectorizeIndex, type VectorStore, type IndexedChunk,
} from '@kinu.run/core';
import { adaptMemory, backfillMemoryVectors } from '@kinu.run/core';

function createStore() {
  const database = new Database(':memory:');
  const sql = makeSql(database);
  const files = createWorkspaceBundle(database).vfs;
  const store = new MemoryStore(files, sql, write => database.transaction(write)());
  store.ensureSchema();

  return { sql, store, files, database };
}

function fakeVectorStore(available = true) {
  const upserted: IndexedChunk[] = [];
  const deleted: string[] = [];
  const live = new Map<string, IndexedChunk>();

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
    const { store, files } = createStore()
    const vs = fakeVectorStore();
    const memory = adaptMemory(store, files, { store: vs.store });

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
    const { store, files } = createStore()
    const vs = fakeVectorStore();
    const memory = adaptMemory(store, files, { store: vs.store });

    await memory.write(PATH, doc(60));
    await memory.index(PATH);
    const embeddedIds = new Set(vs.upserted.map((c) => c.id));

    await memory.write(PATH, doc(3));
    await memory.index(PATH);

    expect(vs.deleted.length).toBeGreaterThan(0);

    for (const id of vs.deleted) expect(embeddedIds.has(id)).toBe(true);

    for (const id of vs.deleted) expect(vs.live.has(id)).toBe(false);
  });

  test('a Vectorize outage does not fail the memory write, and does not claim the chunks were indexed', async () => {
    const { store, files } = createStore()

    const throwing: VectorStore = {
      available: true,
      async upsertChunk() { throw new Error('vectorize down'); },
      async upsertChunks() { throw new Error('vectorize down'); },
      async deleteChunks() { throw new Error('vectorize down'); },
      async search() { return []; },
    };

    const memory = adaptMemory(store, files, { store: throwing });
    await memory.write(PATH, doc(60));
    await expect(memory.index(PATH)).resolves.toBeUndefined();
    expect((await memory.search('note', 5)).length).toBeGreaterThan(0);

    expect(store.pendingProjection().length).toBeGreaterThan(0);
    const expected = await store.chunksByIds(store.pendingProjection().map((change) => change.id));
    const vs = fakeVectorStore();
    await backfillMemoryVectors(store, vs.store);
    expect(vs.upserted).toEqual(expected);
    expect(store.pendingProjection()).toEqual([]);
  });

  test('an unavailable vector store is never called', async () => {
    const { store, files } = createStore()
    const vs = fakeVectorStore(false);
    const memory = adaptMemory(store, files, { store: vs.store });
    await memory.write(PATH, doc(60));
    await memory.index(PATH);
    expect(vs.upserted).toEqual([]);
    expect(vs.deleted).toEqual([]);
  });
});

// A note is the text's only copy, and a shell may change it beside the memory tool.
describe('adaptMemory — a note changed under its index', () => {
  test('is re-chunked when it is read, and its vectors follow', async () => {
    const { store, files } = createStore()
    const vs = fakeVectorStore();
    const memory = adaptMemory(store, files, { store: vs.store });
    await memory.write(PATH, 'wrangler staging deploy succeeded');
    await memory.index(PATH);
    await writeText(files, PATH, 'kubernetes ingress now fronts staging');

    expect(await memory.read(PATH)).toBe('kubernetes ingress now fronts staging');
    expect([...vs.live.values()].map((chunk) => chunk.text)).toEqual(['kubernetes ingress now fronts staging']);
    expect((await memory.search('kubernetes', 5)).map((hit) => hit.snippet)).toEqual(['kubernetes ingress now fronts staging']);
  });

  test('is re-chunked when a search finds it, and the stale hit is never served', async () => {
    const { store, files } = createStore()
    const vs = fakeVectorStore();
    const memory = adaptMemory(store, files, { store: vs.store });
    await memory.write(PATH, 'wrangler staging deploy succeeded');
    await memory.index(PATH);
    await writeText(files, PATH, 'kubernetes ingress now fronts staging');

    expect(await memory.search('wrangler', 5)).toEqual([]);
    expect([...vs.live.values()].map((chunk) => chunk.text)).toEqual(['kubernetes ingress now fronts staging']);
  });

  test('a note no index row names yet is found by the next search, however much else is indexed', async () => {
    const { store, files } = createStore()
    const vs = fakeVectorStore();
    const memory = adaptMemory(store, files, { store: vs.store });

    // A restore that stopped partway: one note indexed, the other only on disk.
    await memory.write(PATH, 'wrangler staging deploy succeeded');
    await memory.index(PATH);
    await writeText(files, 'memory/2026-10-07.md', 'kubernetes ingress now fronts staging');

    expect((await memory.search('kubernetes', 5)).map((hit) => hit.path)).toEqual(['memory/2026-10-07.md']);
    expect([...vs.live.values()].map((chunk) => chunk.text).sort()).toEqual(['kubernetes ingress now fronts staging', 'wrangler staging deploy succeeded']);
  });

  test('a note a shell removed or renamed leaves no hit and no vector under its old name', async () => {
    const { store, files } = createStore()
    const vs = fakeVectorStore();
    const memory = adaptMemory(store, files, { store: vs.store });
    await memory.write(PATH, 'wrangler staging deploy succeeded');
    await memory.write('memory/gone.md', 'postgres replica lag alert');
    await memory.index(PATH);
    await memory.index('memory/gone.md');

    await files.rename(PATH, 'memory/deploys.md');
    await files.unlink('memory/gone.md');

    expect(await memory.search('postgres', 5)).toEqual([]);
    expect((await memory.search('wrangler', 5)).map((hit) => hit.path)).toEqual(['memory/deploys.md']);
    expect([...vs.live.keys()].every((id) => id.startsWith('memory/deploys.md:'))).toBe(true);
  });
});

describe('backfillMemoryVectors — one-time embed of pre-existing chunks', () => {
  test('a restart immediately after canonical publication still delivers replacement and deletion', async () => {
    const { store, files, sql, database } = createStore();
    const vs = fakeVectorStore();
    await store.writeFile(PATH, 'original chunk');
    await store.indexFile(PATH, 'original chunk', 'first');
    await backfillMemoryVectors(store, vs.store);

    for (const content of ['replacement chunk', '']) {
      await store.writeFile(PATH, content);
      await store.indexFile(PATH, content, content);
      // The adapter never receives the delta: delivery resumes from committed index state.
      const reopened = new MemoryStore(files, sql, write => database.transaction(write)());
      await backfillMemoryVectors(reopened, vs.store);
      expect([...vs.live.values()].map((chunk) => chunk.text)).toEqual(content === '' ? [] : [content]);
      expect(reopened.pendingProjection()).toEqual([]);
    }
  });

  test('embeds every pending chunk once and acknowledges its delivery', async () => {
    const { store } = createStore()
    // Seed FTS5 directly: the pre-Vectorize state.
    await store.writeFile(PATH, doc(60));
    await store.indexFile(PATH, doc(60));
    const total = store.pendingProjection().length;
    expect(total).toBeGreaterThan(1);

    const vs = fakeVectorStore();
    await backfillMemoryVectors(store, vs.store);
    expect(vs.upserted.length).toBe(total);
    expect(store.pendingProjection()).toEqual([]);

    await backfillMemoryVectors(store, vs.store);
    expect(vs.upserted.length).toBe(total);
  });

  test('pages a table larger than the cap across boots without re-embedding', async () => {
    const { store } = createStore()
    await store.writeFile(PATH, doc(60));
    await store.indexFile(PATH, doc(60));
    const all = await store.chunksByIds(store.pendingProjection().map((change) => change.id));
    expect(all.length).toBeGreaterThanOrEqual(3);

    const vs = fakeVectorStore();
    // Undelivered revisions remain owed until the last page.
    await backfillMemoryVectors(store, vs.store, 1);
    expect(vs.upserted.length).toBe(1);
    expect(store.pendingProjection().length).toBeGreaterThan(0);

    let guard = 0;

    while (store.pendingProjection().length > 0 && guard++ < 100) {
      await backfillMemoryVectors(store, vs.store, 1);
    }

    expect(store.pendingProjection()).toEqual([]);
    expect(vs.upserted.map((c) => c.id).sort()).toEqual(all.map((c) => c.id).sort());
  });

  test('a failed page retains every pending revision for replay', async () => {
    const { store } = createStore()
    await store.writeFile(PATH, doc(60));
    await store.indexFile(PATH, doc(60));
    const all = await store.chunksByIds(store.pendingProjection().map((change) => change.id));
    expect(all.length).toBeGreaterThanOrEqual(3);

    // A down Vectorize index acknowledges no pending delivery.
    let down = true;

    const index: VectorizeIndex = {
      async insert() { return {}; },
      async upsert() {
        if (down) throw new Error('vectorize down');

        return {};
      },
      async query() { return { matches: [] }; },
      async deleteByIds() { return {}; },
      async getByIds() { return []; },
    };

    const embedded: string[] = [];

    const embedder: Embedder = {
      dimensions: 1,
      async embed(text) {
        embedded.push(text);

        return [1];
      },
    };

    const vectorStore = createCloudflareVectorStore({ index, embedder });

    const start = Date.now();
    setSystemTime(new Date(start));

    try {
      // Rejects: a caller that cannot tell a failed page from a finished one cannot record it.
      await expect(backfillMemoryVectors(store, vectorStore, 1)).rejects.toThrow('vectorize down');
      expect(store.pendingProjection().length).toBeGreaterThan(0);
      expect(store.pendingProjection().length).toBe(all.length);

      down = false;
      embedded.length = 0;
      setSystemTime(new Date(start + VECTOR_BACKEND_COOLDOWN_MS));
      let guard = 0;

      while (store.pendingProjection().length > 0 && guard++ < 100) {
        await backfillMemoryVectors(store, vectorStore, 1);
      }

      expect(store.pendingProjection()).toEqual([]);
      expect(embedded.sort()).toEqual(all.map((c) => c.text).sort());
    } finally {
      setSystemTime();
    }
  });

  test('does nothing when the vector store is unavailable', async () => {
    const { store } = createStore()
    await store.writeFile(PATH, doc(60));
    await store.indexFile(PATH, doc(60));
    const vs = fakeVectorStore(false);
    await backfillMemoryVectors(store, vs.store);
    expect(vs.upserted).toEqual([]);
    expect(store.pendingProjection().length).toBeGreaterThan(0);
  });
});

// An emptied note is a change like any other: its chunks leave the index, or a search finds words no file holds.
test('emptying a note through the agent\'s memory removes it from search and from the vector index', async () => {
  const { store, files } = createStore()
  const vs = fakeVectorStore();
  const memory = adaptMemory(store, files, { store: vs.store });

  await memory.write(PATH, 'the wrangler deploy goes to staging');
  await memory.index(PATH);
  expect((await memory.search('wrangler', 5)).length).toBe(1);

  await memory.write(PATH, '');
  await memory.index(PATH);

  expect(await memory.search('wrangler', 5)).toEqual([]);
  expect([...vs.live.keys()]).toEqual([]);
});
