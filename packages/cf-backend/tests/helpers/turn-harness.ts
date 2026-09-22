/**
 * The one seam for running a turn on the hosted root and reading what it did; it names nothing about how the
 * turn is driven. Implemented by `chatSessionTurns` (actor-harness) over core's ChatSession.
 */
import type { LanguageModel, ModelMessage, ToolSet, UIMessage } from 'ai';
import type { SessionMessage } from 'agents/experimental/memory/session';
import type { ChatOptions, JsonObject } from '@kinu.run/core';

export interface PreparedRequest {
  readonly identity: SettledTurn;
  readonly messages: readonly ModelMessage[];
  /** What the model was called with at the first step: history plus step-pipeline splices. */
  readonly prompt: readonly ModelMessage[];
  readonly system: string | undefined;
  readonly model: LanguageModel | undefined;
  readonly tools: ToolSet;
  readonly activeTools: readonly string[] | undefined;
  readonly providerOptions: ChatOptions['providerOptions'];
}

export interface ScriptedAnswer {
  readonly messageId: string;
  readonly text?: string;
  readonly parts?: UIMessage['parts'];
  readonly status?: RanTurn['status'];
  readonly error?: string;
  readonly requestId?: string;
  readonly continuation?: boolean;
  /** The user message this answer is for, when it must exist on disk first. */
  readonly turnId?: string;
  /** `length` is a provider-cut answer, which the loop continues once. Stop by default. */
  readonly finishReason?: 'stop' | 'length';
  /** The answer commit fails, so the settle rejects with that failure. */
  readonly persistFails?: true;
}

/** Conversation, raw tool surface and request body (cwd, tier, oneShot). */
export interface TurnInput {
  readonly messages: readonly ModelMessage[];
  readonly tools?: ToolSet;
  readonly body?: JsonObject;
  readonly continuation?: boolean;
  /** The loop refuses a prepared turn whose signal is already aborted. */
  readonly signal?: AbortSignal;
}

export interface SettledTurn {
  readonly turnId: string;
  readonly messageId: string;
}

/** The loop's verdict and the persisted answer row, in the transcript store's shape. */
export interface RanTurn {
  readonly status: 'completed' | 'error' | 'aborted' | 'skipped';
  readonly message: SessionMessage | undefined;
}

export interface TurnHarness {
  /** Run one whole turn on the harness's model and read how it ended. */
  run(text: string, options?: { readonly signal?: AbortSignal }): Promise<RanTurn>;
  /** Admit a programmatic turn behind everything queued; it runs at the next drain. */
  enqueue(text: string, options?: { readonly id?: string; readonly idempotencyKey?: string; readonly metadata?: JsonObject }): Promise<void>;
  /** Run pending `enqueue` turns, as an alarm drains them in production. */
  drainEnqueued(): Promise<void>;
  /** Run the newest admitted message as its own turn, as owed once the loop is free. */
  runQueuedMessage(): Promise<void>;
  prepare(input: TurnInput): Promise<PreparedRequest>;
  /** Resume on a fresh activation and read the first resumed request, parked at its model call. */
  resume(): Promise<PreparedRequest>;
  /** Park the next turn, whoever admits it, at its model call and return its request. */
  park(): Promise<PreparedRequest>;
  /** The per-step request (dynamic context, cache breakpoints, pruning) for the prepared turn. */
  step(stepNumber: number, messages: readonly ModelMessage[]): Promise<readonly ModelMessage[]>;
  /** Settle through the production spine; answers the opening and answer row ids. */
  settle(answer: ScriptedAnswer): Promise<SettledTurn>;
  /** Name the durable turn the next settle belongs to. */
  open(turnId: string): void;
  /** Admit under this id and park at its model call, so sends route into its next step. */
  openInFlight(turnId: string): Promise<void>;
}
