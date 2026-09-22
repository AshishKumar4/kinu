// The message contract producers use to reach the agent; delivery lives in orchestrator/inbox.ts.
// There is one delivery time, the agent's next step: producers never pick a mechanism.

import type { AdvisorSeverity } from './advisor';
import type { PromptFile } from './backend-host';
import type { WorkMode } from './turn';
import type { JsonObject } from '../utils/json';

export interface UserSignalIdentity {
  /** Assigned on accept (the client's message id on the raw-chat path). */
  readonly id: string;
  readonly files?: readonly PromptFile[];
  /** Rides the turn as `kinuMode`; never a reason to refuse the splice. */
  readonly mode: WorkMode;
}

export const USER_MESSAGE_SIGNAL_KIND = 'user_message';

/** 'preempted': a newer turn generation won the queue slot; 'failed': the enqueue threw. */
export type SignalUndeliveredReason = 'preempted' | 'failed';

/**
 * 'mid-turn': pending in an existing turn. 'queued': started its own turn. 'yielded': an operator
 * message was admitted first, so the offer was withdrawn.
 */
export type SendOutcome = 'mid-turn' | 'queued' | 'undelivered' | 'yielded';

export type SendLanding = 'mid-turn' | 'turn';

export interface AgentSignal {
  /** The `kinuEvent` name: the queued turn's provenance, rendered as an event card. */
  readonly kind: string;
  readonly text: string;
  /** Text when spliced into a live turn's next step. Defaults to `text`. */
  readonly stepText?: string;
  /** Synthetic turn id the source rows are bound to; routes the reply to their channels. */
  readonly replyTurnId?: string;
  readonly metadata?: Readonly<JsonObject> | undefined;
  /** An offered move, not an event: the host yields it to an admitted operator message. */
  readonly yieldsToUserMessage?: boolean | undefined;
  /** Judging and rendering only; delivery never routes on it. */
  readonly severity?: AdvisorSeverity | undefined;
  /**
   * Keyed on the announced fact, never the attempt; becomes the enqueue `idempotencyKey` so an
   * at-least-once producer announces a fact once.
   */
  readonly idempotencyKey?: string;
  /** Called when the queued turn was pre-empted or enqueue threw; never after a step saw it. */
  readonly compensate?: (reason: SignalUndeliveredReason) => void;
  /** Set when this signal is the user's own words; `kind` is {@link USER_MESSAGE_SIGNAL_KIND}. */
  readonly user?: UserSignalIdentity;
}

export interface AgentInbox {
  send(signal: AgentSignal): Promise<SendOutcome>;
}

export interface SettledSignals {
  /** Signals the model actually saw at a step boundary. */
  readonly absorbed: readonly AgentSignal[];
}

/** Turn-metadata key carrying a signal's card identity (see Inbox.beginTurn). */
export const SIGNAL_ID_METADATA_KEY = 'signalId';

export type SignalCardState = 'pending' | 'shown' | 'undelivered';

/**
 * Broadcast only by the inbox, so 'shown' is emitted only where a step actually takes the signal
 * in. The opening event's `metadata` is the same `kinuEvent` shape the durable message carries.
 */
export type SignalCardEvent =
  | {
    readonly type: 'signal_card';
    readonly id: string;
    readonly state: 'pending';
    readonly metadata: Readonly<JsonObject>;
    /** The signal exactly as this delivery presents it to the model. */
    readonly text: string;
  }
  | {
    readonly type: 'signal_card';
    readonly id: string;
    readonly state: 'shown' | 'undelivered';
  };
