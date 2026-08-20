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

import type { AgentConfigStore, Memory, VectorStore } from "@kinu/core";
import { AGENT_CONFIG_KEYS } from "@kinu/core";
import type { IndexedChunk, MemoryStore } from "@kinu/agent-utils/memory";
import { diagnostics, toKinuError } from '@kinu/core/obs';

/** A chunk FTS5 holds and the vector index does not makes the semantic index
 *  incomplete, so the completeness marker must stop claiming otherwise. Clearing
 *  it (and the page cursor) hands the repair to the backfill, which re-embeds
 *  idempotently on the next boot — the one mechanism for exactly this gap. */
function invalidateSemanticIndex(config: AgentConfigStore): void {
  config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillDone, 'false');
  config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillCursor, '');
}

/**
 * Adapt agent-utils' MemoryStore to core's Memory, syncing the semantic index
 * on every write. FTS5 is the source of truth; the vector store is synced from
 * the index delta and its failures are only recorded — a Vectorize hiccup must not fail
 * the memory write (FTS5 already succeeded). The vector calls ARE awaited so the
 * embeddings are durable before the turn continues.
 *
 * A failed sync degrades to lexical-only recall, but it does not pretend the
 * write was indexed: it clears the backfill's completeness marker so the chunks
 * are re-embedded rather than lost.
 */
export function adaptMemory(store: MemoryStore, vectorStore: VectorStore, config: AgentConfigStore): Memory {
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
        diagnostics.failure('memory.vector_sync_failed', toKinuError({
          doing: 'syncing the memory chunk delta into the vector index',
          cause: err,
          otherwise: 'unavailable',
        }), { path });
        invalidateSemanticIndex(config);
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
  config: AgentConfigStore,
  vectorStore: VectorStore,
  cap: number = MEMORY_VECTOR_BACKFILL_CAP,
): Promise<void> {
  if (!vectorStore.available) return;
  if (config.get(AGENT_CONFIG_KEYS.memoryVectorBackfillDone) === 'true') return;

  const cursor = config.get(AGENT_CONFIG_KEYS.memoryVectorBackfillCursor) ?? '';
  let chunks: IndexedChunk[];
  try {
    chunks = store.allChunksAfter(cursor, cap);
  } catch (err) {
    diagnostics.failure('memory.vector_backfill_read_failed', toKinuError({
      doing: 'reading memory chunks for the vector backfill',
      cause: err,
      otherwise: 'io',
    }), { cursor });
    return;
  }
  if (chunks.length === 0) {
    config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillDone, 'true');
    return;
  }

  try {
    await vectorStore.upsertChunks(chunks);
  } catch (err) {
    // Neither the cursor nor the marker may move past a chunk that did not
    // embed: advancing over a failed page is what let the marker claim a
    // complete semantic index over content it never indexed. The next boot
    // retries this same page.
    diagnostics.failure('memory.vector_backfill_page_failed', toKinuError({
      doing: 'embedding a page of memory chunks for the vector backfill',
      cause: err,
      otherwise: 'unavailable',
    }), { cursor, chunks: chunks.length });
    return;
  }

  config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillCursor, chunks[chunks.length - 1].id);
  if (chunks.length < cap) {
    config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillDone, 'true');
  }
}
