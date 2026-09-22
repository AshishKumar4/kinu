// Backend-agnostic per-turn agent logic: turn accounting, evolution cadence, and the event→turn reactor.
//
// Evolution exit contract. Every dispatch is detached; `end()` decides what to wait for.
//   Turn lane (outcome review): `settleEvolution()` joins it with no elapsed bound (owner ruling, 2026-08).
//     A `oneShot` host defers it as a durable row drained by `runDeferredTurnReviews` at the next session open.
//   Cadence lane (session/lifetime chain, incl. scaffold shadow trials): never joined; only started by a host
//     that can afford to finish it. Safe because the session window closes only after its pass settles
//     (`CompletedTurnStore.claim`).
// The in-episode clock (`craft`, `recordRecovery`) writes synchronous rows and needs no join.

import type { ModelMessage } from 'ai';
import { TurnAccumulator, type TurnSinks } from './turn-accumulator';
import type { RunEndReason } from './turn-lifecycle';
import { TurnSteering } from './turn-steering';
import { CraftCycle } from './craft-cycle';
import { DrainScheduler } from './drain-scheduler';
import { Inbox, readSignalId, type UserSteerDeps } from './inbox';
import { buildDrainBatch } from '../events/hub/drain';
import type { EventLog } from '../events/hub/log';
import type { ExecutionRecoveryRecord } from '../events/types';
import type { PrepareStepContext, KinuExtension } from '../extension';
import type { BackendHost } from '../types/backend-host';
import type { AgentSignal } from '../types/signals';
import type { EvolutionEngine } from '../evolution/engine';
import type { ClaimedWindow, DeferredReviewDrain } from '../evolution/session-window';
import type { RecoveryFinding } from '../evolution/recovery';
import type { CompletedTurn } from '../evolution/types';
import {
  MISSION_LABELS_METADATA_KEY, readMissionLabels, type MissionGovernor,
} from '../mission-budget';
import { nanoid } from '../utils/nanoid';
import { workModeForTurnMetadata } from '../prompting/surface';
import { type WorkMode } from '../types/turn';
import type { JsonObject } from '../utils/json';
import { diagnostics, toKinuError } from '../obs/index';

/**
 * Whether an arriving user message is a genuine follow-up or an independent task invocation.
 * An independent task prompt must never grade the previous turn as accepted.
 */
export type TurnContinuity = 'conversation' | 'independent_task';

/** Turns between session-level evolution passes; deliberately not a host option. */
const DEFAULT_SESSION_REFLECTION_INTERVAL = 5;

export interface AgentOrchestratorDeps {
  host: BackendHost;
  engine: Pick<
    EvolutionEngine,
    | 'enabled'
    | 'recordsTurns'
    | 'recoverInterruptedWork'
    | 'sessionWindow'
    | 'craftLedger'
    | 'recordRecovery'
    | 'reviewTurn'
    | 'runStoredTurnReview'
    | 'deferTurnReview'
    | 'runDeferredTurnReviews'
    | 'onSessionComplete'
    | 'runDueShadowTrials'
    | 'recentAdvisorNotes'
    | 'recordAdvisorNote'
    | 'hasAdvisorNoteForTurn'
  >;
  eventLog: EventLog;
  sinks?: TurnSinks;
  /** Absent: no governor wired. Present-but-unscoped is the normal uncapped turn. */
  budget?: MissionGovernor;
  /** This process runs one task turn and exits, so it never starts the cadence lane (see exit contract).
   *  Independent of {@link TurnContinuity}. */
  oneShot?: boolean;
  /**
   * The continual-refinement lane, driven off-turn beside the shadow-trial drain so it never lengthens a turn.
   * Absent: requests stay durable for the next host that wires one.
   */
  refinementLane?: () => Promise<void>;
}

