/**
 * Placement of mid-turn steers inside the one assistant message of a turn. The step index
 * (`STEER_STEP_METADATA_KEY` durable, `atStep` live) maps onto the AI SDK's `step-start` parts, so
 * live and stored placement agree.
 */
import type { UIMessage } from 'ai';
import * as v from 'valibot';
import { STEER_METADATA_KEY, STEER_STEP_METADATA_KEY } from '../orchestrator/inbox';
import { rowText } from '../utils/ui-message';

export type TranscriptPart = UIMessage['parts'][number];

export interface InlineSteer {
  readonly id: string;
  readonly text: string;
  readonly state: 'queued' | 'landed';
  /** Null while queued, or on a landed steer with no recorded step; those draw at the end. */
  readonly atStep: number | null;
}

export type PlacedSteer = InlineSteer & { readonly state: 'landed'; readonly atStep: number };

export interface TranscriptEntry {
  readonly message: UIMessage;
  readonly steers: readonly PlacedSteer[];
}

export interface Transcript {
  readonly entries: readonly TranscriptEntry[];
  /** Steers with no place inside a turn: still queued, or landed with no recorded step. */
  readonly trailing: readonly InlineSteer[];
}

/** A run of assistant parts and the steer immediately before them; null on a turn's first segment. */
export interface TurnSegment {
  readonly steer: PlacedSteer | null;
  readonly parts: readonly TranscriptPart[];
}

const SteerRowSchema = v.looseObject({
  [STEER_METADATA_KEY]: v.optional(v.boolean()),
  [STEER_STEP_METADATA_KEY]: v.optional(v.number()),
});

/** Step of a landed steer row, or null. A steer row without a step is not guessed into place. */
function steerRowStep(row: { metadata: unknown }): number | null {
  const parsed = v.safeParse(SteerRowSchema, row.metadata ?? {});

  if (!parsed.success || parsed.output[STEER_METADATA_KEY] !== true) return null;
  const step = parsed.output[STEER_STEP_METADATA_KEY];

  return step === undefined || !Number.isInteger(step) || step < 0 ? null : step;
}

/** Resumable thread walk: fold the frozen half once, then extend per tick with the live window. */
export interface TranscriptFold {
  readonly entries: readonly TranscriptEntry[];
  readonly pending: readonly PlacedSteer[];
  /** Durable steer row ids; a live steer's id can only collide with its own durable row. */
  readonly steerRowIds: ReadonlySet<string>;
}

const NO_STEERS: readonly PlacedSteer[] = [];

export const EMPTY_TRANSCRIPT_FOLD: TranscriptFold = {
  entries: [], pending: [], steerRowIds: new Set(),
};

/** Extend a fold with the next run of messages. Pure: `fold` is not mutated. */
export function extendTranscript(
  fold: TranscriptFold, messages: readonly UIMessage[],
): TranscriptFold {
  if (messages.length === 0) return fold;
  const entries = [...fold.entries];
  const steerRowIds = new Set(fold.steerRowIds);
  let pending = [...fold.pending];

  for (const message of messages) {
    const step = message.role === 'user' ? steerRowStep({ metadata: message.metadata }) : null;

    if (step !== null) {
      steerRowIds.add(message.id);
      pending.push({ id: message.id, text: rowText(message), atStep: step, state: 'landed' });
      continue;
    }

    if (message.role === 'assistant' && pending.length > 0) {
      entries.push({ message, steers: pending });
      pending = [];
      continue;
    }

    // A steer whose turn failed before its assistant message persisted.
    for (const orphan of pending) entries.push({ message: steerMessage(orphan), steers: NO_STEERS });
    pending = [];
    entries.push({ message, steers: NO_STEERS });
  }

  return { entries, pending, steerRowIds };
}

/** Close a fold: pending steer rows trail; unseen `live` steers attach to the streamed message. */
export function sealTranscript(
  fold: TranscriptFold, live: readonly InlineSteer[] = [],
): Transcript {
  const entries = fold.pending.length === 0
    ? fold.entries
    : [...fold.entries, ...fold.pending.map((orphan) => ({ message: steerMessage(orphan), steers: NO_STEERS }))];

  const unseen = live.filter((steer) => !fold.steerRowIds.has(steer.id));
  const placeable = unseen.filter(isPlaced);
  const trailing = unseen.filter((steer) => !isPlaced(steer));

  return { entries: attachLive(entries, placeable), trailing };
}

/**
 * The thread with every steer inside the turn it landed in. Write order guarantees the steer's
 * turn is the next assistant message; a live steer whose durable row has arrived is dropped.
 */
export function buildTranscript(
  messages: readonly UIMessage[], live: readonly InlineSteer[] = [],
): Transcript {
  return sealTranscript(extendTranscript(EMPTY_TRANSCRIPT_FOLD, messages), live);
}

/** Live steers attach to the last message only when it is an assistant message. */
function attachLive(
  entries: readonly TranscriptEntry[], live: readonly PlacedSteer[],
): readonly TranscriptEntry[] {
  if (live.length === 0) return entries;
  const last = entries.length - 1;

  if (last < 0 || entries[last].message.role !== 'assistant') return entries;

  return entries.map((entry, index) => index === last
    ? { message: entry.message, steers: [...entry.steers, ...live] }
    : entry);
}

function isPlaced(steer: InlineSteer): steer is PlacedSteer {
  return steer.state === 'landed' && steer.atStep !== null;
}

/**
 * One assistant message's parts, cut at its steers. Cut on parts, not render blocks, so a tool
 * run is never folded across a steer. A step past the last `step-start` places the steer at the end.
 */
export function segmentBySteers(
  parts: readonly TranscriptPart[], steers: readonly PlacedSteer[],
): readonly TurnSegment[] {
  if (steers.length === 0) return [{ steer: null, parts }];
  const boundaries: number[] = [];

  for (const [index, part] of parts.entries()) {
    if (part.type === 'step-start') boundaries.push(index);
  }

  const segments: TurnSegment[] = [];
  let cursor = 0;
  let steer: PlacedSteer | null = null;

  for (const next of [...steers].sort((a, b) => a.atStep - b.atStep)) {
    const at = Math.max(cursor, boundaries[next.atStep] ?? parts.length);
    segments.push({ steer, parts: parts.slice(cursor, at) });
    cursor = at;
    steer = next;
  }

  segments.push({ steer, parts: parts.slice(cursor) });

  return segments;
}

function steerMessage(steer: InlineSteer): UIMessage {
  return {
    id: steer.id, role: 'user', parts: [{ type: 'text', text: steer.text }],
    metadata: { [STEER_METADATA_KEY]: true },
  };
}
