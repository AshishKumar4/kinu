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

/**
 * How many store calls one step keeps in flight.
 *
 * MEASURED, and this is the term that spent a deployed deadline. Run
 * 20260903140046's overlay-cas arm never settled its first decisive `npm`
 * checkpoint inside 1,500,000 ms. The ladder in that same run prices why: its
 * committing checkpoints moved 0.05-1.98 MB/s, and the 64 MiB quiesce spent
 * 67,723 ms across roughly 132 store calls — about 513 ms each. The endpoint is
 * not the bound: `bench/measure-first/MEASUREMENTS.md` measures this exact
 * direct path at 95-146 MiB/s with 16-64 requests in flight. Every call here
 * was awaited inside a `for`, so the arm ran at ONE request and was bound by
 * latency times call count — and a fold issues one tree write per changed path
 * plus a read per blob it streams, which passes 25 minutes at about 2,000
 * changed files. An npm tree is far larger than that.
 *
 * SIXTEEN, the low end of the measured range: the flat part of that curve
 * starts there, and a bound this side picks is a bound the platform has been
 * measured at rather than a number chosen for ambition.
 *
 * CONCURRENCY LIVES INSIDE ONE STEP AND NEVER ACROSS TWO. Every ordering the
 * layout's crash safety rests on — blobs before their batch, the batch before
 * the fold, the tree before the manifest, the manifest before the cursor, the
 * cursor before the reap — is a boundary between steps, and each of those is
 * still a single await. What overlaps is only the calls WITHIN a step, which
 * are independent by construction: distinct content-addressed keys, no
 * ordering among themselves, and idempotent under a repeat.
 */
const STORE_CALL_WIDTH = 16;

/**
 * Run `work` over `items` with at most {@link STORE_CALL_WIDTH} in flight, in
 * order of issue. The first failure is what the caller sees, and no further
 * item is issued after it — a step that half-failed must not keep writing.
 */
export async function throughStorePool<Item>(
  items: readonly Item[],
  work: (item: Item) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure !== undefined) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        await work(items[index]!);
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(STORE_CALL_WIDTH, items.length) }, () => worker()),
  );
  if (failure !== undefined) throw failure;
}

/** A file whose bytes no longer digest to what the journal recorded. It stops
 *  the staging, exactly as the sequential form's `return null` did; the class
 *  exists so the bounded pool's first-failure rule carries the reason. */
class StaleUpperBytes extends Error {
  constructor(readonly path: string) {
    super(`upper bytes for ${path} no longer match the digest the journal recorded`);
    this.name = 'StaleUpperBytes';
  }
}

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
    // THE BLOBS OF ONE BATCH GO OUT TOGETHER. Every entry's chunks are
    // independent content-addressed keys with no ordering among themselves, so
    // this is the step whose calls may overlap — and the batch's own journal
    // object still follows ALL of them, which is the invariant that makes a
    // crash leave an orphan blob rather than a journal entry whose bytes are
    // absent. Sequentially this loop was the deployed cost: about 513 ms per
    // call, thousands of calls, one at a time (see STORE_CALL_WIDTH).
    const files = batch.filter((entry): entry is Extract<JournalEntry, { kind: 'file' }> =>
      entry.kind === 'file');
    let stale: string | undefined;
    try {
      await throughStorePool(files, async (entry) => {
        const result = await uploadChunks(store, known, entry, readChunk);
        if (result === null) throw new StaleUpperBytes(entry.path);
        uploaded += result.uploaded;
        skipped += result.skipped;
        if (result.uploaded === 0 && entry.parts.some(part => part.kind === 'data')) dedupHits += 1;
      });
    } catch (error) {
      if (!(error instanceof StaleUpperBytes)) throw error;
      stale = error.path;
    }
    if (stale !== undefined) {
      stalePaths.push(stale);
      break outer;
    }
    const committed: JournalEntry[] = [...batch];
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
  // The chunks of one file are independent, content-addressed and idempotent,
  // so they go out together rather than one round trip at a time. A chunk
  // whose bytes no longer digest to what the journal recorded is STALE and
  // stops the whole staging — the same refusal as before, reported by the
  // first failure the pool sees.
  const pending = chunks
    .map((chunk, index) => ({ chunk, index }))
    .filter(({ chunk }) => {
      if (!known.has(chunk.hash)) return true;
      skipped += 1;
      return false;
    });
  try {
    await throughStorePool(pending, async ({ chunk, index }) => {
      const bytes = await readChunk(entry, index, chunk.size);
      if (bytes === null || sha256Hex(bytes) !== chunk.hash) throw new StaleUpperBytes(entry.path);
      await store.put(blobKey(chunk.hash), bytes);
      known.add(chunk.hash);
      uploaded += 1;
    });
  } catch (error) {
    // STALE IS AN ANSWER, NOT A FAILURE: the sequential form returned null for
    // it and staging stops there. Every other throw is a real store failure
    // and travels.
    if (error instanceof StaleUpperBytes) return null;
    throw error;
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

  // THE INDEPENDENT TREE WRITES OF ONE FOLD GO OUT TOGETHER.
  //
  // This is the term that spent the deployed deadline: one tree object per
  // changed path, each one awaited, at about 513 ms a call (see
  // STORE_CALL_WIDTH). Only files and symlinks are independent — a `hardlink`
  // reads the manifest row its target's own write puts there, and `dir` and
  // `delete` sweep the manifest by prefix — so exactly those two kinds are
  // pooled here and every other kind keeps its place in the sequential pass
  // below, which runs after this one completes. Both passes finish before the
  // manifest, the cursor and the reap, so the crash ordering is untouched.
  const folded = coalesce(entries);
  const independent = folded.filter((entry) => entry.kind === 'file' || entry.kind === 'symlink');
  await throughStorePool(independent, async (entry) => {
    if (entry.kind === 'file') {
      await store.putStream(treeKey(entry.path), fileChunkStream(store, entry), entry.size, {
        mode: S_IFREG | (entry.mode & 0o7777),
        mtimeMs: entry.mtimeMs,
      });
    } else if (entry.kind === 'symlink') {
      await store.put(
        treeKey(entry.path),
        new TextEncoder().encode(entry.target),
        { mode: S_IFLNK | 0o777, symlink: true, mtimeMs: entry.mtimeMs },
      );
    }
  });
  // The manifest rows for what just landed, in the fold's own order, so the
  // map a `hardlink` reads and a `delete` sweeps is identical to what the
  // sequential pass produced.
  for (const entry of independent) {
    manifest.set(entry.path, entry);
    treeWrites += 1;
  }

  for (const entry of folded) {
    switch (entry.kind) {
      case 'file':
      case 'symlink': {
        // Written and recorded by the pooled pass above.
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
