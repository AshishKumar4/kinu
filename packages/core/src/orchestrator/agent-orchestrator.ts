// Backend-agnostic per-turn agent logic: turn accounting and the event→turn reactor, over the agent's evolution lanes
// (`EvolutionLanes`, whose exit contract covers everything this dispatches).
// The in-episode clock (`recordRecovery`) writes synchronous rows and needs no join.

import type { ModelMessage } from 'ai';
import { TurnAccumulator, type TurnSinks } from './turn-accumulator';
import { TurnSteering } from './turn-steering';
import { DrainScheduler } from './drain-scheduler';
import { Inbox, type UserSteerDeps } from './inbox';
import { EvolutionLanes, type EvolutionLanesDeps } from './evolution-lanes';
import type { EventLog } from '../events/hub/log';
import type { ExecutionRecoveryRecord } from '../events/types';
import type { PrepareStepContext, KinuExtension } from '../extension';
import type { BackendHost } from '../types/backend-host';
import type { AgentInbox } from '../types/signals';
import { pendingEventsDelivery, type Delivery } from '../subagents/deliveries';
import type { EvolutionEngine } from '../evolution/engine';
import type { RecoveryFinding } from '../evolution/recovery';
import { turnTags } from '../types/turn-metadata';
import { type WorkMode } from '../types/turn';
import type { JsonObject } from '../utils/json';
import { Effect } from 'effect';
import { attempt, diagnostics, settle, settleLoggedSync } from '../obs/index';

export interface AgentOrchestratorDeps extends EvolutionLanesDeps {
  host: BackendHost;
  engine: EvolutionLanesDeps['engine'] & Pick<
    EvolutionEngine,
    | 'withTurnLearning'
    | 'recordRecovery'
    | 'reviewTurn'
    | 'recentAdvisorNotes'
    | 'recordAdvisorNote'
    | 'hasAdvisorNoteForTurn'
    | 'advisorNoteForTurn'
  >;
  eventLog: EventLog;
  sinks?: TurnSinks;
  /**
   * The one admission path (design v2 §1): every signal to this agent and every drain of its events goes out as a
   * delivery, committed with its source, then handed to the agent's chat; `inbox` takes only a person's words while a
   * turn runs. `commit` runs `bind` in one synchronous commit with the delivery's row and crosses it.
   */
  deliveries: {
    readonly signals: AgentInbox;
    readonly commit: (bind: () => Delivery | null) => Promise<void>;
  };
}

export class AgentOrchestrator extends EvolutionLanes {
  readonly acc: TurnAccumulator;
  readonly inbox: Inbox;
  /** Where a signal to this agent goes: its deliveries. */
  readonly signals: AgentInbox;
  /** Per-turn mechanical steering; feeds the durable `turn_steering` rows. */
  readonly steering = new TurnSteering();
  /** Registered on each turn's ExtensionHost by both backends. The steer is decided against the step being
   *  prepared and handed straight to it, so it dies with that step. */
  readonly turnExtension: KinuExtension = {
    name: 'kinu.inbox',
    onToolCall: (ctx) => this.steering.onToolCall(ctx),
    onToolResult: (ctx) => {
      const recovery = this.steering.onToolResult(ctx);

      if (recovery && this.evolutionThisTurn) this.recordRecovery(recovery);
    },
    prepareStep: (ctx: PrepareStepContext): Promise<ModelMessage[] | undefined> => {
      // The file ledger shows what a codemode program changed, which no tool-call signature can.
      const steer = this.steering.steerFor(ctx, this.acc.ledgers.files.progress);

      return this.inbox.prepareStep(ctx, steer ? [steer] : []);
    },
    onStepEnd: (ctx) => { this.inbox.stepEnded(ctx.stepNumber); },
  };
  /** Recorded through the engine at observation time, since an episode can outlive this instance;
   *  collected here only for the turn's `execution_recovery` run event. */
  private turnRecoveries: RecoveryFinding[] = [];
  /**
   * Decided once per turn: whether it evolves (the engine on, and not Plan). Read by the turn gate, by recovery
   * observation (a `--no-auto-evolve` run records no findings) and by the turn's crafted-tool record, whose `eval` calls
   * are observed where they run (`delegation/actor-tools.ts`). The turn's work mode itself is its session's.
   */
  private evolutionThisTurn: boolean;
  private activeMissions: readonly string[] = [];
  private readonly drains: DrainScheduler;

  constructor(private readonly deps: AgentOrchestratorDeps, steers?: UserSteerDeps) {
    super(deps);
    this.evolutionThisTurn = deps.engine.enabled;
    this.acc = new TurnAccumulator(deps.sinks, deps.budget, () => this.evolutionThisTurn);
    this.inbox = new Inbox(deps.host, (e, d) => this.logActivity(e, d), steers);
    this.signals = deps.deliveries.signals;
    this.drains = new DrainScheduler(
      () => this.drainPendingEvents(),
      (fn, ms) => deps.host.setTimer(fn, ms),
    );
  }

  protected override turnGate(): boolean {
    return this.evolutionThisTurn;
  }

  /** Reset per-turn accounting from the turn's metadata. */
  beginTurn(now: number, metadata?: JsonObject): void {
    this.deps.engine.recoverInterruptedWork();
    this.acc.reset(now);
    this.steering.reset();
    const tags = turnTags({ metadata });
    this.activeMissions = [...tags.missionLabels];
    this.evolutionThisTurn = this.deps.engine.enabled && tags.mode !== 'plan';
    this.turnRecoveries = [];
    this.inbox.beginTurn(tags.signalId);
    this.deps.budget?.activate(this.activeMissions);
  }

  withTurnLearning<Result>(body: () => Result): Result {
    return this.deps.engine.withTurnLearning(body);
  }

  /** Restrict a Build turn to plan after accounting opens: closes improvement lanes without resetting accounting. */
  restrictTurnWorkMode(mode: WorkMode): void {
    if (mode === 'plan') this.evolutionThisTurn = false;
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
    settleLoggedSync('event.durable_wake_arm_failed', { doing: 'arming the durable wake a pending reaction needs', otherwise: 'io' }, () => {
      this.deps.host.reconcileDurableWake?.();
    });
  }

  drainPendingEvents(opts?: { readonly rethrow?: boolean }): Promise<void> {
    return drainPendingEvents(this.deps, opts);
  }

}

/**
 * The reactor: bind pending events to a synthetic turn (markConsumed is synchronous, so a concurrent drain
 * sees them consumed), then send the batch as one signal bound to `replyTurnId`. An undelivered signal
 * puts its events back. No-op when nothing is pending.
 */
export function drainPendingEvents(
  { eventLog, deliveries }: Pick<AgentOrchestratorDeps, 'eventLog' | 'deliveries'>,
  /** Rethrow selection/binding failures: a durable effect that owes this drain must not report done. */
  opts?: { readonly rethrow?: boolean },
): Promise<void> {
  // Its events bound to their turn in the commit that writes the turn's delivery: nothing to put back.
  return settle(attempt({ doing: 'deliver the pending events as one turn', otherwise: 'io' }, () => deliveries.commit(() => pendingEventsDelivery(eventLog, Date.now())))
    .pipe(Effect.catch((failure) => {
      diagnostics.failure('orchestrator.drain_select_failed', failure);

      return opts?.rethrow === true ? Effect.fail(failure) : Effect.void;
    })));
}
