/**
 * A message typed while the agent works is drawn where the agent read it: live and
 * reloaded placement come from the same step index, so they agree (#210).
 */
import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { STEER_METADATA_KEY, STEER_STEP_METADATA_KEY } from '../src/orchestrator/inbox';
import {
  EMPTY_TRANSCRIPT_FOLD, buildTranscript, extendTranscript, sealTranscript, segmentBySteers,
  type InlineSteer, type PlacedSteer, type TranscriptPart,
} from '../src/read-models/transcript';

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] });

/** The durable row a landed steer becomes, as `recordLandedSteers` writes it. */
const steerRow = (id: string, text: string, atStep: number): UIMessage => ({
  id, role: 'user', parts: [{ type: 'text', text }],
  metadata: { [STEER_METADATA_KEY]: true, [STEER_STEP_METADATA_KEY]: atStep },
});

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
    // Read off the placement: row metadata matters only through where the thread draws it.
    const { entries } = buildTranscript([
      user('u1', 'research flaxdiff'),
      steerRow('steer-a', 'use the swarm for this', 7),
      turn('a1', 9),
    ]);

    expect(entries.map((entry) => entry.message.id)).toEqual(['u1', 'a1']);
    expect(entries[1].steers.map((steer) => steer.atStep)).toEqual([7]);
    expect(entries[0].steers).toEqual([]);
  });

  test('a steer row written before the index existed keeps its bubble instead of guessing', () => {
    // Legacy rows have no step; placing them at a made-up step would misstate what the model read.
    for (const metadata of [
      { [STEER_METADATA_KEY]: true },
      { [STEER_METADATA_KEY]: true, [STEER_STEP_METADATA_KEY]: -1 },
    ]) {
      const { entries } = buildTranscript([
        { id: 'old-steer', role: 'user', parts: [{ type: 'text', text: 'wait' }], metadata },
        turn('a1', 6),
      ]);

      expect(entries.map((entry) => entry.message.id)).toEqual(['old-steer', 'a1']);
      expect(entries[1].steers).toEqual([]);
    }
  });
});

describe('a steer inside the turn that read it', () => {
  test('the durable row moves into the turn it interrupted, not before it', () => {
    // Write order is user, steer, assistant, so a reload trusting raw row order would draw the
    // steer above the entire turn.
    const { entries } = buildTranscript([
      user('u1', 'research flaxdiff'),
      steerRow('steer-a', 'use the swarm for this', 3),
      turn('a1', 6),
    ]);

    expect(entries.map((entry) => entry.message.id)).toEqual(['u1', 'a1']);
    expect(entries[1].steers).toEqual([
      { id: 'steer-a', text: 'use the swarm for this', atStep: 3, state: 'landed' },
    ]);
  });

  test('a turn nobody interrupted carries no steers and is untouched', () => {
    const messages = [user('u1', 'hello'), turn('a1', 2)];
    const { entries } = buildTranscript(messages);
    expect(entries).toEqual([
      { message: messages[0], steers: [] },
      { message: messages[1], steers: [] },
    ]);
  });

  test('a steer whose turn never persisted an answer is still shown', () => {
    // Attaching to the next turn would put the operator's words inside work not yet started.
    const { entries } = buildTranscript([
      user('u1', 'go'), steerRow('steer-a', 'and the logs', 2),
    ]);

    expect(entries.map((entry) => entry.message.id)).toEqual(['u1', 'steer-a']);
    expect(entries[1].steers).toEqual([]);
  });
});

