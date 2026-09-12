/** Background-job contract: the store's row shape and the detach policy the
 *  tools layer reads, declared at the platform layer so the job ledger and its
 *  consumers share one source. */

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
  /** How many times evict-recovery has re-driven this job (bounds resume loops). */
  resumeAttempts: number;
  /** Replacement job created by an operator retry; null until handled. */
  retriedBy: string | null;
  /**
   * When the attempt CURRENTLY driving this job began — `createdAt` for a first
   * drive, bumped by every {@link BackgroundJobStore.reclaim}.
   *
   * The only column that reads the CURRENT generation's lifetime: `createdAt` says
   * when the work was first asked for and `settledAt` is null while it runs, so
   * neither can answer "how long has this generation been going" and neither bounds
   * it. A live job was measured `running` 28 minutes into its third generation with
   * two completed candidates its caller could not see.
   */
  attemptStartedAt: number;
  /**
   * The instant before which this job's NEXT attempt must not start, or null
   * when nothing is owed.
   *
   * Written FORWARD, at claim time, for the attempt after the one being
   * claimed — because the event it paces is unobservable by the process it
   * kills. An isolate evicted mid-attempt writes nothing, so a pause recorded
   * after a failure would never be recorded at all; the claim is the last
   * moment anything can still speak for the attempt it is starting.
   *
   * So a live attempt carries one too, and that is not a contradiction: it says
   * "if I am still `running` after this instant, whoever finds me may drive me
   * again". A settle clears the question by ending the job, and the next
   * {@link BackgroundJobStore.reclaim} clears the column.
   */
  resumeAfter: number | null;
}

/** Which client surface owns the invocation, and therefore whether detaching
 * work is cheap or expensive. Every invocation has one fixed surface. */
export type InvocationSurface = 'interactive' | 'one-shot';

export interface BackgroundPolicy {
  /** How long a tool call may run before it is moved to the background. */
  readonly detachAfterMs: number;
  /** How long teardown waits on work that has not settled before leaving it. */
  readonly settleGraceMs: number;
  /**
   * Whether this session outlives the turn, and can therefore receive a wake.
   *
   * It decides what SPAWN-shaped work (a swarm node) does, and both answers follow
   * from it. Where a wake can arrive, a node detaches the moment its spawn is
   * confirmed started — its duration is long by construction, so waiting on a
   * threshold could only ever be dead air. Where no wake can arrive, the turn
   * is the ONLY consumer the result will ever have, so the node runs inline to
   * completion: detaching it there produces an answer with nobody left to read
   * it.
   */
  readonly wakesAfterTurn: boolean;
}

/**
 * The two policies, and why they differ.
 *
 * `interactive` — a human is watching the stream, so a tool call that outlives
 * their patience must hand back a handle fast; the wake turn arrives in the
 * same live session, and teardown can afford to wait a while for in-flight work
 * because the session was going to stay open anyway. A node detaches the
 * moment it is confirmed started rather than after the threshold: its duration
 * is not unknown — it is long by construction — so the threshold wait could
 * only ever be dead air in the chat.
 *
 * `one-shot` — nobody is waiting on a fast turn, and the process exits after the
 * answer. Here a detach is expensive, not cheap: it truncates the turn, forces a
 * second (synthesis) turn, and — measured over an 89-task benchmark run — pushes
 * the model into polling its own jobs instead of doing the work (151 of 202
 * sandbox scripts were `agent.jobResult` polls, and nodes were spawned as
 * pollers rather than workers). So ordinary long work — a build, a test suite,
 * an install — runs to completion inline, and only genuinely non-terminating
 * work (a server, a VM) ever crosses. Because anything that DID cross is very
 * unlikely to finish at all, teardown gives it a short grace and then leaves it
 * running rather than joining it: that unbounded join was 6.4 of 16.2 agent-hours
 * of pure idle tail in the same run.
 *
 * A fork here is the case that grace was never meant to cover. It terminates,
 * its result IS the point, and no wake can arrive to deliver one — so letting
 * it cross the threshold guaranteed the worst outcome available: the model got
 * a handle instead of an answer, the search kept running unread, and teardown
 * abandoned it 120s later. A `settle=mcts` fork under `kinu exec` did
 * exactly that — 4 of 40 iterations, `bg_jobs_abandoned`, and a model left to
 * narrate a convergence over rival approaches it never saw. `wakesAfterTurn`
 * is what stops it: no wake, no detach, the turn waits for its own answer.
 */
export const BACKGROUND_POLICY = {
  interactive: { detachAfterMs: 30_000, settleGraceMs: 300_000, wakesAfterTurn: true },
  'one-shot': { detachAfterMs: 300_000, settleGraceMs: 120_000, wakesAfterTurn: false },
} as const satisfies Record<InvocationSurface, BackgroundPolicy>;
