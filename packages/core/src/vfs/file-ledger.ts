/**
 * Per-turn file ledger: read-before-write gating and per-edit outcome counts.
 * A `write` that overwrites needs the whole file read (contiguous prefix coverage); an `edit` needs only part.
 */

import { fnv1a64 } from '../utils/fnv1a';
import { lineCount } from '../utils/text';
import type { VfsRevision } from '../types/primitives';
import type { FileEditOutcomeReason, FileEditSnapshot } from '../types/file-edits';
import { countSharedWrite, newWriteAuthor } from '../obs/msg-counters';

export type { FileEditOutcomeReason, FileEditSnapshot } from '../types/file-edits';

/** `part` suffices to anchor an edit; `whole` is required to discard the file's contents. */
export type FileSeenNeed = 'part' | 'whole';

export type FileSeenState =
  | 'seen'
  /** Seen, but only part of it, and this operation needs the whole. */
  | 'partial'
  /** Seen at this path, but the content has moved on since. */
  | 'stale'
  | 'never';

export interface FileSeenVerdict {
  state: FileSeenState;
  /** Lines of this content the turn has paged through, from line 1. */
  coveredTo: number;
  total: number;
}

interface SeenContent {
  coveredTo: number;
  total: number;
}

/** `fingerprint` must be `fnv1a64` of the file's whole text. */
export interface RangeObservation {
  readonly fingerprint: string;
  readonly first: number;
  readonly last: number;
  readonly total: number;
  readonly revision?: VfsRevision;
}

interface RangeCoverage {
  readonly fingerprint: string;
  readonly coveredTo: number;
  readonly total: number;
  readonly revision?: VfsRevision;
}

export class TurnFileLedger {
  /** Keyed on content digest, not path spelling, so two spellings of one file match. */
  private readonly seen = new Map<string, SeenContent>();
  /** Tells a file that moved on from one never read. */
  private readonly seenPaths = new Map<string, VfsRevision | undefined>();
  private attempts = 0;
  private applied = 0;
  private readonly failures = new Map<FileEditOutcomeReason, number>();
  private readonly failedPaths = new Set<string>();
  private readonly recoveredPaths = new Set<string>();
  /** Not cleared by `reset()`: a per-turn identity would count an agent's own re-edits as collisions. */
  private readonly author = newWriteAuthor();

  reset(): void {
    this.seen.clear();
    this.seenPaths.clear();
    this.attempts = 0;
    this.applied = 0;
    this.failures.clear();
    this.failedPaths.clear();
    this.recoveredPaths.clear();
  }

  observeWhole(path: string, content: string, revision?: VfsRevision): void {
    const total = lineCount(content);

    this.record(path, { fingerprint: fnv1a64(content), coveredTo: total, total, revision });
  }

  /**
   * Coverage extends only when [first, last] continues the prefix already read.
   * `fingerprint` must be `fnv1a64` of the whole file text, never of the window or size/mtime.
   */
  observeRange(path: string, scan: RangeObservation): void {
    const existing = this.seen.get(scan.fingerprint);
    const covered = existing?.coveredTo ?? 0;
    const coveredTo = scan.first <= covered + 1 ? Math.max(covered, scan.last) : covered;

    this.record(path, { fingerprint: scan.fingerprint, coveredTo, total: scan.total, revision: scan.revision });
  }

  observeEdited(path: string, before: string, after: string, revision?: VfsRevision): void {
    const previous = this.seen.get(fnv1a64(before));
    const total = lineCount(after);

    const covered = previous && previous.coveredTo >= previous.total
      ? total
      : Math.min(previous?.coveredTo ?? 0, total);

    this.record(path, { fingerprint: fnv1a64(after), coveredTo: covered, total, revision });
  }

  private record(path: string, entry: RangeCoverage): void {
    this.seen.set(entry.fingerprint, { coveredTo: entry.coveredTo, total: entry.total });
    this.seenPaths.set(path, entry.revision);
  }

  readRevision(path: string): VfsRevision | undefined {
    return this.seenPaths.get(path);
  }

  seenState(path: string, content: string, need: FileSeenNeed): FileSeenVerdict {
    const entry = this.seen.get(fnv1a64(content));

    if (!entry) {
      return { state: this.seenPaths.has(path) ? 'stale' : 'never', coveredTo: 0, total: lineCount(content) };
    }

    const state: FileSeenState = need === 'whole' && entry.coveredTo < entry.total ? 'partial' : 'seen';

    return { state, coveredTo: entry.coveredTo, total: entry.total };
  }

  /** Applied edits are also reported to the shared-write counter under this ledger's author ordinal. */
  recordEdit(path: string, reason: FileEditOutcomeReason | null): void {
    this.attempts++;

    if (reason === null) {
      this.applied++;
      countSharedWrite(this.author, path);

      if (this.failedPaths.has(path)) this.recoveredPaths.add(path);

      return;
    }

    this.failures.set(reason, (this.failures.get(reason) ?? 0) + 1);
    this.failedPaths.add(path);
  }

  snapshot(): FileEditSnapshot {
    let abandoned = 0;

    for (const path of this.failedPaths) if (!this.recoveredPaths.has(path)) abandoned++;
    const failures: Partial<Record<FileEditOutcomeReason, number>> = {};

    for (const [reason, count] of this.failures) failures[reason] = count;

    return {
      attempts: this.attempts,
      applied: this.applied,
      failures,
      recoveredPaths: this.recoveredPaths.size,
      abandonedPaths: abandoned,
    };
  }

  /** The settle spine skips the durable row otherwise, so `turn_end` stays the denominator. */
  get active(): boolean {
    return this.attempts > 0;
  }

  /**
   * Distinct paths touched and applied edits; both monotone within a turn (read by turn-steering's progress trigger).
   * Kept out of `snapshot()`, whose shape is the durable `file_edit` row.
   */
  get progress() {
    return { filesTouched: this.seenPaths.size, editsApplied: this.applied };
  }
}
