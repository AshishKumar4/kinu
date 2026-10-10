import { exists, type VFS, type VfsStat } from '@nimbus-sh/core/vfs/vfs.js';
import { direntTypeOfStat } from '@nimbus-sh/core/vfs/dirent-type.js';
/** Keeps the Vectorize index in step with the FTS5 memory store; separate from runtime.ts to stay dependency-light. */

import { Effect } from 'effect';
import { serialQueue } from '@kinu.run/agent-utils';
import * as v from 'valibot';
import { type AgentConfigStore } from '../config/store';
import { type Memory } from '../types/primitives';
import { type VectorStore } from './vector-store';

import { AGENT_CONFIG_KEYS } from '../config/store';
import { readTailWithVfsOps } from '../vfs/mounts';
import { MEMORY_DIR } from './note';
import type { MemoryStore, NoteStamp } from "@kinu.run/agent-utils/memory";
import { diagnostics, settle, toKinuError } from "../obs/index";

const PendingVectorsSchema = v.object({
  revision: v.number(),
  operations: v.record(v.string(), v.object({ kind: v.picklist(['upsert', 'delete']), revision: v.number() })),
});

const mirrorLanes = new WeakMap<AgentConfigStore, ReturnType<typeof serialQueue>>();

function pendingVectors(config: AgentConfigStore): v.InferOutput<typeof PendingVectorsSchema> {
  const stored = config.get(AGENT_CONFIG_KEYS.memoryVectorPending);

  return stored === null ? { revision: 0, operations: {} } : v.parse(PendingVectorsSchema, JSON.parse(stored));
}

/** Persist references before any remote call: a cooldown or lost acknowledgment cannot consume a lexical delta. */
function rememberVectors(config: AgentConfigStore, delta: { upserted: readonly { id: string }[]; deletedIds: readonly string[] }): void {
  if (delta.upserted.length === 0 && delta.deletedIds.length === 0) return;

  const pending = pendingVectors(config);
  pending.revision += 1;

  for (const id of delta.deletedIds) pending.operations[id] = { kind: 'delete', revision: pending.revision };

  for (const chunk of delta.upserted) pending.operations[chunk.id] = { kind: 'upsert', revision: pending.revision };

  config.set(AGENT_CONFIG_KEYS.memoryVectorPending, JSON.stringify(pending));
}

