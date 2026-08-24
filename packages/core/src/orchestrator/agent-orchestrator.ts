// AgentOrchestrator — the backend-agnostic per-turn agent logic both backends
// share. It owns the per-turn accounting (TurnAccumulator), the session-level
// evolution cadence, and the event→turn reactor — parameterized over the
// EvolutionEngine + EventLog (from AgentRuntime's storage) and a BackendHost.
//
// The cf-backend OrchestratorAgent (a @cloudflare/think subclass) and the local
// cli-backend both delegate their loop hooks here. Platform transport (Think's
// private TurnQueue / the CLI's local loop), durable fibers, and the @callable
// control plane stay on each backend; this owns the LOGIC.
//
// ── The evolution exit contract ──────────────────────────────────────────
//
// Evolution never blocks a turn mid-flight: every dispatch is detached. But a
// process that exits kills whatever it detached, so `end()` has to decide what
// to wait for. Two lanes, with different answers — plus the IN-EPISODE clock,
// which is in neither because it makes no model call: the craft loop (`craft`,
// orchestrator/craft-cycle.ts) and the recovery findings (`recordRecovery`,
// evolution/recovery.ts) each write one synchronous row as a tool call
// settles, so there is nothing to detach and nothing to join. That clock is
// the only evolution that ticks inside a single long autonomous turn.
//
//   TURN LANE — the outcome review (classifier → reflection/extraction/lesson).
//     Seconds to minutes. `settleEvolution()` JOINS this lane with no elapsed
//     bound: a host that runs it is a host that can afford it, and evolution
//     work is never abandoned by the clock (owner ruling, 2026-08).
//     A `oneShot` host does not run it at all. Joining it was the largest item
//     on that process's exit tail — 64.9s of `evolution.settled
//     waitedOn:"Turn review"` against a 27.4s turn (TB2.1, 2026-08-20) — so the
//     turn writes one durable row (evolution/review-queue.ts) carrying exactly
//     `reviewTurn`'s two inputs, and the next host that can afford the work
//     drains it through the SAME code path at session open
//     (`runDeferredTurnReviews`). Deferred, never dropped: same call, same
//     inputs, same `turn_outcomes` row, on somebody else's wall clock.
//
//   CADENCE LANE — the whole session/lifetime chain (queued scaffold trials →
//     session reflection → scaffold proposal → replay eval → craft
//     consolidation → lifetime MCTS). Minutes to tens of minutes.
//     `settleEvolution()` does NOT join it. It is only ever STARTED by a host
//     that can afford to finish it: a long-lived CLI session, the Durable
//     Object (which holds itself open with keepAlive), or the local scheduler
//     daemon. A `oneShot` host — one `kinu exec` process per task — never
//     starts it at all, so it can never land on that process's wall clock.
//     The scaffold shadow trial is here, not on the turn lane: a candidate
//     rollout is a whole extra turn plus two judge calls, and charging that to
//     the process that just answered the user is what "resolving the promotion
//     gate inline" meant. The turn writes one queue row (scaffold/shadow.ts)
//     and is done; the queue is durable, so a host that exits first loses
//     nothing but time.
//
// What makes deferral safe is that the session window is DURABLE and is now
// closed only AFTER the pass it fed settles (`SessionWindowStore.claim`). A
// process that dies mid-pass leaves its turns in the window, and the next host
// that can afford the work picks up the same turns. Nothing is lost by not
// waiting — which is exactly what the durable window is for.

