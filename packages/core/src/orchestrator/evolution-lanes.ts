// An agent's evolution lanes, apart from any turn it runs: the window its turns are recorded into, the reviews they are
// owed and the cadence pass. A turn's session composes them (`AgentOrchestrator`); a host whose agent's turns run
// elsewhere builds them alone (the cloud workspace, for main).
//
// Evolution exit contract. Every dispatch is detached; `end()` decides what to wait for.
//   Turn lane (outcome review): `settleTracked()` joins it, and all work a backend `track()`s, with no elapsed bound
//     (owner ruling, 2026-08).
//     A `oneShot` host defers it as a durable row drained by `runDeferredTurnReviews` at the next session open.
//   Cadence lane (session/lifetime chain and the dream): one pass per settled turn, after the turn
//     lane (`settleEvolution`), never joined; only started by a host that can afford to finish it. Safe because the
//     session window closes only after its pass settles (`CompletedTurnStore.claim`).

import type { EvolutionEngine } from '../evolution/engine';
import type { ClaimedWindow, DeferredReviewDrain } from '../evolution/session-window';
import type { CompletedTurn } from '../evolution/types';
import type { MissionGovernor } from '../mission-budget';
import { nanoid } from '../utils/nanoid';
import type { RunEndReason } from './turn-lifecycle';
import type { WorkMode } from '../types/turn';
import { diagnostics, settleLogged } from '../obs/index';

/**
 * Whether an arriving user message is a genuine follow-up or an independent task invocation.
 * An independent task prompt must never grade the previous turn as accepted.
 */
export type TurnContinuity = 'conversation' | 'independent_task';

/** Turns between session-level evolution passes; deliberately not a host option. */
const DEFAULT_SESSION_REFLECTION_INTERVAL = 5;

export interface EvolutionLanesDeps {
  engine: Pick<
    EvolutionEngine,
    | 'enabled'
    | 'evolves'
    | 'recordsTurns'
    | 'recoverInterruptedWork'
    | 'sessionWindow'
    | 'runStoredTurnReview'
    | 'deferTurnReview'
    | 'runDeferredTurnReviews'
    | 'onSessionComplete'
  >;
  /** Absent: no governor wired. Present-but-unscoped is the normal uncapped turn. */
  budget?: MissionGovernor;
  /** This process runs one task turn and exits, so it never starts the cadence lane (see exit contract).
   *  Independent of {@link TurnContinuity}. */
  oneShot?: boolean;
  /**
   * The continual-refinement lane, driven off-turn beside the evolution pass so it never lengthens a turn.
   * Absent: requests stay durable for the next host that wires one.
   */
  refinementLane?: () => Promise<void>;
}

/** A turn's improvement lanes (evolution, the advisor) open on a completed turn outside Plan: read from the recorded
 *  status and mode, so a replay on a fresh activation decides as the live turn did. */
export function improvementLanesOpen(status: RunEndReason, workMode: WorkMode): boolean {
  return status === 'completed' && workMode !== 'plan';
}

/** The evolution pass also follows a failed turn its agent recorded for evolution (`recorded`): the turn's review rates it. */
export function evolutionPassOpen(status: RunEndReason, workMode: WorkMode, recorded: boolean): boolean {
  return improvementLanesOpen(status, workMode) || (workMode !== 'plan' && recorded);
}

/**
 * The turn to record for this verdict: `'error'` forces `hadError` (a throw can escape the accumulator);
 * an abort is deliberately not an error.
 */
export function recordedTurn(status: RunEndReason, turn: CompletedTurn): CompletedTurn {
  return status === 'error' && !turn.hadError ? { ...turn, hadError: true } : turn;
}

export class EvolutionLanes {
  private readonly reflectionInterval = DEFAULT_SESSION_REFLECTION_INTERVAL;
  /** Tracked and unsettled: the turn lane's evolution and what a backend tracks (a scaffold bootstrap, a history
   *  restore, a context measure), joined by settleTracked. */
  private readonly inFlight = new Map<Promise<void>, string>();
  /** Cadence lane latch: at most one pass, since `claim()` retires nothing until the pass settles. */
  private sessionEvolution: Promise<void> | null = null;
  /** The pass `startEvolution` last started. Deliberately not joined by `settleTracked`. */
  private evolution: Promise<void> = Promise.resolve();

  constructor(private readonly lanes: EvolutionLanesDeps) {}

