/**
 * The turn's file ledger — what the model has actually looked at, and what its
 * edits did.
 *
 * Two jobs, one object, because they are the same bookkeeping read twice:
 *
 *  1. **Read-before-write.** An `edit` or an overwriting `write` is refused
 *     unless this turn read the file, and refused again if the file changed
 *     after that read. Exact matching already stops an anchor landing in text
 *     the model never saw; this stops the other half — an anchor that is still
 *     there while everything around it moved. It is a mechanism, not doctrine,
 *     and our own measurement is that mechanism converts where doctrine does
 *     not (turn-steering.ts: 0% vs 24%). Its cost is one extra call the first
 *     time a turn touches a file it only saw through a shell command.
 *
 *     How much was read matters, not just that something was. A capped read of
 *     three lines authorizes an `edit` — the anchor still has to be exactly and
 *     uniquely present — but not a `write` that discards the 197 lines the
 *     model never saw. Coverage is tracked as the contiguous prefix a turn has
 *     paged through, which is exactly the shape the read's own
 *     "continue with offset=N" recipe produces, so paging to the end earns the
 *     overwrite and nothing is ever a dead end.
 *
 *  2. **The per-edit outcome.** Shell-based edits produce no gradable signal at
 *     all: `sed -i` exits 0 whether or not it matched. Every edit attempt is
 *     counted here by outcome, and the settle spine writes one `file_edit` run
 *     event per turn, so "how often does an edit miss, and does the model
 *     recover" is a query rather than a guess.
 *
 * Owned per turn by the TurnAccumulator, exactly like the context budget, and
 * per ROOT by construction — a fork builds its own toolset and therefore its own
 * ledger, which is correct: a fork reads its own files.
 */

import { fnv1a64 } from '../prompting/volatile-context.js';
import type { FileEditFailure } from './file-edit.js';

/** Why an edit attempt did not land. The text-surgery failures plus the two the
 *  ledger itself raises and the I/O ones the VFS raises. */
export type FileEditOutcomeReason =
  | FileEditFailure
  /** The file was never read this turn. */
  | 'unread'
  /** The file changed after the read this turn. */
  | 'stale'
  /** The path does not exist, or is not a file. */
  | 'missing'
  /** The filesystem refused the read or the write. */
  | 'io';

/** What one turn's edits did. Absent counters never happened.
 *  `attempts`/`applied` count CALLS; `recoveredPaths`/`abandonedPaths` count
 *  PATHS, because recovery is a property of a file, not of a call. */
export interface FileEditSnapshot {
  /** Edit calls attempted. */
  attempts: number;
  /** Edit calls that changed a file. */
  applied: number;
  /** Failed attempts by reason. */
  failures: Partial<Record<FileEditOutcomeReason, number>>;
  /** Paths that failed an edit and then landed one in the same turn. */
  recoveredPaths: number;
  /** Paths that failed an edit and never landed one. */
  abandonedPaths: number;
}

/** How much of a file the caller must have seen. `part` is enough to anchor an
 *  edit; `whole` is what discarding the file's current contents requires. */
export type FileSeenNeed = 'part' | 'whole';

export type FileSeenState =
  /** Seen, to the depth this operation requires. */
  | 'seen'
  /** Seen, but only part of it, and this operation needs the whole. */
  | 'partial'
  /** Seen at this path, but the content has moved on since. */
  | 'stale'
  /** Never read here. */
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

export class TurnFileLedger {
  /** Digest of every file content the model has been shown this turn, with how
   *  far into it the reads reached. Keyed on CONTENT, not on the path spelling,
   *  so reading `/src/a.ts` and then editing `src/a.ts` — the same file through
   *  the same mount table — is not a spurious refusal. */
  private readonly seen = new Map<string, SeenContent>();
  /** Paths observed at all, kept only to tell a file that moved on ("read it
   *  again") from one never read ("read it first"). */
  private readonly seenPaths = new Set<string>();
  private attempts = 0;
  private applied = 0;
  private readonly failures = new Map<FileEditOutcomeReason, number>();
  private readonly failedPaths = new Set<string>();
  private readonly recoveredPaths = new Set<string>();