describe('the live splice and the reloaded row agree', () => {
  test('a live steer draws inside the streaming turn at the same step its row will', () => {
    const streaming = turn('a1', 6);
    const { entries: liveEntries } = buildTranscript([user('u1', 'go'), streaming], [live('steer-a', 'use the swarm', 3)]);
    const { entries: reloaded } = buildTranscript([user('u1', 'go'), steerRow('steer-a', 'use the swarm', 3), streaming]);

    // The bubble does not move when the socket's copy is replaced by the stored one.
    expect(liveEntries[1].steers).toEqual(reloaded[1].steers);
    expect(liveEntries.map((entry) => entry.message.id))
      .toEqual(reloaded.map((entry) => entry.message.id));
  });

  test('a live steer whose durable row has arrived is drawn once', () => {
    const { entries } = buildTranscript(
      [user('u1', 'go'), steerRow('steer-a', 'use the swarm', 3), turn('a1', 6)],
      [live('steer-a', 'use the swarm', 3)],
    );

    expect(entries[1].steers.map((steer) => steer.id)).toEqual(['steer-a']);
  });

  test('a queued steer has no position yet, so it trails instead of being placed', () => {
    // "Taken" and "being read" differ; a queued steer has nowhere honest to sit in the turn.
    const { entries, trailing } = buildTranscript(
      [user('u1', 'go'), turn('a1', 6)], [queued('steer-a', 'wait')],
    );

    expect(entries[1].steers).toEqual([]);
    expect(trailing.map((steer) => steer.id)).toEqual(['steer-a']);
  });

  test('a landed steer with no recorded position trails rather than being guessed', () => {
    const { entries, trailing } = buildTranscript(
      [user('u1', 'go'), turn('a1', 6)],
      [{ id: 'steer-a', text: 'wait', atStep: null, state: 'landed' }],
    );

    expect(entries[1].steers).toEqual([]);
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
    expect(segments[0].steer).toBeNull();
    expect(segments[0].parts.map(partLabel)).toEqual(['start', 'step 0', 'start', 'step 1']);
    expect(segments[1].steer?.id).toBe('s');
    expect(segments[1].parts.map(partLabel)).toEqual(['start', 'step 2', 'start', 'step 3']);
  });

  test('no steer leaves the parts in one piece', () => {
    const parts = turn('a1', 3).parts;
    expect(segmentBySteers(parts, [])).toEqual([{ steer: null, parts }]);
  });

  test('two steers in one turn are drawn in step order, each above its own work', () => {
    const parts = turn('a1', 4).parts;
    const segments = segmentBySteers(parts, [live('b', 'second', 3), live('a', 'first', 1)]);

    expect(segments.map((segment) => segment.steer?.id ?? null)).toEqual([null, 'a', 'b']);
    expect(segments[1].parts.map(partLabel)).toEqual(['start', 'step 1', 'start', 'step 2']);
  });

  test('two steers read at the same boundary stay two bubbles', () => {
    const parts = turn('a1', 3).parts;
    const segments = segmentBySteers(parts, [live('a', 'first', 1), live('b', 'second', 1)]);

    expect(segments.map((segment) => segment.steer?.id ?? null)).toEqual([null, 'a', 'b']);
    expect(segments[1].parts).toEqual([]);
  });

  test('a step the turn never reached puts the steer at the end, not off the list', () => {
    // An abort can end the turn before the spliced step writes anything; the end is where it was read.
    const parts = turn('a1', 2).parts;
    const segments = segmentBySteers(parts, [live('a', 'stop', 9)]);

    expect(segments).toHaveLength(2);
    expect(segments[0].parts).toHaveLength(4);
    expect(segments[1].steer?.id).toBe('a');
    expect(segments[1].parts).toEqual([]);
  });
});

function partLabel(part: TranscriptPart): string {
  if (part.type === 'step-start') return 'start';

  return part.type === 'text' ? part.text : part.type;
}

describe('the resumable fold', () => {
  // Settled entries fold once and each stream tick re-folds only the live window; that is
  // legal because the split point does not show in the result.
  const conversation: UIMessage[] = [
    user('u1', 'go'),
    steerRow('steer-a', 'use the swarm', 3),
    turn('a1', 6),
    steerRow('steer-b', 'and the logs', 2),
    // No assistant row after steer-b: it must orphan identically wherever the fold was cut.
    user('u2', 'thanks'),
  ];

  const liveSteers: InlineSteer[] = [queued('steer-live', 'wait'), live('steer-a', 'use the swarm', 3)];

  test('sealing a fold extended in any two runs equals the one-shot build', () => {
    const whole = buildTranscript(conversation, liveSteers);

    for (let cut = 0; cut <= conversation.length; cut++) {
      const stable = extendTranscript(EMPTY_TRANSCRIPT_FOLD, conversation.slice(0, cut));
      const resumed = sealTranscript(extendTranscript(stable, conversation.slice(cut)), liveSteers);
      expect(resumed).toEqual(whole);
    }
  });

  test('extending a fold reuses the settled half\'s entry objects', () => {
    // memo(MessageView) holds across ticks only if settled entries keep referential identity.
    const stable = extendTranscript(EMPTY_TRANSCRIPT_FOLD, [user('u1', 'go'), turn('a1', 2)]);
    const ticked = extendTranscript(stable, [turn('a2', 1)]);
    expect(ticked.entries[0]).toBe(stable.entries[0]);
    expect(ticked.entries[1]).toBe(stable.entries[1]);
  });

  test('extending never reworks the fold it was given', () => {
    const stable = extendTranscript(EMPTY_TRANSCRIPT_FOLD, [user('u1', 'go'), steerRow('steer-a', 'wait', 1)]);
    extendTranscript(stable, [turn('a1', 3)]);
    // Sealing the original fold orphans the pending steer, as if the extension never happened.
    expect(stable.pending.map((steer) => steer.id)).toEqual(['steer-a']);
    expect(sealTranscript(stable).entries.map((entry) => entry.message.id)).toEqual(['u1', 'steer-a']);
  });

  test('a live steer is deduplicated against steer rows, and only steer rows', () => {
    // Negative control: an ordinary message sharing a live steer's id must not swallow it.
    const fold = extendTranscript(EMPTY_TRANSCRIPT_FOLD, [user('steer-x', 'unrelated'), turn('a1', 2)]);
    const { trailing } = sealTranscript(fold, [queued('steer-x', 'wait')]);
    expect(trailing.map((steer) => steer.id)).toEqual(['steer-x']);
  });
});
