import { coalesce, listJournalAfter, readFoldedSeq } from './journal';
import { readManifest } from './sync';
import type { CasStore, JournalEntry, NewJournalEntry } from './types';

function sameEntry(next: NewJournalEntry, pending: JournalEntry | undefined): boolean {
  if (pending === undefined || next.kind !== pending.kind) return false;
  switch (next.kind) {
    case 'file':
      return pending.kind === 'file'
        && next.hash === pending.hash
        && next.mode === pending.mode
        && next.mtimeMs === pending.mtimeMs;
    case 'dir':
      return pending.kind === 'dir'
        && next.mode === pending.mode
        && next.mtimeMs === pending.mtimeMs
        && next.opaque === pending.opaque;
    case 'symlink':
      return pending.kind === 'symlink'
        && next.target === pending.target
        && next.mode === pending.mode
        && next.mtimeMs === pending.mtimeMs;
    case 'delete':
      return true;
  }
}

/** Parents before children, deletes last within a level. */
export function byApplyOrder(a: NewJournalEntry, b: NewJournalEntry): number {
  const depth = a.path.split('/').length - b.path.split('/').length;
  if (depth !== 0) return depth;
  const rank = kindRank(a) - kindRank(b);
  if (rank !== 0) return rank;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function kindRank(entry: NewJournalEntry): number {
  switch (entry.kind) {
    case 'dir': return 0;
    case 'file': return 1;
    case 'symlink': return 2;
    default: return 3;
  }
}

/** Per-path authority from the folded manifest plus pending journal. Cached for
 * one DO activation, rebuilt after eviction or failure, and advanced after a
 * successful stage. */
export class PendingJournalState {
  private entries: Map<string, JournalEntry> | null = null;
  private nextSeq: number | null = null;
  private pendingPaths: Set<string> | null = null;

  async load(store: CasStore): Promise<void> {
    if (this.entries !== null && this.nextSeq !== null && this.pendingPaths !== null) return;
    const foldedSeq = await readFoldedSeq(store);
    const manifest = await readManifest(store);
    const pending = await listJournalAfter(store, foldedSeq);
    const latestPending = coalesce(pending);
    this.entries = new Map(manifest);
    for (const entry of latestPending) this.entries.set(entry.path, entry);
    this.pendingPaths = new Set(latestPending.map(entry => entry.path));
    this.nextSeq = pending.reduce(
      (next, entry) => Math.max(next, entry.seq + 1),
      foldedSeq + 1,
    );
  }

  sequence(): number {
    if (this.nextSeq === null) throw new Error('pending journal state was not loaded');
    return this.nextSeq;
  }

  filterChanged(entries: readonly NewJournalEntry[]): readonly NewJournalEntry[] {
    if (this.entries === null) throw new Error('pending journal state was not loaded');
    return entries.filter(entry => !sameEntry(entry, this.entries?.get(entry.path)));
  }

  vanished(currentPaths: ReadonlySet<string>, tombstoned: Set<string>): readonly NewJournalEntry[] {
    if (this.entries === null) throw new Error('pending journal state was not loaded');
    const vanished: NewJournalEntry[] = [];
    for (const path of this.pendingPaths ?? []) {
      const entry = this.entries.get(path);
      if (entry !== undefined
        && entry.kind !== 'delete'
        && !currentPaths.has(path)
        && !tombstoned.has(path)) {
        vanished.push({ kind: 'delete', path });
        tombstoned.add(path);
      }
    }
    return vanished;
  }

  record(entries: readonly JournalEntry[]): void {
    if (this.entries === null || this.nextSeq === null) {
      throw new Error('pending journal state was not loaded');
    }
    for (const entry of entries) {
      this.entries.set(entry.path, entry);
      this.pendingPaths?.add(entry.path);
    }
    this.nextSeq = entries.reduce(
      (next, entry) => Math.max(next, entry.seq + 1),
      this.nextSeq,
    );
  }

  blobHashes(): Set<string> {
    if (this.entries === null) throw new Error('pending journal state was not loaded');
    const hashes = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.kind !== 'file') continue;
      for (const chunk of entry.chunks) hashes.add(chunk.hash);
    }
    return hashes;
  }

  folded(): void {
    this.invalidate();
  }

  invalidate(): void {
    this.entries = null;
    this.nextSeq = null;
    this.pendingPaths = null;
  }
}
