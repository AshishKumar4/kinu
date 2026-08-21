/**
 * A message typed while the agent works, drawn where the agent read it.
 *
 * The report (#210, images/210_1): the operator typed into a running turn, the
 * thread said "steered mid-turn", and the bubble sat at the very bottom under
 * twenty steps of work the agent had done BEFORE reading it. Reloading moved it
 * to the other extreme — above the whole turn — because a turn is one assistant
 * message and a sibling row has only those two places to go.
 *
 * These hold the property that fixes it: the live placement and the reloaded
 * placement are computed from the same step index, so they agree.
 */
import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { STEER_METADATA_KEY, STEER_STEP_METADATA_KEY } from '../src/orchestrator/user-steer';
import {
  buildTranscript, segmentBySteers, steerRowStep,
  type InlineSteer, type PlacedSteer, type TranscriptPart,
} from '../src/read-models/transcript';

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] });

/** The durable row a landed steer becomes, exactly as `recordLandedSteers`
 *  writes it. */
const steerRow = (id: string, text: string, atStep: number): UIMessage => ({
  id, role: 'user', parts: [{ type: 'text', text }],
  metadata: { [STEER_METADATA_KEY]: true, [STEER_STEP_METADATA_KEY]: atStep },
});

/** A turn of `steps` steps, each a `step-start` marker and one line of text. */
function turn(id: string, steps: number): UIMessage {
  const parts: TranscriptPart[] = [];
  for (let step = 0; step < steps; step++) {
    parts.push({ type: 'step-start' });
    parts.push({ type: 'text', text: `step ${step}` });
  }
  return { id, role: 'assistant', parts };
}

const live = (id: string, text: string, atStep: number): PlacedSteer =>
  ({ id, text, atStep, state: 'landed' });

const queued = (id: string, text: string): InlineSteer =>
  ({ id, text, atStep: null, state: 'queued' });

describe('reading a steer row', () => {
  test('a landed steer names its step; an ordinary user message names nothing', () => {
    expect(steerRowStep({ [STEER_METADATA_KEY]: true, [STEER_STEP_METADATA_KEY]: 7 })).toBe(7);
    expect(steerRowStep({ kinuMode: 'build' })).toBeNull();
    expect(steerRowStep(undefined)).toBeNull();
  });

  test('a steer row written before the index existed keeps its bubble instead of guessing', () => {
    // Every workspace the operator already has is full of these. Placing them
    // at a made-up step would claim the model read them somewhere it did not.
    expect(steerRowStep({ [STEER_METADATA_KEY]: true })).toBeNull();
    expect(steerRowStep({ [STEER_METADATA_KEY]: true, [STEER_STEP_METADATA_KEY]: -1 })).toBeNull();
  });
});

describe('a steer inside the turn that read it', () => {
  test('the durable row moves into the turn it interrupted, not before it', () => {
    // The write order is user, steer, assistant: the steer is appended while
    // the assistant message is still uncommitted, so it lands between them and
    // a reload used to draw it above the entire turn.
    const { entries } = buildTranscript([
      user('u1', 'research flaxdiff'),
      steerRow('steer-a', 'use the swarm for this', 3),
      turn('a1', 6),
    ]);

    expect(entries.map((entry) => entry.message.id)).toEqual(['u1', 'a1']);
    expect(entries[1]!.steers).toEqual([
      { id: 'steer-a', text: 'use the swarm for this', atStep: 3, state: 'landed' },
    ]);
  });

  test('a turn nobody interrupted carries no steers and is untouched', () => {
    const messages = [user('u1', 'hello'), turn('a1', 2)];
    const { entries } = buildTranscript(messages);
    expect(entries).toEqual([
      { message: messages[0]!, steers: [] },
      { message: messages[1]!, steers: [] },
    ]);
  });

  test('a steer whose turn never persisted an answer is still shown', () => {
    // The turn errored out after the drain. Attaching it to the NEXT turn would
    // put the operator's words inside work that had not started when they typed.
    const { entries } = buildTranscript([
      user('u1', 'go'), steerRow('steer-a', 'and the logs', 2),
    ]);
    expect(entries.map((entry) => entry.message.id)).toEqual(['u1', 'steer-a']);
    expect(entries[1]!.steers).toEqual([]);
  });
});

