/** Keeps the Vectorize index in step with the FTS5 memory store; separate from runtime.ts to stay dependency-light. */

import { type AgentConfigStore } from '../config/store';
import { type Memory, type VFS } from '../types/primitives';
import { type VectorStore } from './vector-store';
import { type VfsNativeReads } from '../vfs/mounts';
import { AGENT_CONFIG_KEYS } from '../config/store';
import { readTailWithVfsOps } from '../vfs/mounts';
import type { MemoryStore } from "@kinu.run/agent-utils/memory";
import { diagnostics, toKinuError } from "../obs/index";

/** Clearing the completeness marker and cursor hands the repair to the idempotent backfill. */
function invalidateSemanticIndex(config: AgentConfigStore): void {
  config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillDone, 'false');
  config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillCursor, '');
}

/**
 * FTS5 is the source of truth: vector failures are recorded, never fail the write, and clear the backfill
 * marker so chunks are re-embedded. Vector calls are awaited so embeddings are durable before the turn continues.
 */
export function adaptMemory(
  store: MemoryStore, files: VFS & Pick<VfsNativeReads, 'readRange'>,
  vectorStore: VectorStore, config: AgentConfigStore,
): Memory {
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
    tail: (path, bytes) => readTailWithVfsOps(files, path, bytes),
  };
}

/** Bounded so a large memory table embeds across several boots. */
const MEMORY_VECTOR_BACKFILL_CAP = 512;

/** Pages across boots by cursor; rejects before moving cursor or marker, so the next boot retries the page. */
export async function backfillMemoryVectors(
  store: MemoryStore,
  config: AgentConfigStore,
  vectorStore: VectorStore,
  cap: number = MEMORY_VECTOR_BACKFILL_CAP,
): Promise<void> {
  if (!vectorStore.available) return;

  if (config.get(AGENT_CONFIG_KEYS.memoryVectorBackfillDone) === 'true') return;

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
}
