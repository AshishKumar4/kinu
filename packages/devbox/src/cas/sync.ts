/**
 * Stage, fold, replay.
 *
 * Tick: stage new chunk blobs, then append the journal batch. Quiesce: also
 * fold those entries into `tree/` and then advance the folded cursor.
 *
 * Order per batch: blobs, then journal objects. Order per quiesce: journal,
 * then fold, then cursor. A crash anywhere redoes at most one batch, and every
 * step of that redo is idempotent.
 */

import { createHash } from 'node:crypto';
import { CHUNK_SIZE, sha256Hex } from './hash';
import {
  DEFAULT_BATCH_SIZE,
  advanceCursor,
  coalesce,
  listJournalAfter,
  pendingBatches,
  readFoldedSeq,
} from './journal';
import {
  CAS_FORMAT_VERSION,
  JournalBatchSchema,
  KEY_MANIFEST,
  ManifestSchema,
  PREFIX_BLOBS,
  blobKey,
  decodeJson,
  encodeJson,
  treeDirKey,
  treeKey,
  type CasStore,
  type FileEntry,
  type JournalEntry,
  type PresentEntry,
  type StoreCounters,
  counterDelta,
} from './types';

/** `S_IFREG`. s3fs decodes `x-amz-meta-mode` as decimal st_mode. */
const S_IFREG = 32_768;
/** `S_IFLNK`. The object body is the raw target. */
const S_IFLNK = 40_960;
/** `S_IFDIR`. The object is empty; its key ends in `/`. */
const S_IFDIR = 16_384;
const EMPTY = new Uint8Array(0);

export interface StageBlobsResult {
  readonly uploaded: number;
  readonly skipped: number;
  readonly dedupHits: number;
  readonly stalePaths: readonly string[];
  readonly staged: readonly JournalEntry[];
  readonly batches: number;
}

export interface StageBlobsOptions {
  readonly store: CasStore;
  readonly entries: readonly JournalEntry[];
  /** One chunk of an upper file, or null when it vanished or changed. */
  readChunk: (entry: FileEntry, index: number, size: number) => Promise<Uint8Array | null>;
  /** Hashes already known durable. Grown in place as blobs land. */
  readonly known?: Set<string>;
  readonly batchSize?: number;
  /**
   * Commit one batch, called after ITS blobs are durable and never before.
   * This is where the journal objects for that batch are written, which is
   * what bounds a crash to redoing one batch instead of the whole change set.
   */
  commitBatch?: (staged: readonly JournalEntry[]) => Promise<void>;
}

/**
 * Stage chunk blobs, in batches, and commit each batch once its bytes are
 * durable.
 *
 * A chunk the manifest or the pending journal already names is skipped with no
 * store call; every other chunk is ONE PUT. Nothing asks the store first: a
 * HEAD per new blob answered "absent" for every one of them on the deployed
 * arm (128 HEAD beside 131 PUT, 2026-09-01), and a blob that did land before a
 * crash costs one idempotent re-PUT on the redo instead.
 *
 * A file whose bytes no longer match the digest the journal recorded is STALE:
 * staging stops there rather than writing a journal object naming blobs that
 * were never stored. Storing them under the journalled hash would corrupt the
 * content-addressed store permanently rather than costing a retry.
 */
export async function stageBlobs(options: StageBlobsOptions): Promise<StageBlobsResult> {
  const { store, entries, readChunk } = options;
  const known = options.known ?? new Set<string>();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let uploaded = 0;
  let skipped = 0;
  let dedupHits = 0;
  let batches = 0;
  const stalePaths: string[] = [];
  const staged: JournalEntry[] = [];

  outer: for (let offset = 0; offset < entries.length; offset += batchSize) {
    const batch = entries.slice(offset, offset + batchSize);
    const committed: JournalEntry[] = [];
    for (const entry of batch) {
      if (entry.kind === 'file') {
        const result = await uploadChunks(store, known, entry, readChunk);
        if (result === null) {
          stalePaths.push(entry.path);
          break outer;
        }
        uploaded += result.uploaded;
        skipped += result.skipped;
        if (result.uploaded === 0 && entry.parts.some(part => part.kind === 'data')) dedupHits += 1;
      }
      committed.push(entry);
    }
    if (committed.length === 0) break;
    if (options.commitBatch !== undefined) await options.commitBatch(committed);
    staged.push(...committed);
    batches += 1;
  }

  return { uploaded, skipped, dedupHits, stalePaths, staged, batches };
}

