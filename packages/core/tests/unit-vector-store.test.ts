/**
 * Unit tests for VectorStore + Reciprocal Rank Fusion + Embedder adapters.
 */

import { describe, test, expect, setSystemTime } from 'bun:test';
import {
  reciprocalRankFusion,
  createCloudflareVectorStore,
  createNoopVectorStore,
  VECTOR_BACKEND_COOLDOWN_MS,
  createWorkersAIEmbedder,
  type VectorizeIndex,
  type Embedder,
  type VectorMemoryChunk,
} from '../src/index.js';

// ── Reciprocal Rank Fusion ───────────────────────────────────────────

describe('reciprocalRankFusion', () => {
  test('returns empty for empty inputs', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[]])).toEqual([]);
  });

  test('single list is preserved in rank order', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const out = reciprocalRankFusion([list]);
    expect(out.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  test('agreement boosts shared items above singletons', () => {
    const lex = [{ id: 'shared' }, { id: 'only-lex' }];
    const sem = [{ id: 'shared' }, { id: 'only-sem' }];
    const out = reciprocalRankFusion([lex, sem]);
    expect(out[0].id).toBe('shared');
    // 'shared' has rrf = 1/(60+1) + 1/(60+1) = ~0.0328
    // 'only-lex' has rrf = 1/(60+2) = ~0.0161
    expect(out[0].rrfScore).toBeGreaterThan(out[1].rrfScore);
    expect(out[0].sources.length).toBe(2);
  });

  test('honors custom k constant', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    const k1 = reciprocalRankFusion([list], 10);
    const k2 = reciprocalRankFusion([list], 1000);
    // Smaller k → larger raw rrf for top items.
    expect(k1[0].rrfScore).toBeGreaterThan(k2[0].rrfScore);
  });

  test('attaches source items for each hit', () => {
    const lex = [{ id: 'x', kind: 'lex' as const }];
    const sem = [{ id: 'x', kind: 'sem' as const }, { id: 'y', kind: 'sem' as const }];
    const out = reciprocalRankFusion([lex, sem]);
    const x = out.find((o) => o.id === 'x')!;
    expect(x.sources.length).toBe(2);
    expect(x.sources.map((s: { kind: string }) => s.kind).sort()).toEqual(['lex', 'sem']);
  });
});

// ── CloudflareVectorStore w/ in-memory mocks ─────────────────────────

function makeMockIndex(): { index: VectorizeIndex; records: Map<string, { values: number[]; metadata?: Record<string, unknown> }> } {
  const records = new Map<string, { values: number[]; metadata?: Record<string, unknown> }>();
  const index: VectorizeIndex = {
    async insert(vecs) {
      for (const v of vecs) records.set(v.id, { values: [...v.values], metadata: v.metadata });
      return { ids: vecs.map((v) => v.id) };
    },
    async upsert(vecs) {
      for (const v of vecs) records.set(v.id, { values: [...v.values], metadata: v.metadata });
      return { ids: vecs.map((v) => v.id) };
    },
    async query(vector, options) {
      const topK = options?.topK ?? 10;
      // Score by cosine similarity (assumes already-normalized — simplistic, but enough for tests).
      const scored = [...records.entries()].map(([id, rec]) => {
        let dot = 0;
        for (let i = 0; i < Math.min(vector.length, rec.values.length); i++) {
          dot += vector[i] * rec.values[i];
        }
        return {
          id,
          score: dot,
          metadata: options?.returnMetadata ? rec.metadata : undefined,
        };
      });
      scored.sort((a, b) => b.score - a.score);
      return { matches: scored.slice(0, topK) };
    },
    async deleteByIds(ids) { for (const id of ids) records.delete(id); return {}; },
    async getByIds(ids) {
      return ids.flatMap((id) => {
        const r = records.get(id);
        return r ? [{ id, values: r.values, metadata: r.metadata }] : [];
      });
    },
  };
  return { index, records };
}

