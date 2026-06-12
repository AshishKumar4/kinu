// AgentOrchestrator — the backend-agnostic per-turn agent logic both backends
// share. It owns the per-turn accounting (TurnAccumulator), the session-level
// evolution cadence, and the event→turn reactor — parameterized over the
// EvolutionEngine + EventLog (from AgentRuntime's storage) and a BackendHost.
//
// The cf-backend OrchestratorAgent (a @cloudflare/think subclass) and the local
// cli-backend both delegate their loop hooks here. Platform transport (Think's
// private TurnQueue / the CLI's local loop), durable fibers, and the @callable
// control plane stay on each backend; this owns the LOGIC.

import { TurnAccumulator, type TurnSinks } from './turn-accumulator.js';
import { buildDrainBatch } from '../events/hub/drain.js';
import type { EventLog } from '../events/hub/log.js';
import type { BackendHost } from '../types/backend-host.js';
import type { EvolutionEngine } from '../evolution/engine.js';
import type { CompletedTurn, CompletedSession } from '../evolution/types.js';
import { nanoid } from '../utils/nanoid.js';

export interface AgentOrchestratorDeps {
  host: BackendHost;
  engine: EvolutionEngine;
  eventLog: EventLog;
  /** Per-turn accounting side-effects (activity log, durable run-event recorder). */
  sinks?: TurnSinks;
  /** Turns between session-level reflections (default 5). */
  sessionReflectionInterval?: number;
}

export class AgentOrchestrator {
  /** Per-turn accounting — tool calls, steps, token usage, errors. */
  readonly acc: TurnAccumulator;
  private readonly reflectionInterval: number;
  private sessionTurnCount = 0;
  private sessionTurns: CompletedTurn[] = [];
  private sessionStartedAt = Date.now();
  /** The last completed user-origin turn, awaiting its outcome review — the
   *  next user message grades it (engine.reviewTurn); a session flush grades
   *  it as abandoned. */
  private pendingReview: CompletedTurn | null = null;

  constructor(private readonly deps: AgentOrchestratorDeps) {
    this.acc = new TurnAccumulator(deps.sinks);
    this.reflectionInterval = deps.sessionReflectionInterval ?? 5;
  }

  /** Completed turns in the current session — the turn index for run events. */
  get sessionTurnIndex(): number {
    return this.sessionTurnCount;
  }

  /** Reset per-turn accounting at the start of a turn. */
  beginTurn(now: number): void {
    this.acc.reset(now);
  }

  /**
   * A new USER message arrived — the verdict on the previous turn. Dispatch
   * the detached outcome review (engine.reviewTurn: trivial pre-filter, one
   * cheap LLM classification, turn_outcomes row + downstream evolution).
   * Backends call this at user-turn start; programmatic turns must not.
   */
  observeUserTurn(userText: string): void {
    const previous = this.pendingReview;
    if (!previous) return;
    this.pendingReview = null;
    this.deps.engine.reviewTurnDetached(previous, userText);
  }

  /**
   * Advance the session-reflection cadence + fire turn/session evolution. All
   * fire-and-forget — never blocks the loop. Does NOT drain events (the backend
   * calls drainPendingEvents() separately so it controls ordering vs its own
   * platform-specific post-turn work).
   *
   * Turn-level evolution is outcome-driven: a user-origin turn waits for the
   * user's follow-up (observeUserTurn) or the session flush (abandoned); a
   * programmatic turn has no user verdict coming, so it reviews immediately.
   */
  recordTurn(turn: CompletedTurn): void {
    this.sessionTurnCount++;
    this.sessionTurns.push(turn);
    if (this.sessionTurnCount >= this.reflectionInterval) {
      const sessionData = this.snapshotSession();
      if (sessionData) {
        void this.deps.engine.onSessionComplete(sessionData).catch((err) =>
          console.error('[proteus] Session evolution failed:', err));
      }
    }
    if (turn.origin === 'programmatic') this.deps.engine.reviewTurnDetached(turn, null);
    else this.pendingReview = turn;
  }

  /**
   * Flush a partial session (fewer than N turns) — review the still-pending
   * last turn as abandoned (the session ended with no follow-up), then fire
   * session evolution on the buffered turns and reset, AWAITING the
   * reflection. For backends with an explicit session end (the CLI on exit);
   * the always-on DO rolls over via the N-turn cadence in recordTurn instead.
   */
  async flushSession(): Promise<void> {
    const pending = this.pendingReview;
    this.pendingReview = null;
    if (pending) {
      try {
        await this.deps.engine.reviewTurn(pending, null);
      } catch (err) {
        console.error('[proteus] Turn review failed at flush:', err);
      }
    }
    const sessionData = this.snapshotSession();
    if (!sessionData) return;
    try {
      await this.deps.engine.onSessionComplete(sessionData);
    } catch (err) {
      console.error('[proteus] Session evolution failed:', err);
    }
  }

  /** Snapshot + reset the current session window. Returns null when empty. */
  private snapshotSession(): CompletedSession | null {
    if (this.sessionTurns.length === 0) return null;
    const data: CompletedSession = {
      sessionId: `sess-${nanoid()}`,
      turns: [...this.sessionTurns],
      startedAt: this.sessionStartedAt,
      endedAt: Date.now(),
    };
    this.sessionTurnCount = 0;
    this.sessionTurns = [];
    this.sessionStartedAt = Date.now();
    return data;
  }

  /**
   * The reactor: bind the selected pending events to a synthetic turn
   * (markConsumed — synchronous, so atomic w.r.t. the event loop; a concurrent
   * drain sees them already consumed) then inject them as ONE programmatic turn
   * via host.enqueueTurn. The injected turn's own post-turn drain re-checks, so
   * this self-terminates once the external backlog is empty. No-op when none.
   */
  async drainPendingEvents(): Promise<void> {
    let batch: ReturnType<typeof buildDrainBatch>;
    try {
      const pending = this.deps.eventLog.pending({ resolve_deferred: { now: Date.now(), phase: 'idle' } });
      batch = buildDrainBatch(pending);
      if (!batch) return;
      const turnId = `evt-${nanoid()}`;
      for (const id of batch.ids) this.deps.eventLog.markConsumed(id, turnId, 0);
    } catch (err) {
      console.warn('[proteus] drainPendingEvents (select) failed:', (err as Error).message);
      return;
    }
    try {
      await this.deps.host.enqueueTurn({ text: batch.text });
    } catch (err) {
      console.warn('[proteus] drainPendingEvents (turn) failed:', (err as Error).message);
    }
  }

  /** Convenience for backends that don't need to interleave: cadence + drain. */
  async completeTurn(turn: CompletedTurn): Promise<void> {
    this.recordTurn(turn);
    await this.drainPendingEvents();
  }
}