async function uploadChunks(
  store: CasStore,
  known: Set<string>,
  entry: FileEntry,
  readChunk: (entry: FileEntry, index: number, size: number) => Promise<Uint8Array | null>,
): Promise<{ uploaded: number; skipped: number } | null> {
  let uploaded = 0;
  let skipped = 0;
  const chunks = entry.parts.filter((part): part is { kind: 'data'; hash: string; size: number } =>
    part.kind === 'data');
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    if (known.has(chunk.hash)) {
      known.add(chunk.hash);
      skipped += 1;
      continue;
    }
    const bytes = await readChunk(entry, index, chunk.size);
    if (bytes === null || sha256Hex(bytes) !== chunk.hash) return null;
    await store.put(blobKey(chunk.hash), bytes);
    known.add(chunk.hash);
    uploaded += 1;
  }
  return { uploaded, skipped };
}

export interface FoldResult {
  readonly foldedEntries: number;
  /** The winning entry per path this fold consumed, from `coalesce`. The
   *  quiesce layer stamps signatures and drops tombstoned rows from exactly
   *  this set, so "folded" means what the fold actually read — never a guess
   *  from the scan. */
  readonly foldedPaths: ReadonlyMap<string, JournalEntry>;
  readonly treeWrites: number;
  readonly treeDeletes: number;
  readonly journalObjectsReaped: number;
  readonly cursorBefore: number;
  readonly cursorAfter: number;
  readonly store: StoreCounters;
}


/**
 * Fold pushed journal entries into `tree/` and advance the durable cursor.
 *
 * Journal-before-fold is structural: this only reads journal objects that are
 * already in the store. Fold-before-cursor is the last assignment: the cursor
 * PUT happens only after every tree write and the manifest PUT.
 */
