import { exists, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** Keeps the Vectorize index in step with the FTS5 memory store; separate from runtime.ts to stay dependency-light. */

import { Effect } from 'effect';
import { type AgentConfigStore } from '../config/store';
import { type Memory } from '../types/primitives';
import { type VectorStore } from './vector-store';

import { AGENT_CONFIG_KEYS } from '../config/store';
import { readTailWithVfsOps } from '../vfs/mounts';
import { MEMORY_DIR } from './note';
import type { MemoryStore } from "@kinu.run/agent-utils/memory";
import { diagnostics, settle, toKinuError } from "../obs/index";

/** Clearing the completeness marker and cursor hands the repair to the idempotent backfill. */
function invalidateSemanticIndex(config: AgentConfigStore): void {
  config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillDone, 'false');
  config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillCursor, '');
}

/** A semantic index beside FTS5, and the config whose backfill marker a failed sync clears. */
export interface MemoryVectors {
  readonly store: VectorStore;
  readonly config: AgentConfigStore;
}

/**
 * Every backend's memory. FTS5 is the source of truth: vector failures are recorded, never fail the write, and clear
 * the backfill marker so chunks are re-embedded. Vector calls are awaited so embeddings are durable before the turn
 * continues. Without `vectors` (the CLI, workspace birth) the index is FTS5 alone.
 */
export function adaptMemory(
  store: MemoryStore, files: VFS & Required<Pick<VFS, 'readRange'>>, vectors?: MemoryVectors,
): Memory {
  /** Whether `path` is a file whose stamp differs from the one it was indexed at: a shell changed it under the index. */
  const changed = async (path: string, stamps = store.stamps()): Promise<boolean> => {
    const stat = await files.stat(path);
    const indexed = stamps.get(path);

    if (stat === null || stat.type !== 'file') return indexed !== undefined;

    return indexed === undefined || indexed.size !== stat.size || indexed.mtimeMs !== stat.mtimeMs;
  };

  /** Every note whose stamp moved, a note no index row names yet, and every indexed one now gone, indexed again. */
  const refresh = async (): Promise<void> => {
    const stamps = store.stamps();
    const notes = await notePaths(files);

    for (const path of new Set([...notes, ...[...stamps.keys()].filter((known) => known.startsWith(MEMORY_DIR))])) {
      if (await changed(path, stamps)) await memory.index(path);
    }
  };

  const memory: Memory = {
    write: (path, content) => store.writeFile(path, content),
    append: (path, content) => store.appendToFile(path, content),
    index(path) {
      return settle(Effect.gen(function* () {
        const content = yield* Effect.promise(() => store.readFile(path));
        const stat = content === null ? null : yield* Effect.promise(async () => files.stat(path));
        // A note that is gone leaves the index with its chunks; an emptied one indexes to none.
        const delta = yield* Effect.promise(() => store.indexFile(path, content ?? '', stat === null ? undefined : { size: stat.size, mtimeMs: stat.mtimeMs }));

        if (vectors === undefined || !vectors.store.available) return;
        const vectorStore = vectors.store;

        yield* Effect.tryPromise({
          try: async () => {
            if (delta.deletedIds.length > 0) await vectorStore.deleteChunks(delta.deletedIds);

            if (delta.upserted.length > 0) await vectorStore.upsertChunks(delta.upserted);
          },
          catch: (cause) => toKinuError({ doing: 'syncing the memory chunk delta into the vector index', cause, otherwise: 'unavailable' }),
        }).pipe(Effect.catch((failure) => Effect.sync(() => {
          diagnostics.failure('memory.vector_sync_failed', failure, { path });
          invalidateSemanticIndex(vectors.config);
        })));
      }));
    },
    // A shell edits notes beside the memory tool: a search first re-indexes every note that moved, so its new words are found.
    async search(query, limit) {
      await refresh();

      return store.search(query, limit, async (path) => memory.index(path));
    },
    async read(path) {
      const content = await store.readFile(path);

      if (await changed(path)) await memory.index(path);

      return content;
    },
    tail: (path, bytes) => readTailWithVfsOps(files, path, bytes),
  };

  return memory;
}

/** Every markdown note under the memory directory, by its relative path. */
async function notePaths(files: VFS, dir = MEMORY_DIR.slice(0, -1)): Promise<string[]> {
  if (!await exists(files, dir)) return [];
  const out: string[] = [];

  for (const entry of await files.readdir(dir)) {
    const path = `${dir}/${entry.name}`;

    if (entry.type === 'directory') out.push(...await notePaths(files, path));
    else if (entry.type === 'file' && path.endsWith('.md')) out.push(path);
  }

  return out;
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
  const page = await store.allChunksAfter(cursor, cap);

  if (page.chunks.length > 0) await vectorStore.upsertChunks(page.chunks);

  if (page.next === null) {
    config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillDone, 'true');

    return;
  }

  config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillCursor, page.next);
}