export class AgentOrchestrator {
  readonly acc: TurnAccumulator;
  readonly inbox: Inbox;
  /** Per-turn mechanical steering; feeds the durable `turn_steering` rows. */
  readonly steering = new TurnSteering();
  readonly craft: CraftCycle;
  /** Registered on each turn's ExtensionHost by both backends. The steer is decided against the step being
   *  prepared and handed straight to it, so it dies with that step. */
  readonly turnExtension: KinuExtension = {
    name: 'kinu.inbox',
    onToolCall: (ctx) => this.steering.onToolCall(ctx),
    onToolResult: (ctx) => {
      const recovery = this.steering.onToolResult(ctx);
      this.craft.onToolResult(ctx);

      if (recovery && this.observeRecoveries) this.recordRecovery(recovery);
    },
    prepareStep: (ctx: PrepareStepContext): Promise<ModelMessage[] | undefined> => {
      // The file ledger shows what a codemode program changed, which no tool-call signature can.
      const steer = this.steering.steerFor(ctx, this.acc.files.progress);

      return this.inbox.prepareStep(ctx, steer ? [steer] : []);
    },
  };
  /** Recorded through the engine at observation time, since an episode can outlive this instance;
   *  collected here only for the turn's `execution_recovery` run event. */
  private turnRecoveries: RecoveryFinding[] = [];
  /** Decided once per turn: a `--no-auto-evolve` run records no recovery findings. */
  private observeRecoveries = false;
  private turnEvolutionEnabled = false;
  private activeWorkMode: WorkMode = 'build';
  private activeMissions: readonly string[] = [];
  private readonly reflectionInterval = DEFAULT_SESSION_REFLECTION_INTERVAL;
  private readonly drains: DrainScheduler;
  /** Turn lane: dispatched, unsettled turn-level evolution, joined by settleEvolution. */
  private readonly inFlight = new Map<Promise<void>, string>();
  /** Cadence lane latch: at most one pass, since `claim()` retires nothing until the pass settles. */
  private sessionEvolution: Promise<void> | null = null;
  /** Cadence lane observer, not a latch: a no-op pass must not hide a window that fills meanwhile.
   *  Deliberately not joined by `settleEvolution`. */
  private cadencePasses: Promise<void> = Promise.resolve();
  /** Cadence lane: trial-drain latch, separate from the window pass so trials never run twice
   *  and a no-op drain never hides a filled window. */
  private shadowTrials: Promise<void> | null = null;

  constructor(private readonly deps: AgentOrchestratorDeps, steers?: UserSteerDeps) {
    this.acc = new TurnAccumulator(deps.sinks, deps.budget);
    this.craft = new CraftCycle(deps.engine.craftLedger, this.acc);
    this.turnEvolutionEnabled = deps.engine.enabled;
    this.inbox = new Inbox(deps.host, (e, d) => this.logActivity(e, d), steers);
    this.drains = new DrainScheduler(
      () => this.drainPendingEvents(),
      (fn, ms) => deps.host.setTimer(fn, ms),
    );
  }

  /** Durable: neither backend's instance outlives the window. */
  private get window() {
    return this.deps.engine.sessionWindow;
  }

  /** Turns buffered in the open window; zero while auto-evolution is off. */
  get sessionTurnIndex(): number {
    return this.window.size();
  }

  /** Reset per-turn accounting from the turn's metadata. `continuation` re-admits the previous turn's signals. */
  beginTurn(now: number, metadata?: JsonObject, continuation = false): void {
    this.deps.engine.recoverInterruptedWork();
    this.acc.reset(now);
    this.steering.reset();
    // Decided once per turn: with evolution off, crafted-tool scoring is off too.
    const workMode = workModeForTurnMetadata(metadata);
    this.activeWorkMode = workMode;
    this.activeMissions = readMissionLabels(metadata);
    const evolutionEnabled = this.deps.engine.enabled && workMode !== 'plan';
    this.turnEvolutionEnabled = evolutionEnabled;
    this.craft.reset(evolutionEnabled);
    this.turnRecoveries = [];
    this.observeRecoveries = evolutionEnabled;
    this.inbox.beginTurn(continuation, readSignalId(metadata));
    this.deps.budget?.activate(this.activeMissions);
  }