  /** Durable: neither backend's instance outlives the window. */
  private get window() {
    return this.lanes.engine.sessionWindow;
  }

  /** Turns buffered in the open window; zero while auto-evolution is off. */
  get sessionTurnIndex(): number {
    return this.window.size();
  }

  /** The gate a turn's own session decided; none decided outside one. */
  protected turnGate(): boolean {
    return false;
  }

  /**
   * A new user message arrived: dispatch the previous turn's detached outcome review. Programmatic turns must
   * not call this. Only a `'conversation'` message counts as follow-up evidence; otherwise no follow-up is passed.
   * An idempotent open transition keyed by the turn, recorded whether or not it grades: a preparation of `turnId`
   * replayed, after a reset or after a later turn, grades nothing more, not even the turn itself once it is recorded.
   * `enabled` is the opening's evolution gate; absent, the running turn's.
   */
  observeUserTurn(turnId: string, userText: string, continuity: TurnContinuity, enabled = this.turnGate()): void {
    const followup = continuity === 'conversation' ? userText : null;
    const previous = this.window.openTurn(turnId, enabled ? { followup } : null);

    if (previous !== null) this.dispatchReview(previous.turn, followup, previous.rowId);
  }

  /**
   * Buffer the turn in the durable window, run due session evolution, and queue a review for any turn with no
   * conversational follow-up coming. Detached; does not drain events. Records nothing with auto-evolution off.
   * `opts.id` makes the append idempotent for a backend that may replay this recording.
   */
  recordTurn(
    turn: CompletedTurn,
    continuity: TurnContinuity,
    opts?: {
      readonly id?: string;
      readonly recordedAt?: number;
      /** The producing session's evolution gate, replacing the ambient one when replaying a recorded turn. */
      readonly enabled?: boolean;
    },
  ): void {
    // The recorded gate wins: a recovery is not the session the turn ran under.
    if (!(opts?.enabled ?? (this.turnGate() && this.lanes.engine.recordsTurns))) return;
    const scoped = this.scopedTurn(turn);
    const awaitsFollowup = turn.origin !== 'programmatic' && continuity === 'conversation';

    // An independent task proves the parked follow-up will never come; its review demotes to the queue.
    if (continuity === 'independent_task') {
      // Bounded by when this turn ended, so a late replay cannot demote a newer parked review.
      this.window.expireAwaitingReviews(
        opts?.recordedAt === undefined ? undefined : { before: opts.recordedAt },
      );
    }

    // The append carries the review obligation; never dispatch inline here, or an eviction loses it and a
    // replay runs it twice.
    const appendOpts = { awaitsFollowup, id: opts?.id };
    this.window.append(
      scoped,
      opts?.recordedAt === undefined ? appendOpts : { ...appendOpts, now: opts.recordedAt },
    );

    // Promptness on top of durability; the queue's claim keeps it exactly-once.
    // A one-shot host must not open work it cannot finish. The cadence pass waits for this review: `settleEvolution`.
    if (!this.lanes.oneShot && !awaitsFollowup) {
      this.detach(this.lanes.engine.runDeferredTurnReviews().then(() => undefined), 'Turn review');
    }
  }

  /**
   * Stamp the turn's mission scope now, the last moment it is knowable (the next turn's activation replaces it).
   * An unscoped turn is returned untouched: absent means ungoverned.
   */
  scopedTurn(turn: CompletedTurn): CompletedTurn {
    // A replay already carries the scope captured at turn end; a cold-start governor must not overwrite it.
    if (turn.missionLabels !== undefined) return turn;
    const labels = this.lanes.budget?.scope ?? [];

    return labels.length === 0 ? turn : { ...turn, missionLabels: [...labels] };
  }

  /** Turn-lane decision point: a `oneShot` host defers the review as a durable row; others detach and join at exit. */
  private dispatchReview(turn: CompletedTurn, followup: string | null, storedRowId?: string): void {
    if (this.lanes.oneShot) {
      this.lanes.engine.deferTurnReview(turn, followup, { storedRowId });

      return;
    }

    this.detach(this.lanes.engine.runStoredTurnReview(storedRowId ?? '', turn, followup), 'Turn review');
  }

