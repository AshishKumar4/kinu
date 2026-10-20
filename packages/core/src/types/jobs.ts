import * as v from 'valibot';
import type { WorkMode } from './turn';

/** `serving` is reported, never stored (`listBackgroundJobs`). */
export type BackgroundJobStatus = 'running' | 'serving' | 'completed' | 'failed' | 'cancelled';

export const JOB_STAMP_ENV = 'KINU_JOB_ID';

export interface BackgroundJob {
  id: string;
  kind: string;
  label: string | null;
  workMode: WorkMode;
  status: BackgroundJobStatus;
  result: string | null;
  error: string | null;
  createdAt: number;
  settledAt: number | null;
  /** Monotonic lease epoch, bumped by `reclaim` on each evict-recovery (§5.3): also how many times the job was
   *  interrupted and re-driven, which bounds its resume loop. */
  epoch: number;
  /** Replacement job created by an operator retry; null until handled. */
  retriedBy: string | null;
  /** Start of the current attempt's generation; `createdAt` for a first drive, bumped by reclaim. */
  attemptStartedAt: number;
  /**
   * Earliest start of the next attempt, written forward at claim time because an evicted isolate
   * writes nothing; cleared by the next {@link BackgroundJobStore.reclaim}.
   */
  resumeAfter: number | null;
  serves: number | null;
}

/** Where a call is made, which decides its {@link BACKGROUND_POLICY}: a chat turn a person watches, or a turn an event, a
 *  timer or a job opened. */
export const InvocationSurfaceSchema = v.picklist(['interactive', 'one-shot']);

export type InvocationSurface = v.InferOutput<typeof InvocationSurfaceSchema>;

/** The turn-metadata key under which a wake that resumes parked calls carries the surface they were made on: the turn
 *  it opens re-issues them, under the background policy of the turn they were parked from. */
export const RESUMED_SURFACE = 'kinuSurface';

/**
 * The wake metadata that resumes calls parked on `surfaces` (an owner's answer to a device consent or to a parked
 * action alike), so the turn it opens runs them under the surface they were made on. Calls parked from both are
 * re-issued as interactive ones, since a call detached at its window still ends, as a job that wakes its agent, while
 * one held past its own holds a turn a person watches. None when no call recorded one (a denial, or a call made in no
 * turn).
 */
export function resumedSurfaceMetadata(surfaces: readonly (InvocationSurface | undefined)[]) {
  const recorded = new Set(surfaces.flatMap((surface) => surface ?? []));
  const resumed: readonly InvocationSurface[] = recorded.size === 0 ? [] : [recorded.has('interactive') ? 'interactive' : 'one-shot'];

  return Object.fromEntries(resumed.map((surface) => [RESUMED_SURFACE, surface]));
}

export interface BackgroundPolicy {
  readonly detachAfterMs: number;
  /** How long teardown waits on work that has not settled before leaving it. */
  readonly settleGraceMs: number;
  /** Where no wake can arrive, spawn-shaped work runs inline: the turn is its only reader. */
  readonly wakesAfterTurn: boolean;
}

/**
 * One-shot runs long work inline and abandons detached work after a short grace; interactive
 * hands back a handle fast because the wake arrives in the same live session.
 */
export const BACKGROUND_POLICY = {
  interactive: { detachAfterMs: 30_000, settleGraceMs: 300_000, wakesAfterTurn: true },
  'one-shot': { detachAfterMs: 300_000, settleGraceMs: 120_000, wakesAfterTurn: false },
} as const satisfies Record<InvocationSurface, BackgroundPolicy>;