const constEmbedder: Embedder = {
  dimensions: 3,
  async embed(text) {
    // Deterministic toy embedding: length → 3-dim with simple character bucket counts.
    const buckets = [0, 0, 0];
    for (const c of text.toLowerCase()) {
      if (c >= 'a' && c <= 'i') buckets[0]++;
      else if (c >= 'j' && c <= 'r') buckets[1]++;
      else if (c >= 's' && c <= 'z') buckets[2]++;
    }
    const norm = Math.sqrt(buckets.reduce((acc, v) => acc + v * v, 0)) || 1;
    return buckets.map((v) => v / norm);
  },
};

describe('CloudflareVectorStore', () => {
  test('upsertChunk + search round-trips a chunk', async () => {
    const { index, records } = makeMockIndex();
    const store = createCloudflareVectorStore({ index, embedder: constEmbedder });

    const chunk: VectorMemoryChunk = {
      id: 'mem-1', path: 'memory/MEMORY.md',
      startLine: 1, endLine: 5,
      text: 'apples and bananas',
    };
    await store.upsertChunk(chunk);
    expect(records.has('mem-1')).toBe(true);
    expect(records.get('mem-1')!.metadata?.path).toBe('memory/MEMORY.md');

    const hits = await store.search('apples', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('mem-1');
    expect(hits[0].path).toBe('memory/MEMORY.md');
    expect(hits[0].startLine).toBe(1);
    expect(hits[0].endLine).toBe(5);
  });

  test('upsertChunks (batched) inserts all + survives single embedBatch path', async () => {
    const { index } = makeMockIndex();
    const store = createCloudflareVectorStore({ index, embedder: constEmbedder });
    const chunks: VectorMemoryChunk[] = [
      { id: 'a', path: 'p', startLine: 0, endLine: 0, text: 'apple' },
      { id: 'b', path: 'p', startLine: 1, endLine: 1, text: 'banana' },
      { id: 'c', path: 'p', startLine: 2, endLine: 2, text: 'zebra' },
    ];
    await store.upsertChunks(chunks);
    const hits = await store.search('apple', 5);
    const ids = hits.map((h) => h.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('c');
  });

  test('deleteChunks removes items', async () => {
    const { index, records } = makeMockIndex();
    const store = createCloudflareVectorStore({ index, embedder: constEmbedder });
    await store.upsertChunk({ id: 'x', path: '.', startLine: 0, endLine: 0, text: 'hello' });
    expect(records.has('x')).toBe(true);
    await store.deleteChunks(['x']);
    expect(records.has('x')).toBe(false);
  });

  test('search failures degrade gracefully (available flips false, returns [])', async () => {
    const failingIndex: VectorizeIndex = {
      async insert() { return {}; },
      async upsert() { return {}; },
      async query() { throw new Error('vectorize down'); },
      async deleteByIds() { return {}; },
      async getByIds() { return []; },
    };
    const store = createCloudflareVectorStore({ index: failingIndex, embedder: constEmbedder });
    expect(store.available).toBe(true);
    const hits = await store.search('anything');
    expect(hits).toEqual([]);
    expect(store.available).toBe(false);
  });

  test('a failed write rejects instead of reporting success', async () => {
    const failingIndex: VectorizeIndex = {
      async insert() { return {}; },
      async upsert() { throw new Error('vectorize down'); },
      async query() { return { matches: [] }; },
      async deleteByIds() { throw new Error('vectorize down'); },
      async getByIds() { return []; },
    };
    const store = createCloudflareVectorStore({ index: failingIndex, embedder: constEmbedder });
    const chunk: VectorMemoryChunk = { id: 'x', path: 'p', startLine: 1, endLine: 2, text: 'hello' };

    // Swallowing these is what let the backfill mark itself done over chunks
    // it never embedded — a caller cannot tell an indexed chunk from a lost one.
    await expect(store.upsertChunk(chunk)).rejects.toThrow('vectorize down');
    await expect(store.upsertChunks([chunk])).rejects.toThrow('vectorize down');
    await expect(store.deleteChunks(['x'])).rejects.toThrow('vectorize down');
    // Empty batches still short-circuit without touching the backend.
    await expect(store.upsertChunks([])).resolves.toBeUndefined();
    await expect(store.deleteChunks([])).resolves.toBeUndefined();
  });

  test('availability re-arms after the cooldown instead of latching off forever', async () => {
    let down = true;
    const flakyIndex: VectorizeIndex = {
      async insert() { return {}; },
      async upsert() { if (down) throw new Error('vectorize down'); return {}; },
      async query() { if (down) throw new Error('vectorize down'); return { matches: [] }; },
      async deleteByIds() { return {}; },
      async getByIds() { return []; },
    };
    const store = createCloudflareVectorStore({ index: flakyIndex, embedder: constEmbedder });
    const start = Date.now();
    setSystemTime(new Date(start));
    try {
      await store.search('anything');
      expect(store.available).toBe(false);
      // A latch here disabled semantic WRITES too, so everything indexed after
      // one transient error was lost rather than merely unsearchable.
      down = false;
      setSystemTime(new Date(start + VECTOR_BACKEND_COOLDOWN_MS - 1));
      expect(store.available).toBe(false);          // no retry storm meanwhile
      setSystemTime(new Date(start + VECTOR_BACKEND_COOLDOWN_MS));
      expect(store.available).toBe(true);
      await expect(store.upsertChunks([{ id: 'x', path: 'p', startLine: 1, endLine: 2, text: 'hi' }]))
        .resolves.toBeUndefined();
    } finally {
      setSystemTime();
    }
  });
});

// ── Workspace isolation (namespaces) ─────────────────────────────────
//
// Models real Vectorize: a vector id is unique per *index* (not per namespace),
// so the same upsert id in two namespaces would collide — the store must make
// storage ids workspace-unique. A query filters to its namespace.
function makeNamespacedIndex(): { index: VectorizeIndex; records: Map<string, { values: number[]; namespace?: string; metadata?: Record<string, unknown> }> } {
  const records = new Map<string, { values: number[]; namespace?: string; metadata?: Record<string, unknown> }>();
  const put = (vecs: VectorMemoryChunkRecord[]) => {
    for (const v of vecs) records.set(v.id, { values: [...v.values], namespace: v.namespace, metadata: v.metadata });
    return { ids: vecs.map((v) => v.id) };
  };
  const index: VectorizeIndex = {
    async insert(vecs) { return put(vecs as VectorMemoryChunkRecord[]); },
    async upsert(vecs) { return put(vecs as VectorMemoryChunkRecord[]); },
    async query(vector, options) {
      const topK = options?.topK ?? 10;
      const ns = options?.namespace;
      const scored = [...records.entries()]
        .filter(([, rec]) => ns === undefined || rec.namespace === ns)
        .map(([id, rec]) => {
          let dot = 0;
          for (let i = 0; i < Math.min(vector.length, rec.values.length); i++) dot += vector[i] * rec.values[i];
          return { id, score: dot, metadata: options?.returnMetadata ? rec.metadata : undefined };
        });
      scored.sort((a, b) => b.score - a.score);
      return { matches: scored.slice(0, topK) };
    },
    async deleteByIds(ids) { for (const id of ids) records.delete(id); return {}; },
    async getByIds() { return []; },
  };
  return { index, records };
}
type VectorMemoryChunkRecord = { id: string; values: number[]; namespace?: string; metadata?: Record<string, unknown> };

describe('CloudflareVectorStore — workspace isolation', () => {
  test('two namespaces sharing a chunk id do not cross-contaminate', async () => {
    const { index, records } = makeNamespacedIndex();
    const wsA = createCloudflareVectorStore({ index, embedder: constEmbedder, namespace: 'workspace-a' });
    const wsB = createCloudflareVectorStore({ index, embedder: constEmbedder, namespace: 'workspace-b' });

    // SAME chunk id in both workspaces, DIFFERENT text.
    const id = 'memory/MEMORY.md:1-5';
    await wsA.upsertChunk({ id, path: 'memory/MEMORY.md', startLine: 1, endLine: 5, text: 'apples and bananas' });
    await wsB.upsertChunk({ id, path: 'memory/MEMORY.md', startLine: 1, endLine: 5, text: 'zebras roam' });

    // Both survive — storage ids are workspace-scoped (no collision on write).
    expect(records.size).toBe(2);

    // Each workspace only sees its own vector, and the returned hit id is the
    // verbatim chunk id (so RRF can fuse it with FTS5).
    const aHits = await wsA.search('apples', 5);
    expect(aHits.length).toBe(1);
    expect(aHits[0].id).toBe(id);

    const bHits = await wsB.search('zebras', 5);
    expect(bHits.length).toBe(1);
    expect(bHits[0].id).toBe(id);
  });

  test('delete is namespace-scoped — removing A leaves B intact', async () => {
    const { index } = makeNamespacedIndex();
    const wsA = createCloudflareVectorStore({ index, embedder: constEmbedder, namespace: 'workspace-a' });
    const wsB = createCloudflareVectorStore({ index, embedder: constEmbedder, namespace: 'workspace-b' });
    const id = 'memory/notes.md:1-2';
    await wsA.upsertChunk({ id, path: 'memory/notes.md', startLine: 1, endLine: 2, text: 'alpha beta' });
    await wsB.upsertChunk({ id, path: 'memory/notes.md', startLine: 1, endLine: 2, text: 'alpha beta' });

    await wsA.deleteChunks([id]);
    expect((await wsA.search('alpha', 5)).length).toBe(0);
    // B's identically-keyed chunk is untouched.
    expect((await wsB.search('alpha', 5)).map((h) => h.id)).toEqual([id]);
  });

  test('storage ids stay within Vectorize’s 64-byte limit for long paths', async () => {
    const { index, records } = makeNamespacedIndex();
    const store = createCloudflareVectorStore({ index, embedder: constEmbedder, namespace: 'a-fairly-long-workspace-name-xyz' });
    const longId = 'memory/logs/2026-07-13-some-very-long-session-file-name.md:100000-100050';
    await store.upsertChunk({ id: longId, path: 'memory/logs/x.md', startLine: 100000, endLine: 100050, text: 'hello world' });
    for (const key of records.keys()) expect(new TextEncoder().encode(key).length).toBeLessThanOrEqual(64);
    const hits = await store.search('hello', 5);
    expect(hits[0].id).toBe(longId);
  });
});

describe('createNoopVectorStore', () => {
  test('reports unavailable + accepts upserts as nop + returns []', async () => {
    const store = createNoopVectorStore();
    expect(store.available).toBe(false);
    await store.upsertChunk({ id: 'x', path: '.', startLine: 0, endLine: 0, text: 'hi' });
    await store.upsertChunks([]);
    await store.deleteChunks([]);
    expect(await store.search('anything')).toEqual([]);
  });
});

describe('createWorkersAIEmbedder', () => {
  test('forwards single embed to ai.run with model + text', async () => {
    const calls: Array<{ model: string; input: unknown }> = [];
    const ai = {
      async run(model: string, input: { text: string | string[] }) {
        calls.push({ model, input });
        return { data: [[0.1, 0.2, 0.3, 0.4]] };
      },
    };
    const embedder = createWorkersAIEmbedder({ aiBinding: ai, dimensions: 4 });
    const vec = await embedder.embed('hello');
    expect(vec).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(calls[0].model).toBe('@cf/baai/bge-small-en-v1.5');
    expect((calls[0].input as { text: string }).text).toBe('hello');
    expect(embedder.dimensions).toBe(4);
  });

  test('embedBatch sends array text + maps response', async () => {
    const ai = {
      async run(_model: string, _input: { text: string | string[] }) {
        return { data: [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]] };
      },
    };
    const embedder = createWorkersAIEmbedder({ aiBinding: ai, dimensions: 2 });
    const out = await embedder.embedBatch!(['a', 'b', 'c']);
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]]);
  });

  test('embedBatch falls back to single-embed if response is wrong length', async () => {
    let callCount = 0;
    const ai = {
      async run(_model: string, input: { text: string | string[] }) {
        callCount++;
        // First call (batch): return wrong length → triggers fallback.
        if (Array.isArray(input.text)) return { data: [[0.1, 0.2]] };
        return { data: [[Number(callCount), 0]] };
      },
    };
    const embedder = createWorkersAIEmbedder({ aiBinding: ai, dimensions: 2 });
    const out = await embedder.embedBatch!(['a', 'b']);
    expect(out.length).toBe(2);
  });

  test('throws when ai.run returns empty data', async () => {
    const ai = { async run() { return { data: [] }; } };
    const embedder = createWorkersAIEmbedder({ aiBinding: ai, dimensions: 2 });
    await expect(embedder.embed('hello')).rejects.toThrow(/no vector/);
  });
});