async function flushPendingVectors(store: MemoryStore, config: AgentConfigStore, vectors: VectorStore): Promise<void> {
  let serial = mirrorLanes.get(config);

  if (serial === undefined) {
    serial = serialQueue();
    mirrorLanes.set(config, serial);
  }

  await serial(async () => {
    const pending = pendingVectors(config);
    const ids = Object.keys(pending.operations);
  
    if (ids.length === 0) return;
  
    const upsert = ids.filter((id) => pending.operations[id].kind === 'upsert');
    const fresh = await store.chunksByIds(upsert);
    const current = new Set(fresh.map((chunk) => chunk.id));
    const remove = ids.filter((id) => pending.operations[id].kind === 'delete' || !current.has(id));
  
    if (remove.length > 0) await vectors.deleteChunks(remove);
  
    if (fresh.length > 0) await vectors.upsertChunks(fresh);
  
    const remaining = pendingVectors(config);
  
    // A newer operation for the same id belongs to a later flush; idempotent acknowledgments clear only this snapshot.
    for (const id of ids) if (remaining.operations[id]?.revision === pending.operations[id].revision) delete remaining.operations[id];
  
    config.set(AGENT_CONFIG_KEYS.memoryVectorPending, JSON.stringify(remaining));
  });
}

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
  /** Every note new to the index, changed under it, or gone from it, indexed again. */
  const refresh = async (): Promise<void> => {
    const stamps = store.stamps();
    const known = [...stamps.keys()].filter((path) => path.startsWith(MEMORY_DIR));

    for (const path of new Set([...await notePaths(files), ...known])) {
      if (await stale(files, path, stamps.get(path))) await memory.index(path);
    }
  };

  const memory: Memory = {
    write: (path, content) => store.writeFile(path, content),
    append: (path, content) => store.appendToFile(path, content),
    index(path) {
      return settle(Effect.gen(function* () {
        const note = yield* Effect.promise(() => settledNote(store, files, path));
        // A note that is gone, or is no file, leaves the index with its chunks; an emptied one indexes to none.
        const delta = yield* Effect.promise(() => (note === null ? store.forgetFile(path) : store.indexFile(path, note.content, note.stamp)));

        if (vectors === undefined) return;
        rememberVectors(vectors.config, delta);

        if (!vectors.store.available) {
          invalidateSemanticIndex(vectors.config);

          return;
        }

        const vectorStore = vectors.store;

        yield* Effect.tryPromise({
          try: () => flushPendingVectors(store, vectors.config, vectorStore),
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

      if (await stale(files, path, store.stampOf(path))) await memory.index(path);

      return content;
    },
    tail: (path, bytes) => readTailWithVfsOps(files, path, bytes),
  };

  return memory;
}

/** A stamp is trusted once its file's last change is this far past: within it, a second change may keep every stamp field. */
const RACY_MS = 2_000;

/** Reads of a note that changed under each of them before it is indexed unstamped. */
const SETTLE_ATTEMPTS = 3;

/** The file's identity: its backend's revision, else git's racy-clean stat (inode, size, mtime, and ctime, which no caller sets). */
function stampOf(stat: VfsStat): string {
  return stat.revision === undefined ? `${stat.ino ?? 0}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs ?? ''}` : `r${stat.revision}`;
}

/** A regular file: a link, a directory, a FIFO or a device at a note's path is no note. */
function regular(stat: VfsStat | null): stat is VfsStat {
  return stat !== null && direntTypeOfStat(stat) === 'file';
}

/** Whether the index holds `path` other than as it stands: new to it, changed under it, untrusted, or no file now. */
async function stale(files: VFS, path: string, indexed: NoteStamp | undefined): Promise<boolean> {
  const stat = await files.stat(path, { follow: false });

  return regular(stat) ? indexed !== stampOf(stat) : indexed !== undefined;
}

/**
 * The note as one file held it, its stamp taken before the read and checked after: a write between them reads it again,
 * and a note still changing, or changed within RACY_MS, is indexed unstamped so the next search reads it again. Null when
 * no regular file is there.
 */
async function settledNote(store: MemoryStore, files: VFS, path: string): Promise<{ readonly content: string; readonly stamp: NoteStamp } | null> {
  for (let attempt = 1; ; attempt += 1) {
    const before = await files.stat(path, { follow: false });

    if (!regular(before)) return null;
    const content = await store.readFile(path);
    const after = await files.stat(path, { follow: false });

    if (content !== null && regular(after) && stampOf(after) === stampOf(before)) {
      const changedAt = Math.max(after.mtimeMs, after.ctimeMs ?? after.mtimeMs);

      return { content, stamp: after.revision !== undefined || changedAt < Date.now() - RACY_MS ? stampOf(after) : null };
    }

    if (attempt === SETTLE_ATTEMPTS) return content === null ? null : { content, stamp: null };
  }
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

  await flushPendingVectors(store, config, vectorStore);

  if (config.get(AGENT_CONFIG_KEYS.memoryVectorBackfillDone) === 'true') return;

  const cursor = config.get(AGENT_CONFIG_KEYS.memoryVectorBackfillCursor) ?? '';
  const page = await store.allChunksAfter(cursor, cap);

  rememberVectors(config, { upserted: page.chunks, deletedIds: [] });
  await flushPendingVectors(store, config, vectorStore);

  if (page.next === null) {
    config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillDone, 'true');

    return;
  }

  config.set(AGENT_CONFIG_KEYS.memoryVectorBackfillCursor, page.next);
}