export async function foldJournalIntoTree(store: CasStore): Promise<FoldResult> {
  const opened = { ...store.counters };
  const cursorBefore = await readFoldedSeq(store);
  const pendingSeqs = await pendingBatches(store, cursorBefore);

  if (pendingSeqs.length === 0) {
    return {
      foldedEntries: 0,
      foldedPaths: new Map(),
      treeWrites: 0,
      treeDeletes: 0,
      journalObjectsReaped: 0,
      cursorBefore,
      cursorAfter: cursorBefore,
      store: counterDelta(opened, store.counters),
    };
  }

  // One object per batch, so this flattens. The cursor advances past whole
  // batches only, which is what makes a half-folded batch unrepresentable.
  const entries: JournalEntry[] = [];
  for (const row of pendingSeqs) {
    const bytes = await store.get(row.key);
    // Absent here means the same hole listJournalAfter refuses: the listing
    // named it and the cursor has not passed it, so it cannot have been reaped.
    if (bytes === null) {
      throw new Error(
        `${row.key} was listed but its bytes are absent, and it is newer than the folded `
        + `cursor (${cursorBefore}), so it cannot have been reaped. The journal has a hole.`,
      );
    }
    entries.push(...decodeJson(JournalBatchSchema, row.key, bytes).entries);
  }

  // The winning entry per path, which is what the fold actually consumes and
  // what a caller needs to know was folded.
  const foldedPaths = new Map(coalesce(entries).map(entry => [entry.path, entry]));

  const manifest = await readManifest(store);
  let treeWrites = 0;
  let treeDeletes = 0;

  for (const entry of coalesce(entries)) {
    switch (entry.kind) {
      case 'file': {
        await store.putStream(treeKey(entry.path), fileChunkStream(store, entry), entry.size, {
          mode: S_IFREG | (entry.mode & 0o7777),
          mtimeMs: entry.mtimeMs,
        });
        manifest.set(entry.path, entry);
        treeWrites += 1;
        break;
      }
      case 'symlink': {
        await store.put(
          treeKey(entry.path),
          new TextEncoder().encode(entry.target),
          { mode: S_IFLNK | 0o777, symlink: true, mtimeMs: entry.mtimeMs },
        );
        manifest.set(entry.path, entry);
        treeWrites += 1;
        break;
      }
      case 'hardlink': {
        const target = manifest.get(entry.target);
        if (target?.kind !== 'file') {
          throw new Error(`hardlink ${entry.path} targets missing or non-file ${entry.target}`);
        }
        await store.putStream(treeKey(entry.path), fileChunkStream(store, target), target.size, {
          mode: S_IFREG | (entry.mode & 0o7777),
          mtimeMs: entry.mtimeMs,
        });
        manifest.set(entry.path, entry);
        treeWrites += 1;
        break;
      }
      case 'dir': {
        if (entry.opaque) {
          for (const held of deepestFirst(manifest, `${entry.path}/`, false)) {
            await store.delete(held.kind === 'dir' ? treeDirKey(held.path) : treeKey(held.path));
            manifest.delete(held.path);
            treeDeletes += 1;
          }
        }
        // WRITTEN, not implied. A directory the lower only knew as the prefix
        // of its files came back from a wake with a default mode, and an empty
        // one did not come back at all (cell 6.13, 2026-09-02).
        await store.put(treeDirKey(entry.path), EMPTY, {
          mode: S_IFDIR | (entry.mode & 0o7777),
          mtimeMs: entry.mtimeMs,
        });
        manifest.set(entry.path, entry);
        treeWrites += 1;
        break;
      }
      case 'delete': {
        let removedForEntry = 0;
        for (const held of deepestFirst(manifest, `${entry.path}/`, true)) {
          await store.delete(held.kind === 'dir' ? treeDirKey(held.path) : treeKey(held.path));
          manifest.delete(held.path);
          treeDeletes += 1;
          removedForEntry += 1;
        }
        // A tombstone for a path the manifest never knew still has to reach the
        // tree, because the tree can hold objects an earlier manifest lost.
        if (removedForEntry === 0) {
          await store.delete(treeKey(entry.path));
          treeDeletes += 1;
        }
        break;
      }
      default: {
        // Unreachable while the schema and this switch agree, which is the
        // point: a kind added to JournalEntry without an arm here would
        // otherwise be SKIPPED, and a fold that silently drops a recorded
        // change is the defect class this whole layout exists to prevent.
        const unknown: never = entry;
        throw new Error(
          `journal entry has a kind this fold does not handle: ${JSON.stringify(unknown)}`,
        );
      }
    }
  }

  await writeManifest(store, manifest);
  const cursorAfter = pendingSeqs[pendingSeqs.length - 1]!.seq;
  await advanceCursor(store, cursorAfter);

  // Reaping after the cursor advances means a crash leaves garbage, never a hole.
  let journalObjectsReaped = 0;
  for (const row of pendingSeqs) {
    await store.delete(row.key);
    journalObjectsReaped += 1;
  }

  return {
    foldedEntries: entries.length,
    foldedPaths,
    treeWrites,
    treeDeletes,
    journalObjectsReaped,
    cursorBefore,
    cursorAfter,
    store: counterDelta(opened, store.counters),
  };
}

/**
 * Rebuild the pending upper from the store. Only entries after the folded
 * cursor are returned: that is the O(pending-change) recovery, never the tree.
 */
export async function replayPending(store: CasStore): Promise<{
  readonly foldedSeq: number;
  readonly pending: readonly JournalEntry[];
  readonly replayed: readonly {
    entry: JournalEntry;
    stream: ReadableStream<Uint8Array> | null;
  }[];
}> {
  const foldedSeq = await readFoldedSeq(store);
  const pending = await listJournalAfter(store, foldedSeq);
  const replayed = coalesce(pending).map(entry => ({
    entry,
    stream: entry.kind === 'file' ? fileChunkStream(store, entry) : null,
  }));
  return { foldedSeq, pending, replayed };
}

/** One file reconstructed as a bounded stream. Every chunk is checked before
 * it leaves, and the whole digest is checked before close. A failed stream
 * aborts R2 multipart or the container write, so no partial object becomes
 * visible. */
