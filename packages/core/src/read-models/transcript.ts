/**
 * Where a message typed mid-turn belongs in the transcript.
 *
 * A turn is ONE assistant message. Think accumulates every step of it and
 * persists it once, after the stream drains, so a row appended beside it can
 * only sort before or after the whole turn — there is no position "inside the
 * agent's work" for a sibling row to take. That is why a steer the model read
 * at step twenty was drawn under the entire turn while it ran, and above the
 * entire turn once it was saved.
 *
 * The step index closes that. The drain records which step it spliced the
 * steer into (`STEER_STEP_METADATA_KEY` on the durable row, `atStep` on the
 * live broadcast), and a step boundary is already a durable part of the
 * assistant message: the AI SDK pushes a `step-start` part for every step it
 * begins. So the same index places the bubble whether it arrives over the
 * socket during the turn or is read back out of storage a week later, and the
 * two cannot disagree.
 *
 * Pure, and separate from the view, because that agreement is the whole
 * property worth testing and a component cannot be asked about it.
 */
import type { UIMessage } from 'ai';
import * as v from 'valibot';
import { STEER_METADATA_KEY, STEER_STEP_METADATA_KEY } from '../orchestrator/user-steer';

/** One part of a message, as a renderer receives it. */
export type TranscriptPart = UIMessage['parts'][number];

/** One steer as the thread draws it: the operator's words, whether the model
 *  has them yet, and where in the turn it read them. */
export interface InlineSteer {
  readonly id: string;
  readonly text: string;
  /** `queued` is a steer the server has taken but the model has not reached. */
  readonly state: 'queued' | 'landed';
  /**
   * The step of the turn the model read it in.
   *
   * Null while it is queued — there is no position until a step takes it — and
   * on a landed steer whose position was never recorded, which is every row in
   * the workspaces that predate the index. A steer with no position is drawn
   * where the thread can honestly put it: at the end, saying it landed and not
   * saying where.
   */
  readonly atStep: number | null;
}

/** A steer whose position inside a turn is known, which is the only kind that
 *  can be placed. */
export type PlacedSteer = InlineSteer & { readonly state: 'landed'; readonly atStep: number };

/** One message of the thread, with the steers that landed inside it. */
export interface TranscriptEntry {
  readonly message: UIMessage;
  /** Empty for every message nobody interrupted, which is nearly all of them. */
  readonly steers: readonly PlacedSteer[];
}

/** The thread as the chat draws it. */
export interface Transcript {
  readonly entries: readonly TranscriptEntry[];
  /**
   * Steers that have no place inside a turn yet: one still queued, and one the
   * model took but whose position was never recorded. They draw under the
   * thread, which is the only thing that can be said about them.
   */
  readonly trailing: readonly InlineSteer[];
}

/** A run of one assistant message's parts, and the steer that arrived
 *  immediately before them. `null` on the first segment of a turn. */
export interface TurnSegment {
  readonly steer: PlacedSteer | null;
  readonly parts: readonly TranscriptPart[];
}

const SteerRowSchema = v.looseObject({
  [STEER_METADATA_KEY]: v.optional(v.boolean()),
  [STEER_STEP_METADATA_KEY]: v.optional(v.number()),
});

/**
 * The step a durable row says it was steered into, or null when the row is not
 * a landed steer.
 *
 * A row stamped as a steer but carrying no step is a row written before the
 * index existed. It stays a top-level bubble rather than being guessed into a
 * position — a wrong position is a worse claim than an honest one at the end.
 */
function steerRowStep<Metadata>(metadata: Metadata): number | null {
  const parsed = v.safeParse(SteerRowSchema, metadata ?? {});
  if (!parsed.success || parsed.output[STEER_METADATA_KEY] !== true) return null;
  const step = parsed.output[STEER_STEP_METADATA_KEY];
  return step === undefined || !Number.isInteger(step) || step < 0 ? null : step;
}

