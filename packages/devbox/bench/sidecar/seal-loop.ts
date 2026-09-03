/**
 * When a seal happens, and what happens when they pile up.
 *
 * THE CADENCE, and the reason for it. A seal costs milliseconds of CPU and
 * closes admission only for the O(k) stage copy, so it could run far more
 * often than this. What bounds the cadence is the PUBLISH: every publish is at
 * least two R2 PUTs, one Durable Object transaction and one object GC must
 * later delete. Two seconds after the first unsealed write, or eight MiB of
 * unsealed bytes, is half a publish per second at worst — about 43,000
 * generations per active day, which compaction and the envelope window absorb.
 *
 * WHY COALESCING IS PART OF THE POLICY. Under sustained writes the upload is
 * the slow half, and a loop that queued one publish per trigger would fall
 * behind by a growing backlog of generations that each cost two PUTs. So while
 * a publish is in flight, later triggers fold into ONE follow-up seal: the
 * next fence takes everything written since the last one, and a chunk written
 * and overwritten inside that window never leaves the box. A barrier or a
 * quiesce still forces its own seal, because a caller waiting on one is
 * waiting for ITS bytes to be durable.
 */

import type { SealKind, SealOutcome } from './core';

export const SEAL_INTERVAL_MS = 2_000;
export const SEAL_DIRTY_BYTES = 8 * 1024 * 1024;

/** What the loop drives: one seal at a time, and the unsealed lag it reports. */
export interface SealTarget {
  seal(kind: SealKind): Promise<SealOutcome>;
  readonly unsealedBytes: number;
  readonly unsealedSince: number | null;
}

const PRIORITY = { tick: 0, barrier: 1, quiesce: 2 } satisfies Record<SealKind, number>;
interface ThrownFailure {
  readonly cause: unknown;
}

/** What a seal that threw leaves behind: one line, never a swallowed value. */
function thrownReason({ cause }: ThrownFailure) {
  return { kind: 'failed', reason: cause instanceof Error ? cause.message : String(cause) } as const;
}

export class SealLoop {
  #running: Promise<SealOutcome> | null = null;
  #queued: SealKind | null = null;
  #coalesced = 0;

  constructor(
    private readonly target: SealTarget,
    private readonly now: () => number,
  ) {}

  /** How many triggers folded into a seal that was already running. */
  get coalesced(): number {
    return this.#coalesced;
  }

  /** Whether the cadence says a seal is owed: two seconds, or eight MiB. */
  due(): boolean {
    if (this.target.unsealedBytes >= SEAL_DIRTY_BYTES) return true;
    const since = this.target.unsealedSince;
    return since !== null && this.now() - since >= SEAL_INTERVAL_MS;
  }

  /** Seal if the cadence says so, and answer what it did, or null when idle. */
  async pump(): Promise<SealOutcome | null> {
    if (!this.due()) return null;
    return await this.#run('tick');
  }

  /** A barrier or a quiesce: seal now, whatever the cadence would have said. */
  async force(kind: SealKind): Promise<SealOutcome> {
    return await this.#run(kind);
  }

  async #run(kind: SealKind): Promise<SealOutcome> {
    const running = this.#running;
    if (running !== null) {
      // A seal is in flight. Fold into ONE follow-up rather than queueing a
      // publish per trigger, and let whoever claims the follow-up run it.
      this.#coalesced += 1;
      this.#queued = this.#queued === null || PRIORITY[kind] > PRIORITY[this.#queued] ? kind : this.#queued;
      let settled: SealOutcome;
      try {
        settled = await running;
      } catch (cause) {
        settled = thrownReason({ cause });
      }
      const claimed = this.#queued;
      if (claimed === null) return settled;
      this.#queued = null;
      return await this.#run(claimed);
    }
    const started = this.target.seal(kind);
    this.#running = started;
    try {
      return await started;
    } finally {
      if (this.#running === started) this.#running = null;
    }
  }
}
