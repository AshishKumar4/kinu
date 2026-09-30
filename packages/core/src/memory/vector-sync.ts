import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** Keeps the Vectorize index in step with the FTS5 memory store; separate from runtime.ts to stay dependency-light. */

import { Effect } from 'effect';
import { type AgentConfigStore } from '../config/store';
import { type Memory } from '../types/primitives';
import { type VectorStore } from './vector-store';

import { AGENT_CONFIG_KEYS } from '../config/store';
import { readTailWithVfsOps } from '../vfs/mounts';
import type { MemoryStore } from "@kinu.run/agent-utils/memory";
import { diagnostics, settle, toKinuError } from "../obs/index";

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
  store: MemoryStore, files: VFS & Required<Pick<VFS, 'readRange'>>,
  vectorStore: VectorStore, config: AgentConfigStore,
): Memory {
  return {
    write: (path, content) => store.writeFile(path, content),
    append: (path, content) => store.appendToFile(path, content),
    index(path) {
      return settle(Effect.gen(function* () {
        const content = yield* Effect.promise(() => store.readFile(path));

        if (!content) return;
        const delta = yield* Effect.promise(() => store.indexFile(path, content));

        if (!vectorStore.available) return;

        yield* Effect.tryPromise({
          try: async () => {
            if (delta.deletedIds.length > 0) await vectorStore.deleteChunks(delta.deletedIds);

            if (delta.upserted.length > 0) await vectorStore.upsertChunks(delta.upserted);
          },
          catch: (cause) => toKinuError({ doing: 'syncing the memory chunk delta into the vector index', cause, otherwise: 'unavailable' }),
        }).pipe(Effect.catch((failure) => Effect.sync(() => {
          diagnostics.failure('memory.vector_sync_failed', failure, { path });
          invalidateSemanticIndex(config);
        })));
      }));
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
