// The signal contract — what an asynchronous producer states when it wants to
// reach the agent, and what it learns about the outcome. Pure types, so a
// producer (the background-job runner, the overflow-recovery policy, a backend
// RPC) depends on the vocabulary without pulling in the delivery machinery.
//
// The mechanism lives in orchestrator/signals.ts (SignalDelivery), which is the
// only implementation and the only caller of BackendHost.enqueueTurn /
// turnInFlight.
//
// There is ONE delivery time: the agent's next step. A producer never states
// it and never picks a mechanism — starting a turn is simply what "next step"
// means when no turn is running.

/** Why a queued signal never became a turn: 'preempted' = a newer turn
 *  generation won the queue slot; 'failed' = the platform enqueue threw. */
export type SignalUndeliveredReason = 'preempted' | 'failed';

/** What actually happened to a delivered signal. */
export type SignalOutcome = 'mid-turn' | 'queued' | 'undelivered';

/** One asynchronous nudge at the agent: an event-hub drain, a settled
 *  background job, an overflow retry, a take pick, an MCP task, the mechanical
 *  delegation nudge. */
export interface AgentSignal {
  /** The `proteusEvent` name. It is the queued turn's provenance (run
   *  `caused_by`), and what makes the chat render the turn as an event card
   *  rather than a user bubble. */
  readonly kind: string;
  /** The signal as a standalone programmatic turn. */
  readonly text: string;
  /** The signal spliced into a live turn's next step, when that reads
   *  differently ("arrived while you were working"). Defaults to `text`. */
  readonly stepText?: string;
  /** The synthetic turn id the signal's source rows are bound to. Stamped on
   *  the queued turn as `drainTurnId` and reported back on the absorbed signal,
   *  so the backend dispatches the answering turn's reply to their channels
   *  (email_thread → outbound reply) by one id whichever way it landed. */
  readonly replyTurnId?: string;
  /** Extra metadata stamped on the queued turn alongside `proteusEvent`. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Put the work back where a later drain can pick it up — called when the
   *  queued turn was pre-empted or the enqueue threw. Never called for a
   *  signal that reached a step boundary. */
  readonly compensate?: (reason: SignalUndeliveredReason) => void;
}

/** The delivery seam as producers depend on it — structural, so nothing but the
 *  verb crosses into a producer's module. */
export interface SignalDeliverer {
  deliver(signal: AgentSignal): Promise<SignalOutcome>;
}

export interface SettledSignals {
  /** Signals the model actually saw at a step boundary. The backend dispatches
   *  this turn's answer to the reply channels of those carrying a
   *  `replyTurnId`. */
  readonly absorbed: readonly AgentSignal[];
}