import type { ModelMessage } from 'ai';
import { TurnAccumulator, type TurnSinks } from './turn-accumulator';
import { TurnSteering } from './turn-steering';
import { CraftCycle } from './craft-cycle';
import { DrainScheduler } from './drain-scheduler';
import { SignalDelivery, readSignalId } from './signals';
import { buildDrainBatch } from '../events/hub/drain';
import type { EventLog } from '../events/hub/log';
import type { ExecutionRecoveryRecord } from '../events/types';
import type { PrepareStepContext, KinuExtension } from '../extension';
import type { BackendHost } from '../types/backend-host';
import type { AgentSignal } from '../types/signals';
import type { EvolutionEngine } from '../evolution/engine';
import type { DeferredReviewDrain } from '../evolution/review-queue';
import type { ClaimedWindow } from '../evolution/session-window';
import type { RecoveryFinding } from '../evolution/recovery';
import type { CompletedTurn } from '../evolution/types';
import {
  MISSION_LABELS_METADATA_KEY, readMissionLabels, type MissionGovernor,
} from '../mission-budget';
import { nanoid } from '../utils/nanoid';
import { workModeForTurnMetadata, type WorkMode } from '../prompting/surface';
import type { JsonObject } from '../utils/json';
import { diagnostics, toKinuError } from '../obs/index';

/**
 * Whether an arriving user message is a genuine conversational follow-up —
 * the user read the previous answer and then replied — or an independent task
 * invocation that merely happens to be the next thing this workspace saw.
 *
 * `kinu exec` / `kinu run` are one process per task: the process that
 * streamed the previous answer has already exited, and the next invocation's
 * prompt was written without seeing it. Grading a turn from such a prompt is
 * what made EVERY headless turn read as `accepted` — the classifier counts
 * "asked something new that presumes it worked" as acceptance, so an unrelated
 * next task fabricated a positive label. Silence is not success.
 *
 * A one-shot host never parks its own turns awaiting a follow-up at all (see
 * `recordTurn`); this type still exists because a turn parked by an EARLIER
 * conversational host can be picked up by a later one-shot process, and that
 * process must not read its own task prompt as the reply.
 */
export type TurnContinuity = 'conversation' | 'independent_task';

/** Turns between session-level evolution passes — the cadence the durable
 *  window is measured against. Not an option: nothing a host can read (config
 *  key, flag, profile field) chooses it, so a per-host knob was a second copy
 *  of this number and nothing more. */
const DEFAULT_SESSION_REFLECTION_INTERVAL = 5;

export interface AgentOrchestratorDeps {
  host: BackendHost;
  engine: Pick<
    EvolutionEngine,
    | 'enabled'
    | 'sessionWindow'
    | 'craftLedger'
    | 'recordRecovery'
    | 'reviewTurn'
    | 'deferTurnReview'
    | 'runDeferredTurnReviews'
    | 'onSessionComplete'
    | 'runDueShadowTrials'
  >;
  eventLog: EventLog;
  /** Per-turn accounting side-effects (activity log, durable run-event recorder). */
  sinks?: TurnSinks;
  /** The actor's mission budget governor. Absent = this backend wires no
   *  governor at all; present-but-unscoped is the normal uncapped turn. */
  budget?: MissionGovernor;
  /** The delegatable role ids as the active catalog offers them, read lazily.
   *  Stamped onto every delegation-opportunity row, because a zero conversion
   *  under an empty catalog is a wiring fact and one under a full catalog is
   *  behaviour. Absent reads as an empty list — stated, never guessed. */
  roleCatalog?: () => readonly string[] | undefined;
  /** This host runs ONE task turn and exits (`kinu exec` / `kinu run`),
   *  so it cannot finish the cadence lane and never STARTS it — see the exit
   *  contract above. Its window stays open and the local scheduler daemon runs
   *  the pass. Purely about what this PROCESS can afford; whether a turn can be
   *  graded from a follow-up is a separate, per-turn question (TurnContinuity),
   *  because the Durable Object can afford the pass for a one-shot request. */
  oneShot?: boolean;
}

