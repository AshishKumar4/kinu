import type { WorkMode } from './turn';

export type BackgroundJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

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
  /** Monotonic lease epoch — bumped by `reclaim` on evict-recovery (§5.3). */
  epoch: number;
  /** Bounds evict-recovery resume loops. */
  resumeAttempts: number;
  /** Replacement job created by an operator retry; null until handled. */
  retriedBy: string | null;
  /** Start of the current attempt's generation; `createdAt` for a first drive, bumped by reclaim. */
  attemptStartedAt: number;
  /**
   * Earliest start of the next attempt, written forward at claim time because an evicted isolate
   * writes nothing; cleared by the next {@link BackgroundJobStore.reclaim}.
   */
  resumeAfter: number | null;
}

export type InvocationSurface = 'interactive' | 'one-shot';

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