  /** Restrict a Build turn to plan after accounting opens: closes improvement lanes without resetting accounting. */
  restrictTurnWorkMode(mode: WorkMode): void {
    if (mode !== 'plan' || this.activeWorkMode === 'plan') return;
    this.activeWorkMode = 'plan';
    this.turnEvolutionEnabled = false;
    this.craft.reset(false);
    this.observeRecoveries = false;
  }

  private recordRecovery(finding: RecoveryFinding): void {
    this.turnRecoveries.push(finding);
    this.deps.engine.recordRecovery(finding);
  }

  /** Null when no streak broke, so no row is written. */
  recoverySnapshot(): ExecutionRecoveryRecord | null {
    if (this.turnRecoveries.length === 0) return null;

    return {
      recoveries: this.turnRecoveries.map(({ tool, failures, failedSignature }) =>
        ({ tool, failures, failedSignature })),
    };
  }

  /**
   * A new user message arrived: dispatch the previous turn's detached outcome review. Programmatic turns must
   * not call this. Only a `'conversation'` message counts as follow-up evidence; otherwise no follow-up is passed.
   */
  observeUserTurn(userText: string, continuity: TurnContinuity): void {
    if (!this.turnEvolutionEnabled) return;
    const previous = this.window.claimPendingReview();

    if (!previous) return;
    const followup = continuity === 'conversation' ? userText : null;
    this.dispatchReview(previous.turn, followup, previous.rowId);
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
    if (!(opts?.enabled ?? (this.turnEvolutionEnabled && this.deps.engine.recordsTurns))) return;
    const scoped = this.scopeTurn(turn);
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
    // A one-shot host must not open work it cannot finish.
    if (!this.deps.oneShot) {
      if (!awaitsFollowup) {
        this.detach(this.deps.engine.runDeferredTurnReviews().then(() => undefined), 'Turn review');
      }

      const cadence = this.runDueSessionEvolution();
      const previousCadence = this.cadencePasses;
      this.cadencePasses = (async (): Promise<void> => {
        try {
          await Promise.all([previousCadence, cadence]);
        } catch (cause) {
          diagnostics.failure(
            'orchestrator.detached_work_failed',
            toKinuError({ doing: 'run detached post-turn work', cause, otherwise: 'unavailable' }),
            { work: 'Session evolution' },
          );
        }
      })();
    }
  }

  /**
   * Stamp the turn's mission scope now, the last moment it is knowable (the next `beginTurn` replaces it).
   * An unscoped turn is returned untouched: absent means ungoverned.
   */
  private scopeTurn(turn: CompletedTurn): CompletedTurn {
    // A replay already carries the scope captured at turn end; a cold-start governor must not overwrite it.
    if (turn.missionLabels !== undefined) return turn;
    const labels = this.deps.budget?.scope ?? [];

    return labels.length === 0 ? turn : { ...turn, missionLabels: [...labels] };
  }

  scopedTurn(turn: CompletedTurn): CompletedTurn {
    return this.scopeTurn(turn);
  }

  /** Turn-lane decision point: a `oneShot` host defers the review as a durable row; others detach and join at exit. */
  private dispatchReview(turn: CompletedTurn, followup: string | null, storedRowId?: string): void {
    if (this.deps.oneShot) {
      this.deps.engine.deferTurnReview(turn, followup, { storedRowId });

      return;
    }

    this.detach(this.deps.engine.runStoredTurnReview(storedRowId ?? '', turn, followup), 'Turn review');
  }

  /**
   * Re-drive reviews one-shot hosts deferred, at session open on hosts that can afford it. One-shot hosts do not
   * re-drive (see MAX_QUEUED_TURN_REVIEWS). Never rejects.
   */
  async runDeferredTurnReviews(): Promise<DeferredReviewDrain> {
    if (this.deps.oneShot) return { reviewed: 0, refused: [] };

    return await this.deps.engine.runDeferredTurnReviews();
  }