export class AgentOrchestrator {
  /** Per-turn accounting — tool calls, steps, token usage, errors. */
  readonly acc: TurnAccumulator;
  /** The ONE way an asynchronous producer reaches the agent — hub drains,
   *  background-job wakes, overflow retries, take picks, MCP tasks — at the ONE
   *  time anything reaches it: its next step. Producers state intent only. */
  readonly signals: SignalDelivery;
  /** Per-turn mechanical steering — turn start, repeat, repeated failure, no
   *  progress, long turn.
   *  Observed through {@link turnExtension} and handed to closeTurnRun for the
   *  durable `turn_steering` rows. */
  readonly steering = new TurnSteering();
  /** The IN-EPISODE evolution clock: crafted tools scored by execution as the
   *  episode runs, off the same tool-result hook the steering rides. The only
   *  evolution timescale that ticks inside one long autonomous turn. */
  readonly craft: CraftCycle;
  /** The orchestrator's per-turn extension, registered on the turn's
   *  ExtensionHost by both backends: the steering object's and the craft
   *  cycle's observation hooks (the craft cycle needs only the result, which
   *  carries its call's own args), plus the ONE mid-turn signal drain every
   *  producer feeds. The steer is decided against the step being prepared and
   *  handed straight to it, so it rides the step it was decided on and dies
   *  with it. */
  readonly turnExtension: KinuExtension = {
    name: 'kinu.signals',
    onToolCall: (ctx) => this.steering.onToolCall(ctx),
    onToolResult: (ctx) => {
      const recovery = this.steering.onToolResult(ctx);
      this.craft.onToolResult(ctx);
      if (recovery && this.observeRecoveries) this.recordRecovery(recovery);
    },
    prepareStep: (ctx: PrepareStepContext): ModelMessage[] | undefined => {
      // The turn's file ledger is the other half of the progress trigger's
      // evidence — what a codemode program actually changed, which no
      // tool-call signature can show. Both live on this object, per turn.
      const steer = this.steering.steerFor(ctx, this.acc.files.progress);
      return this.signals.prepareStep(ctx, steer ? [steer] : []);
    },
  };
  /** The turn's execution recoveries — failure streaks the steering ledger saw
   *  broken by a changed call that ran clean (evolution/recovery.ts). Recorded
   *  through the engine at the MOMENT of observation, because an episode can
   *  outlive this instance (DO eviction, continuation turns) and a finding
   *  held for turn end dies with the process that held it; collected here only
   *  for the turn's `execution_recovery` run event. */
  private turnRecoveries: RecoveryFinding[] = [];
  /** Decided once per turn, exactly like the craft cycle's reset: a
   *  `--no-auto-evolve` run records no evolution state, and a recovery finding
   *  is evolution state. */
  private observeRecoveries = false;
  private turnEvolutionEnabled = false;
  private activeWorkMode: WorkMode = 'build';
  private readonly reflectionInterval = DEFAULT_SESSION_REFLECTION_INTERVAL;
  /** Debounces ingress-triggered drains so an event burst → ONE turn. */
  private readonly drains: DrainScheduler;
  /** TURN LANE: turn-level evolution this instance dispatched and has not yet
   *  settled, by label. Detached so it never blocks a turn; tracked so a
   *  process about to exit can join it (settleEvolution, with no elapsed
   *  bound). */
  private readonly inFlight = new Map<Promise<void>, string>();
  /** CADENCE LANE: the session-evolution pass this instance is running, or
   *  null. At most one at a time — a second would re-run the same window,
   *  because `claim()` retires nothing until the pass settles. */
  private sessionEvolution: Promise<void> | null = null;
  /** CADENCE LANE: the promotion gate's trial drain, or null. Its own latch,
   *  separate from the window pass: two drains would run the same queued
   *  trials twice and record each verdict twice, and folding it into the
   *  window's latch would let a no-op drain hide a window that had just
   *  filled. */
  private shadowTrials: Promise<void> | null = null;

