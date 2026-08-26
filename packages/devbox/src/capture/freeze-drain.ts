/**
 * Mechanism two: stop every writer, drain, flush, stage, seal, resume.
 *
 * Production ownership is the CONTAINER daemon, not a Durable Object. One
 * daemon request performs the full local phase and returns a CapturedCut; the
 * DO only records intent, epoch, head, pins and receipts around that result.
 * The functions below are an in-memory Wave-0 model that proves the daemon
 * phase's cut rule. They are not a sequence of DO exec calls.
 *
 * The soundness argument is a barrier, not an observation. While the freeze
 * holds, no writer can issue anything — the in-model equivalent of SIGSTOP or
 * a freezer cgroup, both of which a stopped process cannot escape by running.
 * The cut is therefore NAMED BY CONSTRUCTION: it is the last sequence number
 * applied before the drain completed. Everything before it is in the capture;
 * everything after it happens after thaw and cannot be in the capture, because
 * staging ran entirely inside the frozen window and the window is checked for
 * leakage afterwards.
 *
 * Two guards make the barrier honest rather than assumed:
 *
 *   `proveComplete` — the platform claim that writers are really stopped and
 *     cannot fork their way around the stop. A seam that cannot prove it gets
 *     a refusal, never a hopeful capture.
 *
 *   post-staging invariant — after staging, the last applied seq and the
 *     generation must be exactly what they were at the cut. Any drift means a
 *     mutation landed inside the supposedly frozen window, and the whole
 *     capture is refused instead of partially trusted.
 *
 * This is the mechanism that survives every counterexample the scan-based
 * approaches die to: open handles, same-size preserved-time rewrites, mmap
 * stores, rename races, hardlink rewrites, container replacement — all of them
 * are just writes, and here no write can run while the bytes are read.
 */

import type { CapturedCut } from '../durability/contracts';

import type { CaptureView } from './view';
import type { Capture, MutationLog, NodeEntry } from './model';

/** Flush primitives, strongest first. */
export type SyncMethod = 'syncfs' | 'per-file-fsync' | 'none';

/** The only capture surface a DO may consume: one supervised daemon operation,
 *  returning the shared contract after local staging is sealed. */
export interface ContainerCaptureDaemon {
  capture(): Promise<CapturedCut>;
}

const SYNC_PREFERENCE: readonly SyncMethod[] = ['syncfs', 'per-file-fsync', 'none'];

/**
 * The platform seam. Locally this wraps the model's writer gate; on a deployed
 * container it maps onto SIGSTOP / cgroup-freezer plus `sync -f` or syncfs,
 * and `proveComplete` reports what the capability probe measured — never what
 * the caller hopes.
 */
export interface FreezeSeam {
  freeze(): Promise<void>;
  /**
   * True iff, with the freeze held, every writer is provably stopped AND no
   * new writer can appear (no fork escape). Must be measured, not presumed.
   */
  proveComplete(): Promise<boolean>;
  /** Waits until operations already in flight have finished applying. */
  drainInflight(): Promise<void>;
  /**
   * Requests the named flush. A weaker requested primitive is honored even
   * when a stronger one is available; a stronger unavailable request degrades
   * to the strongest primitive actually available.
   */
  sync(requested: SyncMethod): Promise<SyncMethod>;
  thaw(): Promise<void>;
}

/** The seam over the model's own writer gate. `availableSync` caps the flush. */
export function logFreezeSeam(log: MutationLog, availableSync: SyncMethod): FreezeSeam {
  const rank = (method: SyncMethod): number => SYNC_PREFERENCE.indexOf(method);
  return {
    freeze: async () => { log.freezeWriters(); },
    proveComplete: async () => true,
    drainInflight: () => log.whenDrained(),
    sync: async (requested) => (rank(requested) >= rank(availableSync) ? requested : availableSync),
    thaw: async () => { log.thawWriters(); },
  };
}

export type FrozenCaptureResult =
  | {
      readonly verdict: 'captured';
      readonly capture: Capture;
      /** The flush that actually ran, reported rather than assumed. */
      readonly syncUsed: SyncMethod;
      readonly caveats: readonly string[];
    }
  | {
      readonly verdict: 'refused';
      readonly reason: 'freeze-not-provable' | 'mutation-during-frozen-window';
      readonly detail: string;
    };

export interface FrozenCaptureOptions {
  /** Requested flush ceiling; defaults to the strongest. */
  readonly requestedSync?: SyncMethod;
}

/**
 * The full protocol: freeze, prove, drain, flush, stage, verify the window,
 * seal, thaw. On any guard failure the freeze is released and NOTHING is
 * returned as a capture.
 */
export async function captureFrozenCopy(
  log: MutationLog,
  view: CaptureView,
  seam: FreezeSeam,
  options: FrozenCaptureOptions = {},
): Promise<FrozenCaptureResult> {
  await seam.freeze();
  try {
    if (!(await seam.proveComplete())) {
      return {
        verdict: 'refused',
        reason: 'freeze-not-provable',
        detail: 'the seam cannot prove writers are stopped and fork-proof',
      };
    }
    await seam.drainInflight();

    // THE CUT. Nothing applied after this point may appear in the capture,
    // because nothing can apply until thaw.
    const cut = log.lastSeq;
    const generationAtCut = log.generation;

    const syncUsed = await seam.sync(options.requestedSync ?? 'syncfs');

    // Stage: read every path once, inside the window. Sparseness travels with
    // the content representation, not as re-materialized zeros.
    const entries: NodeEntry[] = [];
    for (const path of view.paths()) {
      const entry = await view.readEntry(path);
      if (!entry) {
        return {
          verdict: 'refused',
          reason: 'mutation-during-frozen-window',
          detail: `${path} vanished while the freeze was held`,
        };
      }
      entries.push(entry);
    }

    // Window integrity: seq and generation must be exactly the cut's.
    if (log.lastSeq !== cut || log.generation !== generationAtCut) {
      return {
        verdict: 'refused',
        reason: 'mutation-during-frozen-window',
        detail: `state moved inside the frozen window (seq ${cut} -> ${log.lastSeq}, generation ${generationAtCut} -> ${log.generation})`,
      };
    }

    const capture: Capture = { mechanism: 'freeze-drain', cut, generation: generationAtCut, entries };
    const caveats = syncUsed === 'syncfs' ? [] : [
      `staged without syncfs: flushed with ${syncUsed}; the staged copy's durability rests on the weaker primitive`,
    ];
    return { verdict: 'captured', capture, syncUsed, caveats };
  } finally {
    await seam.thaw();
  }
}
