// The message contract — what a producer states when it wants to reach the
// agent, and what it learns about the outcome. Pure types, so a producer (the
// background-job runner, the overflow-recovery policy, a backend RPC) depends
// on the vocabulary without pulling in the delivery machinery.
//
// The mechanism lives in orchestrator/inbox.ts (Inbox), which is the only
// implementation and the only caller of BackendHost.enqueueTurn /
// turnInFlight.
//
// There is ONE delivery time: the agent's next step. A producer never states
// it and never picks a mechanism — starting a turn is simply what "next step"
// means when no turn is running.

import type { AdvisorSeverity } from './advisor';
import type { PromptFile } from './backend-host';
import type { WorkMode } from './turn';
import type { JsonObject } from '../utils/json';

/** The user's own message, sent as the user kind of signal. */
export interface UserSignalIdentity {
  /** Stable id assigned when the message is ACCEPTED (the client's message id on
   *  the raw-chat path). Rides steer_status broadcasts and the durable user row. */
  readonly id: string;
  readonly files?: readonly PromptFile[];
  /** The composer's mode — a fact the message carries, which rides a
   *  user-origin turn as `kinuMode`. Never a reason to refuse the splice: the
   *  user's words always land in the running turn. */
  readonly mode: WorkMode;
}

/** The `kind` of a signal carrying the user's own words. */
export const USER_MESSAGE_SIGNAL_KIND = 'user_message';

/** Why a queued signal never became a turn: 'preempted' = a newer turn
 *  generation won the queue slot; 'failed' = the platform enqueue threw. */
export type SignalUndeliveredReason = 'preempted' | 'failed';

/** What actually happened to a sent message. 'mid-turn': it rides the next
 *  step of a turn that already exists. 'queued': it started a turn of its own.
 *  'yielded': the turn the signal was offered reached its slot after an
 *  operator message was already admitted — the offer was withdrawn and that
 *  message is the turn now. */
export type SendOutcome = 'mid-turn' | 'queued' | 'undelivered' | 'yielded';

/** Where a user-facing entry put the user's message, as a surface hears it:
 *  spliced into the running turn, or run as a turn of its own. */
export type SendLanding = 'mid-turn' | 'turn';

/** One asynchronous nudge at the agent: an event-hub drain, a settled
 *  background job, an overflow retry, a take pick, an MCP task, the turn's own
 *  mechanical steer. */
export interface AgentSignal {
  /** The `kinuEvent` name. It is the queued turn's provenance (run
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
  /** Extra metadata stamped on the queued turn alongside `kinuEvent`. */
  readonly metadata?: Readonly<JsonObject> | undefined;
  /**
   * The turn is a move offered to an agent nobody has spoken to, not an event
   * it must hear. Set by the producer; forwarded to the host, which checks it
   * inside the turn's slot and yields to an admitted operator message.
   */
  readonly yieldsToUserMessage?: boolean | undefined;
  /**
   * How strongly the producer asks this to be weighed, when it has an opinion.
   * Judging and rendering only: delivery never routes on it — when the agent
   * hears a note is a question for turn state alone, not for how strongly the
   * note is meant.
   */
  readonly severity?: AdvisorSeverity | undefined;
  /**
   * Stable identity for the FACT this signal announces, when the producer has
   * one. Forwarded to `BackendHost.enqueueTurn` as its `idempotencyKey`, which
   * gives the queued turn a derived, stable message id — so a producer that is
   * at-least-once by construction (a start-of-life reconciliation that runs on
   * every cold activation) announces the same fact once however many times it
   * re-delivers, without holding a "have I already?" flag that the next
   * activation cannot see.
   *
   * Keyed on the fact, never on the attempt: two deliveries that mean the same
   * thing must collide. A producer whose transition is already idempotent (it
   * settles its own rows first and delivers nothing on a second pass) needs
   * none, and omitting it keeps a genuinely new fact from colliding with an
   * older one.
   */
  readonly idempotencyKey?: string;
  /** Put the work back where a later drain can pick it up — called when the
   *  queued turn was pre-empted or the enqueue threw. Never called for a
   *  signal that reached a step boundary. */
  readonly compensate?: (reason: SignalUndeliveredReason) => void;
  /** Set: this signal IS the user's own words. It lands in the running turn's
   *  next step, or, when none is running, becomes its own user-origin turn
   *  rather than an event card. Its `kind` is {@link USER_MESSAGE_SIGNAL_KIND}. */
  readonly user?: UserSignalIdentity;
}

/** The inbox as producers depend on it — structural, so nothing but the verb
 *  crosses into a producer's module. */
export interface AgentInbox {
  send(signal: AgentSignal): Promise<SendOutcome>;
}

export interface SettledSignals {
  /** Signals the model actually saw at a step boundary. The backend dispatches
   *  this turn's answer to the reply channels of those carrying a
   *  `replyTurnId`. */
  readonly absorbed: readonly AgentSignal[];
}

/** The turn-metadata key carrying a signal's card identity into the durable
 *  message a queued signal becomes — the round trip that lets the turn tell
 *  the inbox which card it is showing (see Inbox.beginTurn). */
export const SIGNAL_ID_METADATA_KEY = 'signalId';

/** Where a signal is on its way to the agent. Delivery opens the card
 *  ('pending' — it happened, the agent has not read it yet); the step that
 *  actually receives it moves the SAME card to 'shown'; a delivery that never
 *  landed ends at 'undelivered' and the card goes away (the work is
 *  compensated back and a later delivery opens a new one). */
export type SignalCardState = 'pending' | 'shown' | 'undelivered';

/**
 * The chat card for one signal, at each moment its state changes.
 *
 * Broadcast by the inbox and by nothing else, so the card cannot claim
 * the agent saw something it did not: 'pending' is emitted where the signal is
 * routed, 'shown' where the step (or the turn the signal started) actually
 * takes it in.
 *
 * The opening event carries what a surface needs to render it — `metadata` is
 * the SAME `kinuEvent` shape a queued signal's durable message is stamped
 * with, so one classifier serves both the live card and the message it becomes.
 * Later events are pure transitions on the same `id`.
 */
export type SignalCardEvent =
  | {
    readonly type: 'signal_card';
    readonly id: string;
    readonly state: 'pending';
    /** Turn metadata: `kinuEvent` + the producer's own. */
    readonly metadata: Readonly<JsonObject>;
    /** The signal exactly as this delivery will present it to the model. */
    readonly text: string;
  }
  | {
    readonly type: 'signal_card';
    readonly id: string;
    readonly state: 'shown' | 'undelivered';
  };