  constructor(private readonly deps: AgentOrchestratorDeps) {
    this.acc = new TurnAccumulator(deps.sinks, deps.budget);
    this.craft = new CraftCycle(deps.engine.craftLedger, this.acc);
    this.turnEvolutionEnabled = deps.engine.enabled;
    this.signals = new SignalDelivery(
      deps.host,
      (e, d) => deps.sinks?.logActivity?.(e, d),
      () => this.activeWorkMode,
    );
    // Read per opportunity, never cached: the catalog can change between turns,
    // and the row must name what was available when the hint was delivered.
    if (deps.roleCatalog) this.steering.observeRoles(deps.roleCatalog);
    this.drains = new DrainScheduler(
      () => this.drainPendingEvents(),
      (fn, ms) => deps.host.setTimer(fn, ms),
    );
  }

  /** The window and the turn awaiting its review — durable, because neither
   *  backend's instance outlives them (`kinu exec` is one process per turn;
   *  a Durable Object is evicted between requests). */
  private get window() {
    return this.deps.engine.sessionWindow;
  }

  /** Turns buffered in the open evolution window — the turn index stamped on
   *  run events. Zero while auto-evolution is off: nothing is buffered then,
   *  because a turn that feeds no evolution leaves no evolution state. */
  get sessionTurnIndex(): number {
    return this.window.size();
  }

  /** Reset per-turn accounting at the start of a turn, from the turn's own
   *  metadata: the mission scope its model calls and spawns debit (absent on
   *  the chat path and every unbudgeted wake — those turns are uncapped), and
   *  the card of the signal that started it, whose "shown to the agent" moment
   *  is exactly here. `continuation` marks a turn that continues the previous
   *  one (Think auto-continue / recovery): its signals ride in again rather
   *  than being dropped as answered. */
  beginTurn<Metadata>(now: number, metadata?: Metadata, continuation = false): void {
    this.acc.reset(now);
    this.steering.reset();
    // Decided once, here, for the whole turn: a `--no-auto-evolve` run records
    // no evolution state at all, and a crafted tool's execution score is
    // evolution state — so a bench arm with evolution off measures the
    // in-episode loop's absence along with the rest of it.
    const workMode = workModeForTurnMetadata(metadata);
    this.activeWorkMode = workMode;
    const evolutionEnabled = this.deps.engine.enabled && workMode !== 'plan';
    this.turnEvolutionEnabled = evolutionEnabled;
    this.craft.reset(evolutionEnabled);
    this.turnRecoveries = [];
    this.observeRecoveries = evolutionEnabled;
    this.signals.beginTurn(continuation, readSignalId(metadata));
    this.deps.budget?.activate(readMissionLabels(metadata));
  }

  /** One recovery observed: hand it to the engine's ledger now (durable
   *  mid-episode) and keep it for the turn's run event. */
  private recordRecovery(finding: RecoveryFinding): void {
    this.turnRecoveries.push(finding);
    this.deps.engine.recordRecovery(finding);
  }

  /** The turn's in-episode recovery record, or null when no streak broke — no
   *  row, `turn_end` being the denominator, exactly as the steering and craft
   *  records read. */
  recoverySnapshot(): ExecutionRecoveryRecord | null {
    if (this.turnRecoveries.length === 0) return null;
    return {
      recoveries: this.turnRecoveries.map(({ tool, failures, failedSignature }) =>
        ({ tool, failures, failedSignature })),
    };
  }

  /**
   * A new USER message arrived. Dispatch the detached outcome review
   * (engine.reviewTurn: trivial pre-filter, one cheap LLM classification,
   * turn_outcomes row + downstream evolution). Backends call this at user-turn
   * start; programmatic turns must not.
   *
   * `continuity` is required, and every caller must answer it honestly,
   * because it decides whether the message is EVIDENCE. Only a
   * `'conversation'` follow-up is a verdict on the previous turn. An
   * `'independent_task'` message still triggers the review — an error on the
   * previous turn is real machine signal and still earns a provisional lesson
   * — but with NO follow-up, which is the engine's "no user signal exists"
   * path: no `turn_outcomes` row is written at all. Honest absence, never a
   * fabricated `accepted`.
   *
   * The previous turn may have been completed by an earlier process — that is
   * the whole point of the durable window.
   */
  observeUserTurn(userText: string, continuity: TurnContinuity): void {
    if (!this.turnEvolutionEnabled) return;
    const previous = this.window.takePendingReview();
    if (!previous) return;
    const followup = continuity === 'conversation' ? userText : null;
    this.dispatchReview(previous, followup);
  }

