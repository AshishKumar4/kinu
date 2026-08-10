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
// to wait for. Two lanes, with different answers:
//
//   TURN LANE — the outcome review (classifier → reflection/extraction/lesson)
//     and the sampled scaffold shadow eval. Seconds to ~a minute, and the
//     shadow eval is what resolves a pending scaffold, so it must not be
//     killed. `settleEvolution()` JOINS this lane, bounded by
//     `settleTimeoutMs` (default DEFAULT_SETTLE_TIMEOUT_MS); whatever is still
//     running when the bound expires is LOGGED by label and abandoned, never
//     silently waited on forever.
//
//   CADENCE LANE — the whole session/lifetime chain (session reflection →
//     scaffold proposal → replay eval → craft consolidation → lifetime MCTS).
//     Minutes to tens of minutes. `settleEvolution()` does NOT join it. It is
//     only ever STARTED by a host that can afford to finish it: a long-lived
//     CLI session, the Durable Object (which holds itself open with keepAlive),
//     or the local scheduler daemon. A `oneShot` host — one `proteus exec`
//     process per task — never starts it at all, so it can never land on that
//     process's wall clock.
//
// What makes deferral safe is that the session window is DURABLE and is now
// closed only AFTER the pass it fed settles (`SessionWindowStore.claim`). A
// process that dies mid-pass leaves its turns in the window, and the next host
// that can afford the work picks up the same turns. Nothing is lost by not
// waiting — which is exactly what the durable window is for.

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

/**
 * Whether an arriving user message is a genuine conversational follow-up —
 * the user read the previous answer and then replied — or an independent task
 * invocation that merely happens to be the next thing this workspace saw.
 *
 * `proteus exec` / `proteus run` are one process per task: the process that
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
 *  window is measured against when a host states no interval of its own. */
export const DEFAULT_SESSION_REFLECTION_INTERVAL = 5;