export function fileChunkStream(
  store: CasStore,
  entry: FileEntry,
): ReadableStream<Uint8Array> {
  let index = 0;
  let holeOffset = 0;
  let total = 0;
  const whole = createHash('sha256');
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= entry.parts.length) {
        if (total !== entry.size) {
          controller.error(new Error(`streamed ${total} bytes, expected ${entry.size} for ${entry.path}`));
          return;
        }
        const digest = whole.digest('hex');
        if (digest !== entry.hash) {
          controller.error(new Error(`streamed bytes fail digest for ${entry.path}`));
          return;
        }
        controller.close();
        return;
      }
      const part = entry.parts[index]!;
      if (part.kind === 'hole') {
        const size = Math.min(CHUNK_SIZE, part.size - holeOffset);
        const bytes = new Uint8Array(size);
        holeOffset += size;
        if (holeOffset === part.size) {
          index += 1;
          holeOffset = 0;
        }
        total += size;
        whole.update(bytes);
        controller.enqueue(bytes);
        return;
      }
      const bytes = await store.get(blobKey(part.hash));
      if (bytes === null) {
        controller.error(new Error(`blob missing for ${entry.path}: ${part.hash}`));
        return;
      }
      if (bytes.byteLength !== part.size || sha256Hex(bytes) !== part.hash) {
        controller.error(new Error(`blob fails size or digest for ${entry.path}: ${part.hash}`));
        return;
      }
      index += 1;
      total += bytes.byteLength;
      whole.update(bytes);
      controller.enqueue(bytes);
    },
  }, { highWaterMark: 0 });
}

/**
 * Delete every blob nothing reaches.
 *
 * THE OFF-HOT-PATH SWEEP the Lean model states (`gcCost`,
 * `gc_is_off_the_hot_path`): reachable set = every chunk the manifest names
 * plus every chunk any still-pending journal entry names; everything else
 * under `blobs/` is a superseded version or a tombstoned file's remains.
 * Content addressing makes the delete safe — a live reference can only name a
 * hash its entry carries, and that hash is in the reachable set by
 * construction.
 * Runs at quiesce only, after fold and cursor advance, NEVER on tick or
 * attach: it lists the whole `blobs/` prefix, which is exactly the cost the
 * model bills to the sweep and keeps off the hot path.
 */
export async function sweepOrphanBlobs(store: CasStore): Promise<{
  readonly listed: number;
  readonly deleted: number;
  /** The full keys of every deleted blob, so a caller holding a content-hash
   *  cache can evict exactly those entries — a cached hash for a swept blob
   *  would make the next tick believe bytes are durable that are not. */
  readonly deletedKeys: readonly string[];
}> {
  const reachable = new Set<string>();
  for (const entry of (await readManifest(store)).values()) {
    if (entry.kind !== 'file') continue;
    for (const part of entry.parts) {
      if (part.kind === 'data') reachable.add(blobKey(part.hash));
    }
  }
  for (const entry of await listJournalAfter(store, await readFoldedSeq(store))) {
    if (entry.kind !== 'file') continue;
    for (const part of entry.parts) {
      if (part.kind === 'data') reachable.add(blobKey(part.hash));
    }
  }
  const listed = await store.list(PREFIX_BLOBS);
  const orphans = listed.filter(key => !reachable.has(key));
  for (const key of orphans) await store.delete(key);
  return { listed: listed.length, deleted: orphans.length, deletedKeys: orphans };
}

/** Manifest entries under `prefix`, deepest first, so a subtree is deleted
 *  children before parents. */
function deepestFirst(
  manifest: ReadonlyMap<string, PresentEntry>,
  prefix: string,
  includeSelf: boolean,
): PresentEntry[] {
  const self = prefix.slice(0, -1);
  return [...manifest.values()]
    .filter(held => held.path.startsWith(prefix) || (includeSelf && held.path === self))
    .sort((a, b) => b.path.split('/').length - a.path.split('/').length || (a.path < b.path ? 1 : -1));
}

export async function readManifest(store: CasStore): Promise<Map<string, PresentEntry>> {
  const bytes = await store.get(KEY_MANIFEST);
  if (bytes === null) return new Map();
  return new Map(decodeJson(ManifestSchema, KEY_MANIFEST, bytes).entries.map(entry => [entry.path, entry]));
}

async function writeManifest(store: CasStore, manifest: Map<string, PresentEntry>): Promise<void> {
  const entries = [...manifest.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  await store.put(KEY_MANIFEST, encodeJson({ version: CAS_FORMAT_VERSION, entries }));
}
