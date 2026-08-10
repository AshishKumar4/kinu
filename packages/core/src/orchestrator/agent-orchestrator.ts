// AgentOrchestrator — the backend-agnostic per-turn agent logic both backends
// share. It owns the per-turn accounting (TurnAccumulator), the session-level
// evolution cadence, and the event→turn reactor — parameterized over the
// EvolutionEngine + EventLog (from AgentRuntime's storage) and a BackendHost.
//
// The cf-backend OrchestratorAgent (a @cloudflare/think subclass) and the local
// cli-backend both delegate their loop hooks here. Platform transport (Think's
// private TurnQueue / the CLI's local loop), durable fibers, and the @callable
// control plane stay on each backend; this owns the LOGIC.

import type { ModelMessage } from 'ai';
import { TurnAccumulator, type TurnSinks } from './turn-accumulator.js';
import { DelegationNudge } from './delegation-nudge.js';
import { DrainScheduler } from './drain-scheduler.js';
import { SignalDelivery } from './signals.js';
import { buildDrainBatch } from '../events/hub/drain.js';
import type { EventLog } from '../events/hub/log.js';
import type { PrepareStepContext, ProteusExtension } from '../extension.js';
import type { BackendHost } from '../types/backend-host.js';
import type { EvolutionEngine } from '../evolution/engine.js';
import type { CompletedTurn } from '../evolution/types.js';
import { MISSION_LABELS_METADATA_KEY, type MissionGovernor } from '../mission-budget.js';
import { nanoid } from '../utils/nanoid.js';

export interface AgentOrchestratorDeps {
  host: BackendHost;
  engine: EvolutionEngine;
  eventLog: EventLog;
  /** Per-turn accounting side-effects (activity log, durable run-event recorder). */
  sinks?: TurnSinks;
  /** The actor's mission budget governor. Absent = this backend wires no
   *  governor at all; present-but-unscoped is the normal uncapped turn. */
  budget?: MissionGovernor;
  /** Turns between session-level reflections (default 5). */
  sessionReflectionInterval?: number;
}

