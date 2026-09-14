/**
 * The user kind of signal — the vocabulary for a message the user types while
 * a turn is running. Delivery itself is the shared seam
 * ({@link SignalDelivery} in orchestrator/signals.ts); this file holds only
 * the words both sides of it speak: the steer row, the merged user message,
 * the steer_status broadcasts, and the durable landed-row shape.
 *
 * Three properties keep a user's message distinct from an event signal, and
 * they are the whole reason the kind exists:
 *
 *   1. it persists as a VERBATIM user row, because the walk-back fork cuts the
 *      conversation at a user message and a steer the model acted on is one;
 *   2. an interrupt HANDS IT BACK to the composer rather than eating it — the
 *      surface already rendered it as sent, so losing it silently is the one
 *      outcome that cannot be explained to the person who typed it;
 *   3. anything left over when the turn ends reruns as a USER-origin turn, not
 *      as a programmatic one, so it is the user's next turn and reads that way
 *      in the transcript and in every provenance decision downstream.
 */

import type { ModelMessage } from 'ai';
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
