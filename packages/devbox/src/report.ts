/** What a caller can read about a box without touching its container. */

import type { IncidentTotals } from './incidents';
import type { IncidentStage, PortExposureSpec, QuiesceAction, SupervisedProcessSpec } from './lifecycle';
import type { Restoration } from './restoration';
import type { ChainState } from './snapshot-chain';
import type { AttachOutcome, DevboxStrategyName } from './storage';

/** `delivered` separates a failure the host already saw from one it never did. */
export interface IncidentReasonRow {
  readonly stage: IncidentStage;
  readonly reason: string;
  readonly at: number;
  readonly attempts: number;
  readonly delivered: boolean;
}

/** Durable so a stalled lease can still answer when it last ticked and what it decided
 *  after the object is evicted. */
export interface HeartbeatTick {
  readonly at: number;
  readonly running: boolean;
  /** The control-plane ping outcome, or why it was not attempted. */
  readonly ping: string;
  /** Did this tick leave a successor armed? `false` is only correct when the box
   *  is stopping. */
  readonly armedNext: boolean;
  readonly decision?: QuiesceAction;
  readonly replaced?: boolean;
}

/** `restartable` means a durable spec exists: only such a process comes back after a recycle. */
export interface SupervisedProcessRow {
  readonly processId: string;
  readonly pid: number | undefined;
  readonly status: string;
  readonly command: string;
  readonly restartable: boolean;
}

/** Everything a caller can ask about a box without touching the container. */
export interface DevboxReport {
  readonly strategy: DevboxStrategyName;
  readonly durable: boolean;
  readonly running: boolean;
  /** `repair` still admits operations: only the agent can fix a failed service, so `exec` stays open.
   *  `unattached` is terminal until an explicit repair; poll this, not a stale attach record. */
  readonly restoration: Restoration['phase'];
  /** Every supervised process back, every exposed port's listener answering and re-exposed.
   *  Equals `restoration === 'attached'`; a half-restored box is `repair`, never ready. */
  readonly ready: boolean;
  /** One sentence on why the box is not ready, undefined when ready; the incident ledger
   *  holds the detail. */
  readonly unready: string | undefined;
  readonly lastInteractionAt: number | undefined;
  readonly quietSince: number | undefined;
  readonly chain: ChainState | null;
  /** Durable: an eviction between the start and the question would erase the only evidence. */
  readonly lastAttach: AttachOutcome | undefined;
  /** A `lastTick.at` far in the past means the box stopped ticking; the row says what
   *  the last tick saw. */
  readonly lastTick: HeartbeatTick | undefined;
  readonly bootId: string | undefined;
  /** Platform replacements of this box's container: a fact about the platform, not a failure. */
  readonly replacedCount: number;
  readonly supervised: readonly SupervisedProcessSpec[];
  readonly ports: readonly PortExposureSpec[];
  readonly incidents: Readonly<IncidentTotals>;
  /** Startup flight: allocation and control-listener proof; hook flight: restore. Null if none.
   *  `unstarted` with a long-open startup flight is waiting on the platform, not a caller. */
  readonly flights: {
    readonly startupMs: number | null;
    readonly hookMs: number | null;
  };
  /** The persistence path's whole share of this object's wire since it activated (D29). */
  readonly wire: { readonly sent: number; readonly received: number };
}