  /**
   * Re-drive reviews one-shot hosts deferred, at session open on hosts that can afford it. One-shot hosts do not
   * re-drive (see MAX_QUEUED_TURN_REVIEWS). Never rejects.
   */
  async runDeferredTurnReviews(): Promise<DeferredReviewDrain> {
    if (this.lanes.oneShot) return { reviewed: 0, refused: [] };

    return await this.lanes.engine.runDeferredTurnReviews();
  }

  /**
   * A settled turn's one cadence pass, after the turn lane: the pass reads the ratings and struggles the turn's review
   * writes. Both hosts run it from the turn's improvement lanes, for an agent whose turns evolve. A one-shot host runs
   * none; its window carries to the daemon. Never rejects.
   */
  async settleEvolution(): Promise<void> {
    if (this.lanes.oneShot || !this.lanes.engine.evolves) return;
    await this.settleTracked();
    await this.runDueSessionEvolution();
  }

  /** {@link settleEvolution} for a host that does not wait for it; a later turn's pass runs after this one. */
  startEvolution(): void {
    const previous = this.evolution;

    this.evolution = settleLogged('orchestrator.detached_work_failed', { doing: 'run detached post-turn work', otherwise: 'unavailable' },
      async () => { await previous; await this.settleEvolution(); }, { work: 'Session evolution' });
  }

  /**
   * Cadence lane: the session/lifetime chain once the window reaches the interval, then the dream's lane.
   * The window is closed only after the chain settles. Never rejects. The window is claimed before any await:
   * `claim()` marks nothing, so a single tick is what keeps a second pass off it.
   */
  runDueSessionEvolution(): Promise<void> {
    this.lanes.engine.recoverInterruptedWork();

    if (this.sessionEvolution) return this.sessionEvolution;

    const claimed = this.lanes.engine.recordsTurns && this.window.size() >= this.reflectionInterval
      ? this.window.claim()
      : null;

    let pass = this.runCadencePass(claimed);

    // Only a pass that claimed a window latches, or it would hide a window that filled while it ran.
    if (claimed) {
      pass = pass.finally(() => { this.sessionEvolution = null; });
      this.sessionEvolution = pass;
    }

    return pass;
  }

  /**
   * The dream's lane runs last, whether or not a window was claimed, since its trigger is durable debt; never while
   * learning is off.
   */
  private async runCadencePass(claimed: ClaimedWindow | null): Promise<void> {
    if (claimed) {
      await settleLogged('evolution.session_pass_failed', { doing: 'run the session evolution pass', otherwise: 'unavailable' }, () => this.lanes.engine.onSessionComplete({
          sessionId: `sess-${nanoid()}`,
          turns: claimed.turns,
          startedAt: claimed.startedAt,
          endedAt: Date.now(),
        }));

      // Settled either way: retrying a persistently failing window would livelock. Carry-forward is for a dead host.
      claimed.settle();
    }

    if (this.lanes.engine.recordsTurns) await this.drainRefinementLane();
  }

  /** At most one step; failures are absorbed since the request rows are durable. */
  private async drainRefinementLane(): Promise<void> {
    const lane = this.lanes.refinementLane;

    if (!lane) return;

    await settleLogged('evolution.refinement_lane_failed', { doing: 'advance the continual-refinement lane', otherwise: 'unavailable' }, () => lane());
  }

  /**
   * Join all tracked work with no elapsed bound; unjoined work is killed at process exit.
   * The cadence lane is deliberately not joined (see module header).
   */
  async settleTracked(): Promise<void> {
    const started = Date.now();
    // Named on the success path too: a slow exit tail is otherwise silent.
    const waitedOn = [...new Set(this.inFlight.values())];

    while (this.inFlight.size > 0) {
      // Work dispatched during the await is joined by the next lap.
      await Promise.all(this.inFlight.keys());
    }

    const waitedMs = Date.now() - started;

    if (waitedMs > 1_000) {
      diagnostics.event('orchestrator.tracked_settled', { waitedMs, waitedOn: waitedOn.join(', ') });
    }
  }

  /** Joined by settleTracked, as the turn lane is. */
  track(work: Promise<void>, label: string): void {
    this.detach(work, label);
  }

  private detach(work: Promise<void>, label: string): void {
    const tracked: Promise<void> = settleLogged('orchestrator.detached_work_failed', { doing: 'run detached post-turn work', otherwise: 'unavailable' },
      () => work, { work: label }).finally(() => { this.inFlight.delete(tracked); });

    this.inFlight.set(tracked, label);
  }
}
