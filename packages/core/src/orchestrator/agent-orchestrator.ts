// Backend-agnostic per-turn agent logic: turn accounting and the event→turn reactor, over the agent's evolution lanes
// (`EvolutionLanes`, whose exit contract covers everything this dispatches).
// The in-episode clock (`craft`, `recordRecovery`) writes synchronous rows and needs no join.

import type { ModelMessage } from 'ai';
import { TurnAccumulator, type TurnSinks } from './turn-accumulator';
import type { RunEndReason } from './turn-lifecycle';
import { TurnSteering } from './turn-steering';
import { CraftCycle } from './craft-cycle';
import { DrainScheduler } from './drain-scheduler';
import { Inbox, readSignalId, type UserSteerDeps } from './inbox';
import { EvolutionLanes, improvementLanesOpen, type EvolutionLanesDeps } from './evolution-lanes';
import type { EventLog } from '../events/hub/log';
import type { ExecutionRecoveryRecord } from '../events/types';
import type { PrepareStepContext, KinuExtension } from '../extension';
import type { BackendHost } from '../types/backend-host';
import type { AgentInbox } from '../types/signals';
import { pendingEventsDelivery, type Delivery } from '../subordinates/deliveries';
import type { EvolutionEngine } from '../evolution/engine';
import type { RecoveryFinding } from '../evolution/recovery';
import { readMissionLabels } from '../mission-budget';
import { workModeForTurnMetadata } from '../prompting/surface';
import { type WorkMode } from '../types/turn';
import type { JsonObject } from '../utils/json';
import { Effect } from 'effect';
import { attempt, diagnostics, settle, settleLoggedSync } from '../obs/index';

export interface AgentOrchestratorDeps extends EvolutionLanesDeps {
  host: BackendHost;
  engine: EvolutionLanesDeps['engine'] & Pick<
    EvolutionEngine,
    | 'withTurnLearning'
    | 'craftLedger'
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
    onStepEnd: (ctx) => { this.inbox.stepEnded(ctx.stepNumber); },
  };
  /** Recorded through the engine at observation time, since an episode can outlive this instance;
   *  collected here only for the turn's `execution_recovery` run event. */
  private turnRecoveries: RecoveryFinding[] = [];
  /** Decided once per turn: a `--no-auto-evolve` run records no recovery findings. */
  private observeRecoveries = false;
  private turnEvolutionEnabled = false;
  private activeWorkMode: WorkMode = 'build';
  private activeMissions: readonly string[] = [];
  private readonly drains: DrainScheduler;

  constructor(private readonly deps: AgentOrchestratorDeps, steers?: UserSteerDeps) {
    super(deps);
    this.acc = new TurnAccumulator(deps.sinks, deps.budget);
    this.craft = new CraftCycle(deps.engine.craftLedger, this.acc);
    this.turnEvolutionEnabled = deps.engine.enabled;
    this.inbox = new Inbox(deps.host, (e, d) => this.logActivity(e, d), steers);
    this.signals = deps.deliveries.signals;
    this.drains = new DrainScheduler(
      () => this.drainPendingEvents(),
      (fn, ms) => deps.host.setTimer(fn, ms),
    );
  }

  protected override turnGate(): boolean {
    return this.turnEvolutionEnabled;
  }

  /** Reset per-turn accounting from the turn's metadata. */
  beginTurn(now: number, metadata?: JsonObject): void {
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
    this.inbox.beginTurn(readSignalId(metadata));
    this.deps.budget?.activate(this.activeMissions);
  }

  withTurnLearning<Result>(body: () => Result): Result {
    return this.deps.engine.withTurnLearning(body);
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

  // The settle spine is `declareTerminalRoster` (orchestrator/terminal-roster.ts). The pure rule below is public so a
  // backend claiming the sub-effects separately asks it without re-spelling it.

  /** Completed-only improvement lanes (advisor review, auto-title) open only after a completed build turn. */
  improvementLanesOpen(status: RunEndReason, workMode?: WorkMode): boolean {
    // `workMode` is for a replay on a fresh activation; absent means the live turn.
    return improvementLanesOpen(status, workMode ?? this.activeWorkMode);
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
