/**
 * Mechanism three: replay an ordered mutation journal up to a named seq.
 *
 * The capture linearizes at the FENCE record, which the daemon appends only
 * after the sealed stage and its delta manifest are on the disk.
 * Before that record is acknowledged, the daemon has closed mutation
 * admission, drained every admitted mutation, syncfs'd the captured root, and
 * sealed its generation-local stage. Writers admitted after the fence are
 * logically after its cut even if they run before the client receives the
 * control-socket reply.
 *
 * Replay proves only the logical part of that argument. The platform facts
 * below are explicit assumptions measured by the probe and daemon runtime
 * matrix; a caller that cannot establish every one gets a refusal. In
 * particular, a watcher is not an interceptor: overflow or a hole in the
 * delivered order makes the prefix unclaimable.
 */

import { prefixState } from './model';
import type { Capture, LogEntry } from './model';

/**
 * Every platform fact the journal proof needs. These are deliberately finer
 * than the mechanism-selection capability: this list names the assumptions
 * behind a successful journal fence rather than treating CaptureSound itself
 * as an assumption.
 */
export const JOURNAL_CAPTURE_PLATFORM_ASSUMPTIONS = [
  'mounted-root-intercepts-concurrent-writes',
  'mounted-open-fds-remain-intercepted',
  'mmap-writes-are-intercepted',
  'rename-and-unlink-are-intercepted',
  'intent-write-precedes-effect',
  'result-write-precedes-reply',
  'fence-closes-admission-and-drains',
  'root-syncfs-precedes-stage',
  'sealed-stage-and-manifest-are-durable',
  'private-state-and-mount-are-excluded',
  'path-resolution-stays-beneath-root',
] as const;

export type JournalCapturePlatformAssumption = (typeof JOURNAL_CAPTURE_PLATFORM_ASSUMPTIONS)[number];
export type JournalCapturePlatformEvidence = Readonly<Record<JournalCapturePlatformAssumption, boolean>>;

/**
 * The one linearization point for a journal capture: a durable FENCE record.
 * `cut` is sampled after admission closes and active mutations drain; the
 * FENCE record is persisted only after the sealed stage and manifest exist.
 */
export interface LinearizationPoint {
  readonly kind: 'durable-fence-record';
  readonly cut: number;
  readonly generation: number;
  readonly evidence: JournalCapturePlatformEvidence;
}

/** `OneCommittedGeneration`: one sealed generation owns every staged entry. */
export interface OneCommittedGeneration {
  readonly generation: number;
  readonly cut: number;
}

/** `Torn` holds only when a capture matches no committed journal prefix. */
export interface Torn {
  readonly matchesNoCommittedPrefix: boolean;
}

/** `CutExcluded`: no journal sequence strictly after `cut` is staged. */
export interface CutExcluded {
  readonly cut: number;
  readonly excludesSequencesAfterCut: boolean;
}

/**
 * The executable counterpart of the Lean properties. It is attached only to
 * captures made from a contiguous, non-overflowing journal under a complete
 * platform evidence set.
 */
export interface JournalCaptureSoundness {
  readonly linearizationPoint: LinearizationPoint;
  readonly oneCommittedGeneration: OneCommittedGeneration;
  readonly torn: Torn;
  readonly cutExcluded: CutExcluded;
}

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
  | {
      readonly verdict: 'captured';
      readonly capture: Capture;
      readonly soundness: JournalCaptureSoundness;
    }
  | {
      readonly verdict: 'refused';
      readonly reason: 'watch-overflow' | 'journal-gap' | 'unproven-platform-assumption' | 'invalid-linearization-point';
      readonly detail: string;
    };


function firstUnprovenPlatformAssumption(
  evidence: JournalCapturePlatformEvidence,
): JournalCapturePlatformAssumption | null {
  for (const assumption of JOURNAL_CAPTURE_PLATFORM_ASSUMPTIONS) {
    if (!evidence[assumption]) return assumption;
  }
  return null;
}

function copiedLinearizationPoint(point: LinearizationPoint): LinearizationPoint {
  return Object.freeze({
    kind: point.kind,
    cut: point.cut,
    generation: point.generation,
    evidence: Object.freeze({ ...point.evidence }),
  });
}

/**
 * Replay a complete journal prefix into a capture. `point` is accepted only
 * after every named platform premise is measured true; continuity then makes
 * the replayed prefix the non-torn state of exactly one committed generation.
 */
export function materializeJournalPrefix(
  source: JournalSource,
  point: LinearizationPoint,
): JournalCaptureResult {
  if (!Number.isSafeInteger(point.cut) || point.cut < -1 ||
      !Number.isSafeInteger(point.generation) || point.generation < 0) {
    return {
      verdict: 'refused',
      reason: 'invalid-linearization-point',
      detail: `invalid durable fence point cut=${point.cut} generation=${point.generation}`,
    };
  }

  const unproven = firstUnprovenPlatformAssumption(point.evidence);
  if (unproven) {
    return {
      verdict: 'refused',
      reason: 'unproven-platform-assumption',
      detail: `journal capture requires measured platform assumption '${unproven}'`,
    };
  }

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
    if (batch.firstSeq > point.cut) break;
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
      if (entry.seq > point.cut) break;
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
  if (expected <= point.cut) {
    return {
      verdict: 'refused',
      reason: 'journal-gap',
      detail: `journal ends at ${expected - 1}, short of the requested cut ${point.cut}`,
    };
  }

  const state = prefixState(entries, point.cut);
  const linearizationPoint = copiedLinearizationPoint(point);
  return {
    verdict: 'captured',
    capture: {
      mechanism: 'mutation-journal',
      cut: point.cut,
      generation: point.generation,
      entries: [...state.values()],
    },
    soundness: {
      linearizationPoint,
      oneCommittedGeneration: { generation: point.generation, cut: point.cut },
      torn: { matchesNoCommittedPrefix: false },
      cutExcluded: { cut: point.cut, excludesSequencesAfterCut: true },
    },
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
