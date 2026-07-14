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
    options?: { topK?: number; namespace?: string; returnMetadata?: boolean | 'all' | 'indexed'; filter?: Record<string, unknown> },
  ): Promise<{ matches: VectorMatch[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
  getByIds(ids: string[]): Promise<VectorRecord[]>;
}

export interface VectorRecord {
  readonly id: string;
  readonly values: number[];
  /** Vectorize namespace — segments the index so a query can be scoped to one
   *  workspace/agent. A vector belongs to exactly one namespace. */
  readonly namespace?: string;
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
 * Metadata convention: { path, startLine, endLine, chunkId } on every record.
 * The chunk text is NOT stored in Vectorize (cheaper) — the caller is
 * expected to rehydrate text from FTS5 by id, or read straight from the VFS.
 *
 * Workspace isolation (`namespace`): the Vectorize index is shared across all
 * of a user's workspaces/agents, so every write and query is scoped to the
 * owning workspace. Scoping is two-layered because Vectorize vector ids are
 * unique per *index*, not per namespace:
 *   • the stored vector id is a namespace-derived hash of the chunk id, so two
 *     workspaces holding the same chunk id (e.g. `memory/MEMORY.md:1-5`) never
 *     collide on write. It stays within Vectorize's 64-byte id limit
 *     regardless of path/workspace-name length.
 *   • the Vectorize `namespace` field + query filter keep a search from ever
 *     ranking another workspace's vectors.
 * The verbatim chunk id is carried in metadata and returned as the hit id, so
 * hits still fuse (RRF) with FTS5 hits that key off that same chunk id.
 */
export function createCloudflareVectorStore(opts: {
  index: VectorizeIndex;
  embedder: Embedder;
  /** Owning workspace/agent. When set, writes and queries are scoped to it.
   *  Omitted only where the index is not shared (e.g. a dedicated test index). */
  namespace?: string;
}): VectorStore {
  const { index, embedder, namespace } = opts;
  let available = true;

  // Namespace-scoped, collision-free, ≤64-byte storage id for a chunk. SHA-256
  // of `${namespace}\0${chunkId}`, truncated to 40 hex chars (160 bits — a
  // birthday collision needs ~2^80 chunks). Deterministic, so delete recomputes
  // the same id. Without a namespace the raw chunk id is used verbatim.
  async function storageId(chunkId: string): Promise<string> {
    if (!namespace) return chunkId;
    const data = new TextEncoder().encode(`${namespace}\u0000${chunkId}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
  }

  async function toRecords(chunks: readonly VectorMemoryChunk[]): Promise<VectorRecord[]> {
    const vectors = embedder.embedBatch
      ? await embedder.embedBatch(chunks.map((c) => c.text))
      : await Promise.all(chunks.map((c) => embedder.embed(c.text)));
    return Promise.all(chunks.map(async (c, i) => ({
      id: await storageId(c.id),
      values: vectors[i],
      ...(namespace ? { namespace } : {}),
      metadata: { path: c.path, startLine: c.startLine, endLine: c.endLine, chunkId: c.id },
    })));
  }

  async function safeQuery(text: string, topK: number): Promise<VectorSearchHit[]> {
    try {
      const vec = await embedder.embed(text);
      const res = await index.query(vec, {
        topK,
        returnMetadata: true,
        ...(namespace ? { namespace } : {}),
      });
      return (res.matches ?? []).map((m) => ({
        // The verbatim chunk id (from metadata) — matches the FTS5 hit id so RRF
        // fuses the two sources. Falls back to the raw id for un-namespaced stores.
        id: String(m.metadata?.chunkId ?? m.id),
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
        await index.upsert(await toRecords([chunk]));
      } catch (err) {
        console.warn('[vector-store] upsert failed:', err instanceof Error ? err.message : err);
      }
    },

    async upsertChunks(chunks: readonly VectorMemoryChunk[]) {
      if (chunks.length === 0) return;
      try {
        await index.upsert(await toRecords(chunks));
      } catch (err) {
        console.warn('[vector-store] batch upsert failed:', err instanceof Error ? err.message : err);
      }
    },

    async deleteChunks(ids: readonly string[]) {
      if (ids.length === 0) return;
      try {
        await index.deleteByIds(await Promise.all(ids.map(storageId)));
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
