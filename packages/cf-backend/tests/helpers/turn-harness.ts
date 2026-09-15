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
 * Two drivers implement it. `thinkTurns` (in actor-harness, beside the
 * bridges it composes) drives the SDK's hooks the way Think calls them today;
 * `chatSessionTurns` will drive core's ChatSession once the root runs on it. A
 * suite moved onto this seam keeps its assertions and changes only how the
 * turn is started — which is the whole point: the switch commit swaps the
 * driver under every suite at once and none of them notices.
 */
import type { LanguageModel, ModelMessage, ToolSet, UIMessage } from 'ai';
import type { SessionMessage } from 'agents/experimental/memory/session';
import type { ChatResponseResult, TurnConfig } from '@cloudflare/think';
import type { JsonObject } from '@kinu.run/core';

/** What the loop was about to send the model for one admitted turn. */
export interface PreparedRequest {
  readonly messages: readonly ModelMessage[];
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
  /** The request the loop composes for step `stepNumber` of the prepared
   *  turn, over `messages` — the per-step weave (dynamic context, cache
   *  breakpoints, pruning) a suite pins on the array the model receives. */
  step(stepNumber: number, messages: readonly ModelMessage[]): Promise<readonly ModelMessage[]>;
  /** Settle a turn with a scripted answer, through the production spine. */
  settle(answer: ScriptedAnswer): Promise<void>;
  /** Name the durable turn the next settle belongs to — the identity the
   *  terminal transition claims against. */
  open(turnId: string): void;
  /** Name the turn AND mark it running, so a send routes into its next step
   *  rather than into a turn of its own. */
  openInFlight(turnId: string): void;
}
