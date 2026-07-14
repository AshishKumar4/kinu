/**
 * Semantic-memory sync — the seam that keeps a Vectorize index in step with the
 * FTS5 memory store. Kept separate from runtime.ts (which pulls in the sandbox /
 * codemode / Think bindings) so this logic stays dependency-light and unit-
 * testable against a fake VectorStore.
 *
 *   • adaptMemory          — every memory write embeds its chunks; changed line
 *                            ranges drop their stale vectors.
 *   • backfillMemoryVectors — one-time embed of chunks indexed before the vector
 *                             store existed (idempotent, cursor-paged).
 */

import type { Memory, VectorStore, createAgentConfigStore } from "@proteus/core";
import { AGENT_CONFIG_KEYS } from "@proteus/core";
import type { MemoryStore } from "@proteus/agent-utils/memory";

/**
 * Adapt agent-utils' MemoryStore to core's Memory, syncing the semantic index
 * on every write. FTS5 is the source of truth; the vector store is synced from
 * the index delta and its failures only warn — a Vectorize hiccup must not fail
 * the memory write (FTS5 already succeeded). The vector calls ARE awaited so the
 * embeddings are durable before the turn continues.
 */
export function adaptMemory(store: MemoryStore, vectorStore: VectorStore): Memory {
  return {
    write: (path, content) => store.writeFile(path, content),
    append: (path, content) => store.appendToFile(path, content),
    async index(path) {
      const content = await store.readFile(path);
      if (!content) return;
      const delta = await store.indexFile(path, content);
      if (!vectorStore.available) return;
      try {
        if (delta.deletedIds.length > 0) await vectorStore.deleteChunks(delta.deletedIds);
        if (delta.upserted.length > 0) await vectorStore.upsertChunks(delta.upserted);
      } catch (err) {
        console.warn('[proteus] memory vector sync failed:', (err as Error).message);
      }
    },
    search: (query, limit) => Promise.resolve(store.search(query, limit)),
    read: (path) => store.readFile(path),
  };
}

/** Chunks embedded per boot during the one-time backfill. Bounded so a large
 *  memory table is embedded across several boots rather than blocking one. */
export const MEMORY_VECTOR_BACKFILL_CAP = 512;

/**
 * One-time backfill: memories indexed into FTS5 before the vector store existed
 * aren't embedded, so their semantic recall is empty. On boot (when a vector
 * store is available and the backfill isn't marked done) embed one bounded page
 * of existing chunks, advancing a cursor so a huge table pages across boots
 * without re-embedding. Idempotent — a no-op once the marker is set.
 */
export async function backfillMemoryVectors(
  store: MemoryStore,
  config: ReturnType<typeof createAgentConfigStore>,
  vectorStore: VectorStore,
  cap: number = MEMORY_VECTOR_BACKFILL_CAP,
): Promise<void> {
  if (!vectorStore.available) return;
  if (config.get(AGENT_CONFIG_KEYS.memoryVectorBackfillDone) === 'true') return;
  try {
    const cursor = config.get(AGENT_CONFIG_KEYS.memoryVectorBackfillCursor) ?? '';
    const chunks = store.allChunksAfter(cursor, cap);
    if (chunks.length === 0) {
      config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillDone, 'true');
      return;
    }
    await vectorStore.upsertChunks(chunks);
    config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillCursor, chunks[chunks.length - 1].id);
    if (chunks.length < cap) {
      config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillDone, 'true');
    }
  } catch (err) {
    console.warn('[proteus] memory vector backfill failed:', (err as Error).message);
  }
}
