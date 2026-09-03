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
import type { JsonObject } from '../utils/json';
import { nanoid } from '../utils/nanoid';

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
  /**
   * Persist a drain before the rewritten messages can reach the provider.
   *
   * A backend that stores queued steers uses this boundary to write their
   * durable conversation rows and retire the queue rows. Rejection aborts the
   * step; the drain restores the same steers to its pending prefix so a retry
   * cannot deliver words that persistence failed to record.
   *
   * `atStep` is the whole difference between a transcript that shows a steer
   * where the model read it and one that shows it after the turn: a turn is
   * ONE assistant message, so a row appended beside it can only sort before or
   * after the entire thing. The step index is the position inside it.
   */
  readonly onDrain?: (
    steers: readonly UserSteer[],
    atStep: number,
  ) => void | Promise<void>;
}

export class UserSteerDrain {
  private pending: UserSteer[] = [];
  /** The prefix currently crossing the durable drain boundary. It remains
   * queued until onDrain succeeds and the provider-visible injection exists. */
  private landing: UserSteer[] = [];
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

  /** Steers the model has not received yet, in their accepted order. A copy:
   * callers can observe or persist the queue but never mutate its authority. */
  pendingSteers(): readonly UserSteer[] {
    return [...this.landing, ...this.pending];
  }

  /** Replace process-local queue state from its durable authority on reset.
   * Only valid before a step drain is in flight or this turn has recorded an
   * injection — mixing two authorities would duplicate delivery. */
  restorePending(steers: readonly UserSteer[]): void {
    if (this.landing.length > 0 || this.injections.recorded.length > 0) {
      throw new Error('cannot restore pending steers after this turn started draining');
    }
    this.pending = [...steers];
  }

  /** How many steers have not reached the provider. */
  get pendingCount(): number {
    return this.landing.length + this.pending.length;
  }

  /** Start of a turn: the previous turn's splice coordinates mean nothing to
   *  this one. Pending steers survive — they were typed for the turn that is
   *  about to run. */
  beginTurn(): void {
    this.injections.reset();
  }

  /**
   * The `prepareStep` body: persist everything buffered, then admit it as ONE
   * user message at this step's tail and re-apply it there for later steps.
   * Persistence is awaited before the injection is recorded or returned, so
   * the provider can never see a steer whose durable landed row failed.
   */
  async prepareStep(ctx: PrepareStepContext): Promise<ModelMessage[] | undefined> {
    const drained = this.pending.splice(0);
    if (drained.length === 0) return this.injections.drain(ctx, []);
    this.landing = drained;
    return await this.persistDrain(ctx, drained);
  }

  private async persistDrain(
    ctx: PrepareStepContext,
    drained: UserSteer[],
  ): Promise<ModelMessage[] | undefined> {
    try {
      await this.deps.onDrain?.(drained, ctx.stepNumber);
      const rewritten = this.injections.drain(ctx, [{
        message: steerUserMessage(drained), texts: drained.map((steer) => steer.text),
      }]);
      this.landing = [];
      return rewritten;
    } catch (cause) {
      // New steers may arrive while persistence is awaited. The failed prefix
      // keeps its durable order ahead of them for the next step attempt.
      this.pending = [...drained, ...this.pending];
      this.landing = [];
      throw cause;
    }
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

/** Metadata on the durable row a landed steer becomes: that it WAS a steer, so
 *  the thread can say why a user bubble appears inside another turn's work. */
export const STEER_METADATA_KEY = 'kinuSteer';

/** The step index the steer was spliced into, on that same row — the durable
 *  half of what {@link SteerStatusEvent} carries live, so the position a
 *  reader sees during the turn is the position they see after a reload. */
export const STEER_STEP_METADATA_KEY = 'kinuSteerAtStep';

/** Where one steer is in its life, as a backend states it. */
export type SteerStatusDetail =
  /** Buffered — it lands at the running turn's next step boundary. */
  | { status: 'queued'; steerId: string; text: string }
  /** The model has it: it was spliced into the step `atStep` started. That
   *  index is what lets a surface draw the steer inside the assistant message
   *  the turn is still writing, rather than under it. */
  | { status: 'landed'; steerId: string; text: string; atStep: number }
  /** An interrupt dropped it before the model saw it — the composer takes it
   *  back. */
  | { status: 'returned'; steerId: string; text: string };

/** The progress event both backends broadcast for a user steer, so every open
 *  surface shows the same thing: the text was accepted, then the model saw it,
 *  or an interrupt handed it back. Compatible with BroadcastEvent's
 *  `{ type: string; … }` shape. */
export type SteerStatusEvent = SteerStatusDetail & { type: 'steer_status' };

/** One landed steer as a durable user row, before a backend writes it. */
export interface LandedSteerRow {
  readonly id: string;
  readonly text: string;
  readonly atStep: number;
  /** Both steer keys, always together — see {@link describeLandedSteers}. */
  readonly metadata: JsonObject;
}

/**
 * The durable rows one drain of landed steers becomes.
 *
 * Thin on purpose, and a seam anyway, because it holds two invariants that a
 * hand-written loop breaks silently:
 *
 * BOTH KEYS OR NEITHER. A row carrying {@link STEER_METADATA_KEY} without
 * {@link STEER_STEP_METADATA_KEY} reads as a steer whose position in the turn is
 * unknown, which is the one thing the step index exists to state — and at rest
 * that row is indistinguishable from an ordinary user turn, which is exactly the
 * drift found on one backend.
 *
 * ONE ID SCHEME. A steer that reached a surface already has an id, and the queued
 * and landed announcements must be the same object to that surface, so a
 * pre-assigned id is kept. Only a steer that never had one is named here. That
 * fallback was spelled twice inside one backend and about to be spelled a third
 * time in the other.
 *
 * What stays per backend is genuinely irreducible: one appends Durable Object
 * messages, the other inserts SQLite rows, and each broadcasts on its own
 * channel.
 */
export function describeLandedSteers(
  steers: readonly UserSteer[],
  atStep: number,
): readonly LandedSteerRow[] {
  return steers.map((steer) => ({
    id: steer.id ?? `steer-${nanoid(12)}`,
    text: steer.text,
    atStep,
    metadata: { [STEER_METADATA_KEY]: true, [STEER_STEP_METADATA_KEY]: atStep },
  }));
}
