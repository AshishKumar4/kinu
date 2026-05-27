/**
 * VectorStore — semantic memory recall over Cloudflare Vectorize.
 *
 * Hybrid retrieval: every memory chunk that gets indexed by FTS5 ALSO gets
 * a Workers-AI embedding (default `@cf/baai/bge-small-en-v1.5`, 384-dim)
 * stored in a Vectorize index. Searches fan out to both:
 *   • FTS5      — lexical match, fast, perfect-recall on exact strings
 *   • Vectorize — semantic match, surfaces paraphrases and concepts
 * and merge via Reciprocal Rank Fusion (RRF) for the final ranking.
 *
 * Adapter pattern: this module defines the contract; the cf-backend wires
 * it to the actual Vectorize/AI bindings.
 */

/** A Vectorize-shaped binding (subset we need). Duck-typed so core stays dep-free. */
export interface VectorizeIndex {
  insert(vectors: VectorRecord[]): Promise<{ ids: string[] } | unknown>;
  upsert(vectors: VectorRecord[]): Promise<{ ids: string[] } | unknown>;
  query(
    vector: number[],
    options?: { topK?: number; returnMetadata?: boolean | 'all' | 'indexed'; filter?: Record<string, unknown> },
  ): Promise<{ matches: VectorMatch[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
  getByIds(ids: string[]): Promise<VectorRecord[]>;
}

export interface VectorRecord {
  readonly id: string;
  readonly values: number[];
  readonly metadata?: Record<string, unknown>;
}

export interface VectorMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata?: Record<string, unknown>;
  readonly values?: number[];
}

/** Embedder — produces an embedding vector for a text chunk. */
export interface Embedder {
  /** Embed a single piece of text. Returns the vector (e.g. 384 dims for bge-small). */
  embed(text: string): Promise<number[]>;
  /** Optional: batch embed for index-time efficiency. */
  embedBatch?(texts: readonly string[]): Promise<number[][]>;
  /** Embedding dimensionality — informational. */
  readonly dimensions: number;
}

export interface VectorMemoryChunk {
  /** Stable chunk id (typically the row id from memory_chunks). */
  id: string;
  /** Source file path within the VFS. */
  path: string;
  /** Inclusive line range in the source. */
  startLine: number;
  endLine: number;
  /** Verbatim chunk text — what we embed. */
  text: string;
}

export interface VectorSearchHit {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Semantic similarity score (cosine), 0..1 (Vectorize convention). */
  score: number;
  /** The chunk text — usually rehydrated from the FTS row by the caller. */
  text?: string;
}

/**
 * VectorStore — the high-level API the rest of Proteus consumes.
 *
 * One implementation: CloudflareVectorStore (wraps Vectorize + an Embedder).
 * Future: in-memory store for tests, R2-backed store for cold storage, etc.
 */
export interface VectorStore {
  /** True if the underlying binding is reachable + ready. */
  readonly available: boolean;
  /** Embed + insert a chunk. Idempotent on id. */
  upsertChunk(chunk: VectorMemoryChunk): Promise<void>;
  /** Embed + insert many chunks (batched). */
  upsertChunks(chunks: readonly VectorMemoryChunk[]): Promise<void>;
  /** Delete chunks by id. */
  deleteChunks(ids: readonly string[]): Promise<void>;
  /** Semantic search — returns top-K hits with their scores. */
  search(query: string, topK?: number): Promise<VectorSearchHit[]>;
}

/**
 * Reciprocal Rank Fusion — merges two ranked lists into one.
 *
 * For each result in either list, score = sum over lists of 1/(k + rank).
 * The default `k=60` is the canonical RRF constant from Cormack/Lynam.
 *
 * Returns the merged hits sorted by descending RRF score.
 */
export function reciprocalRankFusion<T extends { id: string }>(
  lists: readonly (readonly T[])[],
  k: number = 60,
): Array<{ id: string; rrfScore: number; sources: T[] }> {
  const byId = new Map<string, { id: string; rrfScore: number; sources: T[] }>();
  for (const list of lists) {
    list.forEach((item, idx) => {
      const rank = idx + 1;
      const inc = 1 / (k + rank);
      const existing = byId.get(item.id);
      if (existing) {
        existing.rrfScore += inc;
        existing.sources.push(item);
      } else {
        byId.set(item.id, { id: item.id, rrfScore: inc, sources: [item] });
      }
    });
  }
  return Array.from(byId.values()).sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * Build a CloudflareVectorStore — pairs an Embedder with a Vectorize index.
 *
 * Metadata convention: { path, startLine, endLine } on every record.
 * The chunk text is NOT stored in Vectorize (cheaper) — the caller is
 * expected to rehydrate text from FTS5 by id, or read straight from the VFS.
 */
export function createCloudflareVectorStore(opts: {
  index: VectorizeIndex;
  embedder: Embedder;
}): VectorStore {
  const { index, embedder } = opts;
  let available = true;

  async function safeQuery(text: string, topK: number): Promise<VectorSearchHit[]> {
    try {
      const vec = await embedder.embed(text);
      const res = await index.query(vec, { topK, returnMetadata: true });
      return (res.matches ?? []).map((m) => ({
        id: m.id,
        path: String(m.metadata?.path ?? ''),
        startLine: Number(m.metadata?.startLine ?? 0),
        endLine: Number(m.metadata?.endLine ?? 0),
        score: m.score,
      }));
    } catch (err) {
      console.warn('[vector-store] query failed:', err instanceof Error ? err.message : err);
      available = false;
      return [];
    }
  }

  return {
    get available() { return available; },

    async upsertChunk(chunk: VectorMemoryChunk) {
      try {
        const vec = await embedder.embed(chunk.text);
        await index.upsert([{
          id: chunk.id,
          values: vec,
          metadata: { path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine },
        }]);
      } catch (err) {
        console.warn('[vector-store] upsert failed:', err instanceof Error ? err.message : err);
      }
    },

    async upsertChunks(chunks: readonly VectorMemoryChunk[]) {
      if (chunks.length === 0) return;
      try {
        const vectors = embedder.embedBatch
          ? await embedder.embedBatch(chunks.map((c) => c.text))
          : await Promise.all(chunks.map((c) => embedder.embed(c.text)));
        const records: VectorRecord[] = chunks.map((c, i) => ({
          id: c.id,
          values: vectors[i],
          metadata: { path: c.path, startLine: c.startLine, endLine: c.endLine },
        }));
        await index.upsert(records);
      } catch (err) {
        console.warn('[vector-store] batch upsert failed:', err instanceof Error ? err.message : err);
      }
    },

    async deleteChunks(ids: readonly string[]) {
      if (ids.length === 0) return;
      try {
        await index.deleteByIds([...ids]);
      } catch (err) {
        console.warn('[vector-store] delete failed:', err instanceof Error ? err.message : err);
      }
    },

    async search(query: string, topK: number = 10) {
      return safeQuery(query, topK);
    },
  };
}

/**
 * Build a Workers-AI-backed Embedder.
 *
 * Default model: `@cf/baai/bge-small-en-v1.5` (384-dim, fast, English-good).
 * Other options: `@cf/baai/bge-base-en-v1.5` (768-dim), `@cf/baai/bge-large-en-v1.5` (1024-dim).
 *
 * The `aiBinding` is the `env.AI` Worker binding (typed `Ai` in workers-types).
 */
export function createWorkersAIEmbedder(opts: {
  aiBinding: { run: (model: string, input: { text: string | string[] }) => Promise<{ data?: number[][] } | unknown> };
  model?: string;
  dimensions?: number;
}): Embedder {
  const model = opts.model ?? '@cf/baai/bge-small-en-v1.5';
  const dimensions = opts.dimensions ?? 384;

  async function runOne(text: string): Promise<number[]> {
    const result = (await opts.aiBinding.run(model, { text })) as { data?: number[][] };
    const vec = result?.data?.[0];
    if (!vec || vec.length === 0) {
      throw new Error(`Workers AI embed returned no vector for model ${model}`);
    }
    return vec;
  }

  return {
    dimensions,
    async embed(text: string) { return runOne(text); },
    async embedBatch(texts: readonly string[]) {
      // bge endpoints accept an array; one request, one response with N vectors.
      const result = (await opts.aiBinding.run(model, { text: [...texts] })) as { data?: number[][] };
      const vectors = result?.data ?? [];
      if (vectors.length !== texts.length) {
        // Fallback: one-by-one (slow but correct).
        return Promise.all(texts.map((t) => runOne(t)));
      }
      return vectors;
    },
  };
}

/**
 * No-op VectorStore for environments without a Vectorize binding.
 *
 * `available` returns false; search returns []; upserts are silently dropped.
 * The orchestrator uses this as a fallback so FTS5-only retrieval keeps
 * working when Vectorize isn't provisioned.
 */
export function createNoopVectorStore(): VectorStore {
  return {
    available: false,
    async upsertChunk() { /* nop */ },
    async upsertChunks() { /* nop */ },
    async deleteChunks() { /* nop */ },
    async search() { return []; },
  };
}