  /** Clear for a new turn. */
  reset(): void {
    this.seen.clear();
    this.seenPaths.clear();
    this.attempts = 0;
    this.applied = 0;
    this.failures.clear();
    this.failedPaths.clear();
    this.recoveredPaths.clear();
  }

  /** The model has seen this content end to end — it read the whole file, or it
   *  wrote the file and therefore authored every line. */
  observeWhole(path: string, content: string): void {
    const total = lineCount(content);
    this.record(path, content, total, total);
  }

  /** The model has seen lines [first, last] of a `total`-line file. Coverage
   *  extends only when the range continues the prefix already read, which is
   *  what paging with the offset the read handed back does. */
  observeRange(path: string, content: string, first: number, last: number, total: number): void {
    const existing = this.seen.get(fnv1a64(content));
    const covered = existing?.coveredTo ?? 0;
    this.record(path, content, first <= covered + 1 ? Math.max(covered, last) : covered, total);
  }

  /** An edit landed: what the model knew about the old content it knows about
   *  the new one, because only the span it named itself changed. */
  observeEdited(path: string, before: string, after: string): void {
    const previous = this.seen.get(fnv1a64(before));
    const total = lineCount(after);
    const covered = previous && previous.coveredTo >= previous.total
      ? total
      : Math.min(previous?.coveredTo ?? 0, total);
    this.record(path, after, covered, total);
  }

  private record(path: string, content: string, coveredTo: number, total: number): void {
    this.seen.set(fnv1a64(content), { coveredTo, total });
    this.seenPaths.add(path);
  }

  /** Whether `content` is something the model has seen, to the depth `need`
   *  requires. Digest-keyed rather than a boolean, so a read that is still
   *  accurate stays valid for the rest of the turn however many steps later,
   *  and a file that moved underneath one is caught instead of edited blind. */
  seenState(path: string, content: string, need: FileSeenNeed): FileSeenVerdict {
    const entry = this.seen.get(fnv1a64(content));
    if (!entry) {
      return { state: this.seenPaths.has(path) ? 'stale' : 'never', coveredTo: 0, total: lineCount(content) };
    }
    const state: FileSeenState = need === 'whole' && entry.coveredTo < entry.total ? 'partial' : 'seen';
    return { state, coveredTo: entry.coveredTo, total: entry.total };
  }

  /** One edit attempt settled. */
  recordEdit(path: string, reason: FileEditOutcomeReason | null): void {
    this.attempts++;
    if (reason === null) {
      this.applied++;
      if (this.failedPaths.has(path)) this.recoveredPaths.add(path);
      return;
    }
    this.failures.set(reason, (this.failures.get(reason) ?? 0) + 1);
    this.failedPaths.add(path);
  }

  snapshot(): FileEditSnapshot {
    let abandoned = 0;
    for (const path of this.failedPaths) if (!this.recoveredPaths.has(path)) abandoned++;
    return {
      attempts: this.attempts,
      applied: this.applied,
      failures: Object.fromEntries(this.failures) as Partial<Record<FileEditOutcomeReason, number>>,
      recoveredPaths: this.recoveredPaths.size,
      abandonedPaths: abandoned,
    };
  }

  /** True when the turn attempted an edit at all — the settle spine skips the
   *  durable row otherwise, so `turn_end` stays the denominator. */
  get active(): boolean {
    return this.attempts > 0;
  }

  /**
   * How far the turn's file work has actually got: distinct paths it has
   * touched at all, and edits that changed something.
   *
   * Both are monotone within a turn, which is the whole point — the progress
   * trigger (orchestrator/turn-steering.ts) reads them once per step and an
   * INCREASE is literally "the turn moved". Exposed as a pair rather than
   * folded into `snapshot()` because that snapshot is the durable `file_edit`
   * row's shape and must not grow fields nothing writes.
   */
  get progress(): { filesTouched: number; editsApplied: number } {
    return { filesTouched: this.seenPaths.size, editsApplied: this.applied };
  }
}

/** Lines in a file, counting a trailing newline as ending the last line rather
 *  than starting a phantom one. */
function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}