describe('the live splice and the reloaded row agree', () => {
  test('a live steer draws inside the streaming turn at the same step its row will', () => {
    const streaming = turn('a1', 6);
    const { entries: liveEntries } = buildTranscript([user('u1', 'go'), streaming], [live('steer-a', 'use the swarm', 3)]);
    const { entries: reloaded } = buildTranscript([user('u1', 'go'), steerRow('steer-a', 'use the swarm', 3), streaming]);

    // Same turn, same step, same words — the bubble does not move when the
    // socket's copy is replaced by the stored one.
    expect(liveEntries[1]!.steers).toEqual(reloaded[1]!.steers);
    expect(liveEntries.map((entry) => entry.message.id))
      .toEqual(reloaded.map((entry) => entry.message.id));
  });

  test('a live steer whose durable row has arrived is drawn once', () => {
    const { entries } = buildTranscript(
      [user('u1', 'go'), steerRow('steer-a', 'use the swarm', 3), turn('a1', 6)],
      [live('steer-a', 'use the swarm', 3)],
    );
    expect(entries[1]!.steers.map((steer) => steer.id)).toEqual(['steer-a']);
  });

  test('a queued steer has no position yet, so it trails instead of being placed', () => {
    // "We took your words" and "the model is reading them" are different facts,
    // and a queued steer has nowhere honest to sit inside the turn.
    const { entries, trailing } = buildTranscript(
      [user('u1', 'go'), turn('a1', 6)], [queued('steer-a', 'wait')],
    );
    expect(entries[1]!.steers).toEqual([]);
    expect(trailing.map((steer) => steer.id)).toEqual(['steer-a']);
  });

  test('a landed steer with no recorded position trails rather than being guessed', () => {
    const { entries, trailing } = buildTranscript(
      [user('u1', 'go'), turn('a1', 6)],
      [{ id: 'steer-a', text: 'wait', atStep: null, state: 'landed' }],
    );
    expect(entries[1]!.steers).toEqual([]);
    expect(trailing.map((steer) => steer.id)).toEqual(['steer-a']);
  });

  test('a steer whose durable row has arrived stops trailing too', () => {
    const { trailing } = buildTranscript(
      [user('u1', 'go'), steerRow('steer-a', 'wait', 2), turn('a1', 6)],
      [queued('steer-a', 'wait')],
    );
    expect(trailing).toEqual([]);
  });
});

describe('cutting the turn at the steer', () => {
  test('the parts split at the step boundary the model read the steer in', () => {
    const parts = turn('a1', 4).parts;
    const segments = segmentBySteers(parts, [live('s', 'wait', 2)]);

    expect(segments).toHaveLength(2);
    expect(segments[0]!.steer).toBeNull();
    expect(segments[0]!.parts.map(partLabel)).toEqual(['start', 'step 0', 'start', 'step 1']);
    expect(segments[1]!.steer?.id).toBe('s');
    expect(segments[1]!.parts.map(partLabel)).toEqual(['start', 'step 2', 'start', 'step 3']);
  });

  test('no steer leaves the parts in one piece', () => {
    const parts = turn('a1', 3).parts;
    expect(segmentBySteers(parts, [])).toEqual([{ steer: null, parts }]);
  });

  test('two steers in one turn are drawn in step order, each above its own work', () => {
    const parts = turn('a1', 4).parts;
    const segments = segmentBySteers(parts, [live('b', 'second', 3), live('a', 'first', 1)]);

    expect(segments.map((segment) => segment.steer?.id ?? null)).toEqual([null, 'a', 'b']);
    expect(segments[1]!.parts.map(partLabel)).toEqual(['start', 'step 1', 'start', 'step 2']);
  });

  test('two steers read at the same boundary stay two bubbles', () => {
    const parts = turn('a1', 3).parts;
    const segments = segmentBySteers(parts, [live('a', 'first', 1), live('b', 'second', 1)]);

    expect(segments.map((segment) => segment.steer?.id ?? null)).toEqual([null, 'a', 'b']);
    expect(segments[1]!.parts).toEqual([]);
  });

  test('a step the turn never reached puts the steer at the end, not off the list', () => {
    // The drain records the step it spliced into; an abort can end the turn
    // before that step writes anything. The end is where it was read.
    const parts = turn('a1', 2).parts;
    const segments = segmentBySteers(parts, [live('a', 'stop', 9)]);

    expect(segments).toHaveLength(2);
    expect(segments[0]!.parts).toHaveLength(4);
    expect(segments[1]!.steer?.id).toBe('a');
    expect(segments[1]!.parts).toEqual([]);
  });
});

function partLabel(part: TranscriptPart): string {
  if (part.type === 'step-start') return 'start';
  return part.type === 'text' ? part.text : part.type;
}