/** How long `settleEvolution` waits for the turn lane before it gives up and
 *  says what it dropped. Sized for the worst honest turn-level case: one
 *  sampled shadow rollout (its own ≤60s cap) plus its two judge calls. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 120_000;

export interface AgentOrchestratorDeps {
  host: BackendHost;
  engine: EvolutionEngine;
  eventLog: EventLog;
  /** Per-turn accounting side-effects (activity log, durable run-event recorder). */
  sinks?: TurnSinks;
  /** The actor's mission budget governor. Absent = this backend wires no
   *  governor at all; present-but-unscoped is the normal uncapped turn. */
  budget?: MissionGovernor;
  /** Turns between session-level reflections (default
   *  DEFAULT_SESSION_REFLECTION_INTERVAL). */
  sessionReflectionInterval?: number;
  /** This host runs ONE task turn and exits (`proteus exec` / `proteus run`),
   *  so it cannot finish the cadence lane and never STARTS it — see the exit
   *  contract above. Its window stays open and the local scheduler daemon runs
   *  the pass. Purely about what this PROCESS can afford; whether a turn can be
   *  graded from a follow-up is a separate, per-turn question (TurnContinuity),
   *  because the Durable Object can afford the pass for a one-shot request. */
  oneShot?: boolean;
  /** Turn-lane join bound (default DEFAULT_SETTLE_TIMEOUT_MS). */
  settleTimeoutMs?: number;
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
  /** TURN LANE: turn-level evolution this instance dispatched and has not yet
   *  settled, by label. Detached so it never blocks a turn; tracked so a
   *  process about to exit can wait for it under a bound (settleEvolution). */
  private readonly inFlight = new Map<Promise<void>, string>();
  /** CADENCE LANE: the session-evolution pass this instance is running, or
   *  null. At most one at a time — a second would re-run the same window. */
  private sessionEvolution: Promise<void> | null = null;
  private readonly settleTimeoutMs: number;

  constructor(private readonly deps: AgentOrchestratorDeps) {
    this.acc = new TurnAccumulator(deps.sinks, deps.budget);
    this.signals = new SignalDelivery(deps.host, (e, d) => deps.sinks?.logActivity?.(e, d));
    this.reflectionInterval = deps.sessionReflectionInterval ?? DEFAULT_SESSION_REFLECTION_INTERVAL;
    this.settleTimeoutMs = deps.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
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

  /** Turns buffered in the open evolution window — the turn index stamped on
   *  run events. Zero while auto-evolution is off: nothing is buffered then,
   *  because a turn that feeds no evolution leaves no evolution state. */
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
    if (!this.deps.engine.enabled) return;
    const previous = this.window.takePendingReview();
    if (!previous) return;
    const followup = continuity === 'conversation' ? userText : null;
    this.detach(this.deps.engine.reviewTurn(previous, followup), 'Turn review');
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
   *     `proteus exec` invocation is a different task written by a caller who
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
    if (!this.deps.engine.enabled) return;
    const awaitsFollowup = turn.origin !== 'programmatic' && continuity === 'conversation';
    this.window.append(turn, { awaitsFollowup });
    if (!awaitsFollowup) {
      this.detach(this.deps.engine.reviewTurn(turn, null), 'Turn review');
    }
    // A one-shot host is about to exit — it must not open work it cannot
    // finish. The window keeps the turns; the daemon runs the pass.
    if (!this.deps.oneShot) void this.runDueSessionEvolution();
  }

  /**
   * The CADENCE LANE: run the session/lifetime evolution chain when the
   * durable window has reached the interval, and close the window only once
   * that chain has settled — so a host that dies mid-pass carries the same
   * turns forward instead of consuming them for nothing.
   *
   * Returns the running pass (resolved when nothing is due), so the hosts that
   * OWN this work — the Durable Object under keepAlive and the local scheduler
   * daemon — can await it. `recordTurn` ignores the result: the pass runs
   * alongside the live conversation, never in front of it. Never rejects.
   */
  runDueSessionEvolution(): Promise<void> {
    if (!this.deps.engine.enabled) return Promise.resolve();
    if (this.sessionEvolution) return this.sessionEvolution;
    if (this.window.size() < this.reflectionInterval) return Promise.resolve();
    const claimed = this.window.claim();
    if (!claimed) return Promise.resolve();
    const pass = this.deps.engine
      .onSessionComplete({
        sessionId: `sess-${nanoid()}`,
        turns: claimed.turns,
        startedAt: claimed.startedAt,
        endedAt: Date.now(),
      })
      .catch((err) => { console.error('[proteus] Session evolution failed:', err); })
      // Settled either way: retrying the same window forever on a persistent
      // failure would be a livelock, and every step of the chain already
      // absorbs its own errors. Carry-forward is for a host that DIED, which
      // never reaches here at all.
      .then(() => { claimed.settle(); })
      .finally(() => { this.sessionEvolution = null; });
    this.sessionEvolution = pass;
    return pass;
  }

  /**
   * Wait for the TURN LANE this instance dispatched — the outcome review and
   * the sampled shadow eval — under `settleTimeoutMs`. Evolution makes LLM
   * calls that outlive a turn, so a process about to exit must wait or the
   * work is simply killed, which is what made headless runs produce no
   * evolution at all. But waiting without a bound is how one exec invocation
   * came to own a whole lifetime cycle's wall clock, so the bound is real and
   * what it abandons is logged by name rather than silently dropped.
   *
   * The cadence lane is deliberately NOT joined here (see the exit contract in
   * the module header). Neither window needs flushing: both are durable.
   */
  async settleEvolution(): Promise<void> {
    const deadline = Date.now() + this.settleTimeoutMs;
    while (this.inFlight.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const abandoned = [...new Set(this.inFlight.values())].join(', ');
        console.warn(
          `[proteus] evolution settle gave up after ${this.settleTimeoutMs}ms; ` +
          `still running, abandoned: ${abandoned}`,
        );
        return;
      }
      await this.raceInFlight(remaining);
    }
  }

  /** Resolve when every currently-tracked turn-lane promise settles, or when
   *  `ms` elapses — whichever first. The timer is always cleared, so a losing
   *  race leaves nothing pending on the platform. */
  private async raceInFlight(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.inFlight.keys()]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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
      .catch((err) => console.error(`[proteus] ${label} failed:`, err))
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
  async completeTurn(turn: CompletedTurn, continuity: TurnContinuity): Promise<void> {
    this.recordTurn(turn, continuity);
    await this.drainPendingEvents();
  }
}
