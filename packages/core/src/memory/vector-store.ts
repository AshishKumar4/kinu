/** Semantic memory recall over Vectorize; fused with FTS5 hits via RRF. The cf-backend wires the bindings. */

import * as v from 'valibot';
import type { IndexedChunk } from '@kinu.run/agent-utils/memory';
import { renderIssues, type JsonObject } from '../utils/json';
import { diagnostics, toKinuError } from '../obs/index';

/** Duck-typed so core stays dependency-free. */
export interface VectorMutation {
  ids?: string[];
}

export interface VectorizeIndex {
  insert(vectors: VectorRecord[]): Promise<VectorMutation>;
  upsert(vectors: VectorRecord[]): Promise<VectorMutation>;
  query(
    vector: number[],
    options?: { topK?: number; namespace?: string; returnMetadata?: boolean | 'all' | 'indexed'; filter?: JsonObject },
  ): Promise<{ matches: VectorMatch[] }>;
  deleteByIds(ids: string[]): Promise<VectorMutation>;
  getByIds(ids: string[]): Promise<VectorRecord[]>;
}

export interface VectorRecord {
  readonly id: string;
  readonly values: number[];
  /** Scopes the shared index to one workspace/agent. */
  readonly namespace?: string;
  readonly metadata?: JsonObject;
}

export interface VectorMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata?: JsonObject;
  readonly values?: number[];
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: readonly string[]): Promise<number[][]>;
  readonly dimensions: number;
}

export type { IndexedChunk } from '@kinu.run/agent-utils/memory';

export interface VectorSearchHit {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  text?: string;
}

export interface VectorStore {
  readonly available: boolean;
  /** Idempotent on id. Rejects when the write did not land. */
  upsertChunk(chunk: IndexedChunk): Promise<void>;
  upsertChunks(chunks: readonly IndexedChunk[]): Promise<void>;
  deleteChunks(ids: readonly string[]): Promise<void>;
  /** Rejects on backend failure: `hybridSearch` decides whether another arm covers. */
  search(query: string, topK?: number): Promise<VectorSearchHit[]>;
}

/** score = Σ 1/(k + rank); default k=60 (Cormack/Lynam). Sorted descending. */
export function reciprocalRankFusion<T extends { id: string }>(
  lists: readonly (readonly T[])[],
  k = 60,
): Array<{ id: string; rrfScore: number; sources: T[] }> {
  const byId = new Map<string, { id: string; rrfScore: number; sources: T[] }>();

  for (const list of lists) {
    for (const [index, item] of list.entries()) {
      const inc = 1 / (k + index + 1);
      const existing = byId.get(item.id);

      if (existing) {
        existing.rrfScore += inc;
        existing.sources.push(item);
      } else {
        byId.set(item.id, { id: item.id, rrfScore: inc, sources: [item] });
      }
    }
  }

  return Array.from(byId.values()).sort((a, b) => b.rrfScore - a.rrfScore);
}

/** A cooldown, not a latch: the next use after it re-probes, so transient errors recover. */
export const VECTOR_BACKEND_COOLDOWN_MS = 30_000;

/** Every field optional: records may predate a field. */
const ChunkMetadataSchema = v.object({
  chunkId: v.optional(v.string()),
  path: v.optional(v.string()),
  startLine: v.optional(v.number()),
  endLine: v.optional(v.number()),
});

/**
 * Chunk text is not stored; callers rehydrate by id. The index is shared across workspaces and
 * vector ids are unique per index, so ids are namespace-derived hashes plus a namespace filter;
 * the verbatim chunk id rides in metadata so hits fuse with FTS5.
 */
export function createCloudflareVectorStore(opts: {
  index: VectorizeIndex;
  embedder: Embedder;
  /** Omit only for an unshared index. */
  namespace?: string;
}): VectorStore {
  const { index, embedder, namespace } = opts;

  // Failures always throw; `available` only lets the search arm skip during the cooldown.
  let unavailableUntil = 0;

  // SHA-256 of `${namespace}\0${chunkId}` truncated to 40 hex (160 bits), within Vectorize's id limit.
  // Deterministic, so delete recomputes it. Raw chunk id without a namespace.
  async function storageId(chunkId: string): Promise<string> {
    if (!namespace) return chunkId;
    const data = new TextEncoder().encode(`${namespace}\u0000${chunkId}`);
    const digest = await crypto.subtle.digest('SHA-256', data);

    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
  }

  async function toRecords(chunks: readonly IndexedChunk[]): Promise<VectorRecord[]> {
    const vectors = embedder.embedBatch
      ? await embedder.embedBatch(chunks.map((c) => c.text))
      : await Promise.all(chunks.map((c) => embedder.embed(c.text)));

    return Promise.all(chunks.map(async (c, i) => ({
      id: await storageId(c.id),
      values: vectors[i],
      namespace,
      metadata: { path: c.path, startLine: c.startLine, endLine: c.endLine, chunkId: c.id },
    })));
  }

  /** Trips the cooldown and rethrows. */
  async function tripping<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      diagnostics.failure(
        'vector.backend_tripped',
        toKinuError({ doing: 'reach the vector backend', cause: err, otherwise: 'unavailable' }),
        { operation },
      );
      unavailableUntil = Date.now() + VECTOR_BACKEND_COOLDOWN_MS;
      throw err;
    }
  }


  return {
    get available() { return Date.now() >= unavailableUntil; },

    async upsertChunk(chunk: IndexedChunk) {
      await tripping('upsert', async () => index.upsert(await toRecords([chunk])));
    },

    async upsertChunks(chunks: readonly IndexedChunk[]) {
      if (chunks.length === 0) return;
      await tripping('batch upsert', async () => index.upsert(await toRecords(chunks)));
    },

    async deleteChunks(ids: readonly string[]) {
      if (ids.length === 0) return;
      await tripping('delete', async () => index.deleteByIds(await Promise.all(ids.map(storageId))));
    },

    search(text: string, topK = 10) {
      return tripping('query', async () => {
        const res = await index.query(await embedder.embed(text), {
          topK,
          returnMetadata: true,
          namespace,
        });

        return (res.matches ?? []).flatMap((m) => {
          const located = v.safeParse(ChunkMetadataSchema, m.metadata ?? {});

          // Records outside the metadata convention are named, not returned as blank hits.
          if (!located.success) {
            diagnostics.event('vector.hit_refused', { id: m.id, issues: renderIssues(located.issues) });

            return [];
          }

          const fields = located.output;

          return [{
            // Verbatim chunk id matches the FTS5 hit id so RRF fuses them.
            id: fields.chunkId ?? m.id,
            path: fields.path ?? '',
            startLine: fields.startLine ?? 0,
            endLine: fields.endLine ?? 0,
            score: m.score,
          }];
        });
      });
    },
  };
}

/** FTS5-only fallback when Vectorize is not provisioned. */
export function createNoopVectorStore(): VectorStore {
  return {
    available: false,
    async upsertChunk() { /* nop */ },
    async upsertChunks() { /* nop */ },
    async deleteChunks() { /* nop */ },
    async search() { return []; },
  };
}