export class AgentOrchestrator {
  /** Per-turn accounting — tool calls, steps, token usage, errors. */
  readonly acc: TurnAccumulator;
  /** The ONE way an asynchronous producer reaches the agent — hub drains,
   *  background-job wakes, overflow retries, take picks, MCP tasks, the
   *  delegation nudge. Producers state a timing; this picks the mechanism. */
  readonly signals: SignalDelivery;
  /** Per-turn mechanical delegation steering. Observed through
   *  {@link turnExtension} and handed to closeTurnRun for the durable
   *  `delegation_nudge` row. */
  readonly nudge = new DelegationNudge();
  /** The orchestrator's per-turn extension, registered on the turn's
   *  ExtensionHost by both backends: the delegation nudge's observation hooks
   *  plus the ONE mid-turn signal drain every producer feeds. The nudge's
   *  trigger check runs first so its signal rides the step it was decided on;
   *  that ordering lives here, not in each backend's registration order. */
  readonly turnExtension: ProteusExtension = {
    name: 'proteus.signals',
    onToolCall: (ctx) => this.nudge.onToolCall(ctx),
    onToolResult: (ctx) => this.nudge.onToolResult(ctx),
    prepareStep: (ctx: PrepareStepContext): ModelMessage[] | undefined => {
      const nudge = this.nudge.nudgeFor(ctx.stepNumber);
      if (nudge) void this.signals.deliver(nudge);
      return this.signals.prepareStep(ctx);
    },
  };
  private readonly reflectionInterval: number;
  /** Debounces ingress-triggered drains so an event burst → ONE turn. */
  private readonly drains: DrainScheduler;
  /** Evolution dispatched by this instance and not yet settled. Detached so it
   *  never blocks a turn; tracked so a process that is about to exit can wait
   *  for it (settleEvolution). */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly deps: AgentOrchestratorDeps) {
    this.acc = new TurnAccumulator(deps.sinks, deps.budget);
    this.signals = new SignalDelivery(deps.host, (e, d) => deps.sinks?.logActivity?.(e, d));
    this.reflectionInterval = deps.sessionReflectionInterval ?? 5;
    this.drains = new DrainScheduler(
      () => this.drainPendingEvents(),
      (fn, ms) => deps.host.setTimer(fn, ms),
    );
  }

  /** The window and the turn awaiting its review — durable, because neither
   *  backend's instance outlives them (`proteus exec` is one process per turn;
   *  a Durable Object is evicted between requests). */
  private get window() {
    return this.deps.engine.sessionWindow;
  }

  /** Completed turns in the current session — the turn index for run events. */
  get sessionTurnIndex(): number {
    return this.window.size();
  }

  /** Reset per-turn accounting at the start of a turn and bind its mission
   *  scope — the labels the turn's model calls and spawns debit. Omitted (the
   *  chat path and every unbudgeted wake) leaves the turn uncapped.
   *  `continuation` marks a turn that continues the previous one (Think
   *  auto-continue / recovery): its signals ride in again rather than being
   *  dropped as answered. */
  beginTurn(now: number, missionLabels: readonly string[] = [], continuation = false): void {
    this.acc.reset(now);
    this.nudge.reset();
    this.signals.beginTurn(continuation);
    this.deps.budget?.activate(missionLabels);
  }

  /**
   * A new USER message arrived — the verdict on the previous turn. Dispatch
   * the detached outcome review (engine.reviewTurn: trivial pre-filter, one
   * cheap LLM classification, turn_outcomes row + downstream evolution).
   * Backends call this at user-turn start; programmatic turns must not.
   *
   * The previous turn may have been completed by an earlier process — that is
   * the whole point of the durable window: in headless usage the follow-up IS
   * the next `proteus exec` invocation's prompt.
   */
  observeUserTurn(userText: string): void {
    const previous = this.window.takePendingReview();
    if (!previous) return;
    this.detach(this.deps.engine.reviewTurn(previous, userText), 'Turn review');
  }

  /**
   * Buffer the turn in the durable window, fire session evolution when the
   * window reaches the interval, and review programmatic turns immediately.
   * All detached — never blocks the loop. Does NOT drain events (the backend
   * calls drainPendingEvents() separately so it controls ordering vs its own
   * platform-specific post-turn work).
   *
   * Turn-level evolution is outcome-driven: a user-origin turn waits for the
   * user's next message to grade it; a programmatic turn has no user verdict
   * coming, so it reviews immediately.
   */
  recordTurn(turn: CompletedTurn): void {
    const startedAt = this.window.startedAt() ?? Date.now();
    this.window.append(turn);
    if (this.window.size() >= this.reflectionInterval) {
      const turns = this.window.close();
      if (turns.length > 0) {
        this.detach(this.deps.engine.onSessionComplete({
          sessionId: `sess-${nanoid()}`, turns, startedAt, endedAt: Date.now(),
        }), 'Session evolution');
      }
    }
    if (turn.origin === 'programmatic') {
      this.detach(this.deps.engine.reviewTurn(turn, null), 'Turn review');
    }
  }

  /**
   * Wait for the evolution this instance dispatched. Evolution makes LLM calls
   * that outlive a turn, so a process that is about to exit (`proteus exec`,
   * a chat session closing) must wait or the work is simply killed — which is
   * what made headless runs produce no evolution at all.
   *
   * The window itself needs no flushing: it is durable, so a partial window
   * carries over to the next run instead of being force-closed as a session.
   */
  async settleEvolution(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /**
   * Register post-turn evolution work the backend owns but this orchestrator
   * must still join — the sampled scaffold shadow eval is the one case. It is
   * detached like the rest (never blocks the loop) and is awaited by
   * settleEvolution, so a process that exits right after a turn does not kill
   * the evaluation that would have resolved a pending scaffold.
   */
  track(work: Promise<void>, label: string): void {
    this.detach(work, label);
  }

  private detach(work: Promise<void>, label: string): void {
    const tracked = work
      .catch((err) => console.error(`[proteus] ${label} failed:`, err))
      .then(() => { this.inFlight.delete(tracked); });
    this.inFlight.add(tracked);
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
        console.warn('[proteus] event unbind failed:', id, err instanceof Error ? err.message : err);
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
      console.warn('[proteus] drainPendingEvents (select) failed:', (err as Error).message);
      return;
    }
    const ids = batch.ids;
    const outcome = await this.signals.deliver({
      kind: 'event_drain',
      text: batch.text,
      stepText: batch.midTurnText,
      timing: 'now',
      replyTurnId: turnId,
      // The mission scope the woken turn spends under — the link between a
      // schedule that declared a budget and the ledger its turn debits.
      ...(batch.missions.length > 0
        ? { metadata: { [MISSION_LABELS_METADATA_KEY]: batch.missions } }
        : {}),
      compensate: () => this.returnEventsToPending(ids),
    });
    if (outcome === 'mid-turn') {
      this.deps.host.broadcast({ type: 'background_event_injected', turnId, events: ids.length });
    }
  }

  /** Convenience for backends that don't need to interleave: cadence + drain. */
  async completeTurn(turn: CompletedTurn): Promise<void> {
    this.recordTurn(turn);
    await this.drainPendingEvents();
  }
}
