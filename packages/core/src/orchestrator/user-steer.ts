/**
 * The user steer-drain — the ONE path a message the user types while a turn is
 * running takes to reach the model.
 *
 * A user steer is deliberately NOT an {@link SignalDelivery} signal, and the
 * difference is the whole reason this class exists rather than a second call
 * into that seam. A signal is never persisted and re-delivers as a turn of its
 * own; a user steer has three properties a signal must not have:
 *
 *   1. it persists as a VERBATIM user row, because the walk-back fork cuts the
 *      conversation at a user message and a steer the model acted on is one;
 *   2. an interrupt HANDS IT BACK to the composer rather than eating it — the
 *      surface already rendered it as sent, so losing it silently is the one
 *      outcome that cannot be explained to the person who typed it;
 *   3. anything left over when the turn ends reruns as a USER-origin turn, not
 *      as a programmatic one, so it is the user's next turn and reads that way
 *      in the transcript and in every provenance decision downstream.
 *
 * Everything buffered drains at the next step boundary as ONE merged user
 * message appended after the latest tool results — Anthropic groups tool+user
 * into a single turn, so role alternation stays provider-safe. The splice
 * coordinate math is the shared {@link StepInjections} both backends' step
 * pipelines already run on.
 */

import type { ModelMessage } from 'ai';
import type { PrepareStepContext } from '../extension';
import { StepInjections } from '../prompting/step-injections';
import type { PromptFile } from '../types/backend-host';

/** One thing the user typed mid-turn, with any attachments it carried. */
export interface UserSteer {
  readonly text: string;
  readonly files?: ReadonlyArray<PromptFile>;
  /** Stable identity assigned when the steer is ACCEPTED, so the "queued" and
   *  "landed" announcements are the same object to a surface, and the durable
   *  user row can carry it too. Absent on surfaces that render steers locally
   *  (the TUI) rather than from broadcasts. */
  readonly id?: string;
}

/**
 * Where a message the user typed actually landed. The surface MUST say which:
 * "it went into the running turn" and "it started a new turn" are different
 * events with different consequences, and silence about which one happened is
 * the failure this type exists to prevent.
 */
export type UserSteerOutcome =
  /** Buffered for the running turn's next step boundary. */
  | 'mid-turn'
  /** No turn was running — the caller must send it as an ordinary turn. */
  | 'idle';

/** What the drain recorded for one step boundary: the merged message the model
 *  saw plus the verbatim texts that composed it (the persistence payload). */
interface DrainedSteers {
  readonly message: ModelMessage;
  readonly texts: readonly string[];
}

export interface UserSteerDrainDeps {
  /** Whether a turn exists for a steer to land on. Read synchronously, in the
   *  same tick as the buffer push, so the turn observed is the turn whose
   *  `prepareStep` drains it. */
  readonly turnInFlight: () => boolean;
  /** Fired with the steers of a drain that actually happened — the moment they
   *  stop being "queued" and become something the model has. A backend uses it
   *  to persist the verbatim user rows and to tell every open surface they
   *  landed. Never fired for an empty drain. */
  readonly onDrain?: (steers: readonly UserSteer[]) => void;
}

export class UserSteerDrain {
  private pending: UserSteer[] = [];
  private readonly injections = new StepInjections<DrainedSteers>();

  constructor(private readonly deps: UserSteerDrainDeps) {}

  /**
   * Accept a message typed while a turn runs. `'idle'` means nothing was
   * buffered and the caller owns the text — send it as a normal turn.
   */
  accept(steer: UserSteer): UserSteerOutcome {
    if (!this.deps.turnInFlight()) return 'idle';
    this.pending.push(steer);
    return 'mid-turn';
  }

  /** How many steers are waiting for a step boundary. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Start of a turn: the previous turn's splice coordinates mean nothing to
   *  this one. Pending steers survive — they were typed for the turn that is
   *  about to run. */
  beginTurn(): void {
    this.injections.reset();
  }

  /** The `prepareStep` body: everything buffered becomes ONE user message at
   *  this step's tail, re-applied at that index for the rest of the turn. */
  prepareStep(ctx: PrepareStepContext): ModelMessage[] | undefined {
    const drained = this.pending.splice(0);
    if (drained.length === 0) return this.injections.drain(ctx, []);
    const rewritten = this.injections.drain(ctx, [{
      message: steerUserMessage(drained), texts: drained.map((steer) => steer.text),
    }]);
    this.deps.onDrain?.(drained);
    return rewritten;
  }

  /** The verbatim texts the model actually saw this turn, in drain order —
   *  the rows a backend persists so the walk-back fork can cut at them. */
  drainedTexts(): string[] {
    return this.injections.recorded.flatMap((entry) => entry.texts);
  }

  /** The spliced conversation as durable history: the turn's response messages
   *  with each drained steer back at the position the model saw it. */
  replayInto(responseMessages: ReadonlyArray<ModelMessage>): ModelMessage[] {
    return this.injections.replayInto(responseMessages);
  }

  /** The merged messages themselves, for a backend whose failure path appends
   *  them without a response array to replay into. */
  recordedMessages(): ModelMessage[] {
    return this.injections.recorded.map((entry) => entry.message);
  }

  /**
   * Interrupt: drop what never reached the model and RETURN it. An interrupt
   * means "stop", not "stop and then do what I typed" — but it comes back so
   * the surface can restore it to the composer instead of losing it.
   */
  interrupt(): UserSteer[] {
    return this.pending.splice(0);
  }

  /**
   * Turn over: take whatever never saw a step boundary (the model was already
   * writing its final answer). The caller reruns it as the IMMEDIATE next
   * USER-origin turn.
   */
  takeLeftover(): UserSteer[] {
    return this.pending.splice(0);
  }
}

/** Merge steers into ONE user ModelMessage — text joined in arrival order,
 *  attachments carried as file parts (the runChat user-message shape). */
export function steerUserMessage(drained: ReadonlyArray<UserSteer>): ModelMessage {
  const text = drained.map((steer) => steer.text).join('\n\n');
  const files = drained.flatMap((steer) => steer.files ?? []);
  if (files.length === 0) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      ...files.map((f) => ({ type: 'file' as const, data: f.url, mediaType: f.mediaType, filename: f.filename })),
      { type: 'text' as const, text },
    ],
  };
}

/** The progress event both backends broadcast for a user steer, so every open
 *  surface shows the same thing: the text was accepted, then the model saw it,
 *  or an interrupt handed it back. Compatible with BroadcastEvent's
 *  `{ type: string; … }` shape. */
export type SteerStatusEvent =
  /** Buffered — it lands at the running turn's next step boundary. */
  | { type: 'steer_status'; status: 'queued'; steerId: string; text: string }
  /** The model has it: it was spliced into the step that just started. */
  | { type: 'steer_status'; status: 'landed'; steerId: string; text: string }
  /** An interrupt dropped it before the model saw it — the composer takes it
   *  back. */
  | { type: 'steer_status'; status: 'returned'; steerId: string; text: string };
