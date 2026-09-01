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
//     turn writes one durable row (evolution/session-window.ts) carrying exactly
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
// closed only AFTER the pass it fed settles (`CompletedTurnStore.claim`). A
// process that dies mid-pass leaves its turns in the window, and the next host
// that can afford the work picks up the same turns. Nothing is lost by not
// waiting — which is exactly what the durable window is for.

import type { ModelMessage } from 'ai';
import { TurnAccumulator, type TurnSinks } from './turn-accumulator';
import type { RunEndReason } from './turn-lifecycle';
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
import type { ClaimedWindow, DeferredReviewDrain } from '../evolution/session-window';
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
    | 'runStoredTurnReview'
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
  /**
   * The continual-refinement lane, as ONE step this cadence drives.
   *
   * A thunk rather than the lane's deps, because those deps are per-backend
   * objects (a control plane, a facts store, a temporary-agent port, an
   * approval authority) and this orchestrator has no business holding any of
   * them. What it owns is WHEN: the same off-turn pass that drains the
   * promotion gate's trials, so a refinement never lengthens a user's turn and
   * both backends reach the lane through one drive site rather than two that
   * eventually disagree.
   *
   * Absent = this host drives no refinement lane. The requests stay durable and
   * the next host that wires one picks them up.
   */
  refinementLane?: () => Promise<void>;
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
  /** CADENCE LANE: every pass dispatched at turn end. This is an observer, not
   *  the claim latch above: a no-op pass must never hide a window that fills
   *  while it runs, but its rejection still needs a process owner. It is
   *  deliberately not joined by `settleEvolution`; its rows are durable and a
   *  one-shot host must not inherit a lifetime cycle's clock. */
  private cadencePasses: Promise<void> = Promise.resolve();
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
    const previous = this.window.claimPendingReview();
    if (!previous) return;
    const followup = continuity === 'conversation' ? userText : null;
    this.dispatchReview(previous.turn, followup, previous.rowId);
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
   *
   * `opts.id` names the durable identity of the turn being recorded, for a
   * backend that OWES this recording and may therefore run it again: with it,
   * the window append is idempotent and a replay leaves one row and one
   * cadence tick instead of two. A host whose recording nothing can replay
   * passes none.
   */
  recordTurn(
    turn: CompletedTurn,
    continuity: TurnContinuity,
    opts?: {
      readonly id?: string;
      readonly recordedAt?: number;
      /** Whether the PRODUCING session recorded evolution state. Supplied by a
       *  caller replaying a recorded turn, and it replaces the ambient gate:
       *  that gate is this session's, and a recovery's is not the one the turn
       *  ran under. Same shape as `improvementLanesOpen(status, workMode)` —
       *  recorded values in, no ambient read. */
      readonly enabled?: boolean;
    },
  ): void {
    // The RECORDED gate wins when there is one. `turnEvolutionEnabled` is this
    // session's, set at `beginTurn` from its own engine and mode, and a recovery
    // is not the session the turn ran under: a turn produced with evolution on
    // was silently dropped by a host that had it off, and one produced under
    // `--no-auto-evolve` was written into a window it never earned.
    if (!(opts?.enabled ?? this.turnEvolutionEnabled)) return;
    const scoped = this.scopeTurn(turn);
    const awaitsFollowup = turn.origin !== 'programmatic' && continuity === 'conversation';
    // An independent task's arrival proves the parked turn's follow-up can
    // never come — this prompt was written without reading the answer it
    // waits on. Its review is still owed, so it demotes to the queue. A
    // programmatic turn proves nothing about the conversation and leaves the
    // park alone, and a conversational arrival already claimed the pending
    // review through observeUserTurn.
    if (continuity === 'independent_task') {
      // Bounded by WHEN this turn ended, not by when the recording ran. A replay
      // arriving after a newer conversational turn parked its review would
      // otherwise demote a review that did not exist when the task finished.
      this.window.expireAwaitingReviews(
        opts?.recordedAt === undefined ? undefined : { before: opts.recordedAt },
      );
    }
    // The append CARRIES the obligation: a turn with no follow-up coming is
    // inserted already `queued`, and the durable queued-review lane
    // (`settleEvolution` → `takeQueuedReviews`, with `resetStaleClaims` for a
    // dead claimer) is what runs it. There is no inline dispatch here any more:
    // it sat AFTER this insert, so an eviction between the two lost the review
    // while a replay of the recording ran it twice. One durable write, one
    // claimant.
    const appendOpts = { awaitsFollowup, id: opts?.id };
    this.window.append(
      scoped,
      opts?.recordedAt === undefined ? appendOpts : { ...appendOpts, now: opts.recordedAt },
    );
    // Promptness on TOP of durability, never instead of it. The obligation is
    // already on the row, so this drain is a liveness choice: it runs the review
    // now instead of at the next session open, and a crash costs only the
    // promptness. The queue's own claim is what keeps it exactly-once, so a
    // replay of the recording cannot run the review twice.
    //
    // A one-shot host is about to exit — it must not open work it cannot finish.
    // The window keeps the turns; the next capable host runs the pass.
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
    // A turn that already carries labels keeps them: a REPLAY hands back the
    // scope captured when the turn ended, and this activation's governor — which
    // has no active scope at all on a cold start — must not overwrite it with
    // nothing.
    if (turn.missionLabels !== undefined) return turn;
    const labels = this.deps.budget?.scope ?? [];
    return labels.length === 0 ? turn : { ...turn, missionLabels: [...labels] };
  }

  /**
   * The turn with its mission scope stamped, for a caller that must RECORD the
   * turn now and replay the recording later.
   *
   * Read here because here is the last moment the answer is knowable: the
   * governor's active scope belongs to the turn that just ended, and the next
   * `beginTurn` replaces it. A recording replayed a day later by another process
   * has no way back to it, so it has to travel on the turn.
   */
  scopedTurn(turn: CompletedTurn): CompletedTurn {
    return this.scopeTurn(turn);
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
  private dispatchReview(turn: CompletedTurn, followup: string | null, storedRowId?: string): void {
    if (this.deps.oneShot) {
      this.deps.engine.deferTurnReview(turn, followup, { storedRowId });
      return;
    }
    this.detach(this.deps.engine.runStoredTurnReview(storedRowId ?? '', turn, followup), 'Turn review');
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
    let pass = this.runCadencePass(claimed);
    // Only a pass that CLAIMED a window latches. A drain-only pass must not,
    // or it would hide a window that filled while it ran.
    if (claimed) {
      pass = pass.finally(() => { this.sessionEvolution = null; });
      this.sessionEvolution = pass;
    }
    return pass;
  }

  /**
   * The pass itself. Trials first, because the window pass may want to propose
   * a new scaffold and the engine refuses to while one is still pending.
   *
   * The refinement lane runs LAST, and after `claimed.settle()` is not an
   * option: it is driven whether or not a window was claimed, because its
   * trigger is durable evolution debt rather than this session's window, and a
   * host that reaches the cadence with nothing claimed is exactly the host that
   * can afford it.
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
      // Settled either way: retrying the same window forever on a persistent
      // failure would be a livelock, and every step of the chain already absorbs
      // its own errors. Carry-forward is for a host that DIED, which never
      // reaches here at all.
      claimed.settle();
    }
    await this.drainRefinementLane();
  }

  /** The refinement lane, at most one step at a time. Its own failure is
   *  absorbed here for the same reason the session pass's is: the request rows
   *  are durable, so a failed step is a step the next cadence re-drives. */
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

  /**
   * Ingress trigger: a fresh external event was admitted (webhook, email,
   * peer message, timer). Debounced (~250ms fixed window) so a burst drains
   * into ONE turn — the post-turn drain path stays immediate (the settled
   * turn's own `event_drain` row) because it is already serialized behind a
   * just-finished turn and coalesced everything that arrived during it.
   */
  scheduleDrain(): void {
    this.drains.schedule();
    // …and the wake that outlives this activation. The debounce above is an
    // in-memory timer: it coalesces a burst, and it dies with the process. A
    // pending reaction is durable, so the promise to look at it again has to be
    // too — every caller of this method reaches both halves, which is why the
    // second one lives here rather than at the five ingress sites.
    this.reconcileDurableWake();
  }

  /** Ask the host to re-derive its durable wake. Absent on a host whose next
   *  wake is its own next start (see BackendHost.reconcileDurableWake). */
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
   * Compensation: a signal the host refused puts its events back.
   *
   * The re-arm is the load-bearing half. Unbinding returns the rows to the
   * pending pool, and the pool is only ever read by a drain — so a
   * compensation that stopped at the unbind handed the workspace back work it
   * had scheduled nothing to do. That is the shape the audit found: pending,
   * durable, and unreachable until some unrelated ingress happened along.
   *
   * The DURABLE wake, and deliberately not `scheduleDrain`. A host refuses a
   * signal turn because a newer turn pre-empted it, and that turn's own
   * post-turn drain is what picks these rows up next. Re-entering the 250ms
   * debounce here would retry against the same refusal four times a second for
   * as long as it lasted; the alarm chain retries on its own cadence and
   * collapses onto one row, so it converges without spinning.
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
  async drainPendingEvents(
    /** Whether a selection or binding failure REACHES the caller. A durable
     *  effect that owes this drain needs it to: a swallowed failure leaves events
     *  pending, or a batch half-bound, while the row that owed the drain reports
     *  done and is pruned. Ambient callers (an ingress nudge, a debounced wake)
     *  keep the absorbing behaviour — there is nothing owed to retry them. */
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
      // UNBOUND, back to the pending pool. A binding that failed partway left the
      // prefix owned by a turn that never ran: the retry then drained only the
      // suffix and reported done, and the prefix was stranded with no signal and
      // no wake. Unbinding is the reverse of the only write that happened, and it
      // is what makes the retry see the whole batch again.
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
      // The drain's own durable identity, offered as the admission key.
      //
      // `markConsumed` above bound these rows to `turnId` before this object
      // existed, so the fact is already on disk — which is exactly what an
      // idempotency key has to be. Naming it here is what routes the queued
      // half through a host's DURABLE admission ledger (on cf, Think's
      // submission table: a UNIQUE key, an atomic pending→running claim, and a
      // startup drain) instead of an in-memory turn queue that an eviction
      // takes with it. Nothing new is persisted to make that true.
      //
      // A re-delivery of the same drain therefore lands on the row the first one
      // wrote rather than beside it, so at-least-once delivery of one batch is
      // one turn.
      idempotencyKey: turnId,
      compensate: () => this.returnEventsToPending(ids),
      metadata,
      requiresOwnTurn: batch.mode !== null,
    };
    await this.signals.deliver(signal);
  }

  // THE SETTLE SPINE IS THE TERMINAL ROSTER, and it is not here.
  //
  // Two shapes stood here before it: `completeTurn`, a status-blind record+drain
  // pair, and then `settleTurn`, which took the driver's verdict and ran
  // turn-end → record → drain in one call. Both are gone, because a settle that
  // runs as one call cannot record which half of itself an eviction interrupted.
  // `declareTerminalRoster` (orchestrator/terminal-roster.ts) owns that sequence
  // now — `turn_end_extensions`, `turn_record`, `event_drain`,
  // `improvement_lanes`, in that order, each a separately claimed row — and
  // every backend drives it through `TerminalTransitions.settle`.
  //
  // What survives here is what those rows ASK: {@link recordTurn} for the
  // recording itself, {@link drainPendingEvents} for the reactor, and the two
  // pure rules below. They are public precisely because a backend claiming the
  // sub-effects separately has to ask each question without running a settle,
  // and asking twice is how the two backends drifted in the first place.

  /**
   * Whether the COMPLETED-only improvement lanes — shadow trial, advisor
   * review, auto-title — may run after a turn that ended this way.
   *
   * A completed BUILD turn opens them; every other combination closes them. A
   * cut or aborted turn has no subject to replay or review, and plan
   * deliberation belongs in neither evidence set. The mode comes from
   * `beginTurn`, so this is the same derivation the recording gate uses.
   *
   * PURE and public, because a backend that claims the settle's sub-effects
   * separately has to ask the question without re-running the settle to be
   * told the answer. The condition therefore exists once: the CLI used to
   * queue shadow trials for turns that FAILED while the cloud spine did not,
   * because each backend spelled it for itself.
   */
  improvementLanesOpen(status: RunEndReason, workMode?: WorkMode): boolean {
    // `workMode` is for a REPLAY: a backend re-driving a recorded turn on a fresh
    // activation has the mode on its row and must not be answered against this
    // activation's live one, which defaults to build. Absent means "ask the live
    // turn", which is what every in-turn caller wants.
    return status === 'completed' && (workMode ?? this.activeWorkMode) !== 'plan';
  }

  /**
   * The turn as the driver's verdict witnesses it — what `recordTurn` should be
   * given for a turn that ended this way.
   *
   * A turn can throw outside the accumulator's view — that is why one backend
   * had to set `acc.hadError` by hand in its catch — so on the `'error'` arm
   * the status is the more reliable witness. An ABORT is deliberately left
   * alone: the user pressing Stop did not make the agent fail, and stamping
   * their turn as an error would feed the outcome classifier a negative label
   * nothing earned, which is the fabricated signal this codebase refuses
   * everywhere else.
   *
   * PURE and public for the same reason as `improvementLanesOpen`: the backend
   * that claims the recording as its own durable effect records the turn from
   * inside that row's body, and this rule must not be spelled a second time
   * there.
   */
  recordedTurn(status: RunEndReason, turn: CompletedTurn): CompletedTurn {
    return status === 'error' && !turn.hadError ? { ...turn, hadError: true } : turn;
  }
}