  /**
   * Buffer the turn in the durable window, fire session evolution when the
   * window reaches the interval, and review immediately every turn that has no
   * conversational follow-up coming. All detached — never blocks the loop.
   * Does NOT drain events (the backend calls drainPendingEvents() separately so
   * it controls ordering vs its own platform-specific post-turn work).
   *
   * Turn-level evolution is outcome-driven, and this is the ONE place that
   * decides where each turn's verdict can come from:
   *   • a `'conversation'` user turn waits for the user's next message;
   *   • a programmatic turn (reactor / job wake) has no user behind it;
   *   • an `'independent_task'` turn has no follow-up either — the next
   *     `kinu exec` invocation is a different task written by a caller who
   *     never saw this answer.
   * The last two are reviewed here and now, on the execution signal the turn
   * itself carries (errors, tool outcomes), and are never parked awaiting a
   * "follow-up" that would be a different task's prompt.
   *
   * With auto-evolution off nothing is recorded at all: no window row, no
   * review, no cadence. That is what the flag says, and it is what keeps a
   * `--no-auto-evolve` run from leaving state for some later evolution-enabled
   * host (the scheduler daemon, a chat session) to evolve on its behalf.
   */
  recordTurn(turn: CompletedTurn, continuity: TurnContinuity): void {
    if (!this.turnEvolutionEnabled) return;
    const scoped = this.scopeTurn(turn);
    const awaitsFollowup = turn.origin !== 'programmatic' && continuity === 'conversation';
    this.window.append(scoped, { awaitsFollowup });
    if (!awaitsFollowup) {
      this.dispatchReview(scoped, null);
    }
    // A one-shot host is about to exit — it must not open work it cannot
    // finish. The window keeps the turns; the daemon runs the pass.
    if (!this.deps.oneShot) void this.runDueSessionEvolution();
  }

  /**
   * Stamp the mission the turn ran under, so its review debits that mission
   * wherever and whenever the review actually runs.
   *
   * Read here because here is the last moment the answer is knowable: the
   * governor's active scope belongs to the turn that just ended, and the next
   * `beginTurn` replaces it. A review dispatched at the next user message, or
   * drained by a different process a day later, has no way back to it.
   *
   * An unscoped turn is returned untouched — no field, no empty array. Absent
   * means ungoverned, and a review must never invent a label.
   */
  private scopeTurn(turn: CompletedTurn): CompletedTurn {
    const labels = this.deps.budget?.scope ?? [];
    return labels.length === 0 ? turn : { ...turn, missionLabels: [...labels] };
  }

  /**
   * The TURN LANE's one decision point: run this review now, or defer it.
   *
   * An interactive session and the Durable Object detach it and join it at
   * exit — they outlive the call, so paying for it inline costs nobody
   * anything. A one-shot host cannot: it is about to exit, so `settleEvolution`
   * would charge the whole classifier→reflection→extraction chain to the
   * process that has already answered the user. It writes one durable row
   * instead and the next host that can afford the work runs it, which is
   * exactly what the cadence lane's shadow-trial queue already does.
   *
   * The mode is structural: `deps.oneShot`, fixed at construction from the
   * host's InvocationSurface, never inferred inside the review path.
   */
  private dispatchReview(turn: CompletedTurn, followup: string | null): void {
    if (this.deps.oneShot) {
      this.deps.engine.deferTurnReview(turn, followup);
      return;
    }
    this.detach(this.deps.engine.reviewTurn(turn, followup), 'Turn review');
  }

