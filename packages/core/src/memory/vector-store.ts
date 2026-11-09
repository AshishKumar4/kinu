/** Semantic memory recall over the vectors the memory store keeps beside its chunks; fused with FTS5 hits via RRF. */

import { serialQueue } from '@kinu.run/agent-utils';
import type { MemoryStore, NearestChunk } from '@kinu.run/agent-utils/memory';
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import { noteDater } from './note';

export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: readonly string[]): Promise<number[][]>;
}

export type { IndexedChunk, NearestChunk } from '@kinu.run/agent-utils/memory';

export interface VectorStore {
  readonly available: boolean;
  /** The chunks nearest `query` in meaning, with their text. */
  search(query: string, topK?: number): Promise<NearestChunk[]>;
  /** Embeds every chunk that holds no vector of its current text, newest first. Rejects when an embedding did not land. */
  fill(): Promise<void>;
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

/** Chunks one embedding request carries. */
const FILL_PAGE = 512;

/** Unit length, so a dot product is the cosine. */
function normalized(vector: readonly number[]): Float32Array {
  const norm = Math.hypot(...vector);
  const unit = new Float32Array(vector.length);

  for (const [at, value] of vector.entries()) unit[at] = norm === 0 ? 0 : value / norm;

  return unit;
}

/**
 * The workspace's vectors, kept in its own storage beside the chunks they embed: a note written is found by meaning on
 * the next search, and a chunk deleted takes its vector in the same transaction.
 */
export function createMemoryVectors(opts: { store: MemoryStore; embedder: Embedder; files: Pick<VFS, 'stat'> }): VectorStore {
  const { store, embedder, files } = opts;
  // One fill at a time, so two writes in a row do not embed the same owed chunks twice.
  const lane = serialQueue();

  return {
    available: true,

    async search(query, topK = 10) {
      return await store.nearestChunks(async () => normalized(await embedder.embed(query)), topK, noteDater(files));
    },

    fill() {
      return lane(async () => {
        // Newest first, so a note just written is embedded before an older backlog; until a page finds nothing owed.
        for (let owed = await store.chunksOwedVectors(FILL_PAGE); owed.length > 0; owed = await store.chunksOwedVectors(FILL_PAGE)) {
          const texts = owed.map((chunk) => chunk.text);
          const vectors = embedder.embedBatch ? await embedder.embedBatch(texts) : await Promise.all(texts.map((text) => embedder.embed(text)));

          store.putVectors(owed.flatMap((chunk, at) => {
            const vector = vectors[at];

            return vector === undefined ? [] : [{ id: chunk.id, hash: chunk.hash, embedding: normalized(vector) }];
          }));
        }
      });
    },
  };
}

/** FTS5 alone where no embedder is bound (the CLI, an unbound AI). */
export function createNoopVectorStore(): VectorStore {
  return {
    available: false,
    async search() { return []; },
    async fill() { /* nop */ },
  };
}
