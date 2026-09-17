/**
 * ONE way for a suite to run a turn on the hosted root and read what it did.
 *
 * Every suite that fabricates a turn's state — a checkpoint declared here, a
 * flag set there, a hook called by name — is coupled to the loop that happens
 * to run the turn. This seam names the two things those suites actually assert
 * on, and nothing about how a turn is driven:
 *
 *   `prepare`  — admit an input and answer with what the loop was about to
 *                send the model: the request messages, the system prompt, the
 *                model, the tools. The turn then settles with a scripted answer.
 *   `settle`   — run a turn whose scripted answer is the given message, so the
 *                loop persists and settles it exactly as production would; the
 *                ledgers a suite reads afterwards are the loop's own writes.
 *
 * One driver implements it: `chatSessionTurns` (in actor-harness, beside the
 * bridges it composes) drives core's ChatSession, the loop the root runs on.
 * A suite on this seam keeps its assertions and names nothing about how the
 * turn is driven — which is what let the Think switch swap the driver under
 * every suite at once with none of them noticing.
 */
import type { LanguageModel, ModelMessage, ToolSet, UIMessage } from 'ai';
import type { SessionMessage } from 'agents/experimental/memory/session';
import type { ChatResponseResult, TurnConfig } from '@cloudflare/think';
import type { JsonObject } from '@kinu.run/core';

/** What the loop was about to send the model for one admitted turn. */
export interface PreparedRequest {
  /** The ids the loop gave the admitted turn. */
  readonly identity: SettledTurn;
  /** The conversation the turn was assembled over, as the loop was handed it. */
  readonly messages: readonly ModelMessage[];
  /** What the model was actually called with at the first step — the
   *  history plus what the step pipeline spliced in. */
  readonly prompt: readonly ModelMessage[];
  readonly system: string | undefined;
  readonly model: LanguageModel | string | undefined;
  readonly tools: ToolSet;
  readonly activeTools: readonly string[] | undefined;
  readonly providerOptions: TurnConfig['providerOptions'];
}

/** The answer a turn settles with, as the suite scripts it. */
export interface ScriptedAnswer {
  readonly messageId: string;
  readonly text?: string;
  readonly parts?: UIMessage['parts'];
  readonly status?: ChatResponseResult['status'];
  readonly error?: string;
  readonly requestId?: string;
  readonly continuation?: boolean;
  /** The user message this answer is for, when the suite needs one on disk
   *  first (the loop's own admission writes it in production). */
  readonly turnId?: string;
  /** A stored row the converter REFUSES — the one reason to say a role the
   *  SDK's own type forbids. Production never writes one; recovery can meet
   *  one, and the suite that pins that arm needs it. */
  readonly unreadableRole?: 'tool';
  /** How the model's step ended: `length` is an answer the provider cut at
   *  its output limit, which the loop continues once and the roster then
   *  reads off the last step. Stop by default. */
  readonly finishReason?: 'stop' | 'length';
  /** The answer row cannot be written: the commit fails, so the turn leaves no
   *  durable answer, and the settle rejects with that failure. */
  readonly persistFails?: true;
}

/** How a suite admits a turn: the conversation as the loop sees it, the raw
 *  tool surface, and the request body (cwd, tier, oneShot ride on it). */
export interface TurnInput {
  readonly messages: readonly ModelMessage[];
  readonly tools?: ToolSet;
  readonly body?: JsonObject;
  readonly continuation?: boolean;
  /** An admission a suite cuts short: the loop refuses a prepared turn whose
   *  signal is already aborted. */
  readonly signal?: AbortSignal;
}

/** The identity a settled turn's rows carry. */
export interface SettledTurn {
  readonly turnId: string;
  readonly messageId: string;
}

/** How a whole turn ended, as a suite reads it: the loop's verdict and the
 *  answer row it persisted, in the transcript store's own row shape. */
export interface RanTurn {
  readonly status: 'completed' | 'error' | 'aborted' | 'skipped';
  readonly message: SessionMessage | undefined;
}

export interface TurnHarness {
  /** Run one whole turn on the harness's model — admission, every step, the
   *  settle — and read how it ended. */
  run(text: string, options?: { readonly signal?: AbortSignal }): Promise<RanTurn>;
  /** Admit a programmatic turn behind everything queued, under the producer's
   *  own name for the fact it announces; it runs at the next drain. */
  enqueue(text: string, options?: { readonly id?: string; readonly idempotencyKey?: string; readonly metadata?: JsonObject }): Promise<void>;
  /** Run the programmatic turns admitted with `enqueue` that have not run
   *  yet — the durable queue an alarm drains in production. */
  drainEnqueued(): Promise<void>;
  /** Run the newest admitted message as its own turn — what a message that
   *  arrived while the loop was busy is owed once the loop is free. */
  runQueuedMessage(): Promise<void>;
  /** Admit a turn and read the request the loop assembled for it. */
  prepare(input: TurnInput): Promise<PreparedRequest>;
  /** Resume the loop on a fresh activation — the turn the last process died
   *  inside continues, the sends it acknowledged rerun — and read the request
   *  the first resumed turn was assembled with, parked at its model call. */
  resume(): Promise<PreparedRequest>;
  /** Park the NEXT turn, whoever admits it — a signal, a wake, the workspace's
   *  own first turn — at its model call, and hand back the request it was
   *  parked with. The suite settles it as it settles a prepared one. */
  park(): Promise<PreparedRequest>;
  /** The request the loop composes for step `stepNumber` of the prepared
   *  turn, over `messages` — the per-step weave (dynamic context, cache
   *  breakpoints, pruning) a suite pins on the array the model receives. */
  step(stepNumber: number, messages: readonly ModelMessage[]): Promise<readonly ModelMessage[]>;
  /** Settle a turn with a scripted answer, through the production spine, and
   *  answer the ids the loop gave it: the opening row's and the answer's —
   *  the keys every durable row of the turn is written under. */
  settle(answer: ScriptedAnswer): Promise<SettledTurn>;
  /** Name the durable turn the next settle belongs to — the identity the
   *  terminal transition claims against. */
  open(turnId: string): void;
  /** Name the turn AND run it: admitted under this id and parked at its
   *  model call, so a send routes into its next step rather than into a turn
   *  of its own, and a command the turn issues carries its id. Settled like
   *  any prepared turn. */
  openInFlight(turnId: string): Promise<void>;
}