  /**
   * Run the reviews one-shot hosts deferred — the re-driver, called at session
   * open by the hosts that can afford the work (the interactive client's
   * connect, the scheduler daemon's tick), alongside the interrupted-job
   * recovery that runs there for the same reason.
   *
   * A one-shot host does NOT re-drive: draining at its startup would move the
   * cost from one task's exit to the next task's start, which is not a saving.
   * That is what the queue's own ceiling is for — see
   * MAX_QUEUED_TURN_REVIEWS.
   *
   * Never rejects: the engine absorbs each review's failure and leaves that
   * row for the next open.
   */
  async runDeferredTurnReviews(): Promise<DeferredReviewDrain> {
    if (this.deps.oneShot) return { reviewed: 0, refused: [] };
    return await this.deps.engine.runDeferredTurnReviews();
  }

  /**
   * The CADENCE LANE: the promotion gate's queued shadow trials, then the
   * session/lifetime evolution chain when the durable window has reached the
   * interval — closing the window only once that chain has settled, so a host
   * that dies mid-pass carries the same turns forward instead of consuming
   * them for nothing.
   *
   * Returns the running pass, so the hosts that OWN this work — the Durable
   * Object under keepAlive, a long-lived CLI session, and the local scheduler
   * daemon — can await it. `recordTurn` ignores the result: the pass runs
   * alongside the live conversation, never in front of it. Never rejects.
   *
   * The window is claimed BEFORE any await. `claim()` does not mark its rows —
   * they are retired only by `settle()`, once the pass has actually run — so
   * the one thing keeping a second pass off the same window is taking it in a
   * single event-loop tick, exactly as the event drain takes its batch.
   */
  runDueSessionEvolution(): Promise<void> {
    if (this.sessionEvolution) return this.sessionEvolution;
    const claimed = this.deps.engine.enabled && this.window.size() >= this.reflectionInterval
      ? this.window.claim()
      : null;
    const pass = this.runCadencePass(claimed);
    // Only a pass that CLAIMED a window latches. A drain-only pass must not,
    // or it would hide a window that filled while it ran.
    if (claimed) {
      this.sessionEvolution = pass;
      void pass.finally(() => { this.sessionEvolution = null; });
    }
    return pass;
  }

  /**
   * The pass itself. Trials first, because the window pass may want to propose
   * a new scaffold and the engine refuses to while one is still pending.
   */
  private async runCadencePass(claimed: ClaimedWindow | null): Promise<void> {
    await this.drainDueShadowTrials();
    if (!claimed) return;
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
    // Settled either way: retrying the same window forever on a persistent
    // failure would be a livelock, and every step of the chain already absorbs
    // its own errors. Carry-forward is for a host that DIED, which never
    // reaches here at all.
    claimed.settle();
  }

  /** The promotion gate's queued trials, at most one drain at a time. */
  private drainDueShadowTrials(): Promise<void> {
    if (this.shadowTrials) return this.shadowTrials;
    const drain = this.deps.engine.runDueShadowTrials()
      .finally(() => { this.shadowTrials = null; });
    this.shadowTrials = drain;
    return drain;
  }

  /**
   * Wait for the TURN LANE this instance dispatched — the outcome review and
   * the sampled shadow eval — with NO elapsed bound. Evolution makes LLM calls
   * that outlive a turn, so a process about to exit must wait or the work is
   * simply killed, which is what made headless runs produce no evolution at
   * all. A host that joins is a host that chose to run the lane; abandoning
   * honest work because it takes long would only relabel the old exit-tail
   * defect. Work still in flight when this returns never happens: there is no
   * such path here.
   *
   * The cadence lane is deliberately NOT joined here (see the exit contract in
   * the module header). Neither window needs flushing: both are durable.
   */
  async settleEvolution(): Promise<void> {
    const started = Date.now();
    // Named on the SUCCESS path too: an exit tail is silent exactly when it is
    // slow, and 100-600s of unattributed post-answer wall has been chased
    // across environments twice (TB2.1, 2026-08-20).
    const waitedOn = [...new Set(this.inFlight.values())];
    while (this.inFlight.size > 0) {
      // A lap over one snapshot; work dispatched by settled work lands in the
      // map during the await and is joined by the next lap.
      await Promise.all(this.inFlight.keys());
    }
    const waitedMs = Date.now() - started;
    if (waitedMs > 1_000) {
      diagnostics.event('evolution.settled', { waitedMs, waitedOn: waitedOn.join(', ') });
    }
  }

