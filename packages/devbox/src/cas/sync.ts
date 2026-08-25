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

import { sha256Hex } from './hash';
import {
  DEFAULT_BATCH_SIZE,
  advanceCursor,
  coalesce,
  listJournalAfter,
  pendingBatches,
  readFoldedSeq,
} from './journal';
import {
  JournalBatchSchema,
  KEY_MANIFEST,
  PresentEntrySchema,
  blobKey,
  decodeJson,
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
        if (result.uploaded === 0 && entry.chunks.length > 0) dedupHits += 1;
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
  for (let index = 0; index < entry.chunks.length; index += 1) {
    const chunk = entry.chunks[index]!;
    if (known.has(chunk.hash) || (await store.head(blobKey(chunk.hash))) !== null) {
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
    entries.push(...decodeJson(JournalBatchSchema, row.key, bytes));
  }

  const manifest = await readManifest(store);
  let treeWrites = 0;
  let treeDeletes = 0;

  for (const entry of coalesce(entries)) {
    switch (entry.kind) {
      case 'file': {
        await store.put(treeKey(entry.path), await assembleFile(store, entry), {
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
      case 'dir': {
        if (entry.opaque) {
          for (const path of deepestFirst(manifest, `${entry.path}/`, false)) {
            await store.delete(treeKey(path));
            manifest.delete(path);
            treeDeletes += 1;
          }
        }
        manifest.set(entry.path, entry);
        break;
      }
      case 'delete': {
        let removedForEntry = 0;
        for (const path of deepestFirst(manifest, `${entry.path}/`, true)) {
          await store.delete(treeKey(path));
          manifest.delete(path);
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
  readonly replayed: readonly { entry: JournalEntry; bytes: Uint8Array | null }[];
}> {
  const foldedSeq = await readFoldedSeq(store);
  const pending = await listJournalAfter(store, foldedSeq);
  const replayed: { entry: JournalEntry; bytes: Uint8Array | null }[] = [];
  for (const entry of coalesce(pending)) {
    const bytes = entry.kind === 'file' ? await assembleFile(store, entry) : null;
    replayed.push({ entry, bytes });
  }
  return { foldedSeq, pending, replayed };
}

export async function assembleFile(store: CasStore, entry: FileEntry): Promise<Uint8Array> {
  const out = new Uint8Array(entry.size);
  let offset = 0;
  for (const chunk of entry.chunks) {
    const bytes = await store.get(blobKey(chunk.hash));
    if (bytes === null) throw new Error(`blob missing for ${entry.path}: ${chunk.hash}`);
    out.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (offset !== entry.size) throw new Error(`assembled ${offset} bytes, expected ${entry.size}`);
  if (sha256Hex(out) !== entry.hash) throw new Error(`assembled bytes fail digest for ${entry.path}`);
  return out;
}

function deepestFirst(
  manifest: ReadonlyMap<string, PresentEntry>,
  prefix: string,
  includeSelf: boolean,
): string[] {
  const self = prefix.slice(0, -1);
  return [...manifest.keys()]
    .filter(path => path.startsWith(prefix) || (includeSelf && path === self))
    .sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1));
}

async function readManifest(store: CasStore): Promise<Map<string, PresentEntry>> {
  const bytes = await store.get(KEY_MANIFEST);
  const manifest = new Map<string, PresentEntry>();
  if (bytes === null) return manifest;
  // One entry per line, each parsed on its own so a refusal names the line it
  // came from rather than the whole manifest.
  const lines = new TextDecoder().decode(bytes).split('\n');
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (line === '') continue;
    const entry = decodeJson(
      PresentEntrySchema, `${KEY_MANIFEST}:${at + 1}`, new TextEncoder().encode(line),
    );
    manifest.set(entry.path, entry);
  }
  return manifest;
}

async function writeManifest(store: CasStore, manifest: Map<string, PresentEntry>): Promise<void> {
  const lines = [...manifest.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(entry => JSON.stringify(entry));
  await store.put(KEY_MANIFEST, new TextEncoder().encode(`${lines.join('\n')}\n`));
}
