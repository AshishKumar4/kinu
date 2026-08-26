/**
 * Mechanism three: replay an ordered mutation journal up to a named seq.
 *
 * When every mutation is intercepted and recorded BEFORE it takes effect, a
 * capture is simply the replay of the journal's prefix at the cut — sound by
 * construction, online (no writer pause), and exactly reproducible. The catch
 * is coverage: mmap stores bypass syscall interposers, direct block access
 * bypasses mounts, and a watcher-based transport drops events on overflow. The
 * mechanism is therefore conditional on platform capabilities (see
 * `capabilities.ts`), and its two honest failure modes are built in here:
 *
 *   watch-overflow — the transport admitted dropping events. A journal that
 *     lost events cannot claim any prefix; refuse, never approximate.
 *
 *   journal-gap — sequence numbers are contiguous by construction, so a hole
 *     in the delivered range means undelivered mutations exist inside the cut.
 *     Refuse with the position named.
 */

import { prefixState } from './model';
import type { Capture, LogEntry } from './model';

export interface JournalBatch {
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly entries: readonly LogEntry[];
}

export interface JournalSource {
  /** Delivered batches, in delivery order. */
  batches(): readonly JournalBatch[];
  /** True iff the transport dropped events and said so (inotify Q_OVERFLOW shape). */
  overflowed(): boolean;
}

export type JournalCaptureResult =
  | { readonly verdict: 'captured'; readonly capture: Capture }
  | { readonly verdict: 'refused'; readonly reason: 'watch-overflow' | 'journal-gap'; readonly detail: string };

/**
 * Replay the journal prefix at `cut` into a capture. The cut is exact by
 * definition: prefix(cut) IS the captured state, so post-cut mutations — even
 * ones applied concurrently while this function runs — are excluded because
 * they are not in the delivered range.
 */
export function materializeJournalPrefix(
  source: JournalSource,
  cut: number,
  generation: number,
): JournalCaptureResult {
  if (source.overflowed()) {
    return {
      verdict: 'refused',
      reason: 'watch-overflow',
      detail: 'the journal transport dropped events; no prefix can be claimed',
    };
  }

  const entries: LogEntry[] = [];
  let expected = 0;
  for (const batch of source.batches()) {
    if (batch.firstSeq > cut) break;
    const first = batch.entries[0];
    const last = batch.entries[batch.entries.length - 1];
    if (!first || !last || first.seq !== batch.firstSeq || last.seq !== batch.lastSeq) {
      return {
        verdict: 'refused',
        reason: 'journal-gap',
        detail: `batch ${batch.firstSeq}..${batch.lastSeq} does not carry its declared contiguous boundaries`,
      };
    }
    if (batch.firstSeq !== expected) {
      return {
        verdict: 'refused',
        reason: 'journal-gap',
        detail: `expected seq ${expected}, batch starts at ${batch.firstSeq}`,
      };
    }
    for (const entry of batch.entries) {
      if (entry.seq > cut) break;
      if (entry.seq !== expected) {
        return {
          verdict: 'refused',
          reason: 'journal-gap',
          detail: `expected seq ${expected}, batch delivered ${entry.seq}`,
        };
      }
      entries.push(entry);
      expected += 1;
    }
  }
  if (expected <= cut) {
    return {
      verdict: 'refused',
      reason: 'journal-gap',
      detail: `journal ends at ${expected - 1}, short of the requested cut ${cut}`,
    };
  }

  const state = prefixState(entries, cut);
  return {
    verdict: 'captured',
    capture: { mechanism: 'mutation-journal', cut, generation, entries: [...state.values()] },
  };
}

/**
 * A bounded event queue with inotify semantics: pushes past the limit DROP and
 * raise the overflow flag rather than blocking. This is the shape whose silent
 * handling poisons watcher-built journals, which is why materialize refuses on
 * the flag instead of trusting the survivors.
 */
export class WatchEventQueue {
  private items: LogEntry[] = [];
  private droppedOverflow = false;

  constructor(private readonly limit: number) {}

  get overflowed(): boolean { return this.droppedOverflow; }

  push(entry: LogEntry): void {
    if (this.items.length >= this.limit) {
      this.droppedOverflow = true;
      return;
    }
    this.items.push(entry);
  }

  toSource(): JournalSource {
    const snapshot = [...this.items];
    const overflowed = this.droppedOverflow;
    return {
      batches: () => snapshot.length === 0 ? [] : [{
        firstSeq: snapshot[0]!.seq,
        lastSeq: snapshot[snapshot.length - 1]!.seq,
        entries: snapshot,
      }],
      overflowed: () => overflowed,
    };
  }
}