  /**
   * Register post-turn evolution work the backend owns but this orchestrator
   * must still join — the sampled scaffold shadow eval is the one case. It is
   * detached like the rest (never blocks the loop) and joins the TURN LANE, so
   * a process that exits right after a turn does not kill the evaluation that
   * would have resolved a pending scaffold.
   */
  track(work: Promise<void>, label: string): void {
    this.detach(work, label);
  }

  private detach(work: Promise<void>, label: string): void {
    const tracked = work
      .catch((err) => diagnostics.failure(
        'orchestrator.detached_work_failed',
        toKinuError({ doing: 'run detached post-turn work', cause: err, otherwise: 'unavailable' }),
        { work: label },
      ))
      .then(() => { this.inFlight.delete(tracked); });
    this.inFlight.set(tracked, label);
  }

  /**
   * Ingress trigger: a fresh external event was admitted (webhook, email,
   * peer message, timer). Debounced (~250ms fixed window) so a burst drains
   * into ONE turn — the post-turn drain path stays immediate (completeTurn /
   * the backend's post-turn hook) because it is already serialized behind a
   * just-finished turn and coalesced everything that arrived during it.
   */
  scheduleDrain(): void {
    this.drains.schedule();
  }

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
  }

  /**
   * The reactor: bind the selected pending events to a synthetic turn
   * (markConsumed — synchronous, so atomic w.r.t. the event loop; a concurrent
   * drain sees them already consumed), then hand the batch to signal delivery
   * as ONE 'now' signal. Whether it splices into a live turn's next step or
   * queues as its own programmatic turn is the seam's decision, not this
   * caller's; either way the events stay bound to `replyTurnId`, so
   * reply-channel dispatch (email_thread → outbound reply) finds them by the
   * same id. A signal that cannot be delivered puts its events back. The woken
   * turn's own post-turn drain re-checks, so this self-terminates once the
   * external backlog is empty. No-op when nothing is pending.
   *
   * The user's card for the drain comes from delivery itself (the seam's
   * `signal_card` broadcast), so it is the same card whichever way the batch
   * landed — this caller neither knows nor announces the outcome.
   */
  async drainPendingEvents(): Promise<void> {
    let batch: ReturnType<typeof buildDrainBatch>;
    const turnId = `evt-${nanoid()}`;
    try {
      const pending = this.deps.eventLog.pending({ resolve_deferred: { now: Date.now(), phase: 'idle' } });
      batch = buildDrainBatch(pending);
      if (!batch) return;
      for (const id of batch.ids) this.deps.eventLog.markConsumed(id, turnId, 0);
    } catch (err) {
      diagnostics.failure(
        'orchestrator.drain_select_failed',
        toKinuError({ doing: 'select the pending events for a drain turn', cause: err, otherwise: 'io' }),
        { turnId },
      );
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
      compensate: () => this.returnEventsToPending(ids),
      metadata,
      requiresOwnTurn: batch.mode !== null,
    };
    await this.signals.deliver(signal);
  }

  /** Convenience for backends that don't need to interleave: cadence + drain. */
  async completeTurn(turn: CompletedTurn, continuity: TurnContinuity): Promise<void> {
    this.recordTurn(turn, continuity);
    await this.drainPendingEvents();
  }
}