  /**
   * Cadence lane: shadow trials, then the session/lifetime chain once the window reaches the interval.
   * The window is closed only after the chain settles. Never rejects. The window is claimed before any await:
   * `claim()` marks nothing, so a single tick is what keeps a second pass off it.
   */
  runDueSessionEvolution(): Promise<void> {
    this.deps.engine.recoverInterruptedWork();

    if (this.sessionEvolution) return this.sessionEvolution;

    const claimed = this.deps.engine.recordsTurns && this.window.size() >= this.reflectionInterval
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
   * Trials first: the engine refuses to propose a scaffold while one is pending. The refinement lane runs last,
   * whether or not a window was claimed; its trigger is durable debt.
   */
  private async runCadencePass(claimed: ClaimedWindow | null): Promise<void> {
    await this.drainDueShadowTrials();

    if (claimed) {
      try {
        await this.deps.engine.onSessionComplete({
          sessionId: `sess-${nanoid()}`,
          turns: claimed.turns,
          startedAt: claimed.startedAt,
          endedAt: Date.now(),
        });
      } catch (err) {
        diagnostics.failure(
          'evolution.session_pass_failed',
          toKinuError({ doing: 'run the session evolution pass', cause: err, otherwise: 'unavailable' }),
        );
      }

      // Settled either way: retrying a persistently failing window would livelock. Carry-forward is for a dead host.
      claimed.settle();
    }

    await this.drainRefinementLane();
  }

  /** At most one step; failures are absorbed since the request rows are durable. */
  private async drainRefinementLane(): Promise<void> {
    const lane = this.deps.refinementLane;

    if (!lane) return;

    try {
      await lane();
    } catch (err) {
      diagnostics.failure(
        'evolution.refinement_lane_failed',
        toKinuError({ doing: 'advance the continual-refinement lane', cause: err, otherwise: 'unavailable' }),
      );
    }
  }

  private drainDueShadowTrials(): Promise<void> {
    if (this.shadowTrials) return this.shadowTrials;

    const drain = this.deps.engine.runDueShadowTrials()
      .finally(() => { this.shadowTrials = null; });

    this.shadowTrials = drain;

    return drain;
  }

  /**
   * Join the turn lane with no elapsed bound; unjoined work is killed at process exit.
   * The cadence lane is deliberately not joined (see module header).
   */
  async settleEvolution(): Promise<void> {
    const started = Date.now();
    // Named on the success path too: a slow exit tail is otherwise silent.
    const waitedOn = [...new Set(this.inFlight.values())];

    while (this.inFlight.size > 0) {
      // Work dispatched during the await is joined by the next lap.
      await Promise.all(this.inFlight.keys());
    }

    const waitedMs = Date.now() - started;

    if (waitedMs > 1_000) {
      diagnostics.event('evolution.settled', { waitedMs, waitedOn: waitedOn.join(', ') });
    }
  }

  /** Join backend-owned post-turn evolution (the sampled scaffold shadow eval) to the turn lane. */
  track(work: Promise<void>, label: string): void {
    this.detach(work, label);
  }

  private detach(work: Promise<void>, label: string): void {
    let tracked: Promise<void> | null = null;
    tracked = (async (): Promise<void> => {
      try {
        await work;
      } catch (cause) {
        diagnostics.failure(
          'orchestrator.detached_work_failed',
          toKinuError({ doing: 'run detached post-turn work', cause, otherwise: 'unavailable' }),
          { work: label },
        );
      } finally {
        if (tracked !== null) this.inFlight.delete(tracked);
      }
    })();
    this.inFlight.set(tracked, label);
  }

  logActivity(event: string, detail?: string): void {
    this.deps.sinks?.logActivity?.(event, detail);
  }

  /** Ingress trigger: debounced so a burst drains into one turn. The post-turn drain stays immediate. */
  scheduleDrain(): void {
    this.drains.schedule();
    // The debounce dies with the process; a pending reaction also needs the durable wake.
    this.reconcileDurableWake();
  }

  /** Absent on a host whose next wake is its own next start (see BackendHost.reconcileDurableWake). */
  private reconcileDurableWake(): void {
    try {
      this.deps.host.reconcileDurableWake?.();
    } catch (err) {
      diagnostics.failure(
        'event.durable_wake_arm_failed',
        toKinuError({ doing: 'arming the durable wake a pending reaction needs', cause: err, otherwise: 'io' }),
      );
    }
  }

  /**
   * Compensation: put a refused signal's events back, then re-arm, or pending rows are unreachable.
   * Uses the durable wake, not `scheduleDrain`: the debounce would spin against the same pre-emption.
   */
  private returnEventsToPending(ids: readonly string[]): void {
    for (const id of ids) {
      try {
        this.deps.eventLog.unbind(id);
      } catch (err) {
        diagnostics.failure(
          'event.unbind_failed',
          toKinuError({ doing: 'return a bound event to pending', cause: err, otherwise: 'io' }),
          { eventId: id },
        );
      }
    }

    this.reconcileDurableWake();
  }

  /**
   * The reactor: bind pending events to a synthetic turn (markConsumed is synchronous, so a concurrent drain
   * sees them consumed), then send the batch as one signal bound to `replyTurnId`. An undelivered signal
   * puts its events back. No-op when nothing is pending.
   */
  async drainPendingEvents(
    /** Rethrow selection/binding failures: a durable effect that owes this drain must not report done. */
    opts?: { readonly rethrow?: boolean },
  ): Promise<void> {
    let batch: ReturnType<typeof buildDrainBatch>;
    const turnId = `evt-${nanoid()}`;
    const bound: string[] = [];

    try {
      const pending = this.deps.eventLog.pending({ resolve_deferred: { now: Date.now(), phase: 'idle' } });
      batch = buildDrainBatch(pending);

      if (!batch) return;

      for (const id of batch.ids) {
        this.deps.eventLog.markConsumed(id, turnId, 0);
        bound.push(id);
      }
    } catch (err) {
      // Unbind the prefix so the retry sees the whole batch; otherwise it strands with no signal or wake.
      for (const id of bound) {
        try {
          this.deps.eventLog.unbind(id);
        } catch (undo) {
          diagnostics.failure(
            'orchestrator.drain_unbind_failed',
            toKinuError({ doing: 'release an event bound by a drain that failed', cause: undo, otherwise: 'io' }),
            { turnId, event: id },
          );
        }
      }

      const failure = toKinuError({
        doing: 'select the pending events for a drain turn', cause: err, otherwise: 'io',
      });

      diagnostics.failure('orchestrator.drain_select_failed', failure, { turnId });

      if (opts?.rethrow) throw failure;

      return;
    }

    const ids = batch.ids;
    let metadata: JsonObject | undefined;

    if (batch.mode !== null || batch.missions.length > 0) {
      metadata = {};

      if (batch.mode !== null) metadata.kinuMode = batch.mode;

      if (batch.missions.length > 0) metadata[MISSION_LABELS_METADATA_KEY] = batch.missions;
    }

    const signal: AgentSignal = {
      kind: 'event_drain',
      text: batch.text,
      stepText: batch.midTurnText,
      replyTurnId: turnId,
      // The rows are already bound to `turnId`, so it routes the queued half through the host's durable
      // admission ledger; a re-delivery of the same drain collapses to one turn.
      idempotencyKey: turnId,
      compensate: () => this.returnEventsToPending(ids),
      metadata,
    };

    await this.inbox.send(signal);
  }

  // The settle spine is `declareTerminalRoster` (orchestrator/terminal-roster.ts). The pure rules below are
  // public so a backend claiming the sub-effects separately asks them without re-spelling them.

  /** Completed-only improvement lanes (shadow trial, advisor review, auto-title) open only after a completed build turn. */
  improvementLanesOpen(status: RunEndReason, workMode?: WorkMode): boolean {
    // `workMode` is for a replay on a fresh activation; absent means the live turn.
    return status === 'completed' && (workMode ?? this.activeWorkMode) !== 'plan';
  }

  /**
   * The turn to record for this verdict: `'error'` forces `hadError` (a throw can escape the accumulator);
   * an abort is deliberately not an error.
   */
  recordedTurn(status: RunEndReason, turn: CompletedTurn): CompletedTurn {
    return status === 'error' && !turn.hadError ? { ...turn, hadError: true } : turn;
  }
}