/**
 * The thread, with every steer moved inside the turn it landed in.
 *
 * A durable steer row is followed in the message list by the assistant message
 * of the turn it interrupted — `addMessages` parents it off the turn's user
 * message while the assistant message is still uncommitted, and the assistant
 * message then parents off it. So the steer's turn is the next assistant
 * message, and attaching it there is a fact about the write order rather than a
 * guess.
 *
 * `live` are the steers this session has been told about over the socket but
 * has no durable row for yet — the turn is still running, and `addMessages`
 * deliberately does not broadcast from inside the inference loop. They attach
 * to the message being streamed. A live steer whose row HAS arrived is dropped
 * here rather than drawn twice.
 */
export function buildTranscript(
  messages: readonly UIMessage[], live: readonly InlineSteer[] = [],
): Transcript {
  const entries: TranscriptEntry[] = [];
  let pending: PlacedSteer[] = [];

  for (const message of messages) {
    const step = message.role === 'user' ? steerRowStep(message.metadata) : null;
    if (step !== null) {
      pending.push({ id: message.id, text: messageText(message), atStep: step, state: 'landed' });
      continue;
    }
    if (message.role === 'assistant' && pending.length > 0) {
      entries.push({ message, steers: pending });
      pending = [];
      continue;
    }
    // A steer with no turn after it — the turn failed before its assistant
    // message was persisted. Show it where it is rather than losing it.
    for (const orphan of pending) entries.push({ message: steerMessage(orphan), steers: [] });
    pending = [];
    entries.push({ message, steers: [] });
  }
  for (const orphan of pending) entries.push({ message: steerMessage(orphan), steers: [] });

  const durable = new Set(messages.map((message) => message.id));
  const unseen = live.filter((steer) => !durable.has(steer.id));
  const placeable = unseen.filter(isPlaced);
  const trailing = unseen.filter((steer) => !isPlaced(steer));
  return { entries: attachLive(entries, placeable), trailing };
}

/** Live steers onto the turn being streamed — the last message, when there is
 *  one to stream. A steer that arrives with no turn to sit in trails instead. */
function attachLive(
  entries: readonly TranscriptEntry[], live: readonly PlacedSteer[],
): readonly TranscriptEntry[] {
  if (live.length === 0) return entries;
  const last = entries.length - 1;
  if (last < 0 || entries[last]!.message.role !== 'assistant') return entries;
  return entries.map((entry, index) => index === last
    ? { message: entry.message, steers: [...entry.steers, ...live] }
    : entry);
}

/** Whether the model has this steer AND the thread knows where. */
function isPlaced(steer: InlineSteer): steer is PlacedSteer {
  return steer.state === 'landed' && steer.atStep !== null;
}

/**
 * One assistant message's parts, cut at the steers that landed in it.
 *
 * The cut is on the parts and not on the render blocks, so a run of tool calls
 * the operator interrupted renders as two runs. Folding across the steer would
 * put a '7 calls' headline over work done on either side of an instruction that
 * changed what the agent was doing.
 *
 * A step index past the last `step-start` places the steer at the end: the turn
 * stopped before that step wrote anything, and the end is where it was read.
 */
export function segmentBySteers(
  parts: readonly TranscriptPart[], steers: readonly PlacedSteer[],
): readonly TurnSegment[] {
  if (steers.length === 0) return [{ steer: null, parts }];
  const boundaries: number[] = [];
  parts.forEach((part, index) => { if (part.type === 'step-start') boundaries.push(index); });

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

function messageText(message: UIMessage): string {
  return message.parts
    .flatMap((part) => part.type === 'text' ? [part.text] : [])
    .join('');
}

/** A live or orphaned steer as the plain user message the thread draws. */
function steerMessage(steer: InlineSteer): UIMessage {
  return {
    id: steer.id, role: 'user', parts: [{ type: 'text', text: steer.text }],
    metadata: { [STEER_METADATA_KEY]: true },
  };
}
