/**
 * The durable changed-path journal and its cursors.
 *
 * Shape follows @cloudflare/dofs: an entry names a path and its content hashes
 * and never carries bytes; entries are coalesced to one per path with the
 * latest state winning; a monotonic sequence plays the role of `rev`.
 *
 * Two cursors, deliberately separate:
 *
 *   pushedSeq  the highest journal object that is durable. Rebuildable by
 *              listing `journal/`. Tick advances this.
 *   foldedSeq  entries already folded into `tree/`. Remote, in `cursor.json`,
 *              and authoritative, because restore replays exactly what follows
 *              it. Quiesce advances this, and only after the fold is durable.
 */

import {
  CursorSchema,
  JournalBatchSchema,
  KEY_CURSOR,
  PREFIX_JOURNAL,
  decodeJson,
  encodeJson,
  journalKey,
  seqFromJournalKey,
  type CasStore,
  type DeleteEntry,
  type JournalEntry,
  type NewJournalEntry,
} from './types';

export const DEFAULT_BATCH_SIZE = 64;

/**
 * One entry per path, latest state wins, ascending seq order. Five rewrites of
 * a path between syncs become one upload; a delete after a write erases the
 * write.
 */
export function coalesce(entries: readonly JournalEntry[]): JournalEntry[] {
  const latest = new Map<string, JournalEntry>();
  for (const entry of entries) latest.set(entry.path, entry);
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

/** Stamp a batch with a contiguous sequence starting at `nextSeq`. */
export function stampEntries(
  entries: readonly NewJournalEntry[],
  nextSeq: number,
): JournalEntry[] {
  let seq = nextSeq;
  return entries.map((entry): JournalEntry => ({ ...entry, seq: seq++ }));
}


/**
 * What the previous generation owned that the current scan no longer does.
 *
 * Only a path this generation owns can vanish into a deletion. A folded path
 * is served by the lower layer and its absence from the upper means nothing —
 * treating it as a tombstone is how an emptied upper once mass-deleted the
 * workspace.
 */
export function vanishedTombstones(
  previous: ReadonlyMap<string, { readonly folded?: boolean }>,
  currentPaths: ReadonlySet<string>,
  alreadyTombstoned: ReadonlySet<string>,
): readonly Omit<DeleteEntry, 'seq'>[] {
  const vanished: Omit<DeleteEntry, 'seq'>[] = [];
  for (const [path, signature] of previous) {
    if (currentPaths.has(path) || alreadyTombstoned.has(path)) continue;
    if (signature.folded === true) continue;
    vanished.push({ kind: 'delete', path });
  }
  vanished.sort((a, b) => (a.path < b.path ? -1 : 1));
  return vanished;
}

/**
 * The seq through which `tree/` has been folded.
 *
 * ABSENT means zero and that is a real state: a store nothing has folded yet.
 * PRESENT BUT MALFORMED is corruption and it refuses, naming the key. It used
 * to fall back to 0, which reads as "nothing folded" — so a single unreadable
 * cursor would silently re-fold the entire store from the beginning and, worse,
 * make every already-folded path look pending. Loud beats an unbounded redo
 * wearing the face of a fresh store.
 */
export async function readFoldedSeq(store: CasStore): Promise<number> {
  const bytes = await store.get(KEY_CURSOR);
  if (bytes === null) return 0;
  return decodeJson(CursorSchema, KEY_CURSOR, bytes).foldedSeq;
}

/**
 * Written only after every fold it describes is durable.
 *
 * This is `advanceCursor`. The name is the one the cost model cites: the
 * cursor is the folded seq, and it moves only after `tree/` holds what it
 * claims.
 */
export async function advanceCursor(store: CasStore, foldedSeq: number): Promise<void> {
  await store.put(KEY_CURSOR, encodeJson({ foldedSeq }));
}

/**
 * Every pending entry, oldest first.
 *
 * One object holds a whole BATCH, so a listing of `journal/` returns batch
 * objects and this flattens them. The cursor only ever advances past whole
 * batches, so an object newer than the cursor is pending in its entirety and
 * no batch is ever half-folded.
 */
export async function listJournalAfter(
  store: CasStore,
  after: number,
): Promise<JournalEntry[]> {
  const entries: JournalEntry[] = [];
  for (const row of await pendingBatches(store, after)) {
    const bytes = await store.get(row.key);
    // THE LISTING ALREADY NAMED IT. Under the reap-after-cursor rule an object
    // is deleted only once the cursor has passed it, so a batch newer than the
    // cursor that is absent is not a race — it is a hole where recorded changes
    // used to be. Skipping it would drop those changes with no word, which is
    // the silent-truncation class this layout exists to make impossible.
    if (bytes === null) {
      throw new Error(
        `${row.key} was listed but its bytes are absent, and it is newer than the folded `
        + `cursor (${after}), so it cannot have been reaped. The journal has a hole.`,
      );
    }
    entries.push(...decodeJson(JournalBatchSchema, row.key, bytes));
  }
  return entries;
}

/** The batch objects newer than `after`, oldest first. */
export async function pendingBatches(
  store: CasStore,
  after: number,
): Promise<readonly { key: string; seq: number }[]> {
  const keys = await store.list(PREFIX_JOURNAL);
  return keys
    .map(key => ({ key, seq: seqFromJournalKey(key) }))
    .filter((row): row is { key: string; seq: number } => row.seq !== null && row.seq > after)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Write one batch as ONE object, keyed by the batch's LAST sequence.
 *
 * One PUT per batch, not one per entry. A tick over an npm-shaped tree touches
 * thousands of paths, and a class-A operation per path would make the journal
 * cost proportional to the changed-path COUNT rather than to the bytes that
 * actually changed — which is the whole efficiency claim of this strategy.
 *
 * Keyed by the last seq so that lexicographic order over `journal/` is the
 * order the batches were written, and so a cursor holding that seq means
 * "every entry in this batch is folded".
 */
export async function appendJournalBatch(
  store: CasStore,
  entries: readonly JournalEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const last = entries[entries.length - 1]!.seq;
  await store.put(journalKey(last), encodeJson([...entries]));
}
